import {
  Condition,
  type ExpressionSource,
  ExpressionValue,
} from "./expression.ts";
import {
  type ConditionLike,
  type ConfigValue,
  serializeConditionLike,
  Step,
} from "./step.ts";

export interface JobConfig {
  name?: string;
  runsOn: string | ExpressionValue;
  needs?: Job[];
  if?: ConditionLike;
  strategy?: {
    matrix?: unknown;
    failFast?: boolean | ConditionLike;
    maxParallel?: number;
  };
  env?: Record<string, ConfigValue>;
  timeoutMinutes?: number;
  defaults?: { run?: { shell?: string; workingDirectory?: string } };
  permissions?: Record<string, string>;
  concurrency?: { group: string; cancelInProgress?: boolean | string };
  environment?:
    | { name: string | ExpressionValue; url?: string }
    | string
    | ExpressionValue;
}

export class Job implements ExpressionSource {
  readonly _id: string;
  readonly config: JobConfig;
  readonly leafSteps: Step<string>[] = [];
  readonly outputDefs: Record<string, ExpressionValue> = {};
  readonly outputs: Record<string, ExpressionValue> = {};

  constructor(id: string, config: JobConfig) {
    this._id = id;
    this.config = config;
  }

  withSteps(...steps: Step<string>[]): this {
    this.leafSteps.push(...steps);
    return this;
  }

  withOutputs(defs: Record<string, ExpressionValue>): this {
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

    return topoSort(allSteps);
  }

  inferNeeds(): Job[] {
    const jobSources = new Set<Job>();

    // explicit needs
    if (this.config.needs) {
      for (const j of this.config.needs) jobSources.add(j);
    }

    // collect from job-level if
    collectJobSources(this.config.if, jobSources);

    // collect from job-level env
    if (this.config.env) {
      for (const value of Object.values(this.config.env)) {
        collectJobSources(value, jobSources);
      }
    }

    // collect from job-level runsOn
    collectJobSources(this.config.runsOn, jobSources);

    // collect from job-level environment
    collectJobSources(this.config.environment, jobSources);

    // collect from strategy
    if (this.config.strategy?.failFast != null) {
      collectJobSources(this.config.strategy.failFast, jobSources);
    }

    // collect from all step configs
    for (const s of this.leafSteps) {
      collectJobSourcesFromStep(s, jobSources);
    }

    return [...jobSources];
  }

  toYaml(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (this.config.name != null) {
      result.name = this.config.name;
    }

    const needs = this.inferNeeds();
    if (needs.length > 0) {
      result.needs = needs.map((j) => j._id);
    }

    if (this.config.if != null) {
      result.if = serializeConditionLike(this.config.if);
    }

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
        s.matrix = this.config.strategy.matrix;
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
    result.steps = resolvedSteps.map((s) => s.toYaml());

    return result;
  }
}

// --- topological sort ---

function topoSort(steps: Set<Step<string>>): Step<string>[] {
  // build in-degree map (only counting edges within our set)
  const inDegree = new Map<Step<string>, number>();
  for (const s of steps) {
    if (!inDegree.has(s)) inDegree.set(s, 0);
    for (const dep of s.dependencies) {
      if (steps.has(dep)) {
        // dep is a prerequisite of s, so s has an incoming edge from dep
        inDegree.set(s, (inDegree.get(s) ?? 0) + 1);
      }
    }
    // also count condition-inferred deps
    if (s.config.if instanceof Condition) {
      for (const source of s.config.if.sources) {
        if (source instanceof Step && steps.has(source as Step<string>)) {
          inDegree.set(s, (inDegree.get(s) ?? 0) + 1);
        }
      }
    }
  }

  // kahn's algorithm — process in insertion order for stability
  const insertionOrder = [...steps];
  const queue: Step<string>[] = [];
  for (const s of insertionOrder) {
    if ((inDegree.get(s) ?? 0) === 0) {
      queue.push(s);
    }
  }

  const result: Step<string>[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    // for each step that depends on current, decrement in-degree
    for (const s of insertionOrder) {
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
          queue.push(s);
        }
      }
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
  } else if (value instanceof ExpressionValue && value.source instanceof Job) {
    out.add(value.source);
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
