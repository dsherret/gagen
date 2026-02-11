import {
  Condition,
  type ExpressionSource,
  ExpressionValue,
} from "./expression.ts";
import { Matrix } from "./matrix.ts";
import type { Permissions } from "./permissions.ts";
import {
  type ConditionLike,
  type ConfigValue,
  serializeConditionLike,
  serializeConfigValues,
  Step,
  type StepLike,
  StepRef,
  toCondition,
  unwrapSteps,
} from "./step.ts";

interface CommonJobFields {
  name?: string | ExpressionValue;
  needs?: Job[];
  if?: ConditionLike;
  permissions?: Permissions;
  concurrency?: { group: string; cancelInProgress?: boolean | string };
}

export interface ServiceContainer {
  image: string;
  credentials?: { username: string; password: string | ExpressionValue };
  env?: Record<string, ConfigValue>;
  ports?: string[];
  volumes?: string[];
  options?: string;
}

export interface StepsJobConfig extends CommonJobFields {
  runsOn: string | ExpressionValue;
  strategy?: {
    matrix?: unknown;
    failFast?: boolean | ConditionLike;
    maxParallel?: number;
  };
  env?: Record<string, ConfigValue>;
  timeoutMinutes?: number;
  defaults?: { run?: { shell?: string; workingDirectory?: string } };
  environment?:
    | { name: string | ExpressionValue; url?: string }
    | string
    | ExpressionValue;
  services?: Record<string, ServiceContainer>;
}

export interface ReusableJobConfig extends CommonJobFields {
  uses: string;
  with?: Record<string, ConfigValue>;
  secrets?: "inherit" | Record<string, ConfigValue>;
}

export type JobConfig = StepsJobConfig | ReusableJobConfig;

export interface StepsJobDef extends StepsJobConfig {
  id?: string;
  steps: StepLike | StepLike[];
  outputs?: Record<string, ExpressionValue>;
}

export interface ReusableJobDef extends ReusableJobConfig {
  id?: string;
}

export type JobDef = StepsJobDef | ReusableJobDef;

// --- per-job dependency graph ---

interface GraphEntry {
  deps: Set<Step<string>>;
  afterDeps: Set<Step<string>>;
  /** individual context conditions from each encounter (OR'd together later) */
  contexts: ConditionLike[];
  hasUnconditionalContext?: boolean;
}

function ensureEntry(
  graph: Map<Step<string>, GraphEntry>,
  step: Step<string>,
): GraphEntry {
  let entry = graph.get(step);
  if (!entry) {
    entry = { deps: new Set(), afterDeps: new Set(), contexts: [] };
    graph.set(step, entry);
  }
  return entry;
}

/**
 * Records a context condition for a graph entry. Contexts from multiple
 * encounters are collected and combined later (via combineContexts) to
 * properly factor out shared terms. An undefined context means
 * unconditional and dominates any condition.
 */
function applyContextCondition(
  entry: GraphEntry,
  context?: ConditionLike,
): void {
  if (entry.hasUnconditionalContext) return;
  if (context == null) {
    entry.contexts = [];
    entry.hasUnconditionalContext = true;
    return;
  }
  entry.contexts.push(context);
}

/**
 * Combines the collected context conditions for a graph entry into a single
 * condition. Factors out common AND-terms so that shared conditions (like
 * `!(matrix.skip)`) appear once rather than being duplicated in each OR branch.
 */
function combineContexts(entry: GraphEntry): Condition | undefined {
  if (entry.hasUnconditionalContext || entry.contexts.length === 0) {
    return undefined;
  }
  if (entry.contexts.length === 1) {
    return toCondition(entry.contexts[0]);
  }
  const conditions = entry.contexts.map((c) => toCondition(c));
  return simplifyOrConditions(conditions) ?? undefined;
}

/** ANDs two optional conditions together (for nesting StepRef conditions). */
function combineAndConditions(
  a?: ConditionLike,
  b?: ConditionLike,
): ConditionLike | undefined {
  if (a != null && b != null) return toCondition(a).and(toCondition(b));
  return a ?? b;
}

/**
 * Returns a step's config.if as a ConditionLike suitable for passing down
 * to dependencies, or undefined if it references step outputs (which would
 * create circular condition dependencies).
 */
function propagatableConfigIf(step: Step<string>): ConditionLike | undefined {
  const configIf = step.config.if;
  if (configIf == null) return undefined;
  if (configIf instanceof Condition) {
    for (const source of configIf.sources) {
      if (source instanceof Step) return undefined;
    }
  }
  if (configIf instanceof ExpressionValue) {
    for (const source of configIf.allSources) {
      if (source instanceof Step) return undefined;
    }
  }
  return configIf;
}

interface DeferredAfterDep {
  step: Step<string>;
  target: StepLike;
}

/**
 * Recursively flattens a StepLike tree into a flat graph of Steps with
 * per-job dependencies and conditions. Returns the leaf-level Steps that
 * were contributed, so parent composite steps can apply their modifiers.
 *
 * Context conditions are accumulated top-down via AND (nesting) and applied
 * at leaf steps via OR (multiple encounters from different paths).
 *
 * afterDependencies (comesAfter) are NOT flattened into the graph — they are
 * collected in `deferredAfterDeps` and resolved later, so that comesAfter
 * only adds ordering edges for steps already present in the graph.
 */
function flattenStepLike(
  item: StepLike,
  graph: Map<Step<string>, GraphEntry>,
  isLeaf: boolean,
  leafSteps: Step<string>[],
  deferredAfterDeps: DeferredAfterDep[],
  contextCondition?: ConditionLike,
): Step<string>[] {
  if (item instanceof StepRef) {
    const step = item.step as Step<string>;
    // AND this StepRef's condition with the parent context
    const newContext = combineAndConditions(contextCondition, item.condition);

    if (step.children.length > 0) {
      // StepRef wrapping composite step: recurse with combined context
      const contributed: Step<string>[] = [];
      for (const child of step.children) {
        contributed.push(
          ...flattenStepLike(
            child,
            graph,
            isLeaf,
            leafSteps,
            deferredAfterDeps,
            newContext,
          ),
        );
      }
      // compute aggregate dep context: newContext AND (OR of children's
      // config.ifs). If any child is unconditional, or the OR is a tautology,
      // just use newContext.
      let compositeDepsCtx: ConditionLike | undefined = newContext;
      if (item.dependencies.length > 0) {
        const childIfs: ConditionLike[] = [];
        let allConditional = true;
        for (const s of contributed) {
          const cif = propagatableConfigIf(s);
          if (cif == null) {
            allConditional = false;
            break;
          }
          childIfs.push(cif);
        }
        if (allConditional && childIfs.length > 0) {
          const orCond = simplifyOrConditions(
            childIfs.map((c) => toCondition(c)),
          );
          if (orCond != null) {
            compositeDepsCtx = combineAndConditions(newContext, orCond);
          }
        }
      }

      // apply deps once with aggregate context, add to all children's dep sets
      for (const dep of item.dependencies) {
        const depSteps = flattenStepLike(
          dep,
          graph,
          false,
          [],
          deferredAfterDeps,
          compositeDepsCtx,
        );
        for (const s of contributed) {
          const entry = graph.get(s)!;
          for (const ds of depSteps) entry.deps.add(ds);
        }
      }
      for (const s of contributed) {
        for (const dep of item.afterDependencies) {
          deferredAfterDeps.push({ step: s, target: dep });
        }
      }
      return contributed;
    }

    // StepRef wrapping leaf step
    const entry = ensureEntry(graph, step);
    if (isLeaf) leafSteps.push(step);
    applyContextCondition(entry, newContext);
    // include step's config.if in the dep context
    const depContext = combineAndConditions(
      newContext,
      propagatableConfigIf(step),
    );
    for (const dep of item.dependencies) {
      flattenDep(dep, entry.deps, graph, deferredAfterDeps, depContext);
    }
    for (const dep of item.afterDependencies) {
      deferredAfterDeps.push({ step, target: dep });
    }
    return [step];
  }

  // Step (leaf or composite)
  if (item.children.length > 0) {
    // composite step: recurse into children with same context
    const contributed: Step<string>[] = [];
    for (const child of item.children) {
      contributed.push(
        ...flattenStepLike(
          child,
          graph,
          isLeaf,
          leafSteps,
          deferredAfterDeps,
          contextCondition,
        ),
      );
    }
    return contributed;
  }

  // leaf step
  const entry = ensureEntry(graph, item);
  if (isLeaf) leafSteps.push(item);
  applyContextCondition(entry, contextCondition);
  return [item];
}

/** Flattens a dependency target into the graph and adds it to a dep set. */
function flattenDep(
  dep: StepLike,
  targetSet: Set<Step<string>>,
  graph: Map<Step<string>, GraphEntry>,
  deferredAfterDeps: DeferredAfterDep[],
  contextCondition?: ConditionLike,
): void {
  const steps = flattenStepLike(
    dep,
    graph,
    false,
    [],
    deferredAfterDeps,
    contextCondition,
  );
  for (const s of steps) {
    targetSet.add(s);
  }
}

/**
 * Adds condition-source steps as deps in the graph. Iterates until stable
 * because condition sources may bring in new steps whose own conditions
 * reference additional steps.
 */
function addConditionSourceDeps(
  graph: Map<Step<string>, GraphEntry>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [step, entry] of [...graph]) {
      for (const cond of [step.config.if, ...entry.contexts]) {
        if (!(cond instanceof Condition)) continue;
        for (const source of cond.sources) {
          if (!(source instanceof Step)) continue;
          const srcStep = source as Step<string>;
          if (!graph.has(srcStep)) {
            ensureEntry(graph, srcStep);
            changed = true;
          }
          entry.deps.add(srcStep);
        }
      }
    }
  }
}

// --- Job class ---

export class Job implements ExpressionSource {
  readonly #id: string;
  readonly #config: JobConfig;
  readonly #leafItems: StepLike[] = [];
  readonly #outputDefs: Record<string, ExpressionValue> = {};
  readonly outputs: Readonly<Record<string, ExpressionValue>> = {};

  // cached graph — built lazily
  #cachedGraph?: Map<Step<string>, GraphEntry>;
  #cachedLeafSteps?: Step<string>[];

  constructor(
    id: string,
    config: JobConfig,
    init?: {
      steps?: StepLike[];
      outputs?: Record<string, ExpressionValue>;
    },
  ) {
    this.#id = id;
    this.#config = config;

    if (init?.steps) {
      for (const s of init.steps) {
        this.#leafItems.push(s);
      }
    }

    if (init?.outputs) {
      const outputs = this.outputs as Record<string, ExpressionValue>;
      for (const [name, stepOutput] of Object.entries(init.outputs)) {
        this.#outputDefs[name] = stepOutput;
        outputs[name] = new ExpressionValue(
          `needs.${this.#id}.outputs.${name}`,
          this,
        );
      }
    }
  }

  get id(): string {
    return this.#id;
  }

  #buildGraph(): {
    graph: Map<Step<string>, GraphEntry>;
    leafSteps: Step<string>[];
  } {
    if (this.#cachedGraph && this.#cachedLeafSteps) {
      return { graph: this.#cachedGraph, leafSteps: this.#cachedLeafSteps };
    }

    const graph = new Map<Step<string>, GraphEntry>();
    const leafSteps: Step<string>[] = [];
    const deferredAfterDeps: DeferredAfterDep[] = [];

    for (const item of this.#leafItems) {
      flattenStepLike(item, graph, true, leafSteps, deferredAfterDeps);
    }

    addConditionSourceDeps(graph);

    // resolve deferred after-deps: only add ordering edges for steps
    // already present in the graph (comesAfter does not pull in steps)
    for (const { step, target } of deferredAfterDeps) {
      const entry = graph.get(step)!;
      for (const t of unwrapSteps(target)) {
        if (graph.has(t)) entry.afterDeps.add(t);
      }
    }

    this.#cachedGraph = graph;
    this.#cachedLeafSteps = leafSteps;
    return { graph, leafSteps };
  }

  resolveSteps(): Step<string>[] {
    const { graph, leafSteps } = this.#buildGraph();
    const allSteps = new Set(graph.keys());

    // compute priority: each step gets the minimum leaf index of any
    // leaf step that transitively depends on it (directly or via
    // condition sources). This makes the topo sort respect steps order.
    const priority = new Map<Step<string>, number>();
    const assignPriority = (s: Step<string>, p: number) => {
      const current = priority.get(s);
      if (current !== undefined && current <= p) return;
      priority.set(s, p);
      const entry = graph.get(s);
      if (!entry) return;
      for (const dep of entry.deps) {
        if (allSteps.has(dep)) {
          assignPriority(dep, p);
        }
      }
    };
    for (let i = 0; i < leafSteps.length; i++) {
      assignPriority(leafSteps[i], i);
    }

    return topoSort(allSteps, priority, graph);
  }

  inferNeeds(stepOwners?: Map<Step<string>, Job[]>): Job[] {
    const config = this.#config;
    const jobSources = new Set<Job>();

    // explicit needs
    if (config.needs) {
      for (const j of config.needs) jobSources.add(j);
    }

    // collect from job-level if
    collectJobSources(config.if, jobSources);

    if ("uses" in config) {
      // reusable workflow job — collect from with/secrets
      if (config.with) {
        for (const value of Object.values(config.with)) {
          collectJobSources(value, jobSources);
        }
      }
      if (config.secrets && config.secrets !== "inherit") {
        for (const value of Object.values(config.secrets)) {
          collectJobSources(value, jobSources);
        }
      }
    } else {
      // steps job — collect from env, runsOn, environment, strategy, steps
      if (config.env) {
        for (const value of Object.values(config.env)) {
          collectJobSources(value, jobSources);
        }
      }

      collectJobSources(config.runsOn, jobSources);
      collectJobSources(config.environment, jobSources);

      if (config.strategy?.failFast != null) {
        collectJobSources(config.strategy.failFast, jobSources);
      }

      // collect from all steps in the graph
      const { graph } = this.#buildGraph();
      collectJobSourcesFromGraph(graph, jobSources, stepOwners);
    }

    // filter out self-references (can happen with cross-job deps in the same job)
    return [...jobSources].filter((j) => j !== this);
  }

  toYaml(stepOwners?: Map<Step<string>, Job[]>): Record<string, unknown> {
    const config = this.#config;
    const result: Record<string, unknown> = {};

    if (config.name != null) {
      result.name = config.name instanceof ExpressionValue
        ? config.name.toString()
        : config.name;
    }

    const needs = this.inferNeeds(stepOwners);
    if (needs.length > 0) {
      result.needs = needs.map((j) => j.id);
    }

    if (config.if != null) {
      result.if = serializeConditionLike(config.if);
    }

    if ("uses" in config) {
      // reusable workflow job
      if (config.permissions != null) {
        result.permissions = config.permissions;
      }

      if (config.concurrency != null) {
        const c: Record<string, unknown> = {
          group: config.concurrency.group,
        };
        if (config.concurrency.cancelInProgress != null) {
          c["cancel-in-progress"] = config.concurrency.cancelInProgress;
        }
        result.concurrency = c;
      }

      result.uses = config.uses;

      if (config.with != null) {
        result.with = serializeConfigValues(config.with);
      }

      if (config.secrets != null) {
        result.secrets = config.secrets === "inherit"
          ? "inherit"
          : serializeConfigValues(config.secrets);
      }

      return result;
    }

    // steps-based job
    result["runs-on"] = config.runsOn instanceof ExpressionValue
      ? config.runsOn.toString()
      : config.runsOn;

    if (config.permissions != null) {
      result.permissions = config.permissions;
    }

    if (config.environment != null) {
      result.environment = serializeEnvironment(config.environment);
    }

    if (config.concurrency != null) {
      const c: Record<string, unknown> = {
        group: config.concurrency.group,
      };
      if (config.concurrency.cancelInProgress != null) {
        c["cancel-in-progress"] = config.concurrency.cancelInProgress;
      }
      result.concurrency = c;
    }

    if (config.timeoutMinutes != null) {
      result["timeout-minutes"] = config.timeoutMinutes;
    }

    if (config.defaults != null) {
      const d: Record<string, unknown> = {};
      if (config.defaults.run) {
        const run: Record<string, unknown> = {};
        if (config.defaults.run.shell != null) {
          run.shell = config.defaults.run.shell;
        }
        if (config.defaults.run.workingDirectory != null) {
          run["working-directory"] = config.defaults.run.workingDirectory;
        }
        d.run = run;
      }
      result.defaults = d;
    }

    if (config.strategy != null) {
      const s: Record<string, unknown> = {};
      if (config.strategy.matrix != null) {
        s.matrix = config.strategy.matrix instanceof Matrix
          ? config.strategy.matrix.toYaml()
          : config.strategy.matrix;
      }
      if (config.strategy.failFast != null) {
        const ff = config.strategy.failFast;
        s["fail-fast"] = typeof ff === "boolean" || typeof ff === "string"
          ? ff
          : ff.toString();
      }
      if (config.strategy.maxParallel != null) {
        s["max-parallel"] = config.strategy.maxParallel;
      }
      result.strategy = s;
    }

    if (config.env != null) {
      const env: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(config.env)) {
        env[key] = value instanceof ExpressionValue ? value.toString() : value;
      }
      result.env = env;
    }

    if (config.services != null) {
      const services: Record<string, unknown> = {};
      for (const [name, svc] of Object.entries(config.services)) {
        services[name] = serializeService(svc);
      }
      result.services = services;
    }

    // outputs
    if (Object.keys(this.#outputDefs).length > 0) {
      const outputs: Record<string, string> = {};
      for (const [name, exprValue] of Object.entries(this.#outputDefs)) {
        outputs[name] = exprValue.toString();
      }
      result.outputs = outputs;
    }

    // steps
    const { graph } = this.#buildGraph();
    const resolvedSteps = this.resolveSteps();
    const effectiveConditions = computeEffectiveConditions(
      resolvedSteps,
      graph,
    );
    result.steps = resolvedSteps.map((s) => {
      return s.toYaml(effectiveConditions.get(s));
    });

    return result;
  }
}

// --- effective conditions ---

/**
 * Computes effective conditions for all steps. Each step's effective condition
 * is the combination of its collected context conditions (OR'd together,
 * simplified) AND'd with its intrinsic config.if.
 *
 * Context conditions are collected during the tree walk — they flow DOWN
 * from parent groups and StepRef conditions through dependencies, so shared
 * top-level conditions like `!(matrix.skip)` naturally stay factored out.
 */
function computeEffectiveConditions(
  steps: Step<string>[],
  graph: Map<Step<string>, GraphEntry>,
): Map<Step<string>, Condition | undefined> {
  const effective = new Map<Step<string>, Condition | undefined>();
  for (const s of steps) {
    const entry = graph.get(s)!;
    const ctx = combineContexts(entry);
    const configIf = s.config.if != null ? toCondition(s.config.if) : undefined;
    if (ctx != null && configIf != null) {
      effective.set(s, deduplicateAndTerms(ctx.and(configIf)));
    } else {
      effective.set(s, ctx ?? configIf);
    }
  }
  return effective;
}

// --- condition simplification ---

/**
 * Simplifies an array of conditions that will be OR'd together:
 * 1. Deduplicates identical conditions (by expression string)
 * 2. Deduplicates AND-terms within each condition (A && B && A → A && B)
 * 3. Complement elimination: A && X || A && !X → A (with inline OR-flattening)
 * 4. Absorption: A || (A && B) → A
 * 5. Common factor extraction: (A && B) || (A && C) → A && (B || C)
 *
 * Note: OR-flattening is done inline during complement elimination (not upfront)
 * so that absorption can still match compound conditions against their parents.
 */
function simplifyOrConditions(
  conditions: Condition[],
): Condition | undefined {
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];

  // 1. dedup by expression string
  let terms = deduplicateConditions([...conditions]);
  if (terms.length <= 1) return terms[0];

  // 2. dedup AND-terms within each condition
  terms = terms.map(deduplicateAndTerms);

  // 3. complement elimination (iterative, with inline OR-flattening)
  terms = complementEliminate(terms);
  if (terms.length === 0) return undefined;
  if (terms.length === 1) return terms[0];

  // 4. dedup again after complement merges
  terms = deduplicateConditions(terms);
  if (terms.length <= 1) return terms[0];

  // 5. absorption: if A's AND-terms ⊆ B's AND-terms, B is redundant
  terms = applyAbsorption(terms);
  if (terms.length === 0) return undefined;
  if (terms.length === 1) return terms[0];

  // 6. common factor extraction: (A && B) || (A && C) → A && (B || C)
  const factored = extractCommonFactors(terms);
  if (factored != null) return factored;

  // OR the remaining conditions
  let result = terms[0];
  for (let i = 1; i < terms.length; i++) {
    result = result.or(terms[i]);
  }
  return result;
}

function deduplicateConditions(terms: Condition[]): Condition[] {
  const seen = new Set<string>();
  const unique: Condition[] = [];
  for (const c of terms) {
    const expr = c.toExpression();
    if (!seen.has(expr)) {
      seen.add(expr);
      unique.push(c);
    }
  }
  return unique;
}

/** Removes duplicate AND-terms within a single condition: A && B && A → A && B */
function deduplicateAndTerms(c: Condition): Condition {
  const children = c.flattenAnd();
  if (children.length <= 1) return c;

  const seen = new Set<string>();
  const unique: Condition[] = [];
  for (const child of children) {
    const expr = child.toExpression();
    if (!seen.has(expr)) {
      seen.add(expr);
      unique.push(child);
    }
  }

  if (unique.length === children.length) return c;

  let result = unique[0];
  for (let i = 1; i < unique.length; i++) {
    result = result.and(unique[i]);
  }
  return result;
}

/**
 * Iteratively merges OR-terms that differ in exactly one complementary
 * AND-term: (A && X) || (A && !X) → A
 */
function complementEliminate(terms: Condition[]): Condition[] {
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) {
        const merged = tryComplementMerge(terms[i], terms[j]);
        if (merged === "tautology") {
          // A || !A = always true → no condition needed
          return [];
        }
        if (merged !== undefined) {
          terms[i] = merged;
          terms.splice(j, 1);
          // re-flatten in case the merged result is an OR
          const flattened = terms[i].flattenOr();
          if (flattened.length > 1) {
            terms.splice(i, 1, ...flattened);
          }
          changed = true;
          break outer;
        }
      }
    }
  }
  return terms;
}

/**
 * Tries to merge two conditions that differ in exactly one complementary
 * AND-term. Returns the merged condition, "tautology" if the result is
 * always true, or undefined if they can't be merged.
 */
function tryComplementMerge(
  a: Condition,
  b: Condition,
): Condition | "tautology" | undefined {
  const aTerms = new Set(a.getAndTerms());
  const bTerms = new Set(b.getAndTerms());

  const aOnly: string[] = [];
  const common: string[] = [];
  for (const t of aTerms) {
    if (bTerms.has(t)) common.push(t);
    else aOnly.push(t);
  }
  const bOnly: string[] = [];
  for (const t of bTerms) {
    if (!aTerms.has(t)) bOnly.push(t);
  }

  if (aOnly.length !== 1 || bOnly.length !== 1) return undefined;
  if (!areComplements(aOnly[0], bOnly[0])) return undefined;

  if (common.length === 0) return "tautology";

  // reconstruct from a's AND-children, excluding the complementary term
  const aChildren = a.flattenAnd();
  const filtered = aChildren.filter((c) => c.toExpression() !== aOnly[0]);
  if (filtered.length === 0) return "tautology";

  let result = filtered[0];
  for (let i = 1; i < filtered.length; i++) {
    result = result.and(filtered[i]);
  }
  return result;
}

/** Checks whether two expression strings are boolean complements (!X vs X, or X == Y vs X != Y). */
function areComplements(a: string, b: string): boolean {
  if (
    a === `!${b}` || a === `!(${b})` ||
    b === `!${a}` || b === `!(${a})`
  ) {
    return true;
  }
  // check for `X == Y` vs `X != Y`
  const eqA = a.indexOf(" == ");
  const neA = a.indexOf(" != ");
  if (eqA !== -1) {
    return b === a.slice(0, eqA) + " != " + a.slice(eqA + 4);
  }
  if (neA !== -1) {
    return b === a.slice(0, neA) + " == " + a.slice(neA + 4);
  }
  return false;
}

function applyAbsorption(terms: Condition[]): Condition[] {
  const termSets = terms.map((c) => ({
    condition: c,
    terms: new Set(c.getAndTerms()),
  }));

  const absorbed = new Set<number>();
  for (let i = 0; i < termSets.length; i++) {
    if (absorbed.has(i)) continue;
    for (let j = 0; j < termSets.length; j++) {
      if (i === j || absorbed.has(j)) continue;
      if (
        termSets[i].terms.size <= termSets[j].terms.size &&
        isSubsetOf(termSets[i].terms, termSets[j].terms)
      ) {
        absorbed.add(j);
      }
    }
  }

  return termSets
    .filter((_, i) => !absorbed.has(i))
    .map(({ condition }) => condition);
}

function isSubsetOf(a: Set<string>, b: Set<string>): boolean {
  for (const term of a) {
    if (!b.has(term)) return false;
  }
  return true;
}

/**
 * Extracts AND-terms common to ALL OR branches (distributive law):
 * (A && B) || (A && C) → A && (B || C)
 */
function extractCommonFactors(terms: Condition[]): Condition | undefined {
  if (terms.length < 2) return undefined;

  // get AND-term string sets for each OR term
  const termSets = terms.map((t) => new Set(t.getAndTerms()));

  // intersect all sets to find common terms
  const common = new Set(termSets[0]);
  for (let i = 1; i < termSets.length; i++) {
    for (const t of common) {
      if (!termSets[i].has(t)) common.delete(t);
    }
  }

  if (common.size === 0) return undefined;

  // get common Condition objects from the first term's children
  const firstChildren = terms[0].flattenAnd();
  const commonConditions = firstChildren.filter((c) =>
    common.has(c.toExpression())
  );

  // build remainders for each OR term
  const remainders: Condition[] = [];
  for (const term of terms) {
    const children = term.flattenAnd();
    const filtered = children.filter((c) => !common.has(c.toExpression()));
    if (filtered.length === 0) {
      // branch is entirely common — whole expression = just common terms
      let result = commonConditions[0];
      for (let i = 1; i < commonConditions.length; i++) {
        result = result.and(commonConditions[i]);
      }
      return result;
    }
    let remainder = filtered[0];
    for (let i = 1; i < filtered.length; i++) {
      remainder = remainder.and(filtered[i]);
    }
    remainders.push(remainder);
  }

  // build: common1 && common2 && (remainder1 || remainder2 || ...)
  let result = commonConditions[0];
  for (let i = 1; i < commonConditions.length; i++) {
    result = result.and(commonConditions[i]);
  }

  let orPart = remainders[0];
  for (let i = 1; i < remainders.length; i++) {
    orPart = orPart.or(remainders[i]);
  }

  result = result.and(orPart);
  return result;
}

// --- topological sort ---

function topoSort(
  steps: Set<Step<string>>,
  priority: Map<Step<string>, number>,
  graph: Map<Step<string>, GraphEntry>,
): Step<string>[] {
  // build in-degree map (only counting unique predecessors within our set)
  const inDegree = new Map<Step<string>, number>();
  for (const s of steps) {
    const entry = graph.get(s)!;
    const predecessors = new Set<Step<string>>();
    for (const dep of entry.deps) {
      if (steps.has(dep)) {
        predecessors.add(dep);
      }
    }
    for (const dep of entry.afterDeps) {
      if (steps.has(dep)) {
        predecessors.add(dep);
      }
    }
    inDegree.set(s, predecessors.size);
  }

  // secondary tiebreaker: set iteration order (preserves DFS traversal order)
  const setOrder = new Map<Step<string>, number>();
  let idx = 0;
  for (const s of steps) {
    setOrder.set(s, idx++);
  }

  const cmp = (a: Step<string>, b: Step<string>): number => {
    const pa = priority.get(a) ?? Infinity;
    const pb = priority.get(b) ?? Infinity;
    if (pa !== pb) return pa - pb;
    return (setOrder.get(a) ?? 0) - (setOrder.get(b) ?? 0);
  };

  // kahn's algorithm — process in priority order to respect steps ordering
  const queue: Step<string>[] = [];
  for (const s of steps) {
    if ((inDegree.get(s) ?? 0) === 0) {
      queue.push(s);
    }
  }
  queue.sort(cmp);

  const allSteps = [...steps];
  const result: Step<string>[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    // for each step that depends on current, decrement in-degree
    const newlyFreed: Step<string>[] = [];
    for (const s of allSteps) {
      if (s === current) continue;
      const entry = graph.get(s)!;
      const isSuccessor = entry.deps.has(current) ||
        entry.afterDeps.has(current);
      if (isSuccessor) {
        const newDeg = (inDegree.get(s) ?? 0) - 1;
        inDegree.set(s, newDeg);
        if (newDeg === 0) {
          newlyFreed.push(s);
        }
      }
    }
    // insert newly freed steps into queue maintaining priority order
    for (const s of newlyFreed) {
      let insertAt = queue.length;
      for (let i = 0; i < queue.length; i++) {
        if (cmp(s, queue[i]) < 0) {
          insertAt = i;
          break;
        }
      }
      queue.splice(insertAt, 0, s);
    }
  }

  if (result.length !== steps.size) {
    // find and report the cycle path among remaining steps
    const remaining = new Set<Step<string>>();
    const resultSet = new Set(result);
    for (const s of steps) {
      if (!resultSet.has(s)) remaining.add(s);
    }

    const cyclePath = findCyclePath(remaining, graph);
    throw new Error(
      `Cycle detected in step ordering: ${
        cyclePath.map(stepLabel).join(" → ")
      }`,
    );
  }

  return result;
}

function stepLabel(s: Step<string>): string {
  return s.config.name ?? s.config.uses ?? s.id;
}

/** DFS on the remaining (unsorted) steps to find and return one cycle. */
function findCyclePath(
  remaining: Set<Step<string>>,
  graph: Map<Step<string>, GraphEntry>,
): Step<string>[] {
  // build successor map within remaining steps
  const successors = new Map<Step<string>, Step<string>[]>();
  for (const s of remaining) {
    successors.set(s, []);
  }
  for (const s of remaining) {
    const entry = graph.get(s)!;
    // deps: s depends on dep → dep is predecessor of s
    for (const dep of entry.deps) {
      if (remaining.has(dep)) {
        successors.get(dep)!.push(s);
      }
    }
    // afterDeps: s comesAfter dep → dep is predecessor of s
    for (const dep of entry.afterDeps) {
      if (remaining.has(dep)) {
        successors.get(dep)!.push(s);
      }
    }
  }

  // dfs to find cycle
  const visited = new Set<Step<string>>();
  const onStack = new Set<Step<string>>();
  const parent = new Map<Step<string>, Step<string>>();

  for (const start of remaining) {
    if (visited.has(start)) continue;
    const stack = [start];
    while (stack.length > 0) {
      const node = stack[stack.length - 1];
      if (!visited.has(node)) {
        visited.add(node);
        onStack.add(node);
      }
      let pushed = false;
      for (const succ of successors.get(node) ?? []) {
        if (!visited.has(succ)) {
          parent.set(succ, node);
          stack.push(succ);
          pushed = true;
          break;
        }
        if (onStack.has(succ)) {
          // found cycle — trace it back
          const cycle: Step<string>[] = [succ];
          let cur = node;
          while (cur !== succ) {
            cycle.push(cur);
            cur = parent.get(cur)!;
          }
          cycle.push(succ);
          cycle.reverse();
          return cycle;
        }
      }
      if (!pushed) {
        onStack.delete(node);
        stack.pop();
      }
    }
  }

  // fallback — shouldn't happen since we know there's a cycle
  return [...remaining];
}

// --- source collection helpers ---

function collectJobSources(value: unknown, out: Set<Job>): void {
  if (value instanceof Job) {
    out.add(value);
  } else if (value instanceof ExpressionValue) {
    for (const s of value.allSources) {
      if (s instanceof Job) out.add(s);
    }
  } else if (value instanceof Condition) {
    for (const source of value.sources) {
      if (source instanceof Job) {
        out.add(source);
      }
    }
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) {
      collectJobSources(v, out);
    }
  }
}

function collectJobSourcesFromGraph(
  graph: Map<Step<string>, GraphEntry>,
  out: Set<Job>,
  stepOwners?: Map<Step<string>, Job[]>,
): void {
  for (const [step, entry] of graph) {
    collectJobSources(step.config.if, out);
    for (const ctx of entry.contexts) {
      collectJobSources(ctx, out);
    }
    if (step.config.with) collectJobSources(step.config.with, out);
    if (step.config.env) collectJobSources(step.config.env, out);
    if (stepOwners) {
      for (const dep of step._crossJobDeps) {
        const owners = stepOwners.get(dep);
        if (owners) {
          for (const j of owners) out.add(j);
        }
      }
    }
  }
}

function serializeService(svc: ServiceContainer): Record<string, unknown> {
  const result: Record<string, unknown> = { image: svc.image };
  if (svc.credentials != null) {
    result.credentials = {
      username: svc.credentials.username,
      password: svc.credentials.password instanceof ExpressionValue
        ? svc.credentials.password.toString()
        : svc.credentials.password,
    };
  }
  if (svc.env != null) {
    result.env = serializeConfigValues(svc.env);
  }
  if (svc.ports != null) {
    result.ports = svc.ports;
  }
  if (svc.volumes != null) {
    result.volumes = svc.volumes;
  }
  if (svc.options != null) {
    result.options = svc.options;
  }
  return result;
}

function serializeEnvironment(
  env:
    | { name: string | ExpressionValue; url?: string }
    | string
    | ExpressionValue,
): unknown {
  if (typeof env === "string") return env;
  if (env instanceof ExpressionValue) return env.toString();
  const result: Record<string, unknown> = {
    name: env.name instanceof ExpressionValue ? env.name.toString() : env.name,
  };
  if (env.url != null) result.url = env.url;
  return result;
}

// --- helpers ---

export function toKebabCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolveJobId(def: JobDef): string {
  if (def.id != null) return def.id;
  if (def.name != null && typeof def.name === "string") {
    return toKebabCase(def.name);
  }
  throw new Error(
    "Job definition must have either an `id` or a string `name` to derive an ID from",
  );
}

// --- job() free function ---

export function job(id: string, config: JobDef): Job {
  if ("uses" in config) {
    const { id: _id, ...reusableConfig } = config;
    return new Job(id, reusableConfig);
  }
  const { id: _id, steps, outputs, ...jobConfig } = config;
  return new Job(id, jobConfig, {
    steps: Array.isArray(steps) ? steps : [steps],
    outputs,
  });
}
