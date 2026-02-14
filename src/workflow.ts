import process from "node:process";
import { parse } from "@std/yaml/parse";
import { stringify } from "@std/yaml/stringify";
import { ExpressionValue } from "./expression.ts";
import { Job, job as jobFn, type JobDef, resolveJobId } from "./job.ts";
import type { Permissions } from "./permissions.ts";
import type { ConfigValue, Step } from "./step.ts";
import fs from "node:fs";

export interface WorkflowCallInput {
  type: "string" | "boolean" | "number";
  description?: string;
  required?: boolean;
  default?: string | boolean | number;
}

export interface WorkflowCallOutput {
  description?: string;
  value: string;
}

export interface WorkflowCallSecret {
  description?: string;
  required?: boolean;
}

export interface WorkflowCallTrigger {
  inputs?: Record<string, WorkflowCallInput>;
  outputs?: Record<string, WorkflowCallOutput>;
  secrets?: Record<string, WorkflowCallSecret>;
}

export interface WorkflowTriggers {
  push?: {
    branches?: string[];
    tags?: string[];
    paths?: string[];
    pathsIgnore?: string[];
  };
  pull_request?: {
    branches?: string[];
    types?: string[];
    paths?: string[];
    pathsIgnore?: string[];
  };
  workflow_dispatch?: Record<string, unknown>;
  workflow_call?: WorkflowCallTrigger;
  schedule?: { cron: string }[];
  [key: string]: unknown;
}

export interface WorkflowConfig {
  name: string;
  runName?: string;
  on: WorkflowTriggers;
  permissions?: Permissions;
  concurrency?: { group: string; cancelInProgress?: boolean | string };
  env?: Record<string, ConfigValue>;
  defaults?: { run?: { shell?: string; workingDirectory?: string } };
  jobs?: (JobDef | Job)[];
}

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

  toYamlString(options?: { header?: string }): string {
    const obj: Record<string, unknown> = {};

    obj.name = this.#config.name;

    if (this.#config.runName != null) {
      obj["run-name"] = this.#config.runName;
    }

    obj.on = serializeTriggers(this.#config.on);

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
      const env: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(this.#config.env)) {
        env[key] = value instanceof ExpressionValue ? value.toString() : value;
      }
      obj.env = env;
    }

    if (this.#config.defaults != null) {
      const d: Record<string, unknown> = {};
      if (this.#config.defaults.run) {
        const run: Record<string, unknown> = {};
        if (this.#config.defaults.run.shell != null) {
          run.shell = this.#config.defaults.run.shell;
        }
        if (this.#config.defaults.run.workingDirectory != null) {
          run["working-directory"] = this.#config.defaults.run.workingDirectory;
        }
        d.run = run;
      }
      obj.defaults = d;
    }

    // pre-resolve all jobs and build step→job mapping for cross-job deps
    const stepOwners = new Map<Step<string>, Job[]>();
    for (const job of this.#jobs.values()) {
      for (const s of job.resolveSteps()) {
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
      jobs[id] = job.toYaml(stepOwners);
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

  writeToFile(path: string | URL, options?: { header?: string }): void {
    fs.writeFileSync(path, this.toYamlString(options));
  }

  writeOrLint(
    options: { filePath: URL; header?: string },
  ): void {
    const expected = this.toYamlString(options);

    if (isLinting) {
      const existing = fs.readFileSync(options.filePath, { encoding: "utf8" });
      const parsedExisting = parse(existing);
      const parsedExpected = parse(expected);

      if (
        JSON.stringify(parsedExisting) !== JSON.stringify(parsedExpected)
      ) {
        console.error(
          `Error: ${options.filePath} is out of date. Run without --lint to update.`,
        );
        process.exit(1);
      }
    } else {
      fs.writeFileSync(options.filePath, expected);
    }
  }
}

/** Gets if linting would occur when using `writeOrLint` on a workflow. */
export const isLinting: boolean = process.argv.includes("--lint");

export function createWorkflow(config: WorkflowConfig): Workflow {
  return new Workflow(config);
}

// --- trigger serialization ---

function serializeTriggers(
  triggers: WorkflowTriggers,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(triggers)) {
    if (value == null) continue;
    if (key === "pathsIgnore") {
      result["paths-ignore"] = value;
    } else if (typeof value === "object" && !Array.isArray(value)) {
      result[key] = serializeTriggerObject(
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function serializeTriggerObject(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    const yamlKey = key === "pathsIgnore" ? "paths-ignore" : key;
    result[yamlKey] = value;
  }
  return result;
}
