import {
  Condition,
  type ExpressionSource,
  ExpressionValue,
  isAlwaysTrue,
  RawCondition,
  sourcesFrom,
} from "./expression.ts";

export type ConditionLike = Condition | ExpressionValue | string;
export type ConfigValue = string | number | boolean | ExpressionValue;

export interface StepConfig<O extends string = never> {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string | string[];
  readonly with?: Readonly<Record<string, ConfigValue>>;
  readonly env?: Readonly<Record<string, ConfigValue>>;
  readonly if?: ConditionLike;
  readonly shell?: string;
  readonly workingDirectory?: string;
  readonly continueOnError?: boolean | string;
  readonly timeoutMinutes?: number;
  readonly outputs?: readonly O[];
}

let stepCounter = 0;

// exported for testing only
export function resetStepCounter(): void {
  stepCounter = 0;
}

export type StepLike = Step<string> | StepRef<string>;
export type MaybeStepLike = StepLike | null | undefined;

export class Step<O extends string = never> implements ExpressionSource {
  readonly #id: string;
  readonly config: StepConfig<O>;
  readonly outputs: { [K in O]: ExpressionValue };
  // cross-job step references for needs inference (e.g., artifact download → upload)
  readonly _crossJobDeps: readonly Step<string>[];
  readonly children: readonly StepLike[];

  constructor(config: StepConfig<O>, crossJobDeps?: Step<string>[]);
  constructor(children: readonly MaybeStepLike[]);
  constructor(
    configOrChildren: StepConfig<O> | readonly MaybeStepLike[],
    crossJobDeps?: Step<string>[],
  ) {
    if (Array.isArray(configOrChildren)) {
      // composite step (group of children)
      const children = configOrChildren.filter(
        (c): c is StepLike => c != null,
      );
      if (children.length === 0) {
        throw new Error("step() requires at least one step");
      }
      this.#id = `_step_${stepCounter++}`;
      this.config = {} as StepConfig<O>;
      this._crossJobDeps = Object.freeze([]);
      this.outputs = {} as { [K in O]: ExpressionValue };
      this.children = Object.freeze(children);
      return;
    }

    const config = configOrChildren as StepConfig<O>;
    if (config.outputs?.length && !config.id) {
      throw new Error(
        "Step with outputs must have an explicit id",
      );
    }

    this.#id = config.id ?? `_step_${stepCounter++}`;
    this.config = config;
    this._crossJobDeps = Object.freeze(crossJobDeps ?? []);

    // build typed outputs
    const outputs = {} as { [K in O]: ExpressionValue };
    if (config.outputs) {
      for (const name of config.outputs) {
        (outputs as Record<string, ExpressionValue>)[name] =
          new ExpressionValue(
            `steps.${this.#id}.outputs.${name}`,
            this,
          );
      }
    }
    this.outputs = outputs;
    this.children = Object.freeze([] as StepLike[]);
  }

  get id(): string {
    return this.#id;
  }

  dependsOn(...deps: MaybeStepLike[]): StepRef<O> {
    return new StepRef(this, {
      dependencies: deps.filter((d): d is StepLike => d != null),
    });
  }

  comesAfter(...deps: MaybeStepLike[]): StepRef<O> {
    return new StepRef(this, {
      afterDependencies: deps.filter((d): d is StepLike => d != null),
    });
  }

  if(condition: ConditionLike): StepRef<O> {
    return new StepRef(this, { condition });
  }

  toYaml(effectiveIf?: Condition): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (this.config.name != null) {
      result.name = this.config.name;
    }

    // only include user-provided id
    if (this.config.id) {
      result.id = this.config.id;
    }

    if (this.config.uses != null) {
      result.uses = this.config.uses;
    }

    const ifCondition = effectiveIf ?? this.config.if;
    if (ifCondition != null && !isAlwaysTrue(ifCondition)) {
      result.if = serializeConditionLike(ifCondition);
    }

    if (this.config.shell != null) {
      result.shell = this.config.shell;
    }

    if (this.config.workingDirectory != null) {
      result["working-directory"] = this.config.workingDirectory;
    }

    if (this.config.env != null) {
      result.env = serializeConfigValues(this.config.env);
    }

    if (this.config.continueOnError != null) {
      result["continue-on-error"] = this.config.continueOnError;
    }

    if (this.config.timeoutMinutes != null) {
      result["timeout-minutes"] = this.config.timeoutMinutes;
    }

    if (this.config.with != null) {
      result.with = serializeConfigValues(this.config.with);
    }

    if (this.config.run != null) {
      result.run = Array.isArray(this.config.run)
        ? this.config.run.join("\n")
        : this.config.run;
    }

    return result;
  }
}

// --- StepBuilder: prefix API for conditions/deps before step config ---

export interface StepBuilder {
  <const O extends string = never>(
    ...args:
      (StepConfig<O> | Step<string> | StepRef<string> | null | undefined)[]
  ): StepRef<O>;
  if(condition: ConditionLike): StepBuilder;
  dependsOn(...deps: MaybeStepLike[]): StepBuilder;
  comesAfter(...deps: MaybeStepLike[]): StepBuilder;
}

interface StepBuilderInit {
  condition?: ConditionLike;
  dependencies?: readonly StepLike[];
  afterDependencies?: readonly StepLike[];
}

function buildStepFromArgs(...args: unknown[]): Step<string> {
  const filtered = args.filter((a) => a != null);
  if (filtered.length === 0) {
    throw new Error("step() requires at least one argument");
  }
  if (filtered.length === 1) {
    return new Step(filtered[0] as StepConfig);
  }
  const children: StepLike[] = [];
  for (const item of filtered) {
    if (item instanceof Step || item instanceof StepRef) {
      children.push(item);
    } else {
      children.push(new Step(item as StepConfig));
    }
  }
  return new Step(children);
}

function andConditions(
  existing: ConditionLike | undefined,
  added: ConditionLike,
): ConditionLike {
  return existing != null
    ? toCondition(existing).and(toCondition(added))
    : added;
}

function createStepBuilder(init: StepBuilderInit): StepBuilder {
  const builder = function (...args: unknown[]): StepRef<string> {
    const s = buildStepFromArgs(...args);
    // don't merge config.if here — it's already picked up by
    // computeEffectiveConditions (for the step itself) and
    // propagatableConfigIf (for dependency context propagation).
    // Merging it here would cause it to be counted twice.
    return new StepRef(s, {
      condition: init.condition,
      dependencies: init.dependencies ?? [],
      afterDependencies: init.afterDependencies ?? [],
    });
  } as StepBuilder;

  builder.if = (condition: ConditionLike): StepBuilder => {
    return createStepBuilder({
      ...init,
      condition: andConditions(init.condition, condition),
    });
  };

  builder.dependsOn = (...deps: MaybeStepLike[]): StepBuilder => {
    return createStepBuilder({
      ...init,
      dependencies: [
        ...(init.dependencies ?? []),
        ...deps.filter((d): d is StepLike => d != null),
      ],
    });
  };

  builder.comesAfter = (...deps: MaybeStepLike[]): StepBuilder => {
    return createStepBuilder({
      ...init,
      afterDependencies: [
        ...(init.afterDependencies ?? []),
        ...deps.filter((d): d is StepLike => d != null),
      ],
    });
  };

  return builder;
}

// --- step function with prefix builder methods ---

export interface StepFunction {
  <const O extends string = never>(
    ...args:
      (StepConfig<O> | Step<string> | StepRef<string> | null | undefined)[]
  ): Step<O>;
  if(condition: ConditionLike): StepBuilder;
  dependsOn(...deps: MaybeStepLike[]): StepBuilder;
  comesAfter(...deps: MaybeStepLike[]): StepBuilder;
}

export const step: StepFunction = Object.assign(
  buildStepFromArgs as StepFunction,
  {
    if: (condition: ConditionLike): StepBuilder =>
      createStepBuilder({ condition }),
    dependsOn: (...deps: MaybeStepLike[]): StepBuilder =>
      createStepBuilder({
        dependencies: deps.filter((d): d is StepLike => d != null),
      }),
    comesAfter: (...deps: MaybeStepLike[]): StepBuilder =>
      createStepBuilder({
        afterDependencies: deps.filter((d): d is StepLike => d != null),
      }),
  },
);

// --- StepRef: immutable wrapper for per-usage deps/conditions ---

export class StepRef<O extends string = never> {
  readonly step: Step<O>;
  readonly condition?: ConditionLike;
  readonly dependencies: readonly StepLike[];
  readonly afterDependencies: readonly StepLike[];

  constructor(
    step: Step<O>,
    init?: {
      condition?: ConditionLike;
      dependencies?: readonly StepLike[];
      afterDependencies?: readonly StepLike[];
    },
  ) {
    this.step = step;
    this.condition = init?.condition;
    this.dependencies = init?.dependencies ?? [];
    this.afterDependencies = init?.afterDependencies ?? [];
  }

  get id(): string {
    return this.step.id;
  }

  get config(): StepConfig<O> {
    return this.step.config;
  }

  get outputs(): { [K in O]: ExpressionValue } {
    return this.step.outputs;
  }

  dependsOn(...deps: MaybeStepLike[]): StepRef<O> {
    return new StepRef(this.step, {
      condition: this.condition,
      dependencies: [
        ...this.dependencies,
        ...deps.filter((d): d is StepLike => d != null),
      ],
      afterDependencies: this.afterDependencies,
    });
  }

  comesAfter(...deps: MaybeStepLike[]): StepRef<O> {
    return new StepRef(this.step, {
      condition: this.condition,
      dependencies: this.dependencies,
      afterDependencies: [
        ...this.afterDependencies,
        ...deps.filter((d): d is StepLike => d != null),
      ],
    });
  }

  if(condition: ConditionLike): StepRef<O> {
    return new StepRef(this.step, {
      condition: andConditions(this.condition, condition),
      dependencies: this.dependencies,
      afterDependencies: this.afterDependencies,
    });
  }
}

// --- serialization helpers ---

export function serializeConditionLike(c: ConditionLike): string {
  if (c instanceof Condition) {
    return c.toExpression();
  } else if (c instanceof ExpressionValue) {
    return c.expression;
  } else {
    return c;
  }
}

export function toCondition(c: ConditionLike): Condition {
  if (c instanceof Condition) return c;
  if (c instanceof ExpressionValue) {
    return new RawCondition(c.expression, sourcesFrom(c));
  }
  return new RawCondition(c, new Set());
}

export function serializeConfigValues(
  record: Record<string, ConfigValue>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = value instanceof ExpressionValue ? value.toString() : value;
  }
  return result;
}

// --- helpers ---

/** Extracts the underlying Step from a StepLike (Step or StepRef). */
export function unwrapStep(item: Step<string> | StepRef<string>): Step<string> {
  return item instanceof StepRef ? item.step : item;
}

/** Extracts all underlying leaf Steps from a StepLike (recursively for composites). */
export function unwrapSteps(item: StepLike): Step<string>[] {
  const s = unwrapStep(item);
  if (s.children.length > 0) {
    return s.children.flatMap(unwrapSteps);
  }
  return [s];
}
