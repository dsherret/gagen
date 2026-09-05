import * as internal from "./internal.ts";
import { stringify } from "@std/yaml/stringify";
import {
  Job,
  job as jobFn,
  type JobDef,
  type JobDefaults,
  resolveJobId,
  serializeDefaults,
} from "./job.ts";
import type { Permissions } from "./permissions.ts";
import { type ConfigValue, serializeConfigValues, type Step } from "./step.ts";
import { type WriteOrLintOptions, writeOrLintYaml } from "./write.ts";
import fs from "node:fs";

/** An input declared by a `workflow_call` trigger. */
export interface WorkflowCallInput {
  type: "string" | "boolean" | "number";
  description?: string;
  required?: boolean;
  default?: string | boolean | number;
}

/** An output declared by a `workflow_call` trigger. */
export interface WorkflowCallOutput {
  description?: string;
  value: string;
}

/** A secret declared by a `workflow_call` trigger. */
export interface WorkflowCallSecret {
  description?: string;
  required?: boolean;
}

/** The `workflow_call` trigger, which makes a workflow reusable. */
export interface WorkflowCallTrigger {
  inputs?: Record<string, WorkflowCallInput>;
  outputs?: Record<string, WorkflowCallOutput>;
  secrets?: Record<string, WorkflowCallSecret>;
}

/**
 * The events a workflow runs on. Unknown events are passed through as-is, with
 * camelCased keys converted to their kebab-cased YAML form.
 */
export interface WorkflowTriggers {
  push?: {
    branches?: string[];
    branchesIgnore?: string[];
    tags?: string[];
    tagsIgnore?: string[];
    paths?: string[];
    pathsIgnore?: string[];
  };
  pull_request?: {
    branches?: string[];
    branchesIgnore?: string[];
    types?: string[];
    paths?: string[];
    pathsIgnore?: string[];
  };
  workflow_dispatch?: Record<string, unknown>;
  workflow_call?: WorkflowCallTrigger;
  schedule?: { cron: string }[];
  [key: string]: unknown;
}

/** A workflow definition. */
export interface WorkflowConfig {
  name: string;
  runName?: string;
  on: WorkflowTriggers | string[];
  permissions?: Permissions;
  concurrency?: { group: string; cancelInProgress?: boolean | string };
  env?: Record<string, ConfigValue>;
  defaults?: JobDefaults;
  jobs?: (JobDef | Job)[];
}

/**
 * A resolved workflow. Prefer the `workflow()` free function over constructing
 * this directly.
 */
export class Workflow {
  readonly #config: WorkflowConfig;
  readonly #jobs: Map<string, Job> = new Map<string, Job>();

  constructor(config: WorkflowConfig) {
    this.#config = config;
    if (config.jobs != null) {
      for (const jobOrDef of config.jobs) {
        let id: string;
        let resolved: Job;
        if (jobOrDef instanceof Job) {
          id = jobOrDef.id;
          resolved = jobOrDef;
        } else {
          id = resolveJobId(jobOrDef);
          resolved = jobFn(id, jobOrDef);
        }
        if (this.#jobs.has(id)) {
          throw new Error(`Duplicate job id: "${id}"`);
        }
        this.#jobs.set(id, resolved);
      }
    }
  }

  /** Serializes the workflow to GitHub Actions YAML. */
  toYamlString(options?: { header?: string }): string {
    const obj: Record<string, unknown> = {};

    obj.name = this.#config.name;

    if (this.#config.runName != null) {
      obj["run-name"] = this.#config.runName;
    }

    obj.on = Array.isArray(this.#config.on)
      ? this.#config.on
      : serializeTriggers(this.#config.on);

    if (this.#config.permissions != null) {
      obj.permissions = this.#config.permissions;
    }

    if (this.#config.concurrency != null) {
      const c: Record<string, unknown> = {
        group: this.#config.concurrency.group,
      };
      if (this.#config.concurrency.cancelInProgress != null) {
        c["cancel-in-progress"] = this.#config.concurrency.cancelInProgress;
      }
      obj.concurrency = c;
    }

    if (this.#config.env != null) {
      obj.env = serializeConfigValues(this.#config.env);
    }

    if (this.#config.defaults != null) {
      const defaults = serializeDefaults(this.#config.defaults);
      if (defaults != null) obj.defaults = defaults;
    }

    // pre-resolve all jobs and build step→job mapping for cross-job deps
    const stepOwners = new Map<Step<string>, Job[]>();
    for (const job of this.#jobs.values()) {
      for (const s of job[internal.resolveSteps]()) {
        let owners = stepOwners.get(s);
        if (!owners) {
          owners = [];
          stepOwners.set(s, owners);
        }
        owners.push(job);
      }
    }

    // jobs
    const jobs: Record<string, unknown> = {};
    for (const [id, job] of this.#jobs) {
      this.#assertNeedsAreInWorkflow(id, job, stepOwners);
      jobs[id] = job[internal.toYaml](stepOwners);
    }
    obj.jobs = jobs;

    const yaml = stringify(obj, {
      useAnchors: false,
      lineWidth: 10_000,
      compatMode: false,
    });

    const header = options?.header;
    return header ? `${header}\n\n${yaml}` : yaml;
  }

  /** Writes the workflow's YAML to a file. */
  writeToFile(path: string | URL, options?: { header?: string }): void {
    fs.writeFileSync(path, this.toYamlString(options));
  }

  /**
   * Writes the workflow's YAML to `options.filePath`, or with `--lint` verifies
   * the file there is up to date. See {@link writeOrLintYaml}.
   */
  writeOrLint(options: WriteOrLintOptions): void {
    writeOrLintYaml(this.toYamlString(options), options);
  }

  /**
   * Rejects a job whose `needs` (explicit or inferred) names a job id that is
   * not in this workflow. GitHub rejects such a workflow outright, so it is
   * better to fail here with a message naming both jobs.
   *
   * Only the id is compared, not the instance: job factories that rebuild an
   * equivalent `Job` per workflow are a normal way to share definitions, and
   * the emitted `needs` entry is correct as long as some job claims the id.
   */
  #assertNeedsAreInWorkflow(
    id: string,
    job: Job,
    stepOwners: Map<Step<string>, Job[]>,
  ): void {
    for (const dep of job[internal.inferNeeds](stepOwners)) {
      if (!this.#jobs.has(dep.id)) {
        throw new Error(
          `Job "${id}" depends on job "${dep.id}", which is not part of this workflow.`,
        );
      }
    }
  }
}

/** Creates a workflow from the given configuration. */
export function workflow(config: WorkflowConfig): Workflow {
  return new Workflow(config);
}

// --- trigger serialization ---

function serializeTriggers(
  triggers: WorkflowTriggers,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(triggers)) {
    if (value == null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      result[event] = serializeTriggerObject(
        event,
        value as Record<string, unknown>,
      );
    } else {
      result[event] = value;
    }
  }
  return result;
}

/**
 * Filter pairs GitHub rejects when both are present on the same event. Only one
 * of each pair may be used.
 */
const EXCLUSIVE_TRIGGER_FILTERS: readonly (readonly [string, string])[] = [
  ["branches", "branchesIgnore"],
  ["tags", "tagsIgnore"],
  ["paths", "pathsIgnore"],
];

function serializeTriggerObject(
  event: string,
  obj: Record<string, unknown>,
): Record<string, unknown> {
  for (const [filter, ignoreFilter] of EXCLUSIVE_TRIGGER_FILTERS) {
    if (obj[filter] != null && obj[ignoreFilter] != null) {
      throw new Error(
        `The "${event}" trigger cannot use both \`${filter}\` and ` +
          `\`${ignoreFilter}\` — GitHub allows only one of them.`,
      );
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    result[camelToKebab(key)] = value;
  }
  return result;
}

/** Converts a camelCased config key to its kebab-cased YAML form. */
function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
