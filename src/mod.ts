export { Step, step, StepRef } from "./step.ts";
export type {
  CompositeKind,
  ConditionLike,
  ConfigValue,
  StepBuilder,
  StepConfig,
  StepFunction,
  StepLike,
} from "./step.ts";
export { Job, job, type JobFunction } from "./job.ts";
export type {
  JobConfig,
  JobDef,
  JobDefaults,
  ReusableJobConfig,
  ReusableJobDef,
  RunsOn,
  ServiceContainer,
  StepsJobConfig,
  StepsJobDef,
} from "./job.ts";
export { Workflow, workflow, type WorkflowFunction } from "./workflow.ts";
export { isLinting, isUpdatingPins, type WriteOrLintOptions } from "./write.ts";
export { Action, action, type ActionFunction, ActionInputs } from "./action.ts";
export type {
  ActionConfig,
  ActionInputDef,
  ActionOutputDef,
} from "./action.ts";
export type {
  WorkflowCallOutput,
  WorkflowCallSecret,
  WorkflowCallTrigger,
  WorkflowConfig,
  WorkflowDispatchTrigger,
  WorkflowTriggers,
} from "./workflow.ts";
export { WorkflowCallInputs, WorkflowDispatchInputs } from "./inputs.ts";
export type { WorkflowCallInput, WorkflowDispatchInput } from "./inputs.ts";
export {
  concat,
  Condition,
  conditions,
  ElseIfBuilder,
  expr,
  ExpressionValue,
  type ExprFunction,
  fromJSON,
  hashFiles,
  join,
  literal,
  ThenBuilder,
  toJSON,
} from "./expression.ts";
export type {
  ComparisonOp,
  ConcatPart,
  ExpressionSource,
  ExprMap,
  ExprOf,
  Operand,
  TernaryValue,
} from "./expression.ts";
// Only `RefResolver` and `RefNarrower` belong to the public API — they appear
// in the `pinDeps` option of `writeOrLint`. The rest of `pin.ts` is
// implementation detail of `writeOrLint` and the CLI.
export type { RefNarrower, RefResolver } from "./pin.ts";
export { Matrix } from "./matrix.ts";
export type {
  PermissionLevel,
  Permissions,
  PermissionScope,
} from "./permissions.ts";
export { Artifact, artifact } from "./artifact.ts";
export type {
  ArtifactOptions,
  DownloadConfig,
  UploadConfig,
} from "./artifact.ts";

// deprecated re-exports

import { workflow as workflow_ } from "./workflow.ts";
import { artifact as artifact_ } from "./artifact.ts";
import { action as action_ } from "./action.ts";
import { job as job_ } from "./job.ts";
import { expr as expr_ } from "./expression.ts";

/** @deprecated Use `workflow` instead. */
export const createWorkflow: typeof workflow_ = workflow_;
/** @deprecated Use `artifact` instead. */
export const defineArtifact: typeof artifact_ = artifact_;
/** @deprecated Use `action.defineInputs` instead. */
export const defineInputs: typeof action_.defineInputs = action_.defineInputs;
/** @deprecated Use `job.defineMatrix` instead. */
export const defineMatrix: typeof job_.defineMatrix = job_.defineMatrix;
/** @deprecated Use `expr.defineObj` instead. */
export const defineExprObj: typeof expr_.defineObj = expr_.defineObj;

// run the cli
if (import.meta.main) {
  import("./cli.ts").then((mod) => mod.runCli());
}
