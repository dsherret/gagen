import process from "node:process";
import fs from "node:fs";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml/parse";
import { stringify } from "@std/yaml/stringify";
import {
  collectActionVersions,
  isCommitHash,
  parseActionUses,
  parsePinComments,
  type PinEntry,
  pinParsedYaml,
  pinYamlContent,
  pullVersionsInSource,
  type RefResolver,
  unpinParsedYaml,
} from "./pin.ts";
import { runCli } from "./cli.ts";
import { step, workflow } from "./mod.ts";

const HASH = "a".repeat(40);
const OTHER_HASH = "b".repeat(40);

// --- parseActionUses ---

Deno.test("parseActionUses parses a reusable workflow reference", () => {
  assertEquals(
    parseActionUses("owner/repo/.github/workflows/release.yml@main"),
    {
      owner: "owner",
      repo: "repo",
      path: ".github/workflows/release.yml",
      ref: "main",
    },
  );
});

Deno.test("parseActionUses keeps slashes in the ref", () => {
  assertEquals(
    parseActionUses("owner/repo@feature/branch")?.ref,
    "feature/branch",
  );
  assertEquals(
    parseActionUses("owner/repo@refs/tags/v1.0.0")?.ref,
    "refs/tags/v1.0.0",
  );
});

Deno.test("parseActionUses parses an already pinned sha", () => {
  assertEquals(parseActionUses(`actions/checkout@${HASH}`), {
    owner: "actions",
    repo: "checkout",
    path: "",
    ref: HASH,
  });
});

Deno.test("parseActionUses returns undefined for parent relative actions", () => {
  // resolving this would have hit github.com/../up
  assertEquals(parseActionUses("../up/action@v1"), undefined);
});

Deno.test("parseActionUses returns undefined for a docker digest", () => {
  assertEquals(parseActionUses("docker://alpine@sha256:abc123"), undefined);
});

Deno.test("parseActionUses returns undefined for an empty ref", () => {
  assertEquals(parseActionUses("actions/checkout@"), undefined);
});

Deno.test("parseActionUses returns undefined for an empty owner or repo", () => {
  assertEquals(parseActionUses("/checkout@v1"), undefined);
  assertEquals(parseActionUses("actions/@v1"), undefined);
});

// --- isCommitHash ---

Deno.test("isCommitHash requires exactly 40 lowercase hex characters", () => {
  assertEquals(isCommitHash("a".repeat(39)), false);
  assertEquals(isCommitHash("a".repeat(41)), false);
  assertEquals(isCommitHash("a".repeat(64)), false);
  assertEquals(isCommitHash("A".repeat(40)), false);
  assertEquals(isCommitHash("abcdef"), false);
  assertEquals(isCommitHash(""), false);
  assertEquals(isCommitHash(` ${HASH}`), false);
});

// --- pinYamlContent ---

Deno.test("pinYamlContent does not resolve local or docker actions", () => {
  const original = stringify({
    jobs: {
      build: {
        steps: [
          { uses: "./local/action" },
          { uses: "../up/action@v1" },
          { uses: "docker://alpine:3" },
          // the yaml serializer quotes this one, which used to make it look
          // like an action owned by `'docker:`
          { uses: "docker://alpine@sha256:abc123" },
        ],
      },
    },
  });
  const { content, pins } = pinYamlContent(original, failingResolver());
  assertEquals(content, original);
  assertEquals(pins, []);
});

Deno.test("pinYamlContent keeps the quotes around a quoted uses value", () => {
  const original =
    `jobs:\n  build:\n    steps:\n      - uses: 'owner/repo@v1'\n`;
  const { content, pins } = pinYamlContent(original, () => HASH);
  assertEquals(
    content,
    `jobs:\n  build:\n    steps:\n      - uses: 'owner/repo@${HASH}' # v1\n`,
  );
  assertEquals(pins, [{ original: "owner/repo@v1", hash: HASH }]);
  // the comment must land outside the quotes so the value still parses
  assertEquals(
    parse(content),
    { jobs: { build: { steps: [{ uses: `owner/repo@${HASH}` }] } } },
  );
});

Deno.test("pinYamlContent pins a job level reusable workflow uses", () => {
  const original = stringify({
    jobs: {
      release: { uses: "owner/repo/.github/workflows/release.yml@v2" },
    },
  });
  const { content, pins } = pinYamlContent(original, () => HASH);
  assertStringIncludes(
    content,
    `uses: owner/repo/.github/workflows/release.yml@${HASH} # v2`,
  );
  assertEquals(pins, [{
    original: "owner/repo/.github/workflows/release.yml@v2",
    hash: HASH,
  }]);
});

Deno.test("pinYamlContent is idempotent on an already pinned file", () => {
  const original = stringify({
    jobs: { build: { steps: [{ uses: "actions/checkout@v6" }] } },
  });
  const first = pinYamlContent(original, () => HASH);
  const second = pinYamlContent(first.content, failingResolver());
  assertEquals(second.content, first.content);
  assertEquals(second.pins, first.pins);
});

Deno.test("pinYamlContent resolves each distinct ref of the same action", () => {
  const original = stringify({
    jobs: {
      a: { steps: [{ uses: "owner/repo@v1" }] },
      b: { steps: [{ uses: "owner/repo@v2" }] },
    },
  });
  const refs: string[] = [];
  const { content, pins } = pinYamlContent(original, (_o, _r, ref) => {
    refs.push(ref);
    return ref === "v1" ? HASH : OTHER_HASH;
  });
  assertEquals(refs, ["v1", "v2"]);
  assertStringIncludes(content, `owner/repo@${HASH} # v1`);
  assertStringIncludes(content, `owner/repo@${OTHER_HASH} # v2`);
  assertEquals(pins, [
    { original: "owner/repo@v1", hash: HASH },
    { original: "owner/repo@v2", hash: OTHER_HASH },
  ]);
});

Deno.test("pinYamlContent ignores a stale cache entry for another ref", () => {
  const original = stringify({
    jobs: { build: { steps: [{ uses: "actions/checkout@v7" }] } },
  });
  const cache: PinEntry[] = [{ original: "actions/checkout@v6", hash: HASH }];
  const { content, pins } = pinYamlContent(original, () => OTHER_HASH, cache);
  assertStringIncludes(content, `actions/checkout@${OTHER_HASH} # v7`);
  assertEquals(pins, [{ original: "actions/checkout@v7", hash: OTHER_HASH }]);
});

Deno.test("pinYamlContent leaves an unresolvable pinned hash untouched", () => {
  // no inline comment and no cache entry, so the original ref is unknown
  const original =
    `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${HASH}\n`;
  const { content, pins } = pinYamlContent(original, failingResolver());
  assertEquals(content, original);
  assertEquals(pins, []);
});

Deno.test("pinYamlContent ignores a uses value inside a single line run", () => {
  const original =
    `jobs:\n  build:\n    steps:\n      - run: echo "uses: actions/checkout@v6"\n`;
  const { content } = pinYamlContent(original, failingResolver());
  assertEquals(content, original);
});

Deno.test("pinYamlContent rewrites a uses line inside a block scalar", () => {
  // known limitation, asserted so that it is not mistaken for working:
  // pinning is line based, so a `uses:` line inside a `run: |` script is
  // indistinguishable from a real one and gets rewritten into the user's
  // shell script. Telling them apart needs document level rewriting.
  const original = stringify({
    jobs: {
      build: {
        steps: [{ run: "cat <<EOF\n  - uses: actions/checkout@v6\nEOF" }],
      },
    },
  });
  const { content } = pinYamlContent(original, () => HASH);
  assertStringIncludes(content, `- uses: actions/checkout@${HASH} # v6`);
});

Deno.test("pinYamlContent keeps crlf line endings intact", () => {
  const original =
    `jobs:\r\n  build:\r\n    steps:\r\n      - uses: actions/checkout@v6\r\n`;
  const { content } = pinYamlContent(original, () => HASH);
  assertEquals(
    content,
    `jobs:\r\n  build:\r\n    steps:\r\n      - uses: actions/checkout@${HASH} # v6\r\n`,
  );
  // and the reader still finds the pin in what the writer produced
  assertEquals(parsePinComments(content), [{
    original: "actions/checkout@v6",
    hash: HASH,
  }]);
});

// --- pin/unpin round trips ---

Deno.test("pin/unpin round-trips every supported uses form", () => {
  const forms = [
    "actions/checkout@v6",
    "owner/repo/sub/dir@v1",
    "owner/repo/.github/workflows/release.yml@main",
    "owner/repo@feature/branch",
    "owner/repo@refs/tags/v1.0.0",
    "owner/repo@1234567",
    "./local/action",
    "docker://alpine:3",
  ];
  for (const form of forms) {
    const original = stringify({
      jobs: { build: { steps: [{ uses: form }] } },
    });
    assertEquals(roundTrip(original), original, `round trip failed: ${form}`);
  }
});

Deno.test("pin/unpin round-trips a job level uses beside steps jobs", () => {
  const original = stringify({
    jobs: {
      release: {
        uses: "owner/repo/.github/workflows/release.yml@v2",
        secrets: "inherit",
      },
      build: { steps: [{ uses: "actions/checkout@v6" }] },
    },
  });
  assertEquals(roundTrip(original), original);
});

Deno.test("pin/unpin round-trips nested parallel blocks", () => {
  const original = stringify({
    jobs: {
      build: {
        steps: [
          {
            parallel: [
              { uses: "actions/checkout@v6" },
              { parallel: [{ uses: "denoland/setup-deno@v2" }] },
            ],
          },
        ],
      },
    },
  });
  assertEquals(roundTrip(original), original);
});

// --- pinParsedYaml ---

Deno.test("pinParsedYaml pins every ref, including two that share a hash", () => {
  // `v1` and `v1.0.0` commonly point at the same commit. Pinning is a
  // function of the ref, so both sides still line up, whereas unpinning has
  // to guess and gets one of them wrong.
  const pins: PinEntry[] = [
    { original: "owner/repo@v1", hash: HASH },
    { original: "owner/repo@v1.0.0", hash: HASH },
  ];
  const expected = {
    jobs: {
      a: { steps: [{ uses: "owner/repo@v1" }] },
      b: { steps: [{ uses: "owner/repo@v1.0.0" }] },
    },
  };
  assertEquals(pinParsedYaml(expected, pins), {
    jobs: {
      a: { steps: [{ uses: `owner/repo@${HASH}` }] },
      b: { steps: [{ uses: `owner/repo@${HASH}` }] },
    },
  });

  // the other direction cannot tell the two apart
  const generated = {
    jobs: {
      a: { steps: [{ uses: `owner/repo@${HASH}` }] },
      b: { steps: [{ uses: `owner/repo@${HASH}` }] },
    },
  };
  unpinParsedYaml(generated, pins);
  assertEquals(generated.jobs.a.steps[0].uses, generated.jobs.b.steps[0].uses);
});

Deno.test("pinParsedYaml reaches uses values at any depth", () => {
  const pins: PinEntry[] = [{ original: "actions/checkout@v6", hash: HASH }];
  const obj = {
    jobs: {
      release: { uses: "actions/checkout@v6" },
      build: {
        steps: [
          { uses: "actions/checkout@v6" },
          { parallel: [{ parallel: [{ uses: "actions/checkout@v6" }] }] },
        ],
      },
    },
  };
  assertEquals(pinParsedYaml(obj, pins), {
    jobs: {
      release: { uses: `actions/checkout@${HASH}` },
      build: {
        steps: [
          { uses: `actions/checkout@${HASH}` },
          {
            parallel: [{ parallel: [{ uses: `actions/checkout@${HASH}` }] }],
          },
        ],
      },
    },
  });
});

Deno.test("pinParsedYaml leaves refs it has no pin for alone", () => {
  const obj = { jobs: { build: { steps: [{ uses: "actions/checkout@v7" }] } } };
  pinParsedYaml(obj, [{ original: "actions/checkout@v6", hash: HASH }]);
  assertEquals(obj.jobs.build.steps[0].uses, "actions/checkout@v7");
});

Deno.test("pinParsedYaml tolerates empty pins and non-object input", () => {
  const pins: PinEntry[] = [{ original: "actions/checkout@v6", hash: HASH }];
  assertEquals(pinParsedYaml(undefined, pins), undefined);
  assertEquals(pinParsedYaml("text", pins), "text");
  const obj = { jobs: { a: null, b: { steps: [null, "text"] } } };
  assertEquals(pinParsedYaml(obj, []), obj);
  assertEquals(pinParsedYaml(obj, pins), obj);
});

Deno.test("unpinParsedYaml leaves hashes it has no pin for alone", () => {
  const obj = {
    jobs: { build: { steps: [{ uses: `actions/checkout@${OTHER_HASH}` }] } },
  };
  unpinParsedYaml(obj, [{ original: "actions/checkout@v6", hash: HASH }]);
  assertEquals(obj.jobs.build.steps[0].uses, `actions/checkout@${OTHER_HASH}`);
});

Deno.test("unpinParsedYaml tolerates non-object jobs and steps", () => {
  const pins: PinEntry[] = [{ original: "actions/checkout@v6", hash: HASH }];
  assertEquals(unpinParsedYaml(undefined, pins), undefined);
  assertEquals(unpinParsedYaml("text", pins), "text");
  const obj = { jobs: { a: null, b: { steps: [null, "text"] } } };
  assertEquals(unpinParsedYaml(obj, pins), obj);
});

// --- parsePinComments ---

Deno.test("parsePinComments ignores pinned lines without a version comment", () => {
  const content = `      - uses: actions/checkout@${HASH}\n`;
  assertEquals(parsePinComments(content), []);
});

Deno.test("parsePinComments ignores unpinned uses lines", () => {
  const content = `      - uses: actions/checkout@v6 # v6\n`;
  assertEquals(parsePinComments(content), []);
});

Deno.test("parsePinComments reads a quoted pinned value", () => {
  const content = `      - uses: 'owner/repo@${HASH}' # v1\n`;
  assertEquals(parsePinComments(content), [{
    original: "owner/repo@v1",
    hash: HASH,
  }]);
});

// --- collectActionVersions ---

Deno.test("collectActionVersions ignores unpinned and local uses", () => {
  const yaml = `jobs:
  build:
    steps:
      - uses: ./local/action
      - uses: actions/checkout@v6
      - uses: denoland/setup-deno@${HASH} # v2
`;
  const { versions, conflicts } = collectActionVersions([yaml]);
  assertEquals([...versions], [["denoland/setup-deno", "v2"]]);
  assertEquals(conflicts.size, 0);
});

// --- pullVersionsInSource ---

Deno.test("pullVersionsInSource rewrites a subpath action literal", () => {
  const source = `step({ uses: "owner/repo/sub/dir@v1" });`;
  const versions = new Map([["owner/repo/sub/dir", "v2"]]);
  const { content, changes } = pullVersionsInSource(source, versions);
  assertEquals(content, `step({ uses: "owner/repo/sub/dir@v2" });`);
  assertEquals(changes, [{
    action: "owner/repo/sub/dir",
    from: "v1",
    to: "v2",
  }]);
});

Deno.test("pullVersionsInSource leaves module specifiers alone", () => {
  const source = `import { step } from "jsr:@david/gagen@0.1.0";
const url = "https://github.com/actions/checkout@v6";`;
  const versions = new Map([
    ["@david/gagen", "0.2.0"],
    ["actions/checkout", "v7"],
  ]);
  const { content, changes } = pullVersionsInSource(source, versions);
  assertEquals(content, source);
  assertEquals(changes, []);
});

// --- writeOrLint's lint path ---

Deno.test("writeOrLint --lint passes when two refs resolve to the same commit", async () => {
  // `v1` and `v1.0.0` resolving to one commit used to deadlock linting: both
  // steps unpinned to whichever ref was seen last, so the file was reported
  // out of date forever and regenerating produced the same bytes again
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      {
        id: "a",
        runsOn: "ubuntu-latest",
        steps: [step({ uses: "owner/repo@v1" })],
      },
      {
        id: "b",
        runsOn: "ubuntu-latest",
        steps: [step({ uses: "owner/repo@v1.0.0" })],
      },
    ],
  });
  const { dir, filePath } = tempFilePath();
  try {
    wf.writeOrLint({ filePath, pinDeps: { resolve: () => HASH } });
    const written = fs.readFileSync(filePath, "utf8");
    assertStringIncludes(written, `owner/repo@${HASH} # v1\n`);
    assertStringIncludes(written, `owner/repo@${HASH} # v1.0.0\n`);

    const { exitCode } = await captureRun(
      ["--lint"],
      () => wf.writeOrLint({ filePath }),
    );
    assertEquals(exitCode, undefined);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("writeOrLint --lint fails when the generated file is out of date", async () => {
  const config = (command: string) => ({
    name: "ci",
    on: {},
    jobs: [{
      id: "build",
      runsOn: "ubuntu-latest",
      steps: [step({ name: "Test", run: command })],
    }],
  });
  const { dir, filePath } = tempFilePath();
  try {
    workflow(config("echo old")).writeOrLint({ filePath, pinDeps: false });
    const { output, exitCode } = await captureRun(
      ["--lint"],
      () => workflow(config("echo new")).writeOrLint({ filePath }),
    );
    assertEquals(exitCode, 1);
    assertStringIncludes(output, "is out of date");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("writeOrLint --lint explains that the file does not exist", async () => {
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [{
      id: "build",
      runsOn: "ubuntu-latest",
      steps: [step({ name: "Test", run: "echo hi" })],
    }],
  });
  const { dir, filePath } = tempFilePath();
  try {
    const { output, exitCode } = await captureRun(
      ["--lint"],
      () => wf.writeOrLint({ filePath }),
    );
    assertEquals(exitCode, 1);
    assertStringIncludes(output, "does not exist");
    assertStringIncludes(output, "Run without --lint");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("writeOrLint rejects an unknown flag when run directly", async () => {
  // running the script directly skips the cli, so the flag check has to live
  // here too or `./ci.ts --lnit` silently overwrites what it should check
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [{
      id: "build",
      runsOn: "ubuntu-latest",
      steps: [step({ name: "Test", run: "echo hi" })],
    }],
  });
  const { dir, filePath } = tempFilePath();
  try {
    const { output, exitCode } = await captureRun(
      ["--lnit"],
      () => wf.writeOrLint({ filePath, pinDeps: false }),
    );
    assertEquals(exitCode, 1);
    assertStringIncludes(output, "Unknown flag: --lnit");
    assertEquals(fs.existsSync(filePath), false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// --- cli ---

Deno.test("cli --help prints the usage and exits successfully", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const { output, exitCode } = await runCliIn(dir, ["--help"]);
    assertEquals(exitCode, undefined);
    assertStringIncludes(output, "Usage:");
    assertStringIncludes(output, "--lint");
    assertStringIncludes(output, "--update-pins");
    assertStringIncludes(output, "--pull-versions");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli fails on an unknown flag instead of generating", async () => {
  const dir = createWorkflowsDir({
    fileName: "ci.mjs",
    script: generateScript,
  });
  try {
    // a typo like this used to silently overwrite the generated files
    const { output, exitCode } = await runCliIn(dir, ["--lnit"]);
    assertEquals(exitCode, 1);
    assertStringIncludes(output, "Unknown flag: --lnit");
    assertEquals(
      fs.existsSync(join(dir, ".github/workflows/ci.generated.yml")),
      false,
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli generates the workflows in .github/workflows", async () => {
  const dir = createWorkflowsDir({
    fileName: "ci.mjs",
    script: generateScript,
  });
  try {
    const { output, exitCode } = await runCliIn(dir, []);
    assertEquals(exitCode, undefined);
    assertStringIncludes(output, "Generating");
    assertStringIncludes(output, "ci.mjs");
    const generated = fs.readFileSync(
      join(dir, ".github/workflows/ci.generated.yml"),
      "utf8",
    );
    assertStringIncludes(generated, "name: ci");
    assertStringIncludes(generated, "run: echo hi");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli fails when no script uses writeOrLint", async () => {
  const dir = createWorkflowsDir({ script: "export const shared = 1;\n" });
  try {
    const { output, exitCode } = await runCliIn(dir, []);
    assertEquals(exitCode, 1);
    assertStringIncludes(output, "nothing to do");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli fails when there is no .github/workflows directory", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const { output, exitCode } = await runCliIn(dir, []);
    assertEquals(exitCode, 1);
    assertStringIncludes(output, "No .github/workflows directory found.");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli --pull-versions updates the scripts from the generated yaml", async () => {
  const dir = createWorkflowsDir({
    script: `const checkout = "actions/checkout@v6";\nwriteOrLint;\n`,
  });
  const workflowsDir = join(dir, ".github/workflows");
  fs.writeFileSync(
    join(workflowsDir, "ci.generated.yml"),
    `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${HASH} # v7\n`,
  );
  try {
    const { output, exitCode } = await runCliIn(dir, ["--pull-versions"]);
    assertEquals(exitCode, undefined);
    assertStringIncludes(output, "actions/checkout@v6");
    assertEquals(
      fs.readFileSync(join(workflowsDir, "ci.ts"), "utf8"),
      `const checkout = "actions/checkout@v7";\nwriteOrLint;\n`,
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli --pull-versions reports conflicting versions", async () => {
  const dir = createWorkflowsDir({
    script: `const checkout = "actions/checkout@v6";\nwriteOrLint;\n`,
  });
  const workflowsDir = join(dir, ".github/workflows");
  fs.writeFileSync(
    join(workflowsDir, "a.generated.yml"),
    `      - uses: actions/checkout@${HASH} # v7\n`,
  );
  fs.writeFileSync(
    join(workflowsDir, "b.generated.yml"),
    `      - uses: actions/checkout@${OTHER_HASH} # v8\n`,
  );
  try {
    const { output } = await runCliIn(dir, ["--pull-versions"]);
    assertStringIncludes(output, "conflicting versions");
    assertEquals(
      fs.readFileSync(join(workflowsDir, "ci.ts"), "utf8"),
      `const checkout = "actions/checkout@v6";\nwriteOrLint;\n`,
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// --- helpers ---

function roundTrip(original: string): string {
  const { content } = pinYamlContent(original, () => HASH);
  const unpinned = unpinParsedYaml(parse(content), parsePinComments(content));
  return stringify(unpinned as Record<string, unknown>);
}

function failingResolver(): RefResolver {
  return (owner, repo, ref) => {
    throw new Error(`unexpected resolve of ${owner}/${repo}@${ref}`);
  };
}

// the cli only imports scripts that mention writeOrLint, so the script it
// runs is kept dependency free in order to also run from the npm build
const generateScript = `import fs from "node:fs";

// writeOrLint
fs.writeFileSync(
  new URL("./ci.generated.yml", import.meta.url),
  "name: ci\\njobs:\\n  build:\\n    steps:\\n      - run: echo hi\\n",
);
`;

/** Creates a temp directory containing a script in `.github/workflows`. */
function createWorkflowsDir(
  options?: { fileName?: string; script?: string },
): string {
  const dir = Deno.makeTempDirSync();
  const workflowsDir = join(dir, ".github/workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    join(workflowsDir, options?.fileName ?? "ci.ts"),
    options?.script ?? `const checkout = "actions/checkout@v6";\n`,
  );
  return dir;
}

/** Creates a temp directory and a file path in it to generate into. */
function tempFilePath(): { dir: string; filePath: URL } {
  const dir = Deno.makeTempDirSync();
  return { dir, filePath: new URL(`file://${dir}/ci.yml`) };
}

class ExitError extends Error {}

/** Runs the cli in `cwd`, capturing its output and exit code. */
async function runCliIn(
  cwd: string,
  args: string[],
): Promise<{ output: string; exitCode: number | undefined }> {
  const originalCwd = Deno.cwd();
  Deno.chdir(cwd);
  try {
    // must stay awaited so the cwd is still in place for the dynamic imports
    return await captureRun(args, runCli);
  } finally {
    Deno.chdir(originalCwd);
  }
}

/**
 * Runs an action with the given command line flags in place, capturing what
 * it writes to the console and the code it exits with, if any.
 */
async function captureRun(
  args: string[],
  action: () => unknown,
): Promise<{ output: string; exitCode: number | undefined }> {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  let exitCode: number | undefined;

  process.argv = [originalArgv[0], originalArgv[1], ...args];
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitError();
  }) as never;
  console.log = (...data: unknown[]) => lines.push(data.join(" "));
  console.error = (...data: unknown[]) => lines.push(data.join(" "));
  try {
    await action();
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exit = originalExit;
    process.argv = originalArgv;
  }
  return { output: lines.join("\n"), exitCode };
}
