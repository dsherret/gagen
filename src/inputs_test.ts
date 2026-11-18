import { assertEquals, assertThrows } from "@std/assert";
import { action, step, workflow } from "./mod.ts";
import { resetStepCounter } from "./step.ts";

Deno.test("workflow.defineDispatchInputs serializes the inputs and exposes their expressions", () => {
  resetStepCounter();
  const inputs = workflow.defineDispatchInputs({
    countries: {
      description: "Pipe-separated country codes",
      required: false,
      default: "UK|TR|IT",
      type: "string",
    },
    level: {
      type: "choice",
      options: ["info", "debug"],
      default: "info",
    },
    target: { type: "environment" },
  });
  const wf = workflow({
    name: "ci",
    on: { workflow_dispatch: { inputs } },
    jobs: [{
      id: "a",
      runsOn: "ubuntu-latest",
      env: { COUNTRIES: inputs.countries },
      steps: [step({
        if: inputs.level.equals("debug"),
        run: `deploy ${inputs.target}`,
      })],
    }],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on:
  workflow_dispatch:
    inputs:
      countries:
        description: Pipe-separated country codes
        required: false
        default: UK|TR|IT
        type: string
      level:
        type: choice
        options:
          - info
          - debug
        default: info
      target:
        type: environment
jobs:
  a:
    runs-on: ubuntu-latest
    env:
      COUNTRIES: '\${{ inputs.countries }}'
    steps:
      - if: inputs.level == 'debug'
        run: 'deploy \${{ inputs.target }}'
`,
  );
});

Deno.test("workflow.defineCallInputs serializes the inputs and exposes their expressions", () => {
  resetStepCounter();
  const inputs = workflow.defineCallInputs({
    version: { type: "string", required: true },
    dry: { type: "boolean", default: false },
  });
  const wf = workflow({
    name: "release",
    on: { workflow_call: { inputs } },
    jobs: [{
      id: "a",
      runsOn: "ubuntu-latest",
      steps: [step({ if: inputs.dry.not(), run: `release ${inputs.version}` })],
    }],
  });

  assertEquals(
    wf.toYamlString(),
    `name: release
on:
  workflow_call:
    inputs:
      version:
        type: string
        required: true
      dry:
        type: boolean
        default: false
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - if: '!(inputs.dry)'
        run: 'release \${{ inputs.version }}'
`,
  );
});

Deno.test("workflow triggers reject inputs defined for something else", () => {
  const actionInputs = action.defineInputs({ name: { description: "Name" } });
  const dispatchInputs = workflow.defineDispatchInputs({
    name: { type: "string" },
  });
  const callInputs = workflow.defineCallInputs({ name: { type: "string" } });
  const toYaml = (on: Parameters<typeof workflow>[0]["on"]) =>
    workflow({ name: "ci", on, jobs: [] }).toYamlString();

  assertThrows(
    // @ts-expect-error composite action inputs are not workflow inputs
    () => toYaml({ workflow_dispatch: { inputs: actionInputs } }),
    Error,
    "on.workflow_dispatch.inputs received composite action inputs. Use workflow.defineDispatchInputs() or pass a plain input definition object.",
  );
  assertThrows(
    // @ts-expect-error composite action inputs are not workflow inputs
    () => toYaml({ workflow_call: { inputs: actionInputs } }),
    Error,
    "on.workflow_call.inputs received composite action inputs. Use workflow.defineCallInputs() or pass a plain input definition object.",
  );
  assertThrows(
    // @ts-expect-error workflow_dispatch inputs are not workflow_call inputs
    () => toYaml({ workflow_call: { inputs: dispatchInputs } }),
    Error,
    "on.workflow_call.inputs received workflow_dispatch inputs.",
  );
  assertThrows(
    // @ts-expect-error workflow_call inputs are not workflow_dispatch inputs
    () => toYaml({ workflow_dispatch: { inputs: callInputs } }),
    Error,
    "on.workflow_dispatch.inputs received workflow_call inputs.",
  );
});

Deno.test("action rejects the inputs of a workflow trigger", () => {
  const inputs = workflow.defineDispatchInputs({ name: { type: "string" } });
  assertThrows(
    () =>
      action({
        name: "a",
        description: "d",
        // @ts-expect-error workflow inputs are not composite action inputs
        inputs,
        steps: [step({ run: "x" })],
      }).toYamlString(),
    Error,
    "The inputs of a composite action received workflow_dispatch inputs. Use action.defineInputs().",
  );
});

Deno.test("workflow input helpers reject an input that shadows a member", () => {
  assertThrows(
    () => workflow.defineDispatchInputs({ constructor: { type: "string" } }),
    Error,
    'Input "constructor" conflicts with a member of WorkflowDispatchInputs',
  );
  assertThrows(
    () => workflow.defineCallInputs({ constructor: { type: "string" } }),
    Error,
    'Input "constructor" conflicts with a member of WorkflowCallInputs',
  );
});
