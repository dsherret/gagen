import process from "node:process";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parse } from "@std/yaml/parse";
import { action, defineInputs, expr, step } from "./mod.ts";
import { resetStepCounter } from "./step.ts";

// reset step counter between tests for deterministic ids
function setup() {
  resetStepCounter();
}

Deno.test("action serializes metadata, inputs, outputs and composite steps", () => {
  setup();
  const inputs = defineInputs({
    "dprint-version": {
      description: "Specific dprint version to use",
      default: "",
    },
    cache: {
      description: "Cache plugins",
      required: false,
      default: "false",
    },
    token: {
      description: "Token",
      required: true,
      deprecationMessage: "Use `github-token` instead",
    },
  });
  const restore = step({
    id: "restore",
    if: inputs.cache.equals("true"),
    uses: "actions/cache/restore@v5",
    with: { path: "~/.cache", key: inputs["dprint-version"] },
    outputs: ["cache-matched-key"] as const,
  });
  const yaml = action({
    name: "dprint-check-action",
    description: "Run `dprint check`",
    author: "someone",
    inputs,
    outputs: {
      "cache-matched-key": {
        description: "Key of the restored cache",
        value: restore.outputs["cache-matched-key"],
      },
      raw: {
        description: "A raw value",
        value: "${{ steps.restore.outcome }}",
      },
    },
    defaults: { run: { shell: "bash" } },
    steps: [
      step({ name: "Install", run: "curl -fsSL https://example.com | sh" }),
      restore,
      step({ name: "Check", shell: "pwsh", run: "dprint check" }),
    ],
    branding: { icon: "check-circle", color: "gray-dark" },
  }).toYamlString();

  assertEquals(parse(yaml), {
    name: "dprint-check-action",
    description: "Run `dprint check`",
    author: "someone",
    inputs: {
      "dprint-version": {
        description: "Specific dprint version to use",
        default: "",
      },
      cache: {
        description: "Cache plugins",
        required: false,
        default: "false",
      },
      token: {
        description: "Token",
        required: true,
        deprecationMessage: "Use `github-token` instead",
      },
    },
    outputs: {
      "cache-matched-key": {
        description: "Key of the restored cache",
        value: "${{ steps.restore.outputs.cache-matched-key }}",
      },
      raw: {
        description: "A raw value",
        value: "${{ steps.restore.outcome }}",
      },
    },
    runs: {
      using: "composite",
      steps: [
        {
          name: "Install",
          shell: "bash",
          run: "curl -fsSL https://example.com | sh",
        },
        {
          id: "restore",
          uses: "actions/cache/restore@v5",
          if: "inputs.cache == 'true'",
          with: { path: "~/.cache", key: "${{ inputs.dprint-version }}" },
        },
        { name: "Check", shell: "pwsh", run: "dprint check" },
      ],
    },
    branding: { icon: "check-circle", color: "gray-dark" },
  });
});

Deno.test("action places the default shell before env and run", () => {
  setup();
  const yaml = action({
    name: "a",
    description: "d",
    defaults: { run: { shell: "bash", workingDirectory: "src" } },
    steps: [
      step({
        name: "Build",
        id: "build",
        if: "github.event_name == 'push'",
        env: { CI: "1" },
        run: "make",
      }),
    ],
  }).toYamlString();
  const parsed = parse(yaml) as { runs: { steps: Record<string, unknown>[] } };
  assertEquals(Object.keys(parsed.runs.steps[0]), [
    "name",
    "id",
    "if",
    "shell",
    "working-directory",
    "env",
    "run",
  ]);
});

Deno.test("action omits optional sections that are not provided", () => {
  setup();
  const yaml = action({
    name: "minimal",
    description: "A minimal action",
    steps: step({ shell: "bash", run: "echo hi" }),
  }).toYamlString();

  assertEquals(parse(yaml), {
    name: "minimal",
    description: "A minimal action",
    runs: {
      using: "composite",
      steps: [{ shell: "bash", run: "echo hi" }],
    },
  });
});

Deno.test("action resolves step dependencies and propagates conditions", () => {
  setup();
  const inputs = defineInputs({
    cache: { description: "Cache", default: "false" },
  });
  const prepare = step({ name: "Prepare cache", run: "echo prepare" });
  const restore = step({
    name: "Restore cache",
    uses: "actions/cache/restore@v5",
  })
    .dependsOn(prepare);
  const check = step({ name: "Check", run: "dprint check" });

  const yaml = action({
    name: "a",
    description: "d",
    inputs,
    defaults: { run: { shell: "bash" } },
    // only the leaves are listed; `prepare` is pulled in by `restore` and
    // inherits the condition applied to that usage
    steps: [step.if(inputs.cache.equals("true"))(restore), check],
  }).toYamlString();

  const parsed = parse(yaml) as { runs: { steps: Record<string, unknown>[] } };
  assertEquals(parsed.runs.steps.map((s) => [s.name, s.if]), [
    ["Prepare cache", "inputs.cache == 'true'"],
    ["Restore cache", "inputs.cache == 'true'"],
    ["Check", undefined],
  ]);
});

Deno.test("action requires a shell on run steps", () => {
  setup();
  assertThrows(
    () =>
      action({
        name: "a",
        description: "d",
        steps: [step({ name: "Check", run: "dprint check" })],
      }).toYamlString(),
    Error,
    'Composite action run steps require a shell, but the step "Check" has none.',
  );
  // a step with neither a name nor an id is described by its first line
  assertThrows(
    () =>
      action({
        name: "a",
        description: "d",
        steps: [step({ run: "echo one\necho two" })],
      }).toYamlString(),
    Error,
    "the step running `echo one` has none",
  );
});

Deno.test("action rejects an output referencing a step that is not emitted", () => {
  setup();
  const other = step({
    id: "other",
    name: "other",
    uses: "some/action@v1",
    outputs: ["value"] as const,
  });
  assertThrows(
    () =>
      action({
        name: "my-action",
        description: "d",
        outputs: { value: { description: "v", value: other.outputs.value } },
        steps: [step({ shell: "bash", run: "echo hi" })],
      }).toYamlString(),
    Error,
    'Action "my-action" output "value" references step "other", which is not one of the action\'s steps.',
  );
});

Deno.test("defineInputs exposes typed input expressions", () => {
  const inputs = defineInputs({
    "config-path": { description: "Config" },
  });
  assertEquals(inputs["config-path"].expression, "inputs.config-path");
  assertEquals(inputs["config-path"].toString(), "${{ inputs.config-path }}");
  assertEquals(
    inputs["config-path"].notEquals("").toExpression(),
    "inputs.config-path != ''",
  );
});

Deno.test("defineInputs rejects an input that shadows a member", () => {
  assertThrows(
    () => defineInputs({ toYaml: { description: "x" } }),
    Error,
    'Input "toYaml" conflicts with an ActionInputs member',
  );
});

Deno.test("action writeOrLint pins uses references and lints the result", () => {
  setup();
  const fakeHash = "d".repeat(40);
  const a = action({
    name: "a",
    description: "d",
    steps: [
      step({ uses: "actions/cache/restore@v5" }),
      step({ uses: "./" }),
    ],
  });

  const tmpDir = Deno.makeTempDirSync();
  const filePath = new URL(`file://${tmpDir}/action.yml`);
  try {
    a.writeOrLint({
      filePath,
      header: "# GENERATED",
      pinDeps: { resolve: () => fakeHash },
    });
    const written = Deno.readTextFileSync(filePath);
    assertStringIncludes(written, "# GENERATED\n\n");
    assertStringIncludes(
      written,
      `uses: actions/cache/restore@${fakeHash} # v5`,
    );
    // local references are never pinned
    assertStringIncludes(written, "uses: ./\n");

    const originalArgv = [...process.argv];
    process.argv.push("--lint");
    try {
      a.writeOrLint({ filePath, header: "# GENERATED" });
    } finally {
      process.argv.length = originalArgv.length;
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("action serializes expressions in env and run", () => {
  setup();
  const inputs = defineInputs({
    args: { description: "Args", default: "" },
  });
  const yaml = action({
    name: "a",
    description: "d",
    inputs,
    steps: [
      step({
        shell: "bash",
        env: { ARGS: inputs.args },
        run: `dprint check ${expr("inputs.args")}`,
      }),
    ],
  }).toYamlString();
  const parsed = parse(yaml) as { runs: { steps: Record<string, unknown>[] } };
  assertEquals(parsed.runs.steps[0], {
    shell: "bash",
    env: { ARGS: "${{ inputs.args }}" },
    run: "dprint check ${{ inputs.args }}",
  });
});
