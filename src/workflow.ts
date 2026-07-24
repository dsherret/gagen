import process from "node:process";
import { parse } from "@std/yaml/parse";
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
import { parsePinComments, pinParsedYaml, pinYamlContent } from "./pin.ts";
import type { PinEntry, RefResolver } from "./pin.ts";
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
      this.#assertNeedsAreInWorkflow(id, job, stepOwners);
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

  /** Writes the workflow's YAML to a file. */
  writeToFile(path: string | URL, options?: { header?: string }): void {
    fs.writeFileSync(path, this.toYamlString(options));
  }

  writeOrLint(
    options: {
      filePath: URL;
      header?: string;
      pinDeps?: boolean | { resolve: RefResolver };
    },
  ): void {
    assertKnownFlags();
    const pinDeps = options.pinDeps ?? true;
    const expected = this.toYamlString(options);

    if (isLintingNow()) {
      const existing = readForLint(options.filePath);
      let parsedExisting: unknown;
      let parsedExpected: unknown;

      if (pinDeps) {
        // compare in the pinned direction: a ref always maps to one hash,
        // while a hash may have been written by more than one ref
        const pins = parsePinComments(existing);
        parsedExisting = parse(existing);
        parsedExpected = pinParsedYaml(parse(expected), pins);
      } else {
        parsedExisting = parse(existing);
        parsedExpected = parse(expected);
      }

      if (
        JSON.stringify(parsedExisting) !== JSON.stringify(parsedExpected)
      ) {
        console.error(
          `Error: ${options.filePath} is out of date. Run without --lint to update.`,
        );
        process.exit(1);
      }
    } else {
      let output = expected;
      if (pinDeps) {
        const resolve = typeof pinDeps === "object"
          ? pinDeps.resolve
          : undefined;
        // reuse previously resolved hashes from existing file to avoid
        // redundant git ls-remote calls on subsequent runs
        let cache: PinEntry[] | undefined;
        if (!isUpdatingPins()) {
          try {
            const existing = fs.readFileSync(options.filePath, {
              encoding: "utf8",
            });
            cache = parsePinComments(existing);
          } catch {
            // file doesn't exist yet
          }
        }
        const result = pinYamlContent(expected, resolve, cache);
        output = result.content;
      }
      fs.writeFileSync(options.filePath, output);
    }
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
    for (const dep of job.inferNeeds(stepOwners)) {
      if (!this.#jobs.has(dep.id)) {
        throw new Error(
          `Job "${id}" depends on job "${dep.id}", which is not part of this workflow.`,
        );
      }
    }
  }
}

/** Gets if linting would occur when using `writeOrLint` on a workflow. */
export const isLinting: boolean = isLintingNow();

/**
 * Gets if linting should occur, reading the flags on each call.
 *
 * `isLinting` cannot be used internally: it is captured when this module is
 * first imported, which makes the lint path unreachable from a test that sets
 * the flag afterwards.
 */
function isLintingNow(): boolean {
  return process.argv.includes("--lint");
}

/** Gets if pins should be re-resolved when using `writeOrLint` on a workflow. */
export function isUpdatingPins(): boolean {
  return process.argv.includes("--update-pins");
}

/** The command line flags that gagen reads. */
export const KNOWN_FLAGS: readonly string[] = [
  "--lint",
  "--update-pins",
  "--pull-versions",
  "--help",
  "-h",
];

/**
 * Exits with an error when the command line has a flag gagen does not know
 * about.
 *
 * Since gagen decides whether to write or lint from the process' flags, a
 * typo like `--lnit` would otherwise be indistinguishable from no flag at all
 * and would silently overwrite the generated files it was meant to check.
 */
export function assertKnownFlags(
  args: readonly string[] = process.argv.slice(2),
): void {
  const unknown = args.filter((arg) =>
    arg.startsWith("-") && !KNOWN_FLAGS.includes(arg)
  );
  if (unknown.length === 0) return;
  console.error(`Unknown flag: ${unknown.join(", ")}`);
  console.error(`Known flags: ${KNOWN_FLAGS.join(", ")}`);
  process.exit(1);
}

/** Creates a workflow from the given configuration. */
export function workflow(config: WorkflowConfig): Workflow {
  return new Workflow(config);
}

/** Reads the file to lint against, failing with a hint when it is missing. */
function readForLint(filePath: URL): string {
  try {
    return fs.readFileSync(filePath, { encoding: "utf8" });
  } catch (err) {
    if (isNotFound(err)) {
      console.error(
        `Error: ${filePath} does not exist. Run without --lint to generate it.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === "ENOENT";
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
