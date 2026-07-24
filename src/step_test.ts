import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  artifact,
  conditions,
  defineMatrix,
  type ExpressionValue,
  job,
  Step,
  step,
  type StepLike,
  StepRef,
  workflow,
} from "./mod.ts";
import { fromJSON } from "./expression.ts";
import { matrixDefOf } from "./matrix.ts";
import { crossJobDepsOf, resetStepCounter } from "./step.ts";

const { isBranch, isTag } = conditions;

// reset step counter between tests for deterministic ids
function setup() {
  resetStepCounter();
}

/** Builds a single-job workflow around the given steps and serializes it. */
function stepsYaml(steps: StepLike[]): string {
  return workflow({
    name: "test",
    on: {},
    jobs: [{ id: "j", runsOn: "ubuntu-latest", steps }],
  }).toYamlString();
}

// --- plain config objects keep their identity ---

Deno.test("a config object reused as a dependency is not duplicated", () => {
  setup();
  const checkout = { name: "Checkout", run: "checkout" };

  assertEquals(
    stepsYaml([checkout, step.dependsOn(checkout)({ name: "B", run: "b" })]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        run: checkout
      - name: B
        run: b
`,
  );
});

Deno.test("comesAfter targeting a config object adds the ordering edge", () => {
  setup();
  const first = { name: "First", run: "first" };

  assertEquals(
    stepsYaml([
      step.comesAfter(first)({ name: "Second", run: "second" }),
      first,
    ]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: First
        run: first
      - name: Second
        run: second
`,
  );
});

Deno.test("a config object shared by two conditional groups gets the OR condition", () => {
  setup();
  const shared = { name: "Shared", run: "shared" };

  assertEquals(
    stepsYaml([
      step.if(isBranch("main"))(shared, { name: "A", run: "a" }),
      step.if(isBranch("dev"))(shared, { name: "B", run: "b" }),
    ]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/dev'
        run: shared
      - name: A
        if: github.ref == 'refs/heads/main'
        run: a
      - name: B
        if: github.ref == 'refs/heads/dev'
        run: b
`,
  );
});

Deno.test("step() returns the same Step for the same config object", () => {
  setup();
  const config = { name: "A", run: "a" };
  assertEquals(step(config), step(config));
  // distinct objects with equal contents stay distinct steps
  assertEquals(
    step({ name: "A", run: "a" }) === step({ name: "A", run: "a" }),
    false,
  );
});

Deno.test("a config object wrapped by step() is the same step listed in steps", () => {
  setup();
  const server = { id: "server", run: "serve", background: true };

  // step(server) must resolve to the step already contributed by `server`
  // itself, otherwise the background step is emitted twice
  assertEquals(
    stepsYaml([server, step.waitFor(step(server))]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - id: server
        run: serve
        background: true
      - wait: server
`,
  );
});

Deno.test("a step built with new Step() claims its config object", () => {
  setup();
  const checkout = { name: "Checkout", run: "checkout" };
  const built = new Step(checkout);

  // the public constructor must populate the same memo table as step(), or
  // referring to the config elsewhere creates a second, duplicate step
  assertEquals(step(checkout), built);
  assertEquals(
    stepsYaml([built, step.dependsOn(checkout)({ name: "B", run: "b" })]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        run: checkout
      - name: B
        run: b
`,
  );
});

// --- dependency graph resolution ---

Deno.test("a transitive chain is ordered from the deepest dependency", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step.dependsOn(a)({ name: "B", run: "b" });
  const c = step.dependsOn(b)({ name: "C", run: "c" });
  const d = step.dependsOn(c)({ name: "D", run: "d" });

  assertEquals(
    stepsYaml([d]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: A
        run: a
      - name: B
        run: b
      - name: C
        run: c
      - name: D
        run: d
`,
  );
});

Deno.test("a two-level diamond emits each shared dependency once", () => {
  setup();
  const root = step({ name: "Root", run: "root" });
  const left = step.dependsOn(root)({ name: "Left", run: "left" });
  const right = step.dependsOn(root)({ name: "Right", run: "right" });
  const mid = step.dependsOn(left, right)({ name: "Mid", run: "mid" });
  const topLeft = step.dependsOn(mid)({ name: "TopLeft", run: "tl" });
  const topRight = step.dependsOn(mid)({ name: "TopRight", run: "tr" });

  assertEquals(
    stepsYaml([step.dependsOn(topLeft, topRight)({ name: "End", run: "end" })]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Root
        run: root
      - name: Left
        run: left
      - name: Right
        run: right
      - name: Mid
        run: mid
      - name: TopLeft
        run: tl
      - name: TopRight
        run: tr
      - name: End
        run: end
`,
  );
});

Deno.test("a three-step cycle reports the full path", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step({ name: "B", run: "b" });
  const c = step({ name: "C", run: "c" });

  const error = assertThrows(
    () =>
      stepsYaml([
        step.dependsOn(c)(a),
        step.dependsOn(a)(b),
        step.dependsOn(b)(c),
      ]),
    Error,
    "Cycle detected in step ordering",
  );
  // every member of the cycle is named, and the path is closed
  for (const name of ["A", "B", "C"]) {
    assertStringIncludes(error.message, name);
  }
  const path = error.message.split(": ")[1].split(" → ");
  assertEquals(path[0], path[path.length - 1]);
});

Deno.test("dependsOn is order independent for independent branches", () => {
  setup();
  const shared = step({ name: "Shared", run: "s" });
  const a = step.dependsOn(shared)({ name: "A", run: "a" });
  const b = step.dependsOn(shared)({ name: "B", run: "b" });

  // listing B first puts B (and the shared dep) before A
  assertEquals(
    stepsYaml([b, a]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        run: s
      - name: B
        run: b
      - name: A
        run: a
`,
  );
});

// --- condition propagation ---

Deno.test("three differing dependents OR onto a shared dependency", () => {
  setup();
  const shared = step({ name: "Shared", run: "s" });

  assertEquals(
    stepsYaml([
      step.dependsOn(shared).if(isBranch("a"))({ name: "A", run: "a" }),
      step.dependsOn(shared).if(isBranch("b"))({ name: "B", run: "b" }),
      step.dependsOn(shared).if(isBranch("c"))({ name: "C", run: "c" }),
    ]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        if: github.ref == 'refs/heads/a' || github.ref == 'refs/heads/b' || github.ref == 'refs/heads/c'
        run: s
      - name: A
        if: github.ref == 'refs/heads/a'
        run: a
      - name: B
        if: github.ref == 'refs/heads/b'
        run: b
      - name: C
        if: github.ref == 'refs/heads/c'
        run: c
`,
  );
});

Deno.test("an unconditional dependent leaves the shared dep unconditional either way", () => {
  // an unconditional dependent dominates, whichever order the dependents are
  // encountered in — the shared step must run for it regardless of the branch
  const buildYaml = (unconditionalFirst: boolean) => {
    setup();
    const shared = step({ name: "Shared", run: "s" });
    const conditional = step.dependsOn(shared).if(isBranch("main"))({
      name: "A",
      run: "a",
    });
    const unconditional = step.dependsOn(shared)({ name: "B", run: "b" });
    return stepsYaml(
      unconditionalFirst
        ? [unconditional, conditional]
        : [conditional, unconditional],
    );
  };

  assertEquals(
    buildYaml(false),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        run: s
      - name: A
        if: github.ref == 'refs/heads/main'
        run: a
      - name: B
        run: b
`,
  );
  assertEquals(
    buildYaml(true),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        run: s
      - name: B
        run: b
      - name: A
        if: github.ref == 'refs/heads/main'
        run: a
`,
  );
});

Deno.test("a condition propagates through a transitive dependency chain", () => {
  setup();
  const a = step({ name: "A", run: "a" });
  const b = step.dependsOn(a)({ name: "B", run: "b" });

  assertEquals(
    stepsYaml([
      step.dependsOn(b).if(isBranch("main"))({ name: "C", run: "c" }),
    ]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: A
        if: github.ref == 'refs/heads/main'
        run: a
      - name: B
        if: github.ref == 'refs/heads/main'
        run: b
      - name: C
        if: github.ref == 'refs/heads/main'
        run: c
`,
  );
});

Deno.test("complementary dependent conditions cancel out on the shared dep", () => {
  setup();
  const shared = step({ name: "Shared", run: "s" });

  assertEquals(
    stepsYaml([
      step.dependsOn(shared).if(isBranch("main"))({ name: "A", run: "a" }),
      step.dependsOn(shared).if(isBranch("main").not())({
        name: "B",
        run: "b",
      }),
    ]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        run: s
      - name: A
        if: github.ref == 'refs/heads/main'
        run: a
      - name: B
        if: github.ref != 'refs/heads/main'
        run: b
`,
  );
});

Deno.test("an always-false step drops the dependencies it alone pulled in", () => {
  setup();
  const onlyDep = step({ name: "OnlyDep", run: "d" });

  assertEquals(
    stepsYaml([
      step.dependsOn(onlyDep).if(conditions.isFalse())({
        name: "Gone",
        run: "g",
      }),
    ]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps: []
`,
  );
});

Deno.test("the same step in two jobs resolves conditions independently", () => {
  setup();
  const shared = step({ name: "Shared", run: "s" });

  assertEquals(
    workflow({
      name: "test",
      on: {},
      jobs: [
        {
          id: "a",
          runsOn: "ubuntu-latest",
          steps: [step.dependsOn(shared).if(isTag())({ name: "A", run: "a" })],
        },
        {
          id: "b",
          runsOn: "ubuntu-latest",
          steps: [step.dependsOn(shared)({ name: "B", run: "b" })],
        },
      ],
    }).toYamlString(),
    `name: test
on: {}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: s
      - name: A
        if: 'startsWith(github.ref, ''refs/tags/'')'
        run: a
  b:
    runs-on: ubuntu-latest
    steps:
      - name: Shared
        run: s
      - name: B
        run: b
`,
  );
});

// --- parallel groups ---

Deno.test("a step can be ordered after a member of an earlier parallel group", () => {
  setup();
  const first = step({ name: "First", run: "1" });
  const group = step.parallel(first, { name: "Second", run: "2" });

  assertEquals(
    stepsYaml([group, step.comesAfter(first)({ name: "After", run: "a" })]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - parallel:
          - name: First
            run: '1'
          - name: Second
            run: '2'
      - name: After
        run: a
`,
  );
});

Deno.test("the same parallel group listed twice emits a single block", () => {
  setup();
  const group = step.parallel({ name: "A", run: "a" }, { name: "B", run: "b" });

  assertEquals(
    stepsYaml([group, group]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - parallel:
          - name: A
            run: a
          - name: B
            run: b
`,
  );
});

Deno.test("a repeated member appears once in a parallel block", () => {
  setup();
  const a = step({ name: "A", run: "a" });

  assertEquals(
    stepsYaml([step.parallel(a, a, { name: "B", run: "b" })]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - parallel:
          - name: A
            run: a
          - name: B
            run: b
`,
  );
});

Deno.test("a background step used as a group dependency is hoisted, not made a member", () => {
  setup();
  const server = step({ id: "server", run: "serve", background: true });

  assertEquals(
    stepsYaml([
      step.dependsOn(server).parallel(
        { name: "A", run: "a" },
        { name: "B", run: "b" },
      ),
    ]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - id: server
        run: serve
        background: true
      - parallel:
          - name: A
            run: a
          - name: B
            run: b
`,
  );
});

Deno.test("a later step depending on a group runs after the whole block", () => {
  setup();
  const group = step.parallel({ name: "A", run: "a" }, { name: "B", run: "b" });

  assertEquals(
    stepsYaml([step.dependsOn(group)({ name: "After", run: "z" })]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - parallel:
          - name: A
            run: a
          - name: B
            run: b
      - name: After
        run: z
`,
  );
});

// --- background / wait / cancel ---

Deno.test("waitFor and cancel on the same background step keep declaration order", () => {
  setup();
  const server = step({ id: "server", run: "serve", background: true });

  assertEquals(
    stepsYaml([server, step.waitFor(server), step.cancel(server)]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - id: server
        run: serve
        background: true
      - wait: server
      - cancel: server
`,
  );
});

Deno.test("step.cancel pulls in the background step it targets", () => {
  setup();
  const server = step({ id: "server", run: "serve", background: true });

  assertEquals(
    stepsYaml([{ name: "First", run: "f" }, step.cancel(server)]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: First
        run: f
      - id: server
        run: serve
        background: true
      - cancel: server
`,
  );
});

Deno.test("a wait step inherits the deps of a conditional background target", () => {
  setup();
  const prepare = step({ name: "Prepare", run: "p" });
  const server = step.dependsOn(prepare).if(isBranch("main"))({
    id: "server",
    run: "serve",
    background: true,
  });

  assertEquals(
    stepsYaml([step.waitFor(server)]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Prepare
        if: github.ref == 'refs/heads/main'
        run: p
      - id: server
        if: github.ref == 'refs/heads/main'
        run: serve
        background: true
      - wait: server
`,
  );
});

Deno.test("a wait step with an empty target list throws", () => {
  setup();
  assertThrows(
    () => step({ name: "W", wait: [] }),
    Error,
    "A wait step must reference at least one step.",
  );
});

Deno.test("step.waitFor rejects a target that is a group of steps", () => {
  setup();
  const group = step(
    { id: "a", run: "a", background: true },
    { id: "b", run: "b", background: true },
  );

  assertThrows(
    () => step.waitFor(group),
    Error,
    "step.waitFor() requires each referenced step to have an explicit id",
  );
});

// --- artifacts ---

Deno.test("a download declared before its upload still infers needs", () => {
  setup();
  const dist = artifact("dist");
  // the download step is created first — needs inference must still find the upload
  const download = dist.download();
  const upload = dist.upload({ path: "out" });

  assertEquals(
    workflow({
      name: "test",
      on: {},
      jobs: [
        job("build", { runsOn: "ubuntu-latest", steps: [upload] }),
        job("test", { runsOn: "ubuntu-latest", steps: [download] }),
      ],
    }).toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Upload artifact dist
        uses: actions/upload-artifact@v6
        with:
          name: dist
          path: out
  test:
    needs:
      - build
    runs-on: ubuntu-latest
    steps:
      - name: Download artifact dist
        uses: actions/download-artifact@v6
        with:
          name: dist
`,
  );
});

Deno.test("a download needs every job that uploads the artifact", () => {
  setup();
  const dist = artifact("dist");

  assertEquals(
    workflow({
      name: "test",
      on: {},
      jobs: [
        job("linux", {
          runsOn: "ubuntu-latest",
          steps: [dist.upload({ path: "linux" })],
        }),
        job("macos", {
          runsOn: "macos-latest",
          steps: [dist.upload({ path: "macos" })],
        }),
        job("publish", { runsOn: "ubuntu-latest", steps: [dist.download()] }),
      ],
    }).toYamlString(),
    `name: test
on: {}
jobs:
  linux:
    runs-on: ubuntu-latest
    steps:
      - name: Upload artifact dist
        uses: actions/upload-artifact@v6
        with:
          name: dist
          path: linux
  macos:
    runs-on: macos-latest
    steps:
      - name: Upload artifact dist
        uses: actions/upload-artifact@v6
        with:
          name: dist
          path: macos
  publish:
    needs:
      - linux
      - macos
    runs-on: ubuntu-latest
    steps:
      - name: Download artifact dist
        uses: actions/download-artifact@v6
        with:
          name: dist
`,
  );
});

Deno.test("an artifact name interpolating a matrix value carries into both steps", () => {
  setup();
  const matrix = defineMatrix({ os: ["ubuntu-latest", "macos-latest"] });
  const dist = artifact(`dist-${matrix.os}`);

  assertEquals(
    workflow({
      name: "test",
      on: {},
      jobs: [
        job("build", {
          runsOn: matrix.os,
          strategy: { matrix },
          steps: [dist.upload({ path: "out" })],
        }),
        job("publish", {
          runsOn: "ubuntu-latest",
          steps: [dist.download({ dirPath: "in" })],
        }),
      ],
    }).toYamlString(),
    `name: test
on: {}
jobs:
  build:
    runs-on: '\${{ matrix.os }}'
    strategy:
      matrix:
        os:
          - ubuntu-latest
          - macos-latest
    steps:
      - name: 'Upload artifact dist-\${{ matrix.os }}'
        uses: actions/upload-artifact@v6
        with:
          name: 'dist-\${{ matrix.os }}'
          path: out
  publish:
    needs:
      - build
    runs-on: ubuntu-latest
    steps:
      - name: 'Download artifact dist-\${{ matrix.os }}'
        uses: actions/download-artifact@v6
        with:
          name: 'dist-\${{ matrix.os }}'
          path: in
`,
  );
});

// --- matrix ---

Deno.test("a matrix key that would shadow a Matrix member throws", () => {
  setup();
  assertThrows(
    () => defineMatrix({ toYaml: ["a", "b"] } as Record<string, unknown>),
    Error,
    'Matrix key "toYaml" conflicts with a Matrix member',
  );
});

Deno.test("matrixDefOf exposes the unserialized definition and its sources", () => {
  setup();
  const produce = step({
    id: "produce",
    run: "echo versions",
    outputs: ["versions"],
  });
  const matrix = defineMatrix({ version: fromJSON(produce.outputs.versions) });

  // toYaml has already flattened the expression to a string, so needs
  // inference has to read the definition through matrixDefOf instead
  assertEquals(matrix.toYaml(), {
    version: "${{ fromJSON(steps.produce.outputs.versions) }}",
  });
  const def = matrixDefOf(matrix);
  assertEquals(Object.keys(def), ["version"]);
  assertEquals([...(def.version as ExpressionValue).allSources], [produce]);
});

Deno.test("a matrix built from a job output infers needs on that job", () => {
  setup();
  const produce = step({
    id: "produce",
    run: "echo versions",
    outputs: ["versions"],
  });
  const setupJob = job("setup", {
    runsOn: "ubuntu-latest",
    steps: [produce],
    outputs: { versions: produce.outputs.versions },
  });
  const matrix = defineMatrix({ version: fromJSON(setupJob.outputs.versions) });

  assertEquals(
    workflow({
      name: "test",
      on: {},
      jobs: [
        setupJob,
        job("test", {
          runsOn: "ubuntu-latest",
          strategy: { matrix },
          steps: [step({ name: "Test", run: `test ${matrix.version}` })],
        }),
      ],
    }).toYamlString(),
    `name: test
on: {}
jobs:
  setup:
    runs-on: ubuntu-latest
    outputs:
      versions: '\${{ steps.produce.outputs.versions }}'
    steps:
      - id: produce
        run: echo versions
  test:
    needs:
      - setup
    runs-on: ubuntu-latest
    strategy:
      matrix:
        version: '\${{ fromJSON(needs.setup.outputs.versions) }}'
    steps:
      - name: Test
        run: 'test \${{ matrix.version }}'
`,
  );
});

// --- Step / StepRef units ---

Deno.test("Step.toYaml omits generated ids and honours an effective condition", () => {
  setup();
  const generated = step({ name: "Generated", run: "g" });
  assertEquals(generated.toYaml(), { name: "Generated", run: "g" });

  const explicit = step({ id: "explicit", name: "Explicit", run: "e" });
  assertEquals(explicit.toYaml(), {
    name: "Explicit",
    id: "explicit",
    run: "e",
  });

  const conditional = step({ name: "C", run: "c", if: isBranch("main") });
  assertEquals(conditional.toYaml(isTag()), {
    name: "C",
    if: "startsWith(github.ref, 'refs/tags/')",
    run: "c",
  });
});

Deno.test("StepRef modifiers return new refs and accumulate", () => {
  setup();
  const dep = step({ name: "Dep", run: "d" });
  const other = step({ name: "Other", run: "o" });
  const base = step({ name: "Base", run: "b" });

  const withDep = base.dependsOn(dep);
  const withBoth = withDep.dependsOn(other).if(isBranch("main"));

  assertEquals(withDep instanceof StepRef, true);
  assertEquals(withDep.dependencies.length, 1);
  // the original ref is untouched
  assertEquals(withBoth.dependencies.length, 2);
  assertEquals(withDep.condition, undefined);
  assertEquals(withBoth.step, base);
  assertEquals(withBoth.id, base.id);
});

Deno.test("Step.kind and children describe composites", () => {
  setup();
  const leaf = step({ name: "Leaf", run: "l" });
  assertEquals(leaf.kind, "sequential");
  assertEquals(leaf.children.length, 0);

  const group = step.parallel(leaf, { name: "Other", run: "o" });
  assertEquals(group instanceof Step, true);
  assertEquals(group.kind, "parallel");
  assertEquals(group.children.length, 2);
});

Deno.test("a step declaring outputs requires an explicit id", () => {
  setup();
  assertThrows(
    () => step({ run: "echo", outputs: ["value"] }),
    Error,
    "Step with outputs must have an explicit id",
  );

  const withId = step({ id: "producer", run: "echo", outputs: ["value"] });
  assertEquals(
    withId.outputs.value.toString(),
    "${{ steps.producer.outputs.value }}",
  );
});

Deno.test("resetStepCounter makes generated ids reproducible", () => {
  setup();
  const first = step({ name: "A", run: "a" }).id;
  setup();
  const second = step({ name: "A", run: "a" }).id;
  assertEquals(first, second);
  assertEquals(first.startsWith("_step_"), true);
});

Deno.test("resetStepCounter leaves the config memo table intact", () => {
  setup();
  const config = { name: "A", run: "a" };
  const before = step(config);
  assertEquals(before.id, "_step_0");

  setup();
  // the config keeps the step it already produced, id included
  assertEquals(step(config), before);
  assertEquals(before.id, "_step_0");

  // a fresh config restarts numbering, so the generated ids now collide —
  // harmless, since generated ids never reach the YAML and steps are keyed
  // by object identity, not by id
  const other = step({ name: "B", run: "b" });
  assertEquals(other.id, "_step_0");
  assertEquals(other === before, false);

  assertEquals(
    stepsYaml([before, other]),
    `name: test
on: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: A
        run: a
      - name: B
        run: b
`,
  );
});

Deno.test("cross-job deps are exposed as a copy, not the artifact's own list", () => {
  setup();
  const dist = artifact("dist");
  const upload = dist.upload({ path: "out" });
  const download = dist.download();

  const deps = crossJobDepsOf(download);
  assertEquals(deps, [upload]);

  // mutating what the accessor handed back must not corrupt the artifact
  (deps as Step<string>[]).push(new Step({ run: "injected" }));
  assertEquals(crossJobDepsOf(download), [upload]);
});
