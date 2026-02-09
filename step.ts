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

export class Step<O extends string = never> implements ExpressionSource {
  readonly _id: string;
  readonly config: StepConfig<O>;
  readonly dependencies: Step<string>[] = [];
  readonly outputs: { [K in O]: ExpressionValue };
  // cross-job step references for needs inference (e.g., artifact download → upload)
  readonly _crossJobDeps: Step<string>[] = [];
  // set by Job.resolveSteps() — the job that owns this step
  _job?: ExpressionSource;

  constructor(config: StepConfig<O>) {
    if (config.outputs?.length && !config.id) {
      throw new Error(
        "Step with outputs must have an explicit id",
      );
    }

    this._id = config.id ?? `_step_${stepCounter++}`;
    this.config = config;

    // build typed outputs
    const outputs = {} as { [K in O]: ExpressionValue };
    if (config.outputs) {
      for (const name of config.outputs) {
        (outputs as Record<string, ExpressionValue>)[name] =
          new ExpressionValue(
            `steps.${this._id}.outputs.${name}`,
            this,
          );
      }
    }
    this.outputs = outputs;
  }

  dependsOn(...deps: StepLike[]): this {
    for (const d of deps) {
      if (d instanceof StepGroup) {
        this.dependencies.push(...d.all);
      } else {
        this.dependencies.push(d);
      }
    }
    return this;
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
  readonly all: Step<string>[];

  constructor(steps: Step<string>[]) {
    this.all = steps;
  }

  if(condition: ConditionLike): this {
    const cond = toCondition(condition);
    for (const s of this.all) {
      if (s.config.if != null) {
        s.config.if = cond.and(toCondition(s.config.if));
      } else {
        s.config.if = cond;
      }
    }
    return this;
  }

  dependsOn(...deps: StepLike[]): this {
    for (const s of this.all) {
      s.dependsOn(...deps);
    }
    return this;
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
