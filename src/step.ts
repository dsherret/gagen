import {
  Condition,
  type ExpressionSource,
  ExpressionValue,
  RawCondition,
  sourcesFrom,
} from "./expression.ts";

export type ConditionLike = Condition | ExpressionValue | string;
export type ConfigValue = string | number | boolean | ExpressionValue;

export interface StepConfig<O extends string = never> {
  name?: string;
  id?: string;
  uses?: string;
  run?: string | string[];
  with?: Record<string, ConfigValue>;
  env?: Record<string, ConfigValue>;
  if?: ConditionLike;
  shell?: string;
  workingDirectory?: string;
  continueOnError?: boolean | string;
  timeoutMinutes?: number;
  outputs?: readonly O[];
}

let stepCounter = 0;

// exported for testing only
export function resetStepCounter(): void {
  stepCounter = 0;
}

export type StepLike = Step<string> | StepGroup;

// internal state for creating derived (cloned) steps without incrementing the counter
interface _StepState {
  id: string;
  dependencies: readonly Step<string>[];
  comesAfterDeps: readonly Step<string>[];
  crossJobDeps: readonly Step<string>[];
}

export class Step<O extends string = never> implements ExpressionSource {
  readonly #id: string;
  readonly config: Readonly<StepConfig<O>>;
  readonly dependencies: readonly Step<string>[];
  readonly comesAfterDeps: readonly Step<string>[];
  readonly outputs: { readonly [K in O]: ExpressionValue };
  // cross-job step references for needs inference (e.g., artifact download → upload)
  readonly _crossJobDeps: readonly Step<string>[];
  // set by Job.resolveSteps() — the job that owns this step
  _job?: ExpressionSource;

  constructor(config: StepConfig<O>, _state?: _StepState) {
    if (!_state && config.outputs?.length && !config.id) {
      throw new Error(
        "Step with outputs must have an explicit id",
      );
    }

    this.#id = _state?.id ?? config.id ?? `_step_${stepCounter++}`;
    this.config = config;
    this.dependencies = _state?.dependencies ?? [];
    this.comesAfterDeps = _state?.comesAfterDeps ?? [];
    this._crossJobDeps = _state?.crossJobDeps ?? [];

    // build typed outputs (always regenerated so they reference this instance)
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
  }

  get id(): string {
    return this.#id;
  }

  dependsOn(...deps: StepLike[]): Step<O> {
    const newDeps: Step<string>[] = [...this.dependencies];
    for (const d of deps) {
      if (d instanceof StepGroup) {
        newDeps.push(...d.all);
      } else {
        newDeps.push(d);
      }
    }
    return new Step(this.config, {
      id: this.#id,
      dependencies: newDeps,
      comesAfterDeps: this.comesAfterDeps,
      crossJobDeps: this._crossJobDeps,
    });
  }

  comesAfter(...deps: StepLike[]): Step<O> {
    const newDeps: Step<string>[] = [...this.comesAfterDeps];
    for (const d of deps) {
      if (d instanceof StepGroup) {
        newDeps.push(...d.all);
      } else {
        newDeps.push(d);
      }
    }
    return new Step(this.config, {
      id: this.#id,
      dependencies: this.dependencies,
      comesAfterDeps: newDeps,
      crossJobDeps: this._crossJobDeps,
    });
  }

  if(condition: ConditionLike): Step<O> {
    const cond = toCondition(condition);
    const newIf = this.config.if != null
      ? cond.and(toCondition(this.config.if))
      : cond;
    return new Step(
      { ...this.config, if: newIf },
      {
        id: this.#id,
        dependencies: this.dependencies,
        comesAfterDeps: this.comesAfterDeps,
        crossJobDeps: this._crossJobDeps,
      },
    );
  }

  _withCrossJobDep(dep: Step<string>): Step<O> {
    return new Step(this.config, {
      id: this.#id,
      dependencies: this.dependencies,
      comesAfterDeps: this.comesAfterDeps,
      crossJobDeps: [...this._crossJobDeps, dep],
    });
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
    if (ifCondition != null) {
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

export function step<const O extends string = never>(
  config: StepConfig<O>,
): Step<O> {
  return new Step(config);
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

// --- step group ---

export class StepGroup {
  readonly all: readonly Step<string>[];

  constructor(steps: readonly Step<string>[]) {
    this.all = steps;
  }

  if(condition: ConditionLike): StepGroup {
    return new StepGroup(this.all.map((s) => s.if(condition)));
  }

  dependsOn(...deps: StepLike[]): StepGroup {
    return new StepGroup(this.all.map((s) => s.dependsOn(...deps)));
  }

  comesAfter(...deps: StepLike[]): StepGroup {
    return new StepGroup(this.all.map((s) => s.comesAfter(...deps)));
  }
}

export function steps(
  ...items: (Step<string> | StepGroup | StepConfig)[]
): StepGroup {
  if (items.length === 0) {
    throw new Error("steps() requires at least one step");
  }
  const created: Step<string>[] = [];
  for (const item of items) {
    if (item instanceof StepGroup) {
      created.push(...item.all);
    } else if (item instanceof Step) {
      created.push(item);
    } else {
      created.push(new Step(item));
    }
  }
  return new StepGroup(created);
}
