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
export { Job, job } from "./job.ts";
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
export { Workflow, workflow } from "./workflow.ts";
export { isLinting, isUpdatingPins, type WriteOrLintOptions } from "./write.ts";
export { Action, action, ActionInputs, defineInputs } from "./action.ts";
export type {
  ActionConfig,
  ActionInputDef,
  ActionOutputDef,
} from "./action.ts";
export type {
  WorkflowCallInput,
  WorkflowCallOutput,
  WorkflowCallSecret,
  WorkflowCallTrigger,
  WorkflowConfig,
  WorkflowTriggers,
} from "./workflow.ts";
export {
  concat,
  Condition,
  conditions,
  defineExprObj,
  ElseIfBuilder,
  expr,
  ExpressionValue,
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
  TernaryValue,
} from "./expression.ts";
// Only `RefResolver` belongs to the public API — it appears in the `pinDeps`
// option of `writeOrLint`. The rest of `pin.ts` is implementation detail of
// `writeOrLint` and the CLI.
export type { RefResolver } from "./pin.ts";
export { defineMatrix, Matrix } from "./matrix.ts";
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

/** @deprecated Use `workflow` instead. */
export const createWorkflow: typeof workflow_ = workflow_;
/** @deprecated Use `artifact` instead. */
export const defineArtifact: typeof artifact_ = artifact_;

// run the cli
if (import.meta.main) {
  import("./cli.ts").then((mod) => mod.runCli());
}
