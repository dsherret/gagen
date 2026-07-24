import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "@std/yaml/parse";
import {
  concat,
  conditions,
  defineMatrix,
  expr,
  fromJSON,
  job,
  literal,
  step,
  workflow,
} from "./mod.ts";
import { resolveJobId } from "./job.ts";
import { resetStepCounter } from "./step.ts";

// reset step counter between tests for deterministic ids
function setup() {
  resetStepCounter();
}

/** Creates a job exposing a single `value` output produced by a step in it. */
function producerJob(id: string) {
  const producer = step({
    id: `${id}-step`,
    run: "echo v",
    outputs: ["value"],
  });
  return {
    producer,
    job: job(id, {
      runsOn: "ubuntu-latest",
      steps: [producer],
      outputs: { value: producer.outputs.value },
    }),
  };
}

// --- job id validation ---

Deno.test("job() rejects an id with invalid GitHub characters", () => {
  setup();
  assertThrows(
    () =>
      job("my job!", { runsOn: "ubuntu-latest", steps: [step({ run: "x" })] }),
    Error,
    'Invalid job id "my job!"',
  );
});

Deno.test("job() rejects an id starting with a digit", () => {
  setup();
  assertThrows(
    () =>
      job("3build", { runsOn: "ubuntu-latest", steps: [step({ run: "x" })] }),
    Error,
    'Invalid job id "3build"',
  );
});

Deno.test("job() accepts letters, digits, underscores and hyphens", () => {
  setup();
  assertEquals(
    job("_build-2_x", { runsOn: "ubuntu-latest", steps: [step({ run: "x" })] })
      .id,
    "_build-2_x",
  );
});

Deno.test("resolveJobId rejects a name deriving a digit-leading id", () => {
  setup();
  assertThrows(
    () =>
      resolveJobId({ name: "3 Amigos", runsOn: "ubuntu-latest", steps: [] }),
    Error,
    'Job name "3 Amigos" derives the invalid job id "3-amigos"',
  );
});

Deno.test("resolveJobId rejects a name with nothing to derive an id from", () => {
  setup();
  assertThrows(
    () => resolveJobId({ name: "!!!", runsOn: "ubuntu-latest", steps: [] }),
    Error,
    'derives the invalid job id ""',
  );
});

Deno.test("names that kebab-case to the same id are rejected as duplicates", () => {
  setup();
  assertThrows(
    () =>
      workflow({
        name: "ci",
        on: {},
        jobs: [
          {
            name: "C++ Build",
            runsOn: "ubuntu-latest",
            steps: [step({ run: "a" })],
          },
          {
            name: "C# Build",
            runsOn: "ubuntu-latest",
            steps: [step({ run: "b" })],
          },
        ],
      }),
    Error,
    'Duplicate job id: "c-build"',
  );
});

// --- needs inference ---

Deno.test("needs inferred from a plain object matrix referencing a job output", () => {
  setup();
  const { job: setupJob } = producerJob("setup");
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      setupJob,
      job("test", {
        runsOn: "ubuntu-latest",
        strategy: { matrix: { version: fromJSON(setupJob.outputs.value) } },
        steps: [step({ run: "echo" })],
      }),
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  setup:
    runs-on: ubuntu-latest
    outputs:
      value: '\${{ steps.setup-step.outputs.value }}'
    steps:
      - id: setup-step
        run: echo v
  test:
    needs:
      - setup
    runs-on: ubuntu-latest
    strategy:
      matrix:
        version: '\${{ fromJSON(needs.setup.outputs.value) }}'
    steps:
      - run: echo
`,
  );
});

Deno.test("needs inferred from a defineMatrix() referencing a job output", () => {
  setup();
  const { job: setupJob } = producerJob("setup");
  const matrix = defineMatrix({ version: fromJSON(setupJob.outputs.value) });
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      setupJob,
      job("test", {
        runsOn: matrix.version,
        strategy: { matrix },
        steps: [step({ run: "echo" })],
      }),
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { test: { needs: string[]; strategy: { matrix: unknown } } };
  };
  assertEquals(parsed.jobs.test.needs, ["setup"]);
  assertEquals(parsed.jobs.test.strategy.matrix, {
    version: "${{ fromJSON(needs.setup.outputs.value) }}",
  });
});

Deno.test("needs inferred from a service container's env", () => {
  setup();
  const { job: setupJob } = producerJob("setup");
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      setupJob,
      job("test", {
        runsOn: "ubuntu-latest",
        services: {
          db: { image: "postgres", env: { TAG: setupJob.outputs.value } },
        },
        steps: [step({ run: "echo" })],
      }),
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { test: { needs: string[] } };
  };
  assertEquals(parsed.jobs.test.needs, ["setup"]);
});

Deno.test("needs inferred from container credentials", () => {
  setup();
  const { job: setupJob } = producerJob("setup");
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      setupJob,
      job("test", {
        runsOn: "ubuntu-latest",
        container: {
          image: "node",
          credentials: { username: "u", password: setupJob.outputs.value },
        },
        steps: [step({ run: "echo" })],
      }),
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { test: { needs: string[] } };
  };
  assertEquals(parsed.jobs.test.needs, ["setup"]);
});

Deno.test("needs inferred from a job output forwarding another job's output", () => {
  setup();
  const { job: setupJob } = producerJob("setup");
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      setupJob,
      job("forward", {
        runsOn: "ubuntu-latest",
        steps: [step({ run: "echo" })],
        outputs: { value: setupJob.outputs.value },
      }),
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { forward: { needs: string[]; outputs: Record<string, string> } };
  };
  assertEquals(parsed.jobs.forward.needs, ["setup"]);
  assertEquals(parsed.jobs.forward.outputs, {
    value: "${{ needs.setup.outputs.value }}",
  });
});

Deno.test("needs inferred from an expression in the job name", () => {
  setup();
  const { job: setupJob } = producerJob("setup");
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      setupJob,
      job("test", {
        runsOn: "ubuntu-latest",
        name: concat("Test ", setupJob.outputs.value),
        steps: [step({ run: "echo" })],
      }),
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { test: { name: string; needs: string[] } };
  };
  assertEquals(parsed.jobs.test.name, "Test ${{ needs.setup.outputs.value }}");
  assertEquals(parsed.jobs.test.needs, ["setup"]);
});

Deno.test("needs inferred from a reusable workflow job's `with` values", () => {
  setup();
  const { job: setupJob } = producerJob("setup");
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      setupJob,
      job("call", {
        uses: "./.github/workflows/reusable.yml",
        with: { version: setupJob.outputs.value },
        secrets: "inherit",
      }),
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  setup:
    runs-on: ubuntu-latest
    outputs:
      value: '\${{ steps.setup-step.outputs.value }}'
    steps:
      - id: setup-step
        run: echo v
  call:
    needs:
      - setup
    uses: ./.github/workflows/reusable.yml
    with:
      version: '\${{ needs.setup.outputs.value }}'
    secrets: inherit
`,
  );
});

Deno.test("needs are deduplicated with explicit entries first", () => {
  setup();
  const { job: a } = producerJob("a");
  const { job: b } = producerJob("b");
  const { job: c } = producerJob("c");
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      a,
      b,
      c,
      job("last", {
        runsOn: "ubuntu-latest",
        needs: [c, b, c],
        env: { A: a.outputs.value, B: b.outputs.value },
        steps: [step({ run: "echo", env: { C: c.outputs.value } })],
      }),
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { last: { needs: string[] } };
  };
  assertEquals(parsed.jobs.last.needs, ["c", "b", "a"]);
});

Deno.test("depending on a job outside the workflow throws", () => {
  setup();
  const outside = job("outside", {
    runsOn: "ubuntu-latest",
    steps: [step({ run: "a" })],
  });
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      job("build", {
        runsOn: "ubuntu-latest",
        needs: [outside],
        steps: [step({ run: "b" })],
      }),
    ],
  });

  assertThrows(
    () => wf.toYamlString(),
    Error,
    'Job "build" depends on job "outside", which is not part of this workflow.',
  );
});

Deno.test("a job rebuilt by a factory satisfies a need by id, not identity", () => {
  setup();
  // job factories are a normal way to share a definition across workflow files,
  // so the workflow's `setup` and the one referenced here are distinct instances
  const inWorkflow = producerJob("setup").job;
  const referenced = producerJob("setup").job;
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      inWorkflow,
      job("build", {
        runsOn: "ubuntu-latest",
        env: { V: referenced.outputs.value },
        steps: [step({ run: "b" })],
      }),
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { build: { needs: string[]; env: Record<string, string> } };
  };
  assertEquals(parsed.jobs.build.needs, ["setup"]);
  assertEquals(parsed.jobs.build.env, {
    V: "${{ needs.setup.outputs.value }}",
  });
});

// --- job outputs ---

Deno.test("a job output referencing a step from another job throws", () => {
  setup();
  const { producer, job: setupJob } = producerJob("setup");
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      setupJob,
      job("other", {
        runsOn: "ubuntu-latest",
        steps: [step({ run: "echo" })],
        outputs: { value: producer.outputs.value },
      }),
    ],
  });

  assertThrows(
    () => wf.toYamlString(),
    Error,
    'Job "other" output "value" references step "setup-step", which is not one of the job\'s steps.',
  );
});

Deno.test("a job output referencing an always-false step throws", () => {
  setup();
  const dropped = step({
    id: "dropped",
    run: "echo",
    if: literal(false),
    outputs: ["value"],
  });
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      job("a", {
        runsOn: "ubuntu-latest",
        steps: [dropped, step({ run: "other" })],
        outputs: { value: dropped.outputs.value },
      }),
    ],
  });

  assertThrows(
    () => wf.toYamlString(),
    Error,
    'Job "a" output "value" references step "dropped", which is not one of the job\'s steps.',
  );
});

Deno.test("a job output referencing a step shared between jobs is allowed", () => {
  setup();
  const shared = step({ id: "shared", run: "echo v", outputs: ["value"] });
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      job("a", {
        runsOn: "ubuntu-latest",
        steps: [shared],
        outputs: { value: shared.outputs.value },
      }),
      job("b", {
        runsOn: "ubuntu-latest",
        steps: [shared],
        outputs: { value: shared.outputs.value },
      }),
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  a:
    runs-on: ubuntu-latest
    outputs:
      value: '\${{ steps.shared.outputs.value }}'
    steps:
      - id: shared
        run: echo v
  b:
    runs-on: ubuntu-latest
    outputs:
      value: '\${{ steps.shared.outputs.value }}'
    steps:
      - id: shared
        run: echo v
`,
  );
});

// --- dependency gating ---

Deno.test("a group dep is gated by the OR of its members' StepRef conditions", () => {
  setup();
  const isTest = expr("matrix.job").equals("test");
  const isBench = expr("matrix.job").equals("bench");
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v4" });
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      job("j", {
        runsOn: "ubuntu-latest",
        steps: [
          step.dependsOn(checkout).parallel(
            step.if(isTest)({ name: "Test", run: "test" }),
            step.if(isBench)({ name: "Bench", run: "bench" }),
          ),
        ],
      }),
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        if: matrix.job == 'test' || matrix.job == 'bench'
      - parallel:
          - name: Test
            if: matrix.job == 'test'
            run: test
          - name: Bench
            if: matrix.job == 'bench'
            run: bench
`,
  );
});

Deno.test("a group dep stays ungated when a member is unconditional", () => {
  setup();
  const isTest = expr("matrix.job").equals("test");
  const checkout = step({ name: "Checkout", uses: "actions/checkout@v4" });
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      job("j", {
        runsOn: "ubuntu-latest",
        steps: [
          step.dependsOn(checkout).parallel(
            step.if(isTest)({ name: "Test", run: "test" }),
            { name: "Always", run: "always" },
          ),
        ],
      }),
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { j: { steps: Record<string, unknown>[] } };
  };
  assertEquals(parsed.jobs.j.steps[0].name, "Checkout");
  assertEquals(parsed.jobs.j.steps[0].if, undefined);
});

// --- strategy ---

Deno.test("a plain object matrix serializes its expressions to \${{ }}", () => {
  setup();
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      job("test", {
        runsOn: "ubuntu-latest",
        strategy: {
          matrix: {
            os: ["ubuntu-latest", "macos-latest"],
            include: [{ os: "ubuntu-latest", tag: conditions.isTag() }],
          },
        },
        steps: [step({ run: "echo" })],
      }),
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os:
          - ubuntu-latest
          - macos-latest
        include:
          - os: ubuntu-latest
            tag: '\${{ startsWith(github.ref, ''refs/tags/'') }}'
    steps:
      - run: echo
`,
  );
});

Deno.test("an empty strategy is omitted rather than emitted as {}", () => {
  setup();
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "a",
        runsOn: "ubuntu-latest",
        strategy: {},
        steps: [step({ run: "x" })],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: x
`,
  );
});

Deno.test("fail-fast false and max-parallel serialize without a matrix", () => {
  setup();
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "a",
        runsOn: "ubuntu-latest",
        strategy: { failFast: false, maxParallel: 3 },
        steps: [step({ run: "x" })],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 3
    steps:
      - run: x
`,
  );
});

Deno.test("fail-fast accepts a condition", () => {
  setup();
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "a",
        runsOn: "ubuntu-latest",
        strategy: {
          matrix: defineMatrix({ os: ["ubuntu-latest"] }),
          failFast: conditions.isBranch("main"),
        },
        steps: [step({ run: "x" })],
      },
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { a: { strategy: { "fail-fast": string } } };
  };
  assertEquals(
    parsed.jobs.a.strategy["fail-fast"],
    "${{ github.ref == 'refs/heads/main' }}",
  );
});

// --- defaults ---

Deno.test("an empty defaults block is omitted at job and workflow level", () => {
  setup();
  const wf = workflow({
    name: "ci",
    on: {},
    defaults: {},
    jobs: [
      {
        id: "a",
        runsOn: "ubuntu-latest",
        defaults: { run: {} },
        steps: [step({ run: "x" })],
      },
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: x
`,
  );
});

Deno.test("defaults with only a working directory serializes it alone", () => {
  setup();
  const wf = workflow({
    name: "ci",
    on: {},
    defaults: { run: { workingDirectory: "./sub" } },
    jobs: [{ id: "a", runsOn: "ubuntu-latest", steps: [step({ run: "x" })] }],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
defaults:
  run:
    working-directory: ./sub
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: x
`,
  );
});

// --- triggers ---

Deno.test("push with both branches and branchesIgnore throws", () => {
  setup();
  assertThrows(
    () =>
      workflow({
        name: "ci",
        on: { push: { branches: ["main"], branchesIgnore: ["dev"] } },
        jobs: [{
          id: "a",
          runsOn: "ubuntu-latest",
          steps: [step({ run: "x" })],
        }],
      }).toYamlString(),
    Error,
    'The "push" trigger cannot use both `branches` and `branchesIgnore`',
  );
});

Deno.test("push with both tags and tagsIgnore throws", () => {
  setup();
  assertThrows(
    () =>
      workflow({
        name: "ci",
        on: { push: { tags: ["v*"], tagsIgnore: ["v0*"] } },
        jobs: [{
          id: "a",
          runsOn: "ubuntu-latest",
          steps: [step({ run: "x" })],
        }],
      }).toYamlString(),
    Error,
    'The "push" trigger cannot use both `tags` and `tagsIgnore`',
  );
});

Deno.test("pull_request with both paths and pathsIgnore throws", () => {
  setup();
  assertThrows(
    () =>
      workflow({
        name: "ci",
        on: { pull_request: { paths: ["src/**"], pathsIgnore: ["docs/**"] } },
        jobs: [{
          id: "a",
          runsOn: "ubuntu-latest",
          steps: [step({ run: "x" })],
        }],
      }).toYamlString(),
    Error,
    'The "pull_request" trigger cannot use both `paths` and `pathsIgnore`',
  );
});

Deno.test("schedule, workflow_dispatch and unknown events serialize", () => {
  setup();
  const wf = workflow({
    name: "ci",
    on: {
      schedule: [{ cron: "0 0 * * *" }],
      workflow_dispatch: {
        inputs: { level: { type: "string", default: "info" } },
      },
      pull_request_target: { branchesIgnore: ["gh-pages"] },
    },
    jobs: [{ id: "a", runsOn: "ubuntu-latest", steps: [step({ run: "x" })] }],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on:
  schedule:
    - cron: 0 0 * * *
  workflow_dispatch:
    inputs:
      level:
        type: string
        default: info
  pull_request_target:
    branches-ignore:
      - gh-pages
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: x
`,
  );
});

Deno.test("emitted yaml re-parses unchanged, so writeOrLint --lint round-trips", () => {
  setup();
  const yaml = workflow({
    name: "ci",
    on: { push: { branches: ["main"] } },
    env: { FLAG: "yes", MODE: "off" },
    jobs: [{ id: "a", runsOn: "ubuntu-latest", steps: [step({ run: "x" })] }],
  }).toYamlString();

  // `on` must survive as a key rather than collapsing to a YAML 1.1 boolean,
  // and so must string values that look like booleans
  const parsed = parse(yaml) as Record<string, unknown>;
  assertEquals(Object.keys(parsed), ["name", "on", "env", "jobs"]);
  assertEquals(parsed.on, { push: { branches: ["main"] } });
  assertEquals(parsed.env, { FLAG: "yes", MODE: "off" });
});

// --- runsOn ---

Deno.test("runsOn accepts an expression and infers needs from it", () => {
  setup();
  const { job: setupJob } = producerJob("setup");
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      setupJob,
      job("test", {
        runsOn: setupJob.outputs.value,
        steps: [step({ run: "echo" })],
      }),
    ],
  });

  const parsed = parse(wf.toYamlString()) as {
    jobs: { test: { needs: string[]; "runs-on": string } };
  };
  assertEquals(parsed.jobs.test.needs, ["setup"]);
  assertEquals(parsed.jobs.test["runs-on"], "${{ needs.setup.outputs.value }}");
});

// --- key ordering ---

Deno.test("job outputs are emitted before steps", () => {
  setup();
  const producer = step({ id: "s", run: "x", outputs: ["o"] });
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      job("a", {
        runsOn: "ubuntu-latest",
        steps: [producer],
        outputs: { o: producer.outputs.o },
      }),
    ],
  });

  const keys = Object.keys(
    (parse(wf.toYamlString()) as { jobs: { a: Record<string, unknown> } })
      .jobs.a,
  );
  assertEquals(keys.indexOf("outputs") < keys.indexOf("steps"), true);
});

Deno.test("an empty outputs record is omitted", () => {
  setup();
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      job("a", {
        runsOn: "ubuntu-latest",
        steps: [step({ run: "x" })],
        outputs: {},
      }),
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: x
`,
  );
});

Deno.test("reusable job keys serialize in a stable order", () => {
  setup();
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      job("a", {
        name: "A",
        uses: "./.github/workflows/r.yml",
        if: conditions.isBranch("main"),
        permissions: "read-all",
        concurrency: { group: "g" },
        with: { v: "1" },
        secrets: { TOKEN: "x" },
        continueOnError: true,
      }),
    ],
  });

  assertEquals(
    wf.toYamlString(),
    `name: ci
on: {}
jobs:
  a:
    name: A
    if: github.ref == 'refs/heads/main'
    permissions: read-all
    concurrency:
      group: g
    uses: ./.github/workflows/r.yml
    with:
      v: '1'
    secrets:
      TOKEN: x
    continue-on-error: true
`,
  );
});
