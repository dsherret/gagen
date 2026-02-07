import { assertEquals, assertThrows } from "@std/assert";
import { createWorkflow, ExpressionValue, step } from "./mod.ts";
import { Job } from "./job.ts";
import { resetStepCounter } from "./step.ts";

// reset step counter between tests for deterministic ids
function setup() {
  resetStepCounter();
}

// --- basic workflow ---

Deno.test("basic README example", () => {
  setup();
  const cloneRepo = step({
    name: "Clone repository",
    uses: "actions/checkout@v6",
  });

  const cargoBuild = step({
    name: "Cargo Build",
    run: "cargo build",
  }).dependsOn(cloneRepo);

  const cargoTest = step({
    name: "Cargo Test",
    run: "cargo test",
  }).dependsOn(cargoBuild);

  const wf = createWorkflow({
    name: "ci",
    on: {
      push: { branches: ["main"] },
    },
  });

  wf.createJob("build", {
    name: "build",
    runsOn: "ubuntu-latest",
  }).withSteps(cargoTest);

  wf.createJob("lint", {
    runsOn: "ubuntu-latest",
  }).withSteps(cargoBuild);

  const yaml = wf.toYamlString();

  // build job has all 3 steps in order
  assertContainsBefore(yaml, "Clone repository", "Cargo Build");
  assertContainsBefore(yaml, "Cargo Build", "Cargo Test");

  // lint job has 2 steps
  // (Clone repository appears twice — once per job)
  const buildJobSection = yaml.indexOf("build:");
  const lintJobSection = yaml.indexOf("lint:");
  const lintSection = yaml.substring(lintJobSection);
  assertContains(lintSection, "Clone repository");
  assertContains(lintSection, "Cargo Build");
  // cargoTest should NOT be in lint job
  const lintStepsStart = lintSection.indexOf("steps:");
  const lintStepsSection = lintSection.substring(lintStepsStart);
  assertEquals(lintStepsSection.includes("Cargo Test"), false);
});

// --- transitive dependency resolution ---

Deno.test("transitive deps are resolved", () => {
  setup();
  const a = step({ name: "A" });
  const b = step({ name: "B" }).dependsOn(a);
  const c = step({ name: "C" }).dependsOn(b);
  const d = step({ name: "D" }).dependsOn(c);

  const wf = createWorkflow({ name: "test", on: {} });
  const job = wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(d);

  const yaml = wf.toYamlString();
  assertContainsBefore(yaml, "name: A", "name: B");
  assertContainsBefore(yaml, "name: B", "name: C");
  assertContainsBefore(yaml, "name: C", "name: D");
});

// --- diamond dependency ---

Deno.test("diamond dependency - D appears once, before B and C", () => {
  setup();
  const d = step({ name: "D" });
  const b = step({ name: "B" }).dependsOn(d);
  const c = step({ name: "C" }).dependsOn(d);
  const a = step({ name: "A" }).dependsOn(b, c);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(a);

  const yaml = wf.toYamlString();

  // D before B and C
  assertContainsBefore(yaml, "name: D", "name: B");
  assertContainsBefore(yaml, "name: D", "name: C");
  // B and C before A
  assertContainsBefore(yaml, "name: B", "name: A");
  assertContainsBefore(yaml, "name: C", "name: A");

  // D appears exactly once
  const count = yaml.split("name: D").length - 1;
  assertEquals(count, 1);
});

// --- step with if condition ---

Deno.test("step with if condition appears in YAML", () => {
  setup();
  const s = step({
    name: "Conditional step",
    run: "echo hi",
    if: new ExpressionValue("matrix.os").equals("linux"),
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  const yaml = wf.toYamlString();
  assertContains(yaml, "if: matrix.os == 'linux'");
});

Deno.test("step with string if condition", () => {
  setup();
  const s = step({
    name: "Conditional",
    run: "echo hi",
    if: "always()",
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  const yaml = wf.toYamlString();
  assertContains(yaml, "if: always()");
});

// --- job needs inference ---

Deno.test("job needs inferred from job output reference in if", () => {
  setup();
  const checkStep = step({
    id: "check",
    name: "Check",
    run: "echo 'skip=true' >> $GITHUB_OUTPUT",
    outputs: ["skip"],
  });

  const wf = createWorkflow({ name: "test", on: {} });

  const preBuild = wf.createJob("pre_build", {
    runsOn: "ubuntu-latest",
  }).withSteps(checkStep).withOutputs({
    skip: checkStep.outputs.skip,
  });

  const buildStep = step({ name: "Build", run: "cargo build" });
  wf.createJob("build", {
    runsOn: "ubuntu-latest",
    if: preBuild.outputs.skip.notEquals("true"),
  }).withSteps(buildStep);

  const yaml = wf.toYamlString();
  // build job should have needs: [pre_build]
  const buildSection = yaml.substring(yaml.indexOf("build:"));
  assertContains(buildSection, "pre_build");
});

// --- explicit needs ---

Deno.test("explicit needs appear in YAML", () => {
  setup();
  const wf = createWorkflow({ name: "test", on: {} });
  const jobA = wf.createJob("a", { runsOn: "ubuntu-latest" })
    .withSteps(step({ name: "A", run: "echo a" }));
  wf.createJob("b", {
    runsOn: "ubuntu-latest",
    needs: [jobA],
  }).withSteps(step({ name: "B", run: "echo b" }));

  const yaml = wf.toYamlString();
  const bSection = yaml.substring(yaml.indexOf("  b:"));
  assertContains(bSection, "needs:");
  assertContains(bSection, "- a");
});

// --- step outputs and job outputs ---

Deno.test("step outputs create job outputs in YAML", () => {
  setup();
  const checkStep = step({
    id: "check",
    name: "Check",
    run: "echo 'result=ok' >> $GITHUB_OUTPUT",
    outputs: ["result"],
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("check_job", {
    runsOn: "ubuntu-latest",
  }).withSteps(checkStep).withOutputs({
    result: checkStep.outputs.result,
  });

  const yaml = wf.toYamlString();
  assertContains(yaml, "outputs:");
  assertContains(yaml, "result:");
  assertContains(yaml, "steps.check.outputs.result");
});

// --- cycle detection ---

Deno.test("cycle detection throws", () => {
  setup();
  const a = step({ name: "A" });
  const b = step({ name: "B" }).dependsOn(a);
  // create cycle: a depends on b, b depends on a
  a.dependsOn(b);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(a);

  assertThrows(
    () => wf.toYamlString(),
    Error,
    "Cycle detected",
  );
});

// --- duplicate job id ---

Deno.test("duplicate job id throws", () => {
  setup();
  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", { runsOn: "ubuntu-latest" });

  assertThrows(
    () => wf.createJob("build", { runsOn: "ubuntu-latest" }),
    Error,
    'Duplicate job id: "build"',
  );
});

// --- step with outputs requires id ---

Deno.test("step with outputs but no id throws", () => {
  setup();
  assertThrows(
    () => step({ run: "echo hi", outputs: ["result"] }),
    Error,
    "explicit id",
  );
});

// --- step run array joined ---

Deno.test("step run array is joined with newlines", () => {
  setup();
  const s = step({
    name: "Multi-line",
    run: ["echo a", "echo b", "echo c"],
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  const yaml = wf.toYamlString();
  // YAML serializes multiline run as a block scalar
  assertContains(yaml, "echo a");
  assertContains(yaml, "echo b");
  assertContains(yaml, "echo c");
});

// --- step with/env serialization ---

Deno.test("step with ExpressionValue in with field", () => {
  setup();
  const ev = new ExpressionValue("secrets.GITHUB_TOKEN");
  const s = step({
    name: "Deploy",
    uses: "actions/deploy@v1",
    with: { token: ev },
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  const yaml = wf.toYamlString();
  // YAML may single-quote ${{ }} values
  assertContains(yaml, "secrets.GITHUB_TOKEN");
});

// --- job with defaults ---

Deno.test("job defaults serialized correctly", () => {
  setup();
  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", {
    runsOn: "ubuntu-latest",
    defaults: { run: { shell: "bash" } },
  }).withSteps(step({ name: "S", run: "echo hi" }));

  const yaml = wf.toYamlString();
  assertContains(yaml, "defaults:");
  assertContains(yaml, "shell: bash");
});

// --- job timeout ---

Deno.test("job timeout-minutes serialized", () => {
  setup();
  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", {
    runsOn: "ubuntu-latest",
    timeoutMinutes: 60,
  }).withSteps(step({ name: "S", run: "echo hi" }));

  const yaml = wf.toYamlString();
  assertContains(yaml, "timeout-minutes: 60");
});

// --- workflow permissions and concurrency ---

Deno.test("workflow permissions and concurrency", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: { push: { branches: ["main"] } },
    permissions: { contents: "write" },
    concurrency: {
      group: "ci-${{ github.ref }}",
      cancelInProgress: true,
    },
  });
  wf.createJob("j", { runsOn: "ubuntu-latest" })
    .withSteps(step({ name: "S", run: "echo hi" }));

  const yaml = wf.toYamlString();
  assertContains(yaml, "permissions:");
  assertContains(yaml, "contents: write");
  assertContains(yaml, "concurrency:");
  assertContains(yaml, "cancel-in-progress: true");
});

// --- helpers ---

function assertContains(haystack: string, needle: string) {
  if (!haystack.includes(needle)) {
    throw new Error(
      `Expected string to contain "${needle}"\n\nActual:\n${haystack}`,
    );
  }
}

function assertContainsBefore(str: string, first: string, second: string) {
  const i = str.indexOf(first);
  const j = str.indexOf(second);
  if (i === -1) {
    throw new Error(`Expected string to contain "${first}"\n\nActual:\n${str}`);
  }
  if (j === -1) {
    throw new Error(
      `Expected string to contain "${second}"\n\nActual:\n${str}`,
    );
  }
  if (i >= j) {
    throw new Error(
      `Expected "${first}" to appear before "${second}"\n\nActual:\n${str}`,
    );
  }
}
