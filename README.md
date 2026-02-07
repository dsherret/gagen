# `jsr:@david/ci-yml-generator`

Generates GitHub Actions YAML files using a declarative API.

## Basic usage

```ts
#!/usr/bin/env -S deno run --allow-write=ci.yml
import { createWorkflow, step } from "jsr:@david/ci-yml-generator@<version>";

const checkout = step({
  name: "Clone repository",
  uses: "actions/checkout@v6",
});

const build = step({
  name: "Build",
  run: "cargo build",
}).dependsOn(checkout);

const test = step({
  name: "Test",
  run: "cargo test",
}).dependsOn(build);

const wf = createWorkflow({
  name: "ci",
  on: { push: { branches: ["main"] } },
});

// only specify the leaf step — checkout and build are pulled in automatically
wf.createJob("build", {
  runsOn: "ubuntu-latest",
}).withSteps(test);

wf.writeToFile(new URL("./ci.yml", import.meta.url));
```

This generates a `ci.yml` with steps in the correct order: checkout, build,
then test.

## Conditions

Build type-safe GitHub Actions expressions with a fluent API:

```ts
import { ExpressionValue } from "jsr:@david/ci-yml-generator@<version>";

const ref = new ExpressionValue("github.ref");
const os = new ExpressionValue("matrix.os");

// simple comparisons
ref.equals("refs/heads/main");
// => github.ref == 'refs/heads/main'

ref.startsWith("refs/tags/").not();
// => !startsWith(github.ref, 'refs/tags/')

// compose with .and() / .or()
os.equals("linux").and(ref.startsWith("refs/tags/"));
// => matrix.os == 'linux' && startsWith(github.ref, 'refs/tags/')

// use on steps
const deploy = step({
  name: "Deploy",
  run: "deploy.sh",
  if: ref.equals("refs/heads/main").and(os.equals("linux")),
}).dependsOn(build);
```

## Condition propagation

Conditions on leaf steps automatically propagate backward to their
dependencies. This avoids running expensive setup steps when they aren't
needed:

```ts
const checkout = step({ uses: "actions/checkout@v6" });
const build = step({ run: "cargo build" }).dependsOn(checkout);
const test = step({
  run: "cargo test",
  if: new ExpressionValue("matrix.job").equals("test"),
}).dependsOn(build);

// only test is passed — checkout and build inherit its condition
wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(test);
// all three steps get: if: matrix.job == 'test'
```

When multiple leaf steps have different conditions, dependencies get the
OR of those conditions:

```ts
const test = step({ run: "cargo test", if: jobExpr.equals("test") }).dependsOn(checkout);
const bench = step({ run: "cargo bench", if: jobExpr.equals("bench") }).dependsOn(checkout);

wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(test, bench);
// checkout gets: if: matrix.job == 'test' || matrix.job == 'bench'
```

To prevent propagation, pass the unconditional steps to `withSteps()` as
well. Leaf steps act as propagation barriers:

```ts
const build = step({ run: "cargo build" }).dependsOn(checkout);
const test = step({ run: "cargo test" }).dependsOn(build);
const linuxOnly = step({
  run: "linux-specific",
  if: os.equals("linux"),
}).dependsOn(build, test);

// test is a leaf with no condition — blocks propagation to build and checkout
wf.createJob("j", { runsOn: "ubuntu-latest" }).withSteps(test, linuxOnly);
```

## Step outputs and job dependencies

Steps can declare outputs. When a job references another job's outputs, the
`needs` dependency is inferred automatically.

```ts
const checkStep = step({
  id: "check",
  name: "Check if draft",
  run: `echo 'skip=true' >> $GITHUB_OUTPUT`,
  outputs: ["skip"],
});

const preBuild = wf.createJob("pre_build", {
  runsOn: "ubuntu-latest",
}).withSteps(checkStep).withOutputs({
  skip: checkStep.outputs.skip,
});

// preBuild.outputs.skip is an ExpressionValue — using it in the `if`
// automatically adds needs: [pre_build] to this job
wf.createJob("build", {
  runsOn: "ubuntu-latest",
  if: preBuild.outputs.skip.notEquals("true"),
}).withSteps(buildStep);
```

## Diamond dependencies

Steps shared across multiple dependency chains are deduplicated and
topologically sorted:

```ts
const checkout = step({ name: "Checkout", uses: "actions/checkout@v6" });
const buildA = step({ name: "Build A", run: "make a" }).dependsOn(checkout);
const buildB = step({ name: "Build B", run: "make b" }).dependsOn(checkout);
const integrate = step({ name: "Integrate", run: "make all" }).dependsOn(buildA, buildB);

wf.createJob("ci", { runsOn: "ubuntu-latest" }).withSteps(integrate);
// resolves to: checkout → buildA → buildB → integrate
// checkout appears only once
```

## Job configuration

```ts
wf.createJob("build", {
  name: "Build ${{ matrix.os }}",
  runsOn: "ubuntu-latest",
  timeoutMinutes: 60,
  defaults: { run: { shell: "bash" } },
  env: { CARGO_TERM_COLOR: "always" },
  permissions: { contents: "read" },
  concurrency: { group: "build-${{ github.ref }}", cancelInProgress: true },
  strategy: {
    matrix: {
      include: [
        { os: "linux", runner: "ubuntu-latest" },
        { os: "macos", runner: "macos-latest" },
      ],
    },
    failFast: true,
  },
}).withSteps(test);
```

## Step configuration

```ts
step({
  name: "Deploy",
  id: "deploy",
  uses: "actions/deploy@v1",
  with: { token: new ExpressionValue("secrets.GITHUB_TOKEN") },
  env: { NODE_ENV: "production" },
  if: "github.ref == 'refs/heads/main'",
  shell: "bash",
  workingDirectory: "./app",
  continueOnError: true,
  timeoutMinutes: 10,
});
```
