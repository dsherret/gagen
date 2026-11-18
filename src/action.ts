import * as internal from "./internal.ts";
import fs from "node:fs";
import { stringify } from "@std/yaml/stringify";
import { ExpressionValue } from "./expression.ts";
import {
  exposeInputExpressions,
  type WithInputExprs,
  WorkflowCallInputs,
  WorkflowDispatchInputs,
} from "./inputs.ts";
import { Job, type JobDefaults } from "./job.ts";
import type { StepLike } from "./step.ts";
import { type WriteOrLintOptions, writeOrLintYaml } from "./write.ts";

/** An input declared by a composite action. */
export interface ActionInputDef {
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  deprecationMessage?: string;
}

/** An output declared by a composite action. */
export interface ActionOutputDef {
  description: string;
  /** Usually a step output expression, ex. `checkStep.outputs.result`. */
  value: ExpressionValue | string;
}

/** A composite action definition. */
export interface ActionConfig {
  name: string;
  description: string;
  author?: string;
  inputs?: ActionInputs<string>;
  outputs?: Record<string, ActionOutputDef>;
  /**
   * Applied to `run` steps that do not set the field themselves. Composite
   * actions have no `defaults` block of their own and GitHub requires every
   * `run` step in one to name its `shell`, so this saves repeating it.
   */
  defaults?: JobDefaults;
  steps: StepLike | StepLike[];
  branding?: { icon: string; color: string };
}

/**
 * The inputs of a composite action. Each input is exposed as a property
 * holding the `inputs.<name>` expression, so inputs can be referenced directly
 * in step configuration and conditions.
 */
export class ActionInputs<_K extends string> {
  // a private field, which also keeps the inputs of a workflow trigger from
  // type checking as composite action inputs
  readonly #defs: Record<string, ActionInputDef>;

  constructor(defs: Record<string, ActionInputDef>) {
    this.#defs = defs;
    exposeInputExpressions(this, defs, "ActionInputs");
  }

  /** Serializes the input definitions to their YAML form. */
  [internal.toYaml](): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(this.#defs)) {
      const input: Record<string, unknown> = {
        description: def.description,
      };
      if (def.required != null) {
        input.required = def.required;
      }
      if (def.default != null) {
        input.default = def.default;
      }
      if (def.deprecationMessage != null) {
        input.deprecationMessage = def.deprecationMessage;
      }
      result[name] = input;
    }
    return result;
  }
}

/**
 * A resolved composite action. Prefer the `action()` free function over
 * constructing this directly.
 */
export class Action {
  readonly #config: ActionConfig;

  constructor(config: ActionConfig) {
    this.#config = config;
  }

  /** Serializes the action to its `action.yml` YAML. */
  toYamlString(options?: { header?: string }): string {
    const config = this.#config;
    const obj: Record<string, unknown> = {};

    obj.name = config.name;
    obj.description = config.description;

    if (config.author != null) {
      obj.author = config.author;
    }

    if (config.inputs != null) {
      assertActionInputs(config.inputs);
      const inputs = config.inputs[internal.toYaml]();
      if (Object.keys(inputs).length > 0) {
        obj.inputs = inputs;
      }
    }

    // step resolution, condition propagation and output validation are the
    // same as for a job, so run them through one
    const stepOutputs: Record<string, ExpressionValue> = {};
    for (const [name, def] of Object.entries(config.outputs ?? {})) {
      if (def.value instanceof ExpressionValue) {
        stepOutputs[name] = def.value;
      }
    }
    const job = new Job("action", { runsOn: "" }, {
      steps: Array.isArray(config.steps) ? config.steps : [config.steps],
      outputs: stepOutputs,
    });
    const { steps, outputs } = job[internal.toStepsYaml](
      `Action "${config.name}"`,
      "action",
    );

    if (config.outputs != null && Object.keys(config.outputs).length > 0) {
      const result: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(config.outputs)) {
        result[name] = {
          description: def.description,
          value: outputs?.[name] ?? def.value,
        };
      }
      obj.outputs = result;
    }

    applyRunDefaults(steps, config.defaults);
    obj.runs = { using: "composite", steps };

    if (config.branding != null) {
      obj.branding = config.branding;
    }

    const yaml = stringify(obj, {
      useAnchors: false,
      lineWidth: 10_000,
      compatMode: false,
    });

    const header = options?.header;
    return header ? `${header}\n\n${yaml}` : yaml;
  }

  /** Writes the action's YAML to a file. */
  writeToFile(path: string | URL, options?: { header?: string }): void {
    fs.writeFileSync(path, this.toYamlString(options));
  }

  /**
   * Writes the action's YAML to `options.filePath`, or with `--lint` verifies
   * the file there is up to date. See {@link writeOrLintYaml}.
   */
  writeOrLint(options: WriteOrLintOptions): void {
    writeOrLintYaml(this.toYamlString(options), options);
  }
}

/** Creates a composite action, with helpers for defining its parts. */
export interface ActionFunction {
  /** Creates a composite action from the given configuration. */
  (config: ActionConfig): Action;
  /**
   * Defines the inputs of a composite action, returning them with a typed
   * property per input holding that input's `inputs.<name>` expression.
   */
  defineInputs<const T extends Record<string, ActionInputDef>>(
    defs: T,
  ): WithInputExprs<ActionInputs<keyof T & string>, keyof T & string>;
}

/** Creates a composite action from the given configuration. */
export const action: ActionFunction = Object.assign(
  (config: ActionConfig): Action => new Action(config),
  { defineInputs: defineActionInputs },
);

function defineActionInputs<const T extends Record<string, ActionInputDef>>(
  defs: T,
): WithInputExprs<ActionInputs<keyof T & string>, keyof T & string> {
  return new ActionInputs(defs) as WithInputExprs<
    ActionInputs<keyof T & string>,
    keyof T & string
  >;
}

/** Fails for inputs that were not defined with `action.defineInputs`. */
function assertActionInputs(inputs: unknown) {
  if (inputs instanceof ActionInputs) return;
  const received = inputs instanceof WorkflowDispatchInputs
    ? "workflow_dispatch inputs"
    : inputs instanceof WorkflowCallInputs
    ? "workflow_call inputs"
    : "inputs that were not defined with action.defineInputs()";
  throw new Error(
    `The inputs of a composite action received ${received}. Use action.defineInputs().`,
  );
}

/**
 * Fills in `shell` and `working-directory` on serialized `run` steps from the
 * action's defaults, then rejects any `run` step still missing a shell since
 * GitHub requires one in composite actions.
 */
function applyRunDefaults(
  steps: unknown[],
  defaults: JobDefaults | undefined,
): void {
  for (const [index, item] of steps.entries()) {
    const step = item as Record<string, unknown>;
    if (Array.isArray(step.parallel)) {
      applyRunDefaults(step.parallel, defaults);
      continue;
    }
    if (step.run == null) continue;
    const filled: Record<string, unknown> = {};
    if (step.shell == null && defaults?.run?.shell != null) {
      filled.shell = defaults.run.shell;
    }
    if (
      step["working-directory"] == null &&
      defaults?.run?.workingDirectory != null
    ) {
      filled["working-directory"] = defaults.run.workingDirectory;
    }
    if (step.shell == null && filled.shell == null) {
      const label = typeof step.name === "string"
        ? `"${step.name}"`
        : typeof step.id === "string"
        ? `"${step.id}"`
        : `running \`${String(step.run).split("\n")[0]}\``;
      throw new Error(
        `Composite action run steps require a shell, but the step ${label} has none. ` +
          "Set `shell` on the step or `defaults.run.shell` on the action.",
      );
    }
    if (Object.keys(filled).length > 0) {
      steps[index] = insertAfterHeader(step, filled);
    }
  }
}

/**
 * Returns a copy of a serialized step with `fields` placed where the step's
 * own `shell` and `working-directory` would go — after its identifying keys
 * and before its `env`, `with` and `run` — so the output reads the same as a
 * step that set them itself.
 *
 * `shell` counts as a header key so that a default `working-directory` lands
 * after a shell the step set itself, matching the order steps serialize in.
 */
function insertAfterHeader(
  step: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const headerKeys = new Set(["name", "id", "uses", "if", "shell"]);
  const result: Record<string, unknown> = {};
  let inserted = false;
  for (const [key, value] of Object.entries(step)) {
    if (!inserted && !headerKeys.has(key)) {
      Object.assign(result, fields);
      inserted = true;
    }
    result[key] = value;
  }
  if (!inserted) Object.assign(result, fields);
  return result;
}
