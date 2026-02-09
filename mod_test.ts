import { assertEquals, assertThrows } from "@std/assert";
import { conditions, createWorkflow, defineMatrix, expr, step, steps } from "./mod.ts";
import { resetStepCounter } from "./step.ts";

const { status, isTag, isBranch, isEvent } = conditions;

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
    `name: ci
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
    `name: test
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
    `name: test
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
    `name: test
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
    `name: test
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
    `name: test
on: {}
jobs:
  pre_build:
    runs-on: ubuntu-latest
    outputs:
      skip: '\${{ steps.check.outputs.skip }}'
    steps:
      - name: Check
        id: check
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
    `name: test
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
    `name: test
on: {}
jobs:
  check_job:
    runs-on: ubuntu-latest
    outputs:
      result: '\${{ steps.check.outputs.result }}'
    steps:
      - name: Check
        id: check
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
    `name: test
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
    `name: test
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
    `name: test
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
    `name: test
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
    `name: ci
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
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        if: matrix.job == 'test'
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
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        if: matrix.job == 'test' || matrix.job == 'bench'
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
    `name: test
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
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - name: Build
        id: build
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
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        if: matrix.job == 'test' && matrix.profile == 'release'
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
    `name: test
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
    `name: test
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

// --- typed matrix ---

Deno.test("defineMatrix with include serializes and provides typed expressions", () => {
  setup();
  const matrix = defineMatrix({
    include: [
      { os: "linux", runner: "ubuntu-latest" },
      { os: "macos", runner: "macos-latest" },
    ],
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    runsOn: matrix.runner,
    strategy: { matrix },
  }).withSteps(step({ name: "Build", run: "cargo build" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: '\${{ matrix.runner }}'
    strategy:
      matrix:
        include:
          - os: linux
            runner: ubuntu-latest
          - os: macos
            runner: macos-latest
    steps:
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("defineMatrix with key-value arrays", () => {
  setup();
  const matrix = defineMatrix({
    os: ["linux", "macos"],
    node: [18, 20],
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    runsOn: "ubuntu-latest",
    strategy: { matrix, failFast: false },
  }).withSteps(step({ name: "Build", run: "cargo build" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os:
          - linux
          - macos
        node:
          - 18
          - 20
      fail-fast: false
    steps:
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("matrix expressions work in step conditions", () => {
  setup();
  const matrix = defineMatrix({
    os: ["linux", "macos"],
  });
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const linuxStep = step({
    name: "Linux only",
    run: "linux-specific",
    if: matrix.os.equals("linux"),
  }).dependsOn(checkout);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    runsOn: "ubuntu-latest",
    strategy: { matrix },
  }).withSteps(linuxStep);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os:
          - linux
          - macos
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        if: matrix.os == 'linux'
      - name: Linux only
        if: matrix.os == 'linux'
        run: linux-specific
`,
  );
});

// --- ternary expressions ---

Deno.test("simple ternary with .then().else()", () => {
  setup();
  const os = expr("matrix.os");
  const runner = os.equals("linux").then("ubuntu-latest").else("macos-latest");

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    runsOn: runner,
  }).withSteps(step({ name: "Build", run: "cargo build" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: '\${{ matrix.os == ''linux'' && ''ubuntu-latest'' || ''macos-latest'' }}'
    steps:
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("ternary with elseIf chain", () => {
  setup();
  const os = expr("matrix.os");
  const runner = os.equals("linux").then("ubuntu-latest")
    .elseIf(os.equals("macos")).then("macos-latest")
    .else("windows-latest");

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    runsOn: runner,
  }).withSteps(step({ name: "Build", run: "cargo build" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: '\${{ matrix.os == ''linux'' && ''ubuntu-latest'' || matrix.os == ''macos'' && ''macos-latest'' || ''windows-latest'' }}'
    steps:
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("ternary with ExpressionValue as value", () => {
  setup();
  const matrix = defineMatrix({
    include: [
      { os: "linux", runner: "ubuntu-latest" },
      { os: "macos", runner: "macos-latest" },
    ],
  });
  const result = matrix.os.equals("linux")
    .then(matrix.runner)
    .else("self-hosted");

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    runsOn: result,
    strategy: { matrix },
  }).withSteps(step({ name: "Build", run: "cargo build" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: '\${{ matrix.os == ''linux'' && matrix.runner || ''self-hosted'' }}'
    strategy:
      matrix:
        include:
          - os: linux
            runner: ubuntu-latest
          - os: macos
            runner: macos-latest
    steps:
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("ternary with || condition gets parenthesized", () => {
  setup();
  const os = expr("matrix.os");
  const runner = os.equals("linux").or(os.equals("macos"))
    .then("unix-runner")
    .else("windows-runner");

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    runsOn: runner,
  }).withSteps(step({ name: "Build", run: "cargo build" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: '\${{ (matrix.os == ''linux'' || matrix.os == ''macos'') && ''unix-runner'' || ''windows-runner'' }}'
    steps:
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("ternary with job output infers needs", () => {
  setup();
  const checkStep = step({
    id: "check",
    name: "Check",
    run: "echo 'env=prod' >> $GITHUB_OUTPUT",
    outputs: ["env"],
  });

  const wf = createWorkflow({ name: "test", on: {} });
  const preJob = wf.createJob("pre", {
    runsOn: "ubuntu-latest",
  }).withSteps(checkStep).withOutputs({
    env: checkStep.outputs.env,
  });

  const runner = preJob.outputs.env.equals("prod")
    .then("prod-runner")
    .else("dev-runner");

  wf.createJob("build", {
    runsOn: runner,
  }).withSteps(step({ name: "Build", run: "cargo build" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  pre:
    runs-on: ubuntu-latest
    outputs:
      env: '\${{ steps.check.outputs.env }}'
    steps:
      - name: Check
        id: check
        run: echo 'env=prod' >> $GITHUB_OUTPUT
  build:
    needs:
      - pre
    runs-on: '\${{ needs.pre.outputs.env == ''prod'' && ''prod-runner'' || ''dev-runner'' }}'
    steps:
      - name: Build
        run: cargo build
`,
  );
});

// --- status check functions ---

Deno.test("status.always() in step if", () => {
  setup();
  const build = step({ name: "Build", run: "cargo build" });
  const cleanup = step({
    name: "Cleanup",
    run: "rm -rf target",
    if: status.always(),
  }).dependsOn(build);

  const wf = createWorkflow({ name: "test", on: {} });
  // build passed as leaf to block propagation of always()
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(build, cleanup);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: cargo build
      - name: Cleanup
        if: always()
        run: rm -rf target
`,
  );
});

Deno.test("status.failure() composed with condition", () => {
  setup();
  const os = expr("matrix.os");
  const build = step({ name: "Build", run: "cargo build" });
  const notify = step({
    name: "Notify",
    run: "curl ...",
    if: status.failure().and(os.equals("linux")),
  }).dependsOn(build);

  const wf = createWorkflow({ name: "test", on: {} });
  // build passed as leaf to block propagation of failure()
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(build, notify);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: cargo build
      - name: Notify
        if: failure() && matrix.os == 'linux'
        run: curl ...
`,
  );
});

// --- common condition helpers ---

Deno.test("conditions.isTag() matches any tag", () => {
  setup();
  const s = step({
    name: "Publish",
    run: "cargo publish",
    if: isTag(),
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Publish
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: cargo publish
`,
  );
});

Deno.test("conditions.isTag(name) matches specific tag", () => {
  setup();
  const s = step({
    name: "Release",
    run: "make release",
    if: isTag("v1.0.0"),
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Release
        if: github.ref == 'refs/tags/v1.0.0'
        run: make release
`,
  );
});

Deno.test("conditions.isBranch(name) matches specific branch", () => {
  setup();
  const s = step({
    name: "Deploy",
    run: "deploy.sh",
    if: isBranch("main"),
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        if: github.ref == 'refs/heads/main'
        run: deploy.sh
`,
  );
});

Deno.test("conditions.isEvent(name) matches event type", () => {
  setup();
  const s = step({
    name: "Comment",
    run: "echo PR",
    if: isEvent("pull_request"),
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Comment
        if: github.event_name == 'pull_request'
        run: echo PR
`,
  );
});

Deno.test("conditions compose with .and()", () => {
  setup();
  const s = step({
    name: "Deploy",
    run: "deploy.sh",
    if: isBranch("main").and(isEvent("push")),
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(s);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: deploy.sh
`,
  );
});

Deno.test("not() on comparison parenthesizes correctly", () => {
  setup();
  const matrix = defineMatrix({
    include: [
      { cross: "true" },
      { cross: "false" },
    ],
  });
  const isCross = matrix.cross.equals("true");

  const s = step({
    name: "Build",
    run: "make",
    if: isCross.not(),
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", {
    runsOn: "ubuntu-latest",
    strategy: { matrix },
  }).withSteps(s);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - cross: 'true'
          - cross: 'false'
    steps:
      - name: Build
        if: '!(matrix.cross == ''true'')'
        run: make
`,
  );
});

// --- JobConfig.name with ExpressionValue ---

Deno.test("job name accepts ExpressionValue", () => {
  setup();
  const matrix = defineMatrix({
    include: [
      { target: "x86_64", runner: "ubuntu-latest" },
      { target: "aarch64", runner: "arm-runner" },
    ],
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    name: matrix.target,
    runsOn: matrix.runner,
    strategy: { matrix },
  }).withSteps(step({ name: "Build", run: "make" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    name: '\${{ matrix.target }}'
    runs-on: '\${{ matrix.runner }}'
    strategy:
      matrix:
        include:
          - target: x86_64
            runner: ubuntu-latest
          - target: aarch64
            runner: arm-runner
    steps:
      - name: Build
        run: make
`,
  );
});

// --- custom header comment ---

Deno.test("toYamlString with custom header", () => {
  setup();
  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(
    step({ name: "Build", run: "make" }),
  );

  assertEquals(
    wf.toYamlString({ header: "# GENERATED BY ./ci.generate.ts -- DO NOT DIRECTLY EDIT" }),
    `# GENERATED BY ./ci.generate.ts -- DO NOT DIRECTLY EDIT

name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: make
`,
  );
});

Deno.test("toYamlString with no header by default", () => {
  setup();
  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(
    step({ name: "Build", run: "make" }),
  );

  const yaml = wf.toYamlString();
  assertEquals(yaml.startsWith("name: test\n"), true);
});

// --- withGlobalCondition ---

Deno.test("withGlobalCondition applies to all steps", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const build = step({ name: "Build", run: "make" }).dependsOn(checkout);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" })
    .withGlobalCondition(isBranch("main"))
    .withSteps(build);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        if: github.ref == 'refs/heads/main'
      - name: Build
        if: github.ref == 'refs/heads/main'
        run: make
`,
  );
});

Deno.test("withGlobalCondition ANDs with step condition", () => {
  setup();
  const os = expr("matrix.os");
  const s = step({
    name: "Linux deploy",
    run: "deploy.sh",
    if: os.equals("linux"),
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" })
    .withGlobalCondition(isBranch("main"))
    .withSteps(s);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Linux deploy
        if: github.ref == 'refs/heads/main' && matrix.os == 'linux'
        run: deploy.sh
`,
  );
});

// --- steps() / StepGroup ---

Deno.test("steps() groups steps and dependsOn applies to all", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const group = steps(
    { uses: "dsherret/rust-toolchain-file@v1" },
    { uses: "Swatinem/rust-cache@v2" },
  ).dependsOn(checkout);

  const build = step({ name: "Build", run: "cargo build" }).dependsOn(group);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(build);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - uses: dsherret/rust-toolchain-file@v1
      - uses: Swatinem/rust-cache@v2
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("steps() with existing Step instances", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const toolchain = step({ uses: "dsherret/rust-toolchain-file@v1" });
  const cache = step({ uses: "Swatinem/rust-cache@v2" });
  const group = steps(toolchain, cache).dependsOn(checkout);

  const build = step({ name: "Build", run: "cargo build" }).dependsOn(group);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(build);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - uses: dsherret/rust-toolchain-file@v1
      - uses: Swatinem/rust-cache@v2
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("steps() group passed directly to withSteps", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const group = steps(
    { name: "Setup musl", if: expr("matrix.target").equals("x86_64-musl"), run: "apt install musl" },
    { name: "Setup aarch64", if: expr("matrix.target").equals("aarch64"), run: "apt install gcc-aarch64" },
  ).dependsOn(checkout);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(group);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        if: matrix.target == 'x86_64-musl' || matrix.target == 'aarch64'
      - name: Setup musl
        if: matrix.target == 'x86_64-musl'
        run: apt install musl
      - name: Setup aarch64
        if: matrix.target == 'aarch64'
        run: apt install gcc-aarch64
`,
  );
});

Deno.test("steps() single step behaves like step()", () => {
  setup();
  const group = steps({ name: "Only", run: "echo hi" });
  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(group);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Only
        run: echo hi
`,
  );
});

Deno.test("steps() with no args throws", () => {
  assertThrows(
    () => steps(),
    Error,
    "at least one step",
  );
});

// --- withSteps ordering ---

Deno.test("withSteps order is respected over creation order", () => {
  setup();
  // create steps in one order
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const setupDeno = step({ uses: "denoland/setup-deno@v2" });
  const build = step({ name: "Build", run: "cargo build" }).dependsOn(checkout);
  const lint = step({ name: "Lint", run: "deno lint" }).dependsOn(setupDeno);

  const wf = createWorkflow({ name: "test", on: {} });
  // pass build before lint — setupDeno should appear just before lint, not at the top
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(build, lint);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - name: Build
        run: cargo build
      - uses: denoland/setup-deno@v2
      - name: Lint
        run: deno lint
`,
  );
});

Deno.test("withSteps order with independent leaf steps", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step({ name: "B", run: "b" });
  const c = step({ name: "C", run: "c" });

  const wf = createWorkflow({ name: "test", on: {} });
  // explicitly order: C, A, B
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(c, a, b);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: C
        run: c
      - name: A
        run: a
      - name: B
        run: b
`,
  );
});

// --- StepGroup.if() ---

Deno.test("StepGroup.if() applies condition to all steps", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const group = steps(
    { name: "Build (Release)", run: "cargo build --release" },
    { name: "Build cross (Release)", run: "cross build --release" },
  ).if(conditions.isTag()).dependsOn(checkout);

  const wf = createWorkflow({ name: "test", on: {} });
  // pass checkout as leaf to prevent condition propagation
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(checkout, group);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      - name: Build (Release)
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: cargo build --release
      - name: Build cross (Release)
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: cross build --release
`,
  );
});

Deno.test("StepGroup.if() ANDs with existing step conditions", () => {
  setup();
  const isCross = expr("matrix.cross").equals("true");
  const group = steps(
    step({ name: "Build", if: isCross.not(), run: "cargo build" }),
    step({ name: "Build cross", if: isCross, run: "cross build" }),
  ).if(conditions.isTag());

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(group);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        if: 'startsWith(github.ref, ''refs/tags/'') && !(matrix.cross == ''true'')'
        run: cargo build
      - name: Build cross
        if: 'startsWith(github.ref, ''refs/tags/'') && matrix.cross == ''true'''
        run: cross build
`,
  );
});

// --- condition simplification ---

Deno.test("propagation deduplicates identical conditions", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const isTag = conditions.isTag();
  // three leaf steps with the exact same condition
  const a = step({ name: "A", if: isTag, run: "a" }).dependsOn(checkout);
  const b = step({ name: "B", if: isTag, run: "b" }).dependsOn(checkout);
  const c = step({ name: "C", if: isTag, run: "c" }).dependsOn(checkout);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(a, b, c);

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        if: 'startsWith(github.ref, ''refs/tags/'')'
      - name: A
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: a
      - name: B
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: b
      - name: C
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: c
`,
  );
});

Deno.test("propagation applies absorption: A || (A && B) → A", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const isLinux = expr("matrix.os").equals("linux");
  const isTag = conditions.isTag();
  // leaf A has isTag, leaf B has isTag && isLinux — B is absorbed
  const a = step({ name: "A", if: isTag, run: "a" }).dependsOn(checkout);
  const b = step({ name: "B", if: isTag.and(isLinux), run: "b" }).dependsOn(checkout);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(a, b);

  // checkout should get just isTag, not isTag || (isTag && isLinux)
  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        if: 'startsWith(github.ref, ''refs/tags/'')'
      - name: A
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: a
      - name: B
        if: 'startsWith(github.ref, ''refs/tags/'') && matrix.os == ''linux'''
        run: b
`,
  );
});

Deno.test("propagation simplifies complex dprint-like scenario", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const setup_ = step({ name: "Setup", run: "setup" }).dependsOn(checkout);

  const runTests = expr("matrix.run_tests").equals("true");
  const isTag = conditions.isTag();
  const isNotTag = isTag.not();
  const runDebugTests = runTests.and(isNotTag);
  const isLinuxGnu = expr("matrix.target").equals("x86_64-unknown-linux-gnu");

  // many leaf steps with overlapping conditions
  const clippy = step({
    name: "Clippy",
    if: isLinuxGnu.and(isNotTag),
    run: "clippy",
  }).dependsOn(setup_);
  const testDebug = step({
    name: "Test (Debug)",
    if: runDebugTests,
    run: "test-debug",
  }).dependsOn(setup_);
  const testIntegration = step({
    name: "Test integration",
    if: runDebugTests.and(isLinuxGnu),
    run: "test-integration",
  }).dependsOn(setup_);
  const testRelease = step({
    name: "Test (Release)",
    if: runTests.and(isTag),
    run: "test-release",
  }).dependsOn(setup_);

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(
    clippy,
    testDebug,
    testIntegration,
    testRelease,
  );

  const yaml = wf.toYamlString();
  // checkout and setup should get a simplified condition, not a huge OR
  // simplification: absorption removes (isLinuxGnu && isNotTag) || (runDebugTests && isLinuxGnu) → isLinuxGnu && isNotTag
  // complement elimination merges (runTests && !isTag) || (runTests && isTag) → runTests
  // so we get: (isLinuxGnu && isNotTag) || runTests
  assertEquals(
    yaml,
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        if: '(matrix.target == ''x86_64-unknown-linux-gnu'' && !startsWith(github.ref, ''refs/tags/'')) || matrix.run_tests == ''true'''
      - name: Setup
        if: '(matrix.target == ''x86_64-unknown-linux-gnu'' && !startsWith(github.ref, ''refs/tags/'')) || matrix.run_tests == ''true'''
        run: setup
      - name: Clippy
        if: 'matrix.target == ''x86_64-unknown-linux-gnu'' && !startsWith(github.ref, ''refs/tags/'')'
        run: clippy
      - name: Test (Debug)
        if: 'matrix.run_tests == ''true'' && !startsWith(github.ref, ''refs/tags/'')'
        run: test-debug
      - name: Test integration
        if: 'matrix.run_tests == ''true'' && !startsWith(github.ref, ''refs/tags/'') && matrix.target == ''x86_64-unknown-linux-gnu'''
        run: test-integration
      - name: Test (Release)
        if: 'matrix.run_tests == ''true'' && startsWith(github.ref, ''refs/tags/'')'
        run: test-release
`,
  );
});

// --- reusable workflow support ---

Deno.test("workflow_call trigger with inputs, outputs, and secrets", () => {
  setup();
  const wf = createWorkflow({
    name: "Reusable Build",
    on: {
      workflow_call: {
        inputs: {
          environment: { type: "string", required: true },
          deploy: { type: "boolean", default: false },
        },
        outputs: {
          artifact_name: {
            description: "Name of the build artifact",
            value: "${{ jobs.build.outputs.artifact }}",
          },
        },
        secrets: {
          deploy_token: { required: true },
        },
      },
    },
  });

  const build = step({ name: "Build", run: "cargo build" });
  wf.createJob("build", { runsOn: "ubuntu-latest" }).withSteps(build);

  assertEquals(
    wf.toYamlString(),
    `name: Reusable Build
on:
  workflow_call:
    inputs:
      environment:
        type: string
        required: true
      deploy:
        type: boolean
        default: false
    outputs:
      artifact_name:
        description: Name of the build artifact
        value: '\${{ jobs.build.outputs.artifact }}'
    secrets:
      deploy_token:
        required: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("reusable workflow job with uses and secrets inherit", () => {
  setup();
  const wf = createWorkflow({
    name: "CI",
    on: { push: { branches: ["main"] } },
  });

  const build = step({ name: "Build", run: "cargo build" });
  wf.createJob("build", { runsOn: "ubuntu-latest" }).withSteps(build);

  wf.createJob("deploy", {
    uses: "org/repo/.github/workflows/deploy.yml@main",
    with: { environment: "production" },
    secrets: "inherit",
  });

  assertEquals(
    wf.toYamlString(),
    `name: CI
on:
  push:
    branches:
      - main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: cargo build
  deploy:
    uses: org/repo/.github/workflows/deploy.yml@main
    with:
      environment: production
    secrets: inherit
`,
  );
});

Deno.test("reusable workflow job with object secrets", () => {
  setup();
  const wf = createWorkflow({
    name: "CI",
    on: { push: { branches: ["main"] } },
  });

  wf.createJob("deploy", {
    uses: "org/repo/.github/workflows/deploy.yml@main",
    with: { environment: "production", version: 3 },
    secrets: {
      deploy_token: expr("secrets.DEPLOY_TOKEN"),
      api_key: expr("secrets.API_KEY"),
    },
  });

  assertEquals(
    wf.toYamlString(),
    `name: CI
on:
  push:
    branches:
      - main
jobs:
  deploy:
    uses: org/repo/.github/workflows/deploy.yml@main
    with:
      environment: production
      version: 3
    secrets:
      deploy_token: '\${{ secrets.DEPLOY_TOKEN }}'
      api_key: '\${{ secrets.API_KEY }}'
`,
  );
});

Deno.test("reusable workflow job with needs and if", () => {
  setup();
  const wf = createWorkflow({
    name: "CI",
    on: { push: { branches: ["main"] } },
  });

  const buildStep = step({ name: "Build", run: "cargo build" });
  const buildJob = wf.createJob("build", { runsOn: "ubuntu-latest" })
    .withSteps(buildStep);

  wf.createJob("deploy", {
    uses: "org/repo/.github/workflows/deploy.yml@main",
    needs: [buildJob],
    if: conditions.isTag(),
    secrets: "inherit",
  });

  assertEquals(
    wf.toYamlString(),
    `name: CI
on:
  push:
    branches:
      - main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: cargo build
  deploy:
    needs:
      - build
    if: 'startsWith(github.ref, ''refs/tags/'')'
    uses: org/repo/.github/workflows/deploy.yml@main
    secrets: inherit
`,
  );
});

Deno.test("reusable workflow job throws on withSteps", () => {
  setup();
  const wf = createWorkflow({
    name: "CI",
    on: { push: { branches: ["main"] } },
  });

  const job = wf.createJob("deploy", {
    uses: "org/repo/.github/workflows/deploy.yml@main",
  });

  assertThrows(
    () => job.withSteps(step({ run: "echo hi" })),
    Error,
    "Cannot add steps to a reusable workflow job",
  );
});

Deno.test("reusable workflow job throws on withOutputs", () => {
  setup();
  const wf = createWorkflow({
    name: "CI",
    on: { push: { branches: ["main"] } },
  });

  const job = wf.createJob("deploy", {
    uses: "org/repo/.github/workflows/deploy.yml@main",
  });

  assertThrows(
    () => job.withOutputs({ foo: expr("bar") }),
    Error,
    "Cannot add outputs to a reusable workflow job",
  );
});

// --- matrix exclude ---

Deno.test("matrix with exclude serializes correctly", () => {
  setup();
  const matrix = defineMatrix({
    os: ["linux", "macos", "windows"],
    node: [18, 20, 22],
    exclude: [
      { os: "macos", node: 18 },
    ],
  });

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    runsOn: "ubuntu-latest",
    strategy: { matrix },
  }).withSteps(step({ name: "Build", run: "npm test" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os:
          - linux
          - macos
          - windows
        node:
          - 18
          - 20
          - 22
        exclude:
          - os: macos
            node: 18
    steps:
      - name: Build
        run: npm test
`,
  );
});

Deno.test("matrix exclude with include together", () => {
  setup();
  const matrix = defineMatrix({
    os: ["linux", "macos"],
    node: [18, 20],
    include: [
      { os: "linux", node: 22, experimental: true },
    ],
    exclude: [
      { os: "macos", node: 18 },
    ],
  });

  // include keys are available as expressions
  assertEquals(matrix.experimental.toString(), "${{ matrix.experimental }}");

  const wf = createWorkflow({ name: "test", on: {} });
  wf.createJob("build", {
    runsOn: "ubuntu-latest",
    strategy: { matrix },
  }).withSteps(step({ name: "Build", run: "npm test" }));

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os:
          - linux
          - macos
        node:
          - 18
          - 20
        include:
          - os: linux
            node: 22
            experimental: true
        exclude:
          - os: macos
            node: 18
    steps:
      - name: Build
        run: npm test
`,
  );
});

Deno.test("exclude keys don't add new matrix expression keys", () => {
  setup();
  const matrix = defineMatrix({
    os: ["linux", "macos"],
    exclude: [
      { os: "macos" },
    ],
  });

  // os is available (from key-value array)
  assertEquals(matrix.os.toString(), "${{ matrix.os }}");

  // exclude doesn't create new expression keys — only "os" exists
  // (TypeScript also enforces this at compile time via ExtractMatrixKeys)
  const m = matrix as unknown as Record<string, unknown>;
  const keys = Object.keys(m).filter(
    (k) => m[k] instanceof Object &&
      "expression" in (m[k] as Record<string, unknown>),
  );
  assertEquals(keys, ["os"]);
});

// --- type-safe permissions ---

Deno.test("object permissions serialize as map", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: { push: { branches: ["main"] } },
    permissions: {
      contents: "read",
      "pull-requests": "write",
      "id-token": "none",
    },
  });
  wf.createJob("j", { runsOn: "ubuntu-latest" })
    .withSteps(step({ name: "S", run: "echo hi" }));

  assertEquals(
    wf.toYamlString(),
    `name: ci
on:
  push:
    branches:
      - main
permissions:
  contents: read
  pull-requests: write
  id-token: none
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: S
        run: echo hi
`,
  );
});

Deno.test("read-all permissions serialize as scalar string", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: { push: { branches: ["main"] } },
    permissions: "read-all",
  });
  wf.createJob("j", { runsOn: "ubuntu-latest" })
    .withSteps(step({ name: "S", run: "echo hi" }));

  assertEquals(
    wf.toYamlString(),
    `name: ci
on:
  push:
    branches:
      - main
permissions: read-all
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: S
        run: echo hi
`,
  );
});

Deno.test("job-level permissions serialize correctly", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: { push: { branches: ["main"] } },
  });
  wf.createJob("j", {
    runsOn: "ubuntu-latest",
    permissions: { contents: "write", packages: "read" },
  }).withSteps(step({ name: "S", run: "echo hi" }));

  assertEquals(
    wf.toYamlString(),
    `name: ci
on:
  push:
    branches:
      - main
jobs:
  j:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: read
    steps:
      - name: S
        run: echo hi
`,
  );
});
