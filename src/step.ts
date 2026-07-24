import {
  Condition,
  type ExpressionSource,
  ExpressionValue,
  isAlwaysTrue,
  RawCondition,
  sourcesFrom,
} from "./expression.ts";

/** Anything usable as an `if` condition: a Condition, an expression, or raw text. */
export type ConditionLike = Condition | ExpressionValue | string;
/** A value usable in a step's `with`/`env` map. */
export type ConfigValue = string | number | boolean | ExpressionValue;

/**
 * The declarative configuration of a single step.
 *
 * A config object must not be mutated after it has been used: `id`, `outputs`
 * and the shape validation are consumed when the {@linkcode Step} is built, and
 * the object doubles as the identity of the step it produced.
 */
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
  /** Runs the step asynchronously so the job continues without waiting for it. */
  readonly background?: boolean;
  /**
   * Makes this a `wait` step that blocks until the referenced background
   * step(s) finish. Prefer `step.waitFor(...)`, which also wires up ordering.
   */
  readonly wait?: StepLike | readonly StepLike[];
  /**
   * Makes this a `wait-all` step that blocks until all active background steps
   * finish. Prefer `step.waitForAll()`.
   */
  readonly waitAll?: boolean;
  /**
   * Makes this a `cancel` step that terminates the referenced background step.
   * Prefer `step.cancel(...)`, which also wires up ordering.
   */
  readonly cancel?: StepLike;
}

let stepCounter = 0;

// declared ahead of Step because its constructor populates them
const stepsByConfig = new WeakMap<StepConfig<string>, Step<string>>();
const crossJobDepsByStep = new WeakMap<
  Step<string>,
  readonly Step<string>[]
>();
const EMPTY_STEPS: readonly Step<string>[] = Object.freeze([]);

/**
 * Resets the counter used to generate internal step ids.
 *
 * This deliberately does not clear the config-to-step memo table: a config
 * object already turned into a step keeps that step, and therefore its id.
 * Generated ids never reach the YAML and steps are identified by object
 * identity, so a reused id is harmless.
 *
 * Exported for testing only.
 */
export function resetStepCounter(): void {
  stepCounter = 0;
}

/** Anything accepted where a step is expected. */
export type StepLike = Step<string> | StepRef<string> | StepConfig;

/**
 * How a composite step's children relate to each other. "sequential" children
 * run one after another (the default); "parallel" children run concurrently and
 * serialize to a GitHub Actions `parallel:` block.
 */
export type CompositeKind = "sequential" | "parallel";

/**
 * A single workflow step, or a composite grouping several steps together.
 *
 * Instances are immutable — `dependsOn`, `comesAfter` and `if` return a
 * {@link StepRef} carrying the per-usage modifiers rather than mutating the
 * step, so the same step can be reused across jobs with different conditions.
 */
export class Step<O extends string = never> implements ExpressionSource {
  readonly #id: string;
  readonly #kind: CompositeKind;
  /** The configuration this step was created from (empty for composites). */
  readonly config: StepConfig<O>;
  /** Typed expressions for the outputs declared by `config.outputs`. */
  readonly outputs: { [K in O]: ExpressionValue };
  /** The children of a composite step, or an empty array for a leaf step. */
  readonly children: readonly StepLike[];

  constructor(config: StepConfig<O>, crossJobDeps?: readonly Step<string>[]);
  constructor(children: readonly StepLike[], kind?: CompositeKind);
  constructor(
    configOrChildren: StepConfig<O> | readonly StepLike[],
    second?: readonly Step<string>[] | CompositeKind,
  ) {
    if (Array.isArray(configOrChildren)) {
      // composite step (group of children)
      if (configOrChildren.length === 0) {
        throw new Error("step() requires at least one step");
      }
      this.#id = `_step_${stepCounter++}`;
      this.#kind = (second as CompositeKind | undefined) ?? "sequential";
      this.config = {} as StepConfig<O>;
      this.outputs = {} as { [K in O]: ExpressionValue };
      this.children = Object.freeze([...configOrChildren] as StepLike[]);
      return;
    }

    this.#kind = "sequential";
    const crossJobDeps = second as readonly Step<string>[] | undefined;
    const config = configOrChildren as StepConfig<O>;
    if (config.outputs?.length && !config.id) {
      throw new Error(
        "Step with outputs must have an explicit id",
      );
    }
    assertStepShape(config);

    this.#id = config.id ?? `_step_${stepCounter++}`;
    this.config = config;

    const self = this as unknown as Step<string>;
    if (crossJobDeps != null) {
      // kept by reference (not copied) so entries appended after this step was
      // created — an artifact uploaded later in the file, say — are still seen
      crossJobDepsByStep.set(self, crossJobDeps);
    }
    // register here rather than only in stepFromConfig so that every route to a
    // step — including `new Step(config)` — agrees on one step per config object
    if (!stepsByConfig.has(config)) {
      stepsByConfig.set(config, self);
    }

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

  /** The explicit `config.id`, or a generated internal id. */
  get id(): string {
    return this.#id;
  }

  /** Whether this composite's children run sequentially or in parallel. */
  get kind(): CompositeKind {
    return this.#kind;
  }

  /** Orders this step after `deps`, pulling them into the job if absent. */
  dependsOn(...deps: StepLike[]): StepRef<O> {
    return new StepRef(this, { dependencies: deps });
  }

  /** Orders this step after `deps`, but only those already in the job. */
  comesAfter(...deps: StepLike[]): StepRef<O> {
    return new StepRef(this, { afterDependencies: deps });
  }

  /** Applies a condition to this usage of the step. */
  if(condition: ConditionLike): StepRef<O> {
    return new StepRef(this, { condition });
  }

  /**
   * Serializes this step to its YAML object form. `effectiveIf` overrides
   * `config.if` with the condition resolved by the job's dependency graph.
   */
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

    if (this.config.background) {
      result.background = true;
    }

    if (this.config.wait != null) {
      const refs = Array.isArray(this.config.wait)
        ? this.config.wait
        : [this.config.wait];
      const ids = [...new Set(refs.map(waitCancelTargetId))];
      result.wait = ids.length === 1 ? ids[0] : ids;
    }

    if (this.config.waitAll) {
      result["wait-all"] = null;
    }

    if (this.config.cancel != null) {
      result.cancel = waitCancelTargetId(this.config.cancel);
    }

    return result;
  }
}

// --- StepBuilder: prefix API for conditions/deps before step config ---

export interface StepBuilder {
  <const O extends string = never>(
    ...args: (StepConfig<O> | Step<string> | StepRef<string>)[]
  ): StepRef<O>;
  if(condition: ConditionLike): StepBuilder;
  dependsOn(...deps: StepLike[]): StepBuilder;
  comesAfter(...deps: StepLike[]): StepBuilder;
  /** Builds a parallel group from the args, carrying this builder's deps/condition. */
  parallel(
    ...args: (StepConfig | Step<string> | StepRef<string>)[]
  ): StepRef<string>;
}

interface StepBuilderInit {
  condition?: ConditionLike;
  dependencies?: readonly StepLike[];
  afterDependencies?: readonly StepLike[];
}

function buildStepFromArgs(...args: unknown[]): Step<string> {
  if (args.length === 0) {
    throw new Error("step() requires at least one argument");
  }
  if (args.length === 1) {
    const arg = args[0];
    if (arg instanceof Step) {
      return arg;
    }
    if (arg instanceof StepRef) {
      // wrap in a composite so flattenStepLike will see the StepRef's
      // condition/deps/afterDeps (unwrapping to arg.step would discard them)
      return new Step([arg]);
    }
    return stepFromConfig(arg as StepConfig);
  }
  return new Step(args.map((item) => normalizeStepLike(item as StepLike)));
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

  builder.dependsOn = (...deps: StepLike[]): StepBuilder => {
    return createStepBuilder({
      ...init,
      dependencies: [...(init.dependencies ?? []), ...deps],
    });
  };

  builder.comesAfter = (...deps: StepLike[]): StepBuilder => {
    return createStepBuilder({
      ...init,
      afterDependencies: [...(init.afterDependencies ?? []), ...deps],
    });
  };

  builder.parallel = (...args: unknown[]): StepRef<string> => {
    return new StepRef(buildParallelFromArgs(...args), {
      condition: init.condition,
      dependencies: init.dependencies ?? [],
      afterDependencies: init.afterDependencies ?? [],
    });
  };

  return builder;
}

// --- step function with prefix builder methods ---

export interface StepFunction {
  <const O extends string = never>(
    ...args: (StepConfig<O> | Step<string> | StepRef<string>)[]
  ): Step<O>;
  if(condition: ConditionLike): StepBuilder;
  dependsOn(...deps: StepLike[]): StepBuilder;
  comesAfter(...deps: StepLike[]): StepBuilder;
  /**
   * Groups steps into a parallel block. The steps run concurrently and
   * serialize to a GitHub Actions `parallel:` block. Shared dependencies
   * (pulled in via `dependsOn`) are hoisted to run before the block.
   */
  parallel(
    ...args: (StepConfig | Step<string> | StepRef<string>)[]
  ): Step<string>;
  /**
   * Creates a `wait` step that blocks until the given background step(s)
   * finish. The referenced steps are ordered before this one and must each be
   * a background step with an explicit `id`.
   */
  waitFor(...steps: (Step<string> | StepRef<string>)[]): StepRef<string>;
  /** Creates a `wait-all` step that blocks until all background steps finish. */
  waitForAll(): Step<string>;
  /**
   * Creates a `cancel` step that terminates the given background step. The
   * referenced step is ordered before this one and must be a background step
   * with an explicit `id`.
   */
  cancel(target: Step<string> | StepRef<string>): StepRef<string>;
}

export const step: StepFunction = Object.assign(
  buildStepFromArgs as StepFunction,
  {
    if: (condition: ConditionLike): StepBuilder =>
      createStepBuilder({ condition }),
    dependsOn: (...deps: StepLike[]): StepBuilder =>
      createStepBuilder({ dependencies: deps }),
    comesAfter: (...deps: StepLike[]): StepBuilder =>
      createStepBuilder({ afterDependencies: deps }),
    parallel: (...args: unknown[]): Step<string> =>
      buildParallelFromArgs(...args),
    waitFor: (...steps: (Step<string> | StepRef<string>)[]): StepRef<string> =>
      buildWaitFor(...steps),
    waitForAll: (): Step<string> => new Step<string>({ waitAll: true }),
    cancel: (target: Step<string> | StepRef<string>): StepRef<string> =>
      buildCancel(target),
  },
);

/** Builds a `wait` step that depends on (and orders after) its targets. */
function buildWaitFor(
  ...steps: (Step<string> | StepRef<string>)[]
): StepRef<string> {
  if (steps.length === 0) {
    throw new Error("step.waitFor() requires at least one step");
  }
  for (const s of steps) {
    assertWaitCancelTarget(s, "step.waitFor()", "each referenced step");
  }
  // keep the original Step/StepRef so the target's own deps are preserved
  return new StepRef<string>(new Step<string>({ wait: steps }), {
    dependencies: steps,
  });
}

/** Builds a `cancel` step that depends on (and orders after) its target. */
function buildCancel(target: Step<string> | StepRef<string>): StepRef<string> {
  assertWaitCancelTarget(target, "step.cancel()", "the referenced step");
  return new StepRef<string>(new Step<string>({ cancel: target }), {
    dependencies: [target],
  });
}

/** Validates a `waitFor`/`cancel` target: a background step with an explicit id. */
function assertWaitCancelTarget(
  target: Step<string> | StepRef<string>,
  call: string,
  subject: string,
): void {
  const step = unwrapStep(target);
  if (!step.config.id) {
    throw new Error(`${call} requires ${subject} to have an explicit id`);
  }
  if (!step.config.background) {
    throw new Error(`${call} can only target a background step`);
  }
}

/** Builds a parallel composite step from the given args. */
function buildParallelFromArgs(...args: unknown[]): Step<string> {
  if (args.length === 0) {
    throw new Error("step.parallel() requires at least one argument");
  }
  const children = args.map((item) => normalizeStepLike(item as StepLike));
  return new Step(children, "parallel");
}

// --- StepRef: immutable wrapper for per-usage deps/conditions ---

/**
 * One usage of a {@link Step} within a job, carrying the modifiers applied at
 * that usage. Modifier methods return a new StepRef rather than mutating, so a
 * step can appear in several places with different conditions and dependencies.
 */
export class StepRef<O extends string = never> {
  /** The step this reference wraps. */
  readonly step: Step<O>;
  /** The condition applied to this usage, ANDed with the step's own `if`. */
  readonly condition?: ConditionLike;
  /** Steps ordered before this usage, pulled into the job if absent. */
  readonly dependencies: readonly StepLike[];
  /** Steps ordered before this usage, but only those already in the job. */
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

  /** The wrapped step's id. */
  get id(): string {
    return this.step.id;
  }

  /** The wrapped step's config. */
  get config(): StepConfig<O> {
    return this.step.config;
  }

  /** The wrapped step's typed output expressions. */
  get outputs(): { [K in O]: ExpressionValue } {
    return this.step.outputs;
  }

  /** Adds dependencies, pulling them into the job if absent. */
  dependsOn(...deps: StepLike[]): StepRef<O> {
    return new StepRef(this.step, {
      condition: this.condition,
      dependencies: [...this.dependencies, ...deps],
      afterDependencies: this.afterDependencies,
    });
  }

  /** Adds ordering-only dependencies on steps already in the job. */
  comesAfter(...deps: StepLike[]): StepRef<O> {
    return new StepRef(this.step, {
      condition: this.condition,
      dependencies: this.dependencies,
      afterDependencies: [...this.afterDependencies, ...deps],
    });
  }

  /** ANDs an additional condition onto this usage. */
  if(condition: ConditionLike): StepRef<O> {
    return new StepRef(this.step, {
      condition: andConditions(this.condition, condition),
      dependencies: this.dependencies,
      afterDependencies: this.afterDependencies,
    });
  }
}

// --- serialization helpers ---

/**
 * Validates that a step does not combine mutually exclusive control keys.
 * `wait`, `wait-all`, and `cancel` are distinct step kinds — each must stand
 * alone (a step that waits or cancels does no work of its own).
 */
function assertStepShape(config: StepConfig<string>): void {
  const controlKeys: string[] = [];
  if (config.wait != null) {
    if (Array.isArray(config.wait) && config.wait.length === 0) {
      throw new Error("A wait step must reference at least one step.");
    }
    controlKeys.push("wait");
  }
  if (config.waitAll) controlKeys.push("wait-all");
  if (config.cancel != null) controlKeys.push("cancel");
  if (controlKeys.length > 1) {
    throw new Error(
      `A step cannot combine ${controlKeys.join(", ")} — ` +
        "wait, wait-all, and cancel are mutually exclusive.",
    );
  }
  if (controlKeys.length === 1) {
    const work: string[] = [];
    if (config.run != null) work.push("run");
    if (config.uses != null) work.push("uses");
    if (config.background) work.push("background");
    if (work.length > 0) {
      throw new Error(
        `A ${controlKeys[0]} step cannot also have ${work.join(", ")}.`,
      );
    }
  }
}

/** Resolves the explicit id of a step referenced by `wait`/`cancel`. */
function waitCancelTargetId(item: StepLike): string {
  const step = unwrapStep(item);
  if (!step.config.id) {
    throw new Error(
      "a step referenced by `wait` or `cancel` must have an explicit id",
    );
  }
  return step.config.id;
}

/** Renders a condition as the raw expression text used in an `if` field. */
export function serializeConditionLike(c: ConditionLike): string {
  if (c instanceof Condition) {
    return c.toExpression();
  } else if (c instanceof ExpressionValue) {
    return c.expression;
  } else {
    return c;
  }
}

/** Converts a ConditionLike to a Condition, preserving its expression sources. */
export function toCondition(c: ConditionLike): Condition {
  if (c instanceof Condition) return c;
  if (c instanceof ExpressionValue) {
    return new RawCondition(c.expression, sourcesFrom(c));
  }
  return new RawCondition(c, new Set());
}

/** Serializes a `with`/`env` map, wrapping expressions in `${{ }}`. */
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

/** Normalizes a StepLike to a Step or StepRef, auto-wrapping plain objects. */
export function normalizeStepLike(
  item: StepLike,
): Step<string> | StepRef<string> {
  if (item instanceof Step || item instanceof StepRef) return item;
  return stepFromConfig(item);
}

/** Extracts the underlying Step from a StepLike (Step or StepRef). */
export function unwrapStep(item: StepLike): Step<string> {
  const normalized = normalizeStepLike(item);
  return normalized instanceof StepRef ? normalized.step : normalized;
}

/** Extracts all underlying leaf Steps from a StepLike (recursively for composites). */
export function unwrapSteps(item: StepLike): Step<string>[] {
  const s = unwrapStep(item);
  if (s.children.length > 0) {
    return s.children.flatMap(unwrapSteps);
  }
  return [s];
}

/**
 * Returns the cross-job step references a step was created with, used to infer
 * job `needs` — an artifact download referencing its uploads, for example.
 *
 * Resolved on each call rather than captured at construction, so steps
 * registered after this one was created are still picked up. The returned array
 * is a copy; the underlying list stays owned by whoever registered it.
 */
export function crossJobDepsOf(step: Step<string>): readonly Step<string>[] {
  const deps = crossJobDepsByStep.get(step);
  return deps == null ? EMPTY_STEPS : [...deps];
}

/**
 * Returns the Step for a plain config object, creating it on first use.
 *
 * The mapping is memoized so that a config object used in more than one place —
 * listed in `steps` and also passed to `dependsOn`, say — always resolves to the
 * same Step. Steps are identified by object identity when the job's dependency
 * graph is built, so creating a fresh Step per use would emit duplicates and
 * silently drop ordering edges.
 */
function stepFromConfig(config: StepConfig): Step<string> {
  // the Step constructor registers itself, so constructing is enough to memoize
  return stepsByConfig.get(config) ?? new Step(config);
}
