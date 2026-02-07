import { assertEquals, assertThrows } from "@std/assert";
import { createWorkflow, expr, step } from "./mod.ts";
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

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: ci
on:
  push:
    branches:
      - main
jobs:
  build:
    name: build
    runs-on: ubuntu-latest
    steps:
      - name: Clone repository
        uses: actions/checkout@v6
      - name: Cargo Build
        run: cargo build
      - name: Cargo Test
        run: cargo test
  lint:
    runs-on: ubuntu-latest
    steps:
      - name: Clone repository
        uses: actions/checkout@v6
      - name: Cargo Build
        run: cargo build
`,
  );
});

// --- transitive dependency resolution ---

Deno.test("transitive deps are resolved", () => {
  setup();
  const a = step({ name: "A" });
  const b = step({ name: "B" }).dependsOn(a);
  const c = step({ name: "C" }).dependsOn(b);
  const d = step({ name: "D" }).dependsOn(c);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(d);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: A
      - name: B
      - name: C
      - name: D
`,
  );
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

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: D
      - name: B
      - name: C
      - name: A
`,
  );
});

// --- step with if condition ---

Deno.test("step with if condition appears in YAML", () => {
  setup();
  const s = step({
    name: "Conditional step",
    run: "echo hi",
    if: expr("matrix.os").equals("linux"),
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Conditional step
        if: matrix.os == 'linux'
        run: echo hi
`,
  );
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

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Conditional
        if: always()
        run: echo hi
`,
  );
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

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  pre_build:
    runs-on: ubuntu-latest
    outputs:
      skip: '\${{ steps.check.outputs.skip }}'
    steps:
      - id: check
        name: Check
        run: echo 'skip=true' >> $GITHUB_OUTPUT
  build:
    needs:
      - pre_build
    if: needs.pre_build.outputs.skip != 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: cargo build
`,
  );
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

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: A
        run: echo a
  b:
    needs:
      - a
    runs-on: ubuntu-latest
    steps:
      - name: B
        run: echo b
`,
  );
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

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  check_job:
    runs-on: ubuntu-latest
    outputs:
      result: '\${{ steps.check.outputs.result }}'
    steps:
      - id: check
        name: Check
        run: echo 'result=ok' >> $GITHUB_OUTPUT
`,
  );
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

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Multi-line
        run: |-
          echo a
          echo b
          echo c
`,
  );
});

// --- step with/env serialization ---

Deno.test("step with ExpressionValue in with field", () => {
  setup();
  const ev = expr("secrets.GITHUB_TOKEN");
  const s = step({
    name: "Deploy",
    uses: "actions/deploy@v1",
    with: { token: ev },
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        uses: actions/deploy@v1
        with:
          token: '\${{ secrets.GITHUB_TOKEN }}'
`,
  );
});

// --- job with defaults ---

Deno.test("job defaults serialized correctly", () => {
  setup();
  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", {
    runsOn: "ubuntu-latest",
    defaults: { run: { shell: "bash" } },
  }).withSteps(step({ name: "S", run: "echo hi" }));

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - name: S
        run: echo hi
`,
  );
});

// --- job timeout ---

Deno.test("job timeout-minutes serialized", () => {
  setup();
  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", {
    runsOn: "ubuntu-latest",
    timeoutMinutes: 60,
  }).withSteps(step({ name: "S", run: "echo hi" }));

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: S
        run: echo hi
`,
  );
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

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: ci
on:
  push:
    branches:
      - main
permissions:
  contents: write
concurrency:
  group: 'ci-\${{ github.ref }}'
  cancel-in-progress: true
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: S
        run: echo hi
`,
  );
});

// --- condition propagation ---

Deno.test("condition propagates from leaf to dependencies", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const build = step({ name: "Build", run: "cargo build" }).dependsOn(checkout);
  const test = step({
    name: "Test",
    run: "cargo test",
    if: expr("matrix.job").equals("test"),
  }).dependsOn(build);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(test);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        if: matrix.job == 'test'
        uses: actions/checkout@v6
      - name: Build
        if: matrix.job == 'test'
        run: cargo build
      - name: Test
        if: matrix.job == 'test'
        run: cargo test
`,
  );
});

Deno.test("conditions OR'd when multiple dependents", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const test = step({
    name: "Test",
    run: "cargo test",
    if: expr("matrix.job").equals("test"),
  }).dependsOn(checkout);
  const bench = step({
    name: "Bench",
    run: "cargo bench",
    if: expr("matrix.job").equals("bench"),
  }).dependsOn(checkout);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(test, bench);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        if: matrix.job == 'test' || matrix.job == 'bench'
        uses: actions/checkout@v6
      - name: Test
        if: matrix.job == 'test'
        run: cargo test
      - name: Bench
        if: matrix.job == 'bench'
        run: cargo bench
`,
  );
});

Deno.test("no propagation when a dependent has no condition", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const test = step({
    name: "Test",
    run: "cargo test",
    if: expr("matrix.job").equals("test"),
  }).dependsOn(checkout);
  const lint = step({
    name: "Lint",
    run: "cargo clippy",
  }).dependsOn(checkout);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(test, lint);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - name: Test
        if: matrix.job == 'test'
        run: cargo test
      - name: Lint
        run: cargo clippy
`,
  );
});

Deno.test("condition with step output does not propagate past source", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const build = step({
    id: "build",
    name: "Build",
    run: "echo 'status=ok' >> $GITHUB_OUTPUT",
    outputs: ["status"],
  }).dependsOn(checkout);
  const test = step({
    name: "Test",
    run: "cargo test",
    if: build.outputs.status.equals("ok"),
  }).dependsOn(build);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(test);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - id: build
        name: Build
        run: echo 'status=ok' >> $GITHUB_OUTPUT
      - name: Test
        if: steps.build.outputs.status == 'ok'
        run: cargo test
`,
  );
});

Deno.test("propagated condition ANDed with own if", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const build = step({
    name: "Build",
    run: "cargo build",
    if: expr("matrix.profile").equals("release"),
  }).dependsOn(checkout);
  const test = step({
    name: "Test",
    run: "cargo test",
    if: expr("matrix.job").equals("test"),
  }).dependsOn(build);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(test);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        if: matrix.job == 'test' && matrix.profile == 'release'
        uses: actions/checkout@v6
      - name: Build
        if: matrix.job == 'test' && matrix.profile == 'release'
        run: cargo build
      - name: Test
        if: matrix.job == 'test'
        run: cargo test
`,
  );
});

Deno.test("unconditional leaf blocks propagation to shared deps", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const build = step({ name: "Build", run: "cargo build" }).dependsOn(checkout);
  const test = step({ name: "Test", run: "cargo test" }).dependsOn(build);
  const linuxOnly = step({
    name: "Linux only",
    run: "linux-specific",
    if: expr("matrix.os").equals("linux"),
  }).dependsOn(build, test);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(test, linuxOnly);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - name: Build
        run: cargo build
      - name: Test
        run: cargo test
      - name: Linux only
        if: matrix.os == 'linux'
        run: linux-specific
`,
  );
});

Deno.test("leaf steps passed to withSteps do not get propagation", () => {
  setup();
  const a = step({
    name: "A",
    if: expr("matrix.os").equals("linux"),
  });
  const b = step({
    name: "B",
    if: expr("matrix.job").equals("test"),
  }).dependsOn(a);

  const wf = createWorkflow({ name: "test", on: {} });
  // both are explicitly passed to withSteps
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(a, b);

  assertEquals(
    wf.toYamlString(),
    `# GENERATED -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: A
        if: matrix.os == 'linux'
      - name: B
        if: matrix.job == 'test'
`,
  );
});
