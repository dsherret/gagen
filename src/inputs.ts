import * as internal from "./internal.ts";
import { ExpressionValue } from "./expression.ts";

/** An input declared by a `workflow_call` trigger. */
export interface WorkflowCallInput {
  type: "string" | "boolean" | "number";
  description?: string;
  required?: boolean;
  default?: string | boolean | number;
}

/** An input declared by a `workflow_dispatch` trigger. */
export type WorkflowDispatchInput =
  | {
    type?: "string" | "boolean" | "number" | "environment";
    description?: string;
    required?: boolean;
    default?: string | boolean | number;
  }
  | {
    type: "choice";
    options: string[];
    description?: string;
    required?: boolean;
    default?: string;
  };

/**
 * The inputs of a `workflow_dispatch` trigger. Each input is exposed as a
 * property holding the `inputs.<name>` expression, so inputs can be referenced
 * directly in job and step configuration and conditions.
 */
export class WorkflowDispatchInputs<_K extends string> {
  readonly #defs: Record<string, WorkflowDispatchInput>;

  constructor(defs: Record<string, WorkflowDispatchInput>) {
    this.#defs = defs;
    exposeInputExpressions(this, defs, "WorkflowDispatchInputs");
  }

  /** Serializes the input definitions to their YAML form. */
  [internal.toYaml](): Record<string, unknown> {
    return { ...this.#defs };
  }
}

/**
 * The inputs of a `workflow_call` trigger. Each input is exposed as a property
 * holding the `inputs.<name>` expression, so inputs can be referenced directly
 * in job and step configuration and conditions.
 */
export class WorkflowCallInputs<_K extends string> {
  readonly #defs: Record<string, WorkflowCallInput>;

  constructor(defs: Record<string, WorkflowCallInput>) {
    this.#defs = defs;
    exposeInputExpressions(this, defs, "WorkflowCallInputs");
  }

  /** Serializes the input definitions to their YAML form. */
  [internal.toYaml](): Record<string, unknown> {
    return { ...this.#defs };
  }
}

/** Inputs with a typed property per input holding its expression. */
export type WithInputExprs<Inputs, K extends string> =
  & Inputs
  & { readonly [P in K]: ExpressionValue };

/** The implementation of `workflow.defineDispatchInputs`. */
export function defineWorkflowDispatchInputs<
  const T extends Record<string, WorkflowDispatchInput>,
>(
  defs: T,
): WithInputExprs<WorkflowDispatchInputs<keyof T & string>, keyof T & string> {
  return new WorkflowDispatchInputs(defs) as WithInputExprs<
    WorkflowDispatchInputs<keyof T & string>,
    keyof T & string
  >;
}

/** The implementation of `workflow.defineCallInputs`. */
export function defineWorkflowCallInputs<
  const T extends Record<string, WorkflowCallInput>,
>(
  defs: T,
): WithInputExprs<WorkflowCallInputs<keyof T & string>, keyof T & string> {
  return new WorkflowCallInputs(defs) as WithInputExprs<
    WorkflowCallInputs<keyof T & string>,
    keyof T & string
  >;
}

/**
 * Sets a property per input on `target` holding the input's `inputs.<name>`
 * expression, failing for an input that would shadow a member.
 */
export function exposeInputExpressions(
  target: object,
  defs: Record<string, unknown>,
  typeName: string,
): void {
  for (const name of Object.keys(defs)) {
    if (name in target) {
      throw new Error(
        `Input "${name}" conflicts with a member of ${typeName} — rename the input.`,
      );
    }
    (target as Record<string, unknown>)[name] = new ExpressionValue(
      `inputs.${name}`,
    );
  }
}
