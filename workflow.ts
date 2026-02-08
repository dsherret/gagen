import { stringify } from "jsr:@std/yaml/stringify";
import { ExpressionValue } from "./expression.ts";
import { Job, type JobConfig } from "./job.ts";
import type { ConfigValue } from "./step.ts";

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
  schedule?: { cron: string }[];
  [key: string]: unknown;
}

export interface WorkflowConfig {
  name: string;
  on: WorkflowTriggers;
  permissions?: Record<string, string>;
  concurrency?: { group: string; cancelInProgress?: boolean | string };
  env?: Record<string, ConfigValue>;
}

export class Workflow {
  readonly config: WorkflowConfig;
  readonly jobs: Map<string, Job> = new Map<string, Job>();

  constructor(config: WorkflowConfig) {
    this.config = config;
  }

  createJob(id: string, config: JobConfig): Job {
    if (this.jobs.has(id)) {
      throw new Error(`Duplicate job id: "${id}"`);
    }
    const job = new Job(id, config);
    this.jobs.set(id, job);
    return job;
  }

  toYamlString(options?: { header?: string }): string {
    const obj: Record<string, unknown> = {};

    obj.name = this.config.name;

    obj.on = serializeTriggers(this.config.on);

    if (this.config.permissions != null) {
      obj.permissions = this.config.permissions;
    }

    if (this.config.concurrency != null) {
      const c: Record<string, unknown> = {
        group: this.config.concurrency.group,
      };
      if (this.config.concurrency.cancelInProgress != null) {
        c["cancel-in-progress"] = this.config.concurrency.cancelInProgress;
      }
      obj.concurrency = c;
    }

    if (this.config.env != null) {
      const env: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(this.config.env)) {
        env[key] = value instanceof ExpressionValue
          ? value.toString()
          : value;
      }
      obj.env = env;
    }

    // jobs
    const jobs: Record<string, unknown> = {};
    for (const [id, job] of this.jobs) {
      jobs[id] = job.toYaml();
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
    Deno.writeTextFileSync(path, this.toYamlString(options));
  }
}

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
