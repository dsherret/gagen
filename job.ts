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
  StepGroup,
  type StepLike,
  toCondition,
} from "./step.ts";

interface CommonJobFields {
  name?: string | ExpressionValue;
  needs?: Job[];
  if?: ConditionLike;
  permissions?: Permissions;
  concurrency?: { group: string; cancelInProgress?: boolean | string };
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
}

export interface ReusableJobConfig extends CommonJobFields {
  uses: string;
  with?: Record<string, ConfigValue>;
  secrets?: "inherit" | Record<string, ConfigValue>;
}

export type JobConfig = StepsJobConfig | ReusableJobConfig;

export class Job implements ExpressionSource {
  readonly _id: string;
  readonly config: JobConfig;
  readonly leafSteps: Step<string>[] = [];
  readonly outputDefs: Record<string, ExpressionValue> = {};
  readonly outputs: Record<string, ExpressionValue> = {};
  #globalCondition?: Condition;

  constructor(id: string, config: JobConfig) {
    this._id = id;
    this.config = config;
  }

  withGlobalCondition(condition: ConditionLike): this {
    if ("uses" in this.config) {
      throw new Error("Cannot set global condition on a reusable workflow job");
    }
    this.#globalCondition = toCondition(condition);
    return this;
  }

  withSteps(...steps: StepLike[]): this {
    if ("uses" in this.config) {
      throw new Error("Cannot add steps to a reusable workflow job");
    }
    for (const s of steps) {
      if (s instanceof StepGroup) {
        this.leafSteps.push(...s.all);
      } else {
        this.leafSteps.push(s);
      }
    }
    return this;
  }

  withOutputs(defs: Record<string, ExpressionValue>): this {
    if ("uses" in this.config) {
      throw new Error("Cannot add outputs to a reusable workflow job");
    }
    for (const [name, stepOutput] of Object.entries(defs)) {
      this.outputDefs[name] = stepOutput;
      this.outputs[name] = new ExpressionValue(
        `needs.${this._id}.outputs.${name}`,
        this,
      );
    }
    return this;
  }

  resolveSteps(): Step<string>[] {
    // collect all reachable steps from leaves
    const allSteps = new Set<Step<string>>();
    const collect = (s: Step<string>) => {
      if (allSteps.has(s)) return;
      allSteps.add(s);
      for (const dep of s.dependencies) {
        collect(dep);
      }
      // also collect steps referenced in if-conditions
      if (s.config.if instanceof Condition) {
        for (const source of s.config.if.sources) {
          if (source instanceof Step) {
            collect(source as Step<string>);
          }
        }
      }
    };
    for (const leaf of this.leafSteps) {
      collect(leaf);
    }

    // compute priority: each step gets the minimum leaf index of any
    // leaf step that transitively depends on it (directly or via
    // condition sources). This makes the topo sort respect withSteps order.
    const priority = new Map<Step<string>, number>();
    const assignPriority = (s: Step<string>, p: number) => {
      const current = priority.get(s);
      if (current !== undefined && current <= p) return;
      priority.set(s, p);
      for (const dep of s.dependencies) {
        if (allSteps.has(dep)) {
          assignPriority(dep, p);
        }
      }
      if (s.config.if instanceof Condition) {
        for (const source of s.config.if.sources) {
          if (source instanceof Step && allSteps.has(source as Step<string>)) {
            assignPriority(source as Step<string>, p);
          }
        }
      }
    };
    for (let i = 0; i < this.leafSteps.length; i++) {
      assignPriority(this.leafSteps[i], i);
    }

    const sorted = topoSort(allSteps, priority);
    // set job reference on each resolved step for cross-job needs inference
    for (const s of sorted) {
      s._job = this;
    }
    return sorted;
  }

  inferNeeds(): Job[] {
    const jobSources = new Set<Job>();

    // explicit needs
    if (this.config.needs) {
      for (const j of this.config.needs) jobSources.add(j);
    }

    // collect from job-level if
    collectJobSources(this.config.if, jobSources);

    if ("uses" in this.config) {
      // reusable workflow job — collect from with/secrets
      if (this.config.with) {
        for (const value of Object.values(this.config.with)) {
          collectJobSources(value, jobSources);
        }
      }
      if (this.config.secrets && this.config.secrets !== "inherit") {
        for (const value of Object.values(this.config.secrets)) {
          collectJobSources(value, jobSources);
        }
      }
    } else {
      // steps job — collect from env, runsOn, environment, strategy, steps
      if (this.config.env) {
        for (const value of Object.values(this.config.env)) {
          collectJobSources(value, jobSources);
        }
      }

      collectJobSources(this.config.runsOn, jobSources);
      collectJobSources(this.config.environment, jobSources);

      if (this.config.strategy?.failFast != null) {
        collectJobSources(this.config.strategy.failFast, jobSources);
      }

      // collect from all step configs
      for (const s of this.leafSteps) {
        collectJobSourcesFromStep(s, jobSources);
      }
    }

    // filter out self-references (can happen with cross-job deps in the same job)
    return [...jobSources].filter((j) => j !== this);
  }

  toYaml(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (this.config.name != null) {
      result.name = this.config.name instanceof ExpressionValue
        ? this.config.name.toString()
        : this.config.name;
    }

    const needs = this.inferNeeds();
    if (needs.length > 0) {
      result.needs = needs.map((j) => j._id);
    }

    if (this.config.if != null) {
      result.if = serializeConditionLike(this.config.if);
    }

    if ("uses" in this.config) {
      // reusable workflow job
      if (this.config.permissions != null) {
        result.permissions = this.config.permissions;
      }

      if (this.config.concurrency != null) {
        const c: Record<string, unknown> = {
          group: this.config.concurrency.group,
        };
        if (this.config.concurrency.cancelInProgress != null) {
          c["cancel-in-progress"] = this.config.concurrency.cancelInProgress;
        }
        result.concurrency = c;
      }

      result.uses = this.config.uses;

      if (this.config.with != null) {
        result.with = serializeConfigValues(this.config.with);
      }

      if (this.config.secrets != null) {
        result.secrets = this.config.secrets === "inherit"
          ? "inherit"
          : serializeConfigValues(this.config.secrets);
      }

      return result;
    }

    // steps-based job
    result["runs-on"] = this.config.runsOn instanceof ExpressionValue
      ? this.config.runsOn.toString()
      : this.config.runsOn;

    if (this.config.permissions != null) {
      result.permissions = this.config.permissions;
    }

    if (this.config.environment != null) {
      result.environment = serializeEnvironment(this.config.environment);
    }

    if (this.config.concurrency != null) {
      const c: Record<string, unknown> = {
        group: this.config.concurrency.group,
      };
      if (this.config.concurrency.cancelInProgress != null) {
        c["cancel-in-progress"] = this.config.concurrency.cancelInProgress;
      }
      result.concurrency = c;
    }

    if (this.config.timeoutMinutes != null) {
      result["timeout-minutes"] = this.config.timeoutMinutes;
    }

    if (this.config.defaults != null) {
      const d: Record<string, unknown> = {};
      if (this.config.defaults.run) {
        const run: Record<string, unknown> = {};
        if (this.config.defaults.run.shell != null) {
          run.shell = this.config.defaults.run.shell;
        }
        if (this.config.defaults.run.workingDirectory != null) {
          run["working-directory"] = this.config.defaults.run.workingDirectory;
        }
        d.run = run;
      }
      result.defaults = d;
    }

    if (this.config.strategy != null) {
      const s: Record<string, unknown> = {};
      if (this.config.strategy.matrix != null) {
        s.matrix = this.config.strategy.matrix instanceof Matrix
          ? this.config.strategy.matrix.toYaml()
          : this.config.strategy.matrix;
      }
      if (this.config.strategy.failFast != null) {
        const ff = this.config.strategy.failFast;
        s["fail-fast"] = typeof ff === "boolean"
          ? ff
          : serializeConditionLike(ff);
      }
      if (this.config.strategy.maxParallel != null) {
        s["max-parallel"] = this.config.strategy.maxParallel;
      }
      result.strategy = s;
    }

    if (this.config.env != null) {
      const env: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(this.config.env)) {
        env[key] = value instanceof ExpressionValue
          ? value.toString()
          : value;
      }
      result.env = env;
    }

    // outputs
    if (Object.keys(this.outputDefs).length > 0) {
      const outputs: Record<string, string> = {};
      for (const [name, exprValue] of Object.entries(this.outputDefs)) {
        outputs[name] = exprValue.toString();
      }
      result.outputs = outputs;
    }

    // steps
    const resolvedSteps = this.resolveSteps();
    const effectiveConditions = computeEffectiveConditions(
      resolvedSteps,
      this.leafSteps,
    );
    result.steps = resolvedSteps.map((s) => {
      let effective = effectiveConditions.get(s);
      if (this.#globalCondition != null) {
        effective = effective != null
          ? deduplicateAndTerms(this.#globalCondition.and(effective))
          : this.#globalCondition;
      }
      return s.toYaml(effective);
    });

    return result;
  }
}

// --- condition propagation ---

function computeEffectiveConditions(
  sortedSteps: Step<string>[],
  leafSteps: Step<string>[],
): Map<Step<string>, Condition | undefined> {
  const posMap = new Map<Step<string>, number>();
  for (let i = 0; i < sortedSteps.length; i++) {
    posMap.set(sortedSteps[i], i);
  }

  // build dependents map: for each step, which steps depend on it
  const dependents = new Map<Step<string>, Set<Step<string>>>();
  const addDependent = (dep: Step<string>, s: Step<string>) => {
    let set = dependents.get(dep);
    if (!set) {
      set = new Set();
      dependents.set(dep, set);
    }
    set.add(s);
  };
  for (const s of sortedSteps) {
    for (const dep of s.dependencies) {
      if (posMap.has(dep)) {
        addDependent(dep, s);
      }
    }
    // condition-inferred dependencies (matches topo sort edges)
    if (s.config.if instanceof Condition) {
      for (const source of s.config.if.sources) {
        if (source instanceof Step && posMap.has(source as Step<string>)) {
          addDependent(source as Step<string>, s);
        }
      }
    }
  }

  // steps explicitly passed to withSteps should not receive propagated
  // conditions — the user declared them directly, so they keep their own if
  const leafSet = new Set<Step<string>>(leafSteps);

  // compute effective conditions in reverse topo order
  const effective = new Map<Step<string>, Condition | undefined>();

  for (let i = sortedSteps.length - 1; i >= 0; i--) {
    const s = sortedSteps[i];
    const ownIf = s.config.if != null ? toCondition(s.config.if) : undefined;

    if (leafSet.has(s)) {
      // explicitly added by user — no propagation
      effective.set(s, ownIf);
      continue;
    }

    const deps = dependents.get(s);
    if (!deps || deps.size === 0) {
      effective.set(s, ownIf);
      continue;
    }

    // collect propagatable conditions from dependents
    const depConditions: Condition[] = [];
    let mustAlwaysRun = false;

    for (const d of deps) {
      const dEffective = effective.get(d);

      if (dEffective == null) {
        // dependent has no effective condition — step must always run
        mustAlwaysRun = true;
        break;
      }

      // check if the condition can propagate to this position
      if (!canPropagateTo(dEffective, i, posMap)) {
        // condition references steps at or after this position
        mustAlwaysRun = true;
        break;
      }

      depConditions.push(dEffective);
    }

    const propagated = mustAlwaysRun
      ? undefined
      : simplifyOrConditions(depConditions);

    if (mustAlwaysRun) {
      effective.set(s, ownIf);
    } else if (propagated != null && ownIf != null) {
      effective.set(s, deduplicateAndTerms(propagated.and(ownIf)));
    } else {
      effective.set(s, propagated ?? ownIf);
    }
  }

  return effective;
}

// a condition can propagate backward to a step at targetPos only if none of
// the condition's Step sources are at or after that position
function canPropagateTo(
  condition: Condition,
  targetPos: number,
  posMap: Map<Step<string>, number>,
): boolean {
  for (const source of condition.sources) {
    if (source instanceof Step) {
      const pos = posMap.get(source as Step<string>);
      if (pos !== undefined && pos >= targetPos) {
        return false;
      }
    }
  }
  return true;
}

// --- condition simplification ---

/**
 * Simplifies an array of conditions that will be OR'd together:
 * 1. Deduplicates identical conditions (by expression string)
 * 2. Deduplicates AND-terms within each condition (A && B && A → A && B)
 * 3. Complement elimination: A && X || A && !X → A (with inline OR-flattening)
 * 4. Absorption: A || (A && B) → A
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

/** Checks whether two expression strings are boolean complements (!X vs X). */
function areComplements(a: string, b: string): boolean {
  return a === `!${b}` || a === `!(${b})` ||
    b === `!${a}` || b === `!(${a})`;
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

// --- topological sort ---

function topoSort(
  steps: Set<Step<string>>,
  priority: Map<Step<string>, number>,
): Step<string>[] {
  // build in-degree map (only counting unique predecessors within our set)
  const inDegree = new Map<Step<string>, number>();
  for (const s of steps) {
    const predecessors = new Set<Step<string>>();
    for (const dep of s.dependencies) {
      if (steps.has(dep)) {
        predecessors.add(dep);
      }
    }
    // also count condition-inferred deps (deduplicated via Set)
    if (s.config.if instanceof Condition) {
      for (const source of s.config.if.sources) {
        if (source instanceof Step && steps.has(source as Step<string>)) {
          predecessors.add(source as Step<string>);
        }
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

  // kahn's algorithm — process in priority order to respect withSteps ordering
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
      let isDependent = false;
      for (const dep of s.dependencies) {
        if (dep === current) {
          isDependent = true;
          break;
        }
      }
      // check condition sources too
      if (!isDependent && s.config.if instanceof Condition) {
        for (const source of s.config.if.sources) {
          if (source === current) {
            isDependent = true;
            break;
          }
        }
      }
      if (isDependent) {
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
    throw new Error("Cycle detected in step dependencies");
  }

  return result;
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

function collectJobSourcesFromStep(
  s: Step<string>,
  out: Set<Job>,
  visited = new Set<Step<string>>(),
): void {
  if (visited.has(s)) return;
  visited.add(s);
  collectJobSources(s.config.if, out);
  if (s.config.with) collectJobSources(s.config.with, out);
  if (s.config.env) collectJobSources(s.config.env, out);
  // check cross-job step dependencies (e.g., artifact download → upload)
  for (const dep of s._crossJobDeps) {
    if (dep._job instanceof Job) {
      out.add(dep._job);
    }
  }
  // walk dependencies recursively
  for (const dep of s.dependencies) {
    collectJobSourcesFromStep(dep, out, visited);
  }
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
    name: env.name instanceof ExpressionValue
      ? env.name.toString()
      : env.name,
  };
  if (env.url != null) result.url = env.url;
  return result;
}
