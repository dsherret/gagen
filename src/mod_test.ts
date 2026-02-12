import process from "node:process";
import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "@std/yaml/parse";
import { stringify } from "@std/yaml/stringify";
import {
  conditions,
  createWorkflow,
  defineArtifact,
  defineMatrix,
  expr,
  job,
  step,
  StepRef,
} from "./mod.ts";
import { resolveJobId, toKebabCase } from "./job.ts";
import { resetStepCounter } from "./step.ts";

const { status, isTag, isBranch, isEvent, isRunnerOs, isRunnerArch } =
  conditions;

// reset step counter between tests for deterministic ids
function setup() {
  resetStepCounter();
}

// --- writeOrLint ---

Deno.test("writeOrLint writes file when not linting", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: "ubuntu-latest",
        steps: [step({ name: "Test", run: "echo hi" })],
      },
    ],
  });

  const tmpDir = Deno.makeTempDirSync();
  const filePath = new URL(`file://${tmpDir}/ci.yml`);

  try {
    wf.writeOrLint({ filePath });

    const written = Deno.readTextFileSync(filePath);
    assertEquals(written, wf.toYamlString());
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeOrLint lint passes when yaml matches", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: "ubuntu-latest",
        steps: [step({ name: "Test", run: "echo hi" })],
      },
    ],
  });

  const tmpDir = Deno.makeTempDirSync();
  const filePath = new URL(`file://${tmpDir}/ci.yml`);

  // write the expected output
  Deno.writeTextFileSync(filePath, wf.toYamlString());

  const originalArgv = [...process.argv];
  process.argv.push("--lint");
  try {
    wf.writeOrLint({ filePath });
  } finally {
    process.argv.length = originalArgv.length;
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeOrLint lint passes with different formatting", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: "ubuntu-latest",
        steps: [step({ name: "Test", run: "echo hi" })],
      },
    ],
  });

  const tmpDir = Deno.makeTempDirSync();
  const filePath = new URL(`file://${tmpDir}/ci.yml`);

  // write equivalent yaml with different formatting (re-stringify from parsed)
  const yamlObj = parse(wf.toYamlString());
  const reformatted = stringify(yamlObj as Record<string, unknown>, {
    lineWidth: 80,
  });
  Deno.writeTextFileSync(filePath, reformatted);

  const originalArgv = [...process.argv];
  process.argv.push("--lint");
  try {
    wf.writeOrLint({ filePath });
  } finally {
    process.argv.length = originalArgv.length;
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("writeOrLint lint passes when file has header comment", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: "ubuntu-latest",
        steps: [step({ name: "Test", run: "echo hi" })],
      },
    ],
  });

  const tmpDir = Deno.makeTempDirSync();
  const filePath = new URL(`file://${tmpDir}/ci.yml`);

  // write yaml with a header comment — parse() strips comments
  Deno.writeTextFileSync(filePath, "# generated\n" + wf.toYamlString());

  const originalArgv = [...process.argv];
  process.argv.push("--lint");
  try {
    wf.writeOrLint({ filePath });
  } finally {
    process.argv.length = originalArgv.length;
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

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
    jobs: [
      {
        id: "build",
        name: "build",
        runsOn: "ubuntu-latest",
        steps: [cargoTest],
      },
      { id: "lint", runsOn: "ubuntu-latest", steps: [cargoBuild] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [d] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [a] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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

  const preBuild = job("pre_build", {
    runsOn: "ubuntu-latest",
    steps: [checkStep],
    outputs: { skip: checkStep.outputs.skip },
  });

  const buildStep = step({ name: "Build", run: "cargo build" });
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      preBuild,
      {
        id: "build",
        runsOn: "ubuntu-latest",
        if: preBuild.outputs.skip.notEquals("true"),
        steps: [buildStep],
      },
    ],
  });

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
  const jobA = job("a", {
    runsOn: "ubuntu-latest",
    steps: [step({ name: "A", run: "echo a" })],
  });
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      jobA,
      {
        id: "b",
        runsOn: "ubuntu-latest",
        needs: [jobA],
        steps: [step({ name: "B", run: "echo b" })],
      },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "check_job",
        runsOn: "ubuntu-latest",
        steps: [checkStep],
        outputs: { result: checkStep.outputs.result },
      },
    ],
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

Deno.test("cycle detection throws with cycle path", () => {
  setup();
  const a = step({ name: "A" });
  const b = step({ name: "B" });
  // create cycle: a depends on b, b depends on a
  const bRef = b.dependsOn(a);
  const aRef = a.dependsOn(bRef);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [aRef] },
    ],
  });

  assertThrows(
    () => wf.toYamlString(),
    Error,
    "Cycle detected in step ordering: A → B → A",
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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "j",
        runsOn: "ubuntu-latest",
        defaults: { run: { shell: "bash" } },
        steps: [step({ name: "S", run: "echo hi" })],
      },
    ],
  });

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
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "j",
        runsOn: "ubuntu-latest",
        timeoutMinutes: 60,
        steps: [step({ name: "S", run: "echo hi" })],
      },
    ],
  });

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
    jobs: [
      {
        id: "j",
        runsOn: "ubuntu-latest",
        steps: [step({ name: "S", run: "echo hi" })],
      },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [test] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [test, bench] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [test, lint] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [test] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [test] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [test, linuxOnly] },
    ],
  });

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

Deno.test("leaf steps passed to steps do not get propagation", () => {
  setup();
  const a = step({
    name: "A",
    if: expr("matrix.os").equals("linux"),
  });
  const b = step({
    name: "B",
    if: expr("matrix.job").equals("test"),
  }).dependsOn(a);

  // both are explicitly passed to steps
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [a, b] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: matrix.runner,
        strategy: { matrix },
        steps: [step({ name: "Build", run: "cargo build" })],
      },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: "ubuntu-latest",
        strategy: { matrix, failFast: false },
        steps: [step({ name: "Build", run: "cargo build" })],
      },
    ],
  });

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

Deno.test("matrix values with Condition/ExpressionValue auto-serialize to ${{ }}", () => {
  setup();
  const isDenoland = expr("github.repository").equals("denoland/deno");
  const isMainBranch = isBranch("main");
  const isMainOrTag = isMainBranch.or(isTag());

  const matrix = defineMatrix({
    include: [
      {
        os: "linux",
        runner: isDenoland.then("xl-runner").else("ubuntu-latest"),
        skip: isMainOrTag.not(),
      },
      {
        os: "macos",
        runner: "macos-latest",
        skip: false,
      },
    ],
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "build",
      runsOn: matrix.runner,
      strategy: { matrix },
      steps: [step({ name: "Build", run: "make" })],
    }],
  });

  const yaml = wf.toYamlString();
  const parsed = parse(yaml) as Record<string, unknown>;
  const jobs = parsed.jobs as Record<
    string,
    { strategy: { matrix: { include: Record<string, unknown>[] } } }
  >;
  const include = jobs.build.strategy.matrix.include;

  // Condition and ExpressionValue should be auto-wrapped in ${{ }}
  assertEquals(
    include[0].runner,
    "${{ github.repository == 'denoland/deno' && 'xl-runner' || 'ubuntu-latest' }}",
  );
  assertEquals(
    include[0].skip,
    "${{ !(github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')) }}",
  );

  // plain values should be unchanged
  assertEquals(include[1].runner, "macos-latest");
  assertEquals(include[1].skip, false);
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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: "ubuntu-latest",
        strategy: { matrix },
        steps: [linuxStep],
      },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: runner,
        steps: [step({ name: "Build", run: "cargo build" })],
      },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: runner,
        steps: [step({ name: "Build", run: "cargo build" })],
      },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: result,
        strategy: { matrix },
        steps: [step({ name: "Build", run: "cargo build" })],
      },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: runner,
        steps: [step({ name: "Build", run: "cargo build" })],
      },
    ],
  });

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

  const preJob = job("pre", {
    runsOn: "ubuntu-latest",
    steps: [checkStep],
    outputs: { env: checkStep.outputs.env },
  });

  const runner = preJob.outputs.env.equals("prod")
    .then("prod-runner")
    .else("dev-runner");

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      preJob,
      {
        id: "build",
        runsOn: runner,
        steps: [step({ name: "Build", run: "cargo build" })],
      },
    ],
  });

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

  // build passed as leaf to block propagation of always()
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [build, cleanup] },
    ],
  });

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

  // build passed as leaf to block propagation of failure()
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [build, notify] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", strategy: { matrix }, steps: [s] },
    ],
  });

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
        if: matrix.cross != 'true'
        run: make
`,
  );
});

Deno.test("conditions.isRunnerOs() matches runner OS", () => {
  setup();
  const s = step({
    name: "Linux only",
    run: "echo hi",
    if: isRunnerOs("Linux"),
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Linux only
        if: runner.os == 'Linux'
        run: echo hi
`,
  );
});

Deno.test("conditions.isRunnerArch() matches runner architecture", () => {
  setup();
  const s = step({
    name: "ARM64 only",
    run: "echo hi",
    if: isRunnerArch("ARM64"),
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: ARM64 only
        if: runner.arch == 'ARM64'
        run: echo hi
`,
  );
});

Deno.test("conditions.isRunnerOs().not() negates correctly", () => {
  setup();
  const s = step({
    name: "Not Windows",
    run: "echo hi",
    if: isRunnerOs("Windows").not(),
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Not Windows
        if: runner.os != 'Windows'
        run: echo hi
`,
  );
});

Deno.test("conditions.isRunnerOs() composes with .and()", () => {
  setup();
  const s = step({
    name: "Linux ARM64",
    run: "echo hi",
    if: isRunnerOs("Linux").and(isRunnerArch("ARM64")),
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Linux ARM64
        if: runner.os == 'Linux' && runner.arch == 'ARM64'
        run: echo hi
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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        name: matrix.target,
        runsOn: matrix.runner,
        strategy: { matrix },
        steps: [step({ name: "Build", run: "make" })],
      },
    ],
  });

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
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "j",
        runsOn: "ubuntu-latest",
        steps: [step({ name: "Build", run: "make" })],
      },
    ],
  });

  assertEquals(
    wf.toYamlString({
      header: "# GENERATED BY ./ci.generate.ts -- DO NOT DIRECTLY EDIT",
    }),
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
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "j",
        runsOn: "ubuntu-latest",
        steps: [step({ name: "Build", run: "make" })],
      },
    ],
  });

  const yaml = wf.toYamlString();
  assertEquals(yaml.startsWith("name: test\n"), true);
});

// --- step().if() as global condition ---

Deno.test("step().if() applies condition to all steps", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const build = step({ name: "Build", run: "make" }).dependsOn(checkout);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [build.if(isBranch("main"))],
    }],
  });

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

Deno.test("step().if() ANDs with step condition", () => {
  setup();
  const os = expr("matrix.os");
  const s = step({
    name: "Linux deploy",
    run: "deploy.sh",
    if: os.equals("linux"),
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [s.if(isBranch("main"))],
    }],
  });

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

// --- step() composite / grouping ---

Deno.test("step() groups steps and dependsOn applies to all", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const group = step(
    { uses: "dsherret/rust-toolchain-file@v1" },
    { uses: "Swatinem/rust-cache@v2" },
  ).dependsOn(checkout);

  const build = step({ name: "Build", run: "cargo build" }).dependsOn(group);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [build] },
    ],
  });

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

Deno.test("step() composite with existing Step instances", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const toolchain = step({ uses: "dsherret/rust-toolchain-file@v1" });
  const cache = step({ uses: "Swatinem/rust-cache@v2" });
  const group = step(toolchain, cache).dependsOn(checkout);

  const build = step({ name: "Build", run: "cargo build" }).dependsOn(group);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [build] },
    ],
  });

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

Deno.test("step() composite passed directly to steps", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const group = step(
    {
      name: "Setup musl",
      if: expr("matrix.target").equals("x86_64-musl"),
      run: "apt install musl",
    },
    {
      name: "Setup aarch64",
      if: expr("matrix.target").equals("aarch64"),
      run: "apt install gcc-aarch64",
    },
  ).dependsOn(checkout);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [group] },
    ],
  });

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

Deno.test("step() single config behaves as leaf step", () => {
  setup();
  const s = step({ name: "Only", run: "echo hi" });
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [s] },
    ],
  });

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

// --- steps ordering ---

Deno.test("steps order is respected over creation order", () => {
  setup();
  // create steps in one order
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const setupDeno = step({ uses: "denoland/setup-deno@v2" });
  const build = step({ name: "Build", run: "cargo build" }).dependsOn(checkout);
  const lint = step({ name: "Lint", run: "deno lint" }).dependsOn(setupDeno);

  // pass build before lint — setupDeno should appear just before lint, not at the top
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [build, lint] },
    ],
  });

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

Deno.test("steps order with independent leaf steps", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step({ name: "B", run: "b" });
  const c = step({ name: "C", run: "c" });

  // explicitly order: C, A, B
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [c, a, b] },
    ],
  });

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

// --- composite step .if() ---

Deno.test("composite step .if() applies condition to all steps", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const group = step(
    { name: "Build (Release)", run: "cargo build --release" },
    { name: "Build cross (Release)", run: "cross build --release" },
  ).if(conditions.isTag()).dependsOn(checkout);

  // pass checkout as leaf to prevent condition propagation
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [checkout, group] },
    ],
  });

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

Deno.test("composite step .if() ANDs with existing step conditions", () => {
  setup();
  const isCross = expr("matrix.cross").equals("true");
  const group = step(
    step({ name: "Build", if: isCross.not(), run: "cargo build" }),
    step({ name: "Build cross", if: isCross, run: "cross build" }),
  ).if(conditions.isTag());

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [group] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        if: 'startsWith(github.ref, ''refs/tags/'') && matrix.cross != ''true'''
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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [a, b, c] },
    ],
  });

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
  const b = step({ name: "B", if: isTag.and(isLinux), run: "b" }).dependsOn(
    checkout,
  );

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [a, b] },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "j",
        runsOn: "ubuntu-latest",
        steps: [clippy, testDebug, testIntegration, testRelease],
      },
    ],
  });

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

Deno.test("common factor extraction: (A && C) || (B && C) → C && (A || B)", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const isTag = conditions.isTag();
  const isLinux = expr("matrix.os").equals("linux");
  const isMac = expr("matrix.os").equals("macos");

  // both leaves share isTag, differ on OS
  const a = step({ name: "A", if: isLinux.and(isTag), run: "a" }).dependsOn(
    checkout,
  );
  const b = step({ name: "B", if: isMac.and(isTag), run: "b" }).dependsOn(
    checkout,
  );

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [a, b] },
    ],
  });

  // checkout should get: isTag && (isLinux || isMac) — common factor extracted
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
        if: 'startsWith(github.ref, ''refs/tags/'') && (matrix.os == ''linux'' || matrix.os == ''macos'')'
      - name: A
        if: 'matrix.os == ''linux'' && startsWith(github.ref, ''refs/tags/'')'
        run: a
      - name: B
        if: 'matrix.os == ''macos'' && startsWith(github.ref, ''refs/tags/'')'
        run: b
`,
  );
});

Deno.test("common factor extraction: (A && B && C) || (A && D && C) → A && C && (B || D)", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const isTag = conditions.isTag();
  const runTests = expr("matrix.run_tests").equals("true");
  const target1 = expr("matrix.target").equals("x86_64");
  const target2 = expr("matrix.target").equals("aarch64");

  // both share isTag && runTests, differ on target
  const a = step({ name: "A", if: runTests.and(isTag).and(target1), run: "a" })
    .dependsOn(checkout);
  const b = step({ name: "B", if: runTests.and(isTag).and(target2), run: "b" })
    .dependsOn(checkout);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [a, b] },
    ],
  });

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
        if: 'matrix.run_tests == ''true'' && startsWith(github.ref, ''refs/tags/'') && (matrix.target == ''x86_64'' || matrix.target == ''aarch64'')'
      - name: A
        if: 'matrix.run_tests == ''true'' && startsWith(github.ref, ''refs/tags/'') && matrix.target == ''x86_64'''
        run: a
      - name: B
        if: 'matrix.run_tests == ''true'' && startsWith(github.ref, ''refs/tags/'') && matrix.target == ''aarch64'''
        run: b
`,
  );
});

Deno.test("no common factor when not all branches share a term", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const isTag = conditions.isTag();
  const isLinux = expr("matrix.os").equals("linux");
  const isMac = expr("matrix.os").equals("macos");
  const isWindows = expr("matrix.os").equals("windows");

  // A and B share isTag, but C (isWindows) does not — no common factor
  const a = step({ name: "A", if: isLinux.and(isTag), run: "a" }).dependsOn(
    checkout,
  );
  const b = step({ name: "B", if: isMac.and(isTag), run: "b" }).dependsOn(
    checkout,
  );
  const c = step({ name: "C", if: isWindows, run: "c" }).dependsOn(checkout);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [a, b, c] },
    ],
  });

  // checkout should get the raw OR since no common factor across all three
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
        if: '(matrix.os == ''linux'' && startsWith(github.ref, ''refs/tags/'')) || (matrix.os == ''macos'' && startsWith(github.ref, ''refs/tags/'')) || matrix.os == ''windows'''
      - name: A
        if: 'matrix.os == ''linux'' && startsWith(github.ref, ''refs/tags/'')'
        run: a
      - name: B
        if: 'matrix.os == ''macos'' && startsWith(github.ref, ''refs/tags/'')'
        run: b
      - name: C
        if: matrix.os == 'windows'
        run: c
`,
  );
});

// --- reusable workflow support ---

Deno.test("workflow_call trigger with inputs, outputs, and secrets", () => {
  setup();
  const build = step({ name: "Build", run: "cargo build" });
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
    jobs: [
      { id: "build", runsOn: "ubuntu-latest", steps: [build] },
    ],
  });

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
  const build = step({ name: "Build", run: "cargo build" });
  const wf = createWorkflow({
    name: "CI",
    on: { push: { branches: ["main"] } },
    jobs: [
      { id: "build", runsOn: "ubuntu-latest", steps: [build] },
      {
        id: "deploy",
        uses: "org/repo/.github/workflows/deploy.yml@main",
        with: { environment: "production" },
        secrets: "inherit",
      },
    ],
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
    jobs: [
      {
        id: "deploy",
        uses: "org/repo/.github/workflows/deploy.yml@main",
        with: { environment: "production", version: 3 },
        secrets: {
          deploy_token: expr("secrets.DEPLOY_TOKEN"),
          api_key: expr("secrets.API_KEY"),
        },
      },
    ],
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
  const buildStep = step({ name: "Build", run: "cargo build" });
  const buildJob = job("build", {
    runsOn: "ubuntu-latest",
    steps: [buildStep],
  });
  const wf = createWorkflow({
    name: "CI",
    on: { push: { branches: ["main"] } },
    jobs: [
      buildJob,
      {
        id: "deploy",
        uses: "org/repo/.github/workflows/deploy.yml@main",
        needs: [buildJob],
        if: conditions.isTag(),
        secrets: "inherit",
      },
    ],
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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: "ubuntu-latest",
        strategy: { matrix },
        steps: [step({ name: "Build", run: "npm test" })],
      },
    ],
  });

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

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "build",
        runsOn: "ubuntu-latest",
        strategy: { matrix },
        steps: [step({ name: "Build", run: "npm test" })],
      },
    ],
  });

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
    (k) =>
      m[k] instanceof Object &&
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
    jobs: [
      {
        id: "j",
        runsOn: "ubuntu-latest",
        steps: [step({ name: "S", run: "echo hi" })],
      },
    ],
  });

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
    jobs: [
      {
        id: "j",
        runsOn: "ubuntu-latest",
        steps: [step({ name: "S", run: "echo hi" })],
      },
    ],
  });

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
    jobs: [
      {
        id: "j",
        runsOn: "ubuntu-latest",
        permissions: { contents: "write", packages: "read" },
        steps: [step({ name: "S", run: "echo hi" })],
      },
    ],
  });

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

// --- artifact linking ---

Deno.test("upload step serializes correctly", () => {
  setup();
  const artifact = defineArtifact("build-output");
  const upload = artifact.upload({ path: "dist/" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "build", runsOn: "ubuntu-latest", steps: [upload] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: build-output
          path: dist/
`,
  );
});

Deno.test("upload step with custom retention days", () => {
  setup();
  const artifact = defineArtifact("build-output");
  const upload = artifact.upload({ path: "dist/", retentionDays: 5 });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "build", runsOn: "ubuntu-latest", steps: [upload] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: build-output
          path: dist/
          retention-days: 5
`,
  );
});

Deno.test("download in same job doesn't add needs", () => {
  setup();
  const artifact = defineArtifact("build-output");
  const upload = artifact.upload({ path: "dist/" });
  const download = artifact.download({ path: "dist/" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "build", runsOn: "ubuntu-latest", steps: [upload, download] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: build-output
          path: dist/
      - uses: actions/download-artifact@v6
        with:
          name: build-output
          path: dist/
`,
  );
});

Deno.test("download in different job auto-infers needs", () => {
  setup();
  const artifact = defineArtifact("build-output");
  const upload = artifact.upload({ path: "dist/" });
  const download = artifact.download({ path: "dist/" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "build", runsOn: "ubuntu-latest", steps: [upload] },
      { id: "deploy", runsOn: "ubuntu-latest", steps: [download] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v6
        with:
          name: build-output
          path: dist/
  deploy:
    needs:
      - build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v6
        with:
          name: build-output
          path: dist/
`,
  );
});

Deno.test("artifact with custom version", () => {
  setup();
  const artifact = defineArtifact("build-output", { version: "v3" });
  const upload = artifact.upload({ path: "dist/" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "build", runsOn: "ubuntu-latest", steps: [upload] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v3
        with:
          name: build-output
          path: dist/
`,
  );
});

// --- services ---

Deno.test("single service serializes correctly", () => {
  setup();
  const s = step({ name: "Test", run: "npm test" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "test",
        runsOn: "ubuntu-latest",
        services: {
          postgres: {
            image: "postgres:15",
            env: { POSTGRES_PASSWORD: "test" },
            ports: ["5432:5432"],
            options: "--health-cmd pg_isready --health-interval 10s",
          },
        },
        steps: [s],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: 'postgres:15'
        env:
          POSTGRES_PASSWORD: test
        ports:
          - '5432:5432'
        options: '--health-cmd pg_isready --health-interval 10s'
    steps:
      - name: Test
        run: npm test
`,
  );
});

Deno.test("multiple services", () => {
  setup();
  const s = step({ name: "Test", run: "npm test" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "test",
        runsOn: "ubuntu-latest",
        services: {
          postgres: {
            image: "postgres:15",
            ports: ["5432:5432"],
          },
          redis: {
            image: "redis:7",
            ports: ["6379:6379"],
          },
        },
        steps: [s],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: 'postgres:15'
        ports:
          - '5432:5432'
      redis:
        image: 'redis:7'
        ports:
          - '6379:6379'
    steps:
      - name: Test
        run: npm test
`,
  );
});

Deno.test("service with credentials using ExpressionValue", () => {
  setup();
  const s = step({ name: "Test", run: "npm test" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "test",
        runsOn: "ubuntu-latest",
        services: {
          registry: {
            image: "ghcr.io/my-org/my-image:latest",
            credentials: {
              username: "bot",
              password: expr("secrets.GHCR_TOKEN"),
            },
          },
        },
        steps: [s],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      registry:
        image: 'ghcr.io/my-org/my-image:latest'
        credentials:
          username: bot
          password: '\${{ secrets.GHCR_TOKEN }}'
    steps:
      - name: Test
        run: npm test
`,
  );
});

Deno.test("service env with ExpressionValue", () => {
  setup();
  const s = step({ name: "Test", run: "npm test" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "test",
        runsOn: "ubuntu-latest",
        services: {
          db: {
            image: "postgres:15",
            env: {
              POSTGRES_PASSWORD: expr("secrets.DB_PASSWORD"),
              POSTGRES_DB: "testdb",
            },
            volumes: ["data:/var/lib/postgresql/data"],
          },
        },
        steps: [s],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      db:
        image: 'postgres:15'
        env:
          POSTGRES_PASSWORD: '\${{ secrets.DB_PASSWORD }}'
          POSTGRES_DB: testdb
        volumes:
          - 'data:/var/lib/postgresql/data'
    steps:
      - name: Test
        run: npm test
`,
  );
});

// --- job() function and jobs config ---

Deno.test("jobs config with plain object", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const test = step({ name: "Test", run: "cargo test" }).dependsOn(checkout);

  const wf = createWorkflow({
    name: "ci",
    on: { push: { branches: ["main"] } },
    jobs: [
      { id: "build", runsOn: "ubuntu-latest", steps: [test] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on:
  push:
    branches:
      - main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Test
        run: cargo test
`,
  );
});

Deno.test("jobs config with job() instance", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const test = step({ name: "Test", run: "cargo test" }).dependsOn(checkout);

  const build = job("build", {
    runsOn: "ubuntu-latest",
    steps: [test],
  });

  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [build],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Test
        run: cargo test
`,
  );
});

Deno.test("job() with outputs enables cross-job references", () => {
  setup();
  const checkStep = step({
    id: "check",
    name: "Check",
    run: "echo 'skip=true' >> $GITHUB_OUTPUT",
    outputs: ["skip"],
  });

  const preBuild = job("pre_build", {
    runsOn: "ubuntu-latest",
    steps: [checkStep],
    outputs: { skip: checkStep.outputs.skip },
  });

  const buildStep = step({ name: "Build", run: "make build" });

  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [
      preBuild,
      {
        id: "build",
        runsOn: "ubuntu-latest",
        if: preBuild.outputs.skip.notEquals("true"),
        steps: [buildStep],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
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
        run: make build
`,
  );
});

Deno.test("jobs config with reusable workflow", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "deploy",
        uses: "org/repo/.github/workflows/deploy.yml@main",
        with: { environment: "production" },
        secrets: "inherit",
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  deploy:
    uses: org/repo/.github/workflows/deploy.yml@main
    with:
      environment: production
    secrets: inherit
`,
  );
});

Deno.test("job() with step().if() condition", () => {
  setup();
  const s = step({ name: "Test", run: "echo hi" });

  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [{
      id: "build",
      runsOn: "ubuntu-latest",
      steps: [s.if(conditions.isBranch("main"))],
    }],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Test
        if: github.ref == 'refs/heads/main'
        run: echo hi
`,
  );
});

// --- array-based job ID resolution ---

Deno.test("toKebabCase converts name to kebab-case", () => {
  assertEquals(toKebabCase("Build & Test"), "build-test");
  assertEquals(toKebabCase("  Hello World  "), "hello-world");
  assertEquals(toKebabCase("CI/CD Pipeline"), "ci-cd-pipeline");
  assertEquals(toKebabCase("already-kebab"), "already-kebab");
  assertEquals(toKebabCase("UPPER CASE"), "upper-case");
});

Deno.test("job ID derived from name via kebab-case", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [
      {
        name: "Build & Test",
        runsOn: "ubuntu-latest",
        steps: [step({ run: "echo hi" })],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  build-test:
    name: Build & Test
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
  );
});

Deno.test("explicit id takes precedence over name", () => {
  setup();
  const wf = createWorkflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "custom_id",
        name: "Build & Test",
        runsOn: "ubuntu-latest",
        steps: [step({ run: "echo hi" })],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  custom_id:
    name: Build & Test
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
  );
});

Deno.test("resolveJobId throws when no id and no name", () => {
  assertThrows(
    () =>
      resolveJobId({
        runsOn: "ubuntu-latest",
        steps: [step({ run: "echo hi" })],
      }),
    Error,
    "must have either an `id` or a string `name`",
  );
});

Deno.test("duplicate job id in array throws", () => {
  setup();
  assertThrows(
    () =>
      createWorkflow({
        name: "ci",
        on: {},
        jobs: [
          {
            id: "build",
            runsOn: "ubuntu-latest",
            steps: [step({ run: "echo a" })],
          },
          {
            id: "build",
            runsOn: "ubuntu-latest",
            steps: [step({ run: "echo b" })],
          },
        ],
      }),
    Error,
    'Duplicate job id: "build"',
  );
});

// --- comesAfter ---

Deno.test("comesAfter puts step after another", () => {
  setup();
  const setupDeno = step({
    uses: "denoland/setup-deno@v2",
    with: { "deno-version": "canary" },
  });
  const checkoutStep = step({ uses: "actions/checkout@v6" });
  const checkout = checkoutStep.comesAfter(setupDeno);
  const build = step({ name: "Build", run: "cargo build" }).dependsOn(checkout);
  const lint = step({ name: "Lint", run: "deno lint" }).dependsOn(
    setupDeno,
    checkout,
  );

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [build, lint] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: denoland/setup-deno@v2
        with:
          deno-version: canary
      - uses: actions/checkout@v6
      - name: Build
        run: cargo build
      - name: Lint
        run: deno lint
`,
  );
});

Deno.test("comesAfter between two independent steps", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step({ name: "B", run: "b" });
  const c = step({ name: "C", run: "c" });

  // force A after C, despite passing order [a, b, c]
  const aRef = a.comesAfter(c);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [aRef, b, c] },
    ],
  });

  // B keeps its natural priority between A and C; A is forced after C
  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: B
        run: b
      - name: C
        run: c
      - name: A
        run: a
`,
  );
});

Deno.test("comesAfter does not pull in steps", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step({ name: "B", run: "b" });

  // b.comesAfter(a) but only b is in the job — a should NOT be pulled in
  const bRef = b.comesAfter(a);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [bRef] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: B
        run: b
`,
  );
});

Deno.test("comesAfter conflict with dependsOn throws cycle error", () => {
  setup();
  const a = step({ name: "A" });
  const b = step({ name: "B" });

  // b depends on a (b after a), but a.comesAfter(b) means a must come after b
  const bRef = b.dependsOn(a);
  const aRef = a.comesAfter(bRef);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [aRef, bRef] },
    ],
  });

  assertThrows(
    () => wf.toYamlString(),
    Error,
    "Cycle detected in step ordering: A → B → A",
  );
});

Deno.test("comesAfter mutual constraint throws cycle error", () => {
  setup();
  const a = step({ name: "A" });
  const b = step({ name: "B" });

  const aRef = a.comesAfter(b);
  const bRef = b.comesAfter(a);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [aRef, bRef] },
    ],
  });

  assertThrows(
    () => wf.toYamlString(),
    Error,
    "Cycle detected in step ordering: A → B → A",
  );
});

Deno.test("comesAfter does not affect condition propagation", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step({
    name: "B",
    run: "b",
    if: expr("matrix.os").equals("linux"),
  });

  // b comes after a, but a should NOT inherit b's condition
  const bRef = b.comesAfter(a);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [a, bRef] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: A
        run: a
      - name: B
        if: matrix.os == 'linux'
        run: b
`,
  );
});

Deno.test("comesAfter compatible with dependsOn (same direction)", () => {
  setup();
  const a = step({ name: "A" });
  // redundant but compatible: b already comes after a via dependsOn
  const b = step({ name: "B" }).dependsOn(a).comesAfter(a);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [b] },
    ],
  });

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
`,
  );
});

Deno.test("comesAfter on composite step applies to all children", () => {
  setup();
  const setup_ = step({ name: "Setup", run: "setup" });
  const group = step(
    { name: "Build A", run: "build-a" },
    { name: "Build B", run: "build-b" },
  ).comesAfter(setup_);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [setup_, group] },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Setup
        run: setup
      - name: Build A
        run: build-a
      - name: Build B
        run: build-b
`,
  );
});

Deno.test("same step with different .if() in different jobs stays independent", () => {
  setup();
  const shared = step({ name: "Shared", run: "shared" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      {
        id: "job1",
        runsOn: "ubuntu-latest",
        steps: [shared.if("github.ref == 'refs/heads/main'")],
      },
      {
        id: "job2",
        runsOn: "ubuntu-latest",
        steps: [shared.if("github.event_name == 'pull_request'")],
      },
    ],
  });

  const yaml = wf.toYamlString();
  assertEquals(
    yaml,
    `name: test
on: {}
jobs:
  job1:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        if: github.ref == 'refs/heads/main'
        run: shared
  job2:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        if: github.event_name == 'pull_request'
        run: shared
`,
  );
});

Deno.test("shared step in multiple conditional composites gets OR condition", () => {
  setup();
  const isTest = expr("matrix.job").equals("test");
  const isBench = expr("matrix.job").equals("bench");

  const cache = step({ name: "Cache", uses: "cache@v4" });
  const build = step({ name: "Build", run: "cargo build" }).dependsOn(cache);

  const testGroup = step(
    build,
    { name: "Run tests", run: "cargo test" },
  ).if(isTest);

  const benchGroup = step(
    build,
    { name: "Run bench", run: "cargo bench" },
  ).if(isBench);

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [
      { id: "j", runsOn: "ubuntu-latest", steps: [testGroup, benchGroup] },
    ],
  });

  const yaml = wf.toYamlString();
  // build appears in both testGroup and benchGroup, so it should get the OR
  // of both conditions. cache is a dep of build, so it should also get OR.
  const parsed = parse(yaml) as Record<string, unknown>;
  const steps = (parsed as { jobs: { j: { steps: unknown[] } } }).jobs.j.steps;
  const cacheStep = (steps as Record<string, unknown>[]).find((s) =>
    s.name === "Cache"
  );
  const buildStep = (steps as Record<string, unknown>[]).find((s) =>
    s.name === "Build"
  );
  const testStep = (steps as Record<string, unknown>[]).find((s) =>
    s.name === "Run tests"
  );
  const benchStep = (steps as Record<string, unknown>[]).find((s) =>
    s.name === "Run bench"
  );

  // build and cache should have OR condition
  assertEquals(
    buildStep?.if,
    "matrix.job == 'test' || matrix.job == 'bench'",
  );
  assertEquals(
    cacheStep?.if,
    "matrix.job == 'test' || matrix.job == 'bench'",
  );
  // leaf steps keep their individual conditions
  assertEquals(testStep?.if, "matrix.job == 'test'");
  assertEquals(benchStep?.if, "matrix.job == 'bench'");
});

// --- step.dependsOn() / step.if() prefix builder API ---

Deno.test("step.dependsOn() puts dependency before step config", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const build = step.dependsOn(checkout)({
    name: "Build",
    run: "cargo build",
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [build],
    }],
  });

  assertEquals(
    wf.toYamlString(),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Build
        run: cargo build
`,
  );
});

Deno.test("step.dependsOn() returns StepRef", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const build = step.dependsOn(checkout)({
    name: "Build",
    run: "cargo build",
  });
  assertEquals(build instanceof StepRef, true);
});

Deno.test("step.if() puts condition before step config", () => {
  setup();
  const s = step.if(isBranch("main"))({
    name: "Deploy",
    run: "deploy.sh",
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [s],
    }],
  });

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

Deno.test("step.dependsOn().if() chains both before config", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const build = step.dependsOn(checkout).if(isBranch("main"))({
    name: "Build",
    run: "cargo build",
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [build],
    }],
  });

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
        run: cargo build
`,
  );
});

Deno.test("step.if().dependsOn() order doesn't matter", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const build = step.if(isBranch("main")).dependsOn(checkout)({
    name: "Build",
    run: "cargo build",
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [build],
    }],
  });

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
        run: cargo build
`,
  );
});

Deno.test("step.dependsOn() with composite steps", () => {
  setup();
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
  const group = step.dependsOn(checkout)(
    { uses: "dsherret/rust-toolchain-file@v1" },
    { uses: "Swatinem/rust-cache@v2" },
  );

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [group],
    }],
  });

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
`,
  );
});

Deno.test("step.dependsOn().if() with composite steps", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const group = step.dependsOn(checkout).if(conditions.isTag())(
    { name: "Build (Release)", run: "cargo build --release" },
    { name: "Build cross (Release)", run: "cross build --release" },
  );

  const build = step.dependsOn(group)({
    name: "Post-build",
    run: "echo done",
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [build],
    }],
  });

  const yaml = wf.toYamlString();
  assertEquals(
    yaml,
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        if: 'startsWith(github.ref, ''refs/tags/'')'
      - name: Build (Release)
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: cargo build --release
      - name: Build cross (Release)
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: cross build --release
      - name: Post-build
        run: echo done
`,
  );
});

Deno.test("step.if() ANDs multiple conditions", () => {
  setup();
  const s = step.if(isBranch("main")).if(expr("matrix.os").equals("linux"))({
    name: "Deploy",
    run: "deploy.sh",
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [s],
    }],
  });

  const yaml = wf.toYamlString();
  assertEquals(
    yaml,
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        if: github.ref == 'refs/heads/main' && matrix.os == 'linux'
        run: deploy.sh
`,
  );
});

Deno.test("step.comesAfter() prefix form", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step.comesAfter(a)({ name: "B", run: "b" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [a, b],
    }],
  });

  const yaml = wf.toYamlString();
  // b should come after a
  const lines = yaml.split("\n");
  const aIdx = lines.findIndex((l) => l.includes("name: A"));
  const bIdx = lines.findIndex((l) => l.includes("name: B"));
  assertEquals(aIdx < bIdx, true);
});

Deno.test("step.dependsOn() with multiple deps", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step({ name: "B", run: "b" });
  const c = step.dependsOn(a, b)({ name: "C", run: "c" });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [c],
    }],
  });

  const yaml = wf.toYamlString();
  // Both a and b should appear before c
  const lines = yaml.split("\n");
  const aIdx = lines.findIndex((l) => l.includes("name: A"));
  const bIdx = lines.findIndex((l) => l.includes("name: B"));
  const cIdx = lines.findIndex((l) => l.includes("name: C"));
  assertEquals(aIdx < cIdx, true);
  assertEquals(bIdx < cIdx, true);
});

Deno.test("prefix builder result can still chain .if() for per-usage condition", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const build = step.dependsOn(checkout)({
    name: "Build",
    run: "cargo build",
  });

  // Per-usage .if() on the StepRef returned by builder
  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j1",
      runsOn: "ubuntu-latest",
      steps: [build.if(isBranch("main"))],
    }, {
      id: "j2",
      runsOn: "ubuntu-latest",
      steps: [build.if(conditions.isTag())],
    }],
  });

  const yaml = wf.toYamlString();
  // j1 should have branch condition, j2 should have tag condition
  const parsed = parse(yaml) as Record<string, unknown>;
  const jobs = parsed.jobs as Record<
    string,
    { steps: Array<Record<string, string>> }
  >;
  assertEquals(
    jobs.j1.steps[1].if,
    "github.ref == 'refs/heads/main'",
  );
  assertEquals(
    jobs.j2.steps[1].if,
    "startsWith(github.ref, 'refs/tags/')",
  );
});

Deno.test("prefix .if() ANDs with config.if instead of dropping it", () => {
  setup();
  const s = step.if(isBranch("main"))({
    name: "Deploy",
    run: "deploy.sh",
    if: expr("matrix.os").equals("linux"),
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [s],
    }],
  });

  const yaml = wf.toYamlString();
  assertEquals(
    yaml,
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        if: github.ref == 'refs/heads/main' && matrix.os == 'linux'
        run: deploy.sh
`,
  );
});

Deno.test("prefix step.dependsOn() with config.if does not duplicate conditions on deps", () => {
  setup();
  const checkout = step({ uses: "actions/checkout@v6" });
  const conditional = step({
    name: "Setup",
    run: "setup.sh",
    if: "runner.os == 'Linux'",
  });
  // use prefix dependsOn where the step itself has a config.if
  const build = step.dependsOn(checkout, conditional)({
    name: "Build",
    run: "cargo build",
    if: "runner.os == 'Linux'",
  });

  const wf = createWorkflow({
    name: "test",
    on: {},
    jobs: [{
      id: "j",
      runsOn: "ubuntu-latest",
      steps: [build],
    }],
  });

  const yaml = wf.toYamlString();
  // the condition on dependencies should appear only once, not duplicated
  assertEquals(
    yaml,
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        if: runner.os == 'Linux'
      - name: Setup
        if: runner.os == 'Linux'
        run: setup.sh
      - name: Build
        if: runner.os == 'Linux'
        run: cargo build
`,
  );
});
