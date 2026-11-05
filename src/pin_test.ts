import process from "node:process";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml/parse";
import { stringify } from "@std/yaml/stringify";
import {
  collectActionVersions,
  isCommitHash,
  narrowYamlContent,
  parseActionUses,
  parseLockfilePins,
  parsePinComments,
  parseTagCommits,
  pickNarrowedTag,
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
  assertEquals(pins, [{ original: "owner/repo@v1", pinned: HASH }]);
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
    pinned: HASH,
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
    { original: "owner/repo@v1", pinned: HASH },
    { original: "owner/repo@v2", pinned: OTHER_HASH },
  ]);
});

Deno.test("pinYamlContent ignores a stale cache entry for another ref", () => {
  const original = stringify({
    jobs: { build: { steps: [{ uses: "actions/checkout@v7" }] } },
  });
  const cache: PinEntry[] = [{ original: "actions/checkout@v6", pinned: HASH }];
  const { content, pins } = pinYamlContent(original, () => OTHER_HASH, cache);
  assertStringIncludes(content, `actions/checkout@${OTHER_HASH} # v7`);
  assertEquals(pins, [{ original: "actions/checkout@v7", pinned: OTHER_HASH }]);
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
    pinned: HASH,
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
    { original: "owner/repo@v1", pinned: HASH },
    { original: "owner/repo@v1.0.0", pinned: HASH },
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
  const pins: PinEntry[] = [{ original: "actions/checkout@v6", pinned: HASH }];
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
  pinParsedYaml(obj, [{ original: "actions/checkout@v6", pinned: HASH }]);
  assertEquals(obj.jobs.build.steps[0].uses, "actions/checkout@v7");
});

Deno.test("pinParsedYaml tolerates empty pins and non-object input", () => {
  const pins: PinEntry[] = [{ original: "actions/checkout@v6", pinned: HASH }];
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
  unpinParsedYaml(obj, [{ original: "actions/checkout@v6", pinned: HASH }]);
  assertEquals(obj.jobs.build.steps[0].uses, `actions/checkout@${OTHER_HASH}`);
});

Deno.test("unpinParsedYaml tolerates non-object jobs and steps", () => {
  const pins: PinEntry[] = [{ original: "actions/checkout@v6", pinned: HASH }];
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
    pinned: HASH,
  }]);
});

// --- narrowing ---

Deno.test("parseTagCommits uses the peeled commit of an annotated tag", () => {
  const output = [
    `${"1".repeat(40)}\trefs/tags/v1`,
    `${"2".repeat(40)}\trefs/tags/v1.0.0`,
    `${"3".repeat(40)}\trefs/tags/v1.0.0^{}`,
    "",
  ].join("\n");
  assertEquals([...parseTagCommits(output)], [
    ["v1", "1".repeat(40)],
    ["v1.0.0", "3".repeat(40)],
  ]);
});

Deno.test("pickNarrowedTag picks the highest full version in the family at the commit", () => {
  const tagCommits = new Map([
    ["v6", HASH],
    ["v6.0.0", HASH],
    ["v6.0.1", HASH],
    ["v6.1.0", OTHER_HASH],
    ["v7.0.0", HASH],
    ["v6.0.2-beta", HASH],
  ]);
  assertEquals(pickNarrowedTag("v6", HASH, tagCommits), "v6.0.1");
  assertEquals(pickNarrowedTag("v6.0", HASH, tagCommits), "v6.0.1");
  assertEquals(pickNarrowedTag("v6.1", HASH, tagCommits), undefined);
  assertEquals(pickNarrowedTag("v6.1", OTHER_HASH, tagCommits), "v6.1.0");
});

Deno.test("pickNarrowedTag compares versions numerically and prefers a v prefix", () => {
  const tagCommits = new Map([
    ["1.10.0", HASH],
    ["v1.9.0", HASH],
    ["v1.10.0", HASH],
  ]);
  assertEquals(pickNarrowedTag("v1", HASH, tagCommits), "v1.10.0");
});

Deno.test("pickNarrowedTag does not narrow full versions or other refs", () => {
  const tagCommits = new Map([["v6.0.1", HASH]]);
  assertEquals(pickNarrowedTag("v6.0.1", HASH, tagCommits), undefined);
  assertEquals(pickNarrowedTag("main", HASH, tagCommits), undefined);
  assertEquals(pickNarrowedTag("v6.0.1-rc.1", HASH, new Map()), undefined);
});

Deno.test("pickNarrowedTag narrows a suffixed version like gh actions-lock", () => {
  const tagCommits = new Map([
    ["v2.0.0-rc.1", HASH],
    ["v2.0.0", HASH],
    ["v2.1.0", HASH],
    ["v4.2.1", OTHER_HASH],
  ]);
  assertEquals(pickNarrowedTag("v2.0.0-rc.1", HASH, tagCommits), "v2.0.0");
  // a missing minor counts as 0 when there is a suffix
  assertEquals(pickNarrowedTag("v2-beta", HASH, tagCommits), "v2.0.0");
  assertEquals(pickNarrowedTag("v4.2.x", OTHER_HASH, tagCommits), "v4.2.1");
});

Deno.test("narrowYamlContent narrows partial versions and leaves other refs", () => {
  const yaml = `jobs:
  build:
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v4.2
      - uses: denoland/setup-deno@v2.0.3
      - uses: owner/repo@main
      - uses: owner/pinned@${HASH}
      - uses: ./local/action
      - uses: $/.github/actions/setup
`;
  const calls: string[] = [];
  const { content, pins } = narrowYamlContent(yaml, (owner, repo, ref) => {
    calls.push(`${owner}/${repo}@${ref}`);
    return ref === "v6" ? "v6.0.1" : "v4.2.5";
  });
  assertEquals(calls, ["actions/checkout@v6", "actions/setup-node@v4.2"]);
  assertEquals(
    content,
    `jobs:
  build:
    steps:
      - uses: actions/checkout@v6.0.1 # v6
      - uses: actions/setup-node@v4.2.5 # v4.2
      - uses: denoland/setup-deno@v2.0.3
      - uses: owner/repo@main
      - uses: owner/pinned@${HASH}
      - uses: ./local/action
      - uses: $/.github/actions/setup
`,
  );
  assertEquals(pins, [
    { original: "actions/checkout@v6", pinned: "v6.0.1" },
    { original: "actions/setup-node@v4.2", pinned: "v4.2.5" },
  ]);
});

Deno.test("narrowYamlContent pins a reusable workflow to a hash", () => {
  // the lockfile doesn't lock reusable workflows from other repositories
  const yaml = `jobs:
  call:
    uses: owner/repo/.github/workflows/release.yml@v1
  pinned:
    uses: owner/repo/.github/workflows/release.yml@${OTHER_HASH}
`;
  const { content, pins } = narrowYamlContent(
    yaml,
    failingResolver(),
    undefined,
    () => HASH,
  );
  assertEquals(
    content,
    `jobs:
  call:
    uses: owner/repo/.github/workflows/release.yml@${HASH} # v1
  pinned:
    uses: owner/repo/.github/workflows/release.yml@${OTHER_HASH}
`,
  );
  assertEquals(parseLockfilePins(content), pins);
});

Deno.test("parseLockfilePins leaves out the hashes of actions", () => {
  const content = `      - uses: actions/checkout@${HASH} # v6
      - uses: actions/setup-node@v4.2.0 # v4
    uses: owner/repo/.github/workflows/release.yml@${OTHER_HASH} # v1
`;
  assertEquals(parseLockfilePins(content), [
    { original: "actions/setup-node@v4", pinned: "v4.2.0" },
    {
      original: "owner/repo/.github/workflows/release.yml@v1",
      pinned: OTHER_HASH,
    },
  ]);
});

Deno.test("narrowYamlContent leaves a ref the narrower has no tag for", () => {
  const yaml = `      - uses: owner/repo@v1\n      - uses: owner/repo@v1\n`;
  let calls = 0;
  const { content, pins } = narrowYamlContent(yaml, () => {
    calls++;
    return undefined;
  });
  assertEquals(content, yaml);
  assertEquals(pins, []);
  // the result is remembered for the rest of the file
  assertEquals(calls, 1);
});

Deno.test("narrowYamlContent reuses the cache instead of narrowing", () => {
  const yaml = `      - uses: actions/checkout@v6\n`;
  const { content } = narrowYamlContent(
    yaml,
    failingResolver(),
    [{ original: "actions/checkout@v6", pinned: "v6.0.1" }],
  );
  assertEquals(content, `      - uses: actions/checkout@v6.0.1 # v6\n`);
});

Deno.test("narrowYamlContent output round-trips through parsePinComments", () => {
  const { content, pins } = narrowYamlContent(
    `      - uses: actions/checkout@v6\r\n      - uses: 'owner/repo@v1'\r\n`,
    (_owner, _repo, ref) => `${ref}.2.3`,
  );
  assertEquals(
    content,
    `      - uses: actions/checkout@v6.2.3 # v6\r\n      - uses: 'owner/repo@v1.2.3' # v1\r\n`,
  );
  assertEquals(parsePinComments(content, "tag"), pins);
});

Deno.test("parsePinComments reads only the pins of the requested kind", () => {
  const content = `      - uses: actions/checkout@${HASH} # v6
      - uses: actions/setup-node@v4.2.0 # v4
      - uses: owner/repo@v1.0.0 # some other comment
`;
  assertEquals(parsePinComments(content, "hash"), [
    { original: "actions/checkout@v6", pinned: HASH },
  ]);
  assertEquals(parsePinComments(content, "tag"), [
    { original: "actions/setup-node@v4", pinned: "v4.2.0" },
  ]);
});

Deno.test("parsePinComments reads a tag bumped out of its comment's family", () => {
  assertEquals(
    parsePinComments(`      - uses: actions/checkout@v7.0.0 # v6\n`, "tag"),
    [{ original: "actions/checkout@v7", pinned: "v7.0.0" }],
  );
  // keeps the comment's prefix
  assertEquals(
    parsePinComments(`      - uses: owner/repo@7.0.0 # v6.1\n`, "tag"),
    [{ original: "owner/repo@v7.0", pinned: "7.0.0" }],
  );
  // the precision of a suffixed comment is unclear, so it's not a pin
  assertEquals(
    parsePinComments(`      - uses: owner/repo@v7.0.0 # v6-beta\n`, "tag"),
    [],
  );
});

// --- collectActionVersions ---

Deno.test("collectActionVersions reads only unpinned full versions", () => {
  // unpinned partial versions and branches may be in a workflow that wasn't
  // generated, so they are ignored to not conflict with the generated ones
  const yaml = `jobs:
  build:
    steps:
      - uses: ./local/action
      - uses: $/.github/actions/setup
      - uses: actions/checkout@v6
      - uses: owner/branch@main
      - uses: owner/full@v1.2.3
      - uses: denoland/setup-deno@${HASH} # v2
      - uses: owner/no-comment@${HASH}
`;
  const { versions, conflicts } = collectActionVersions([yaml]);
  assertEquals([...versions], [
    ["owner/full", "v1.2.3"],
    ["denoland/setup-deno", "v2"],
  ]);
  assertEquals(conflicts.size, 0);
});

Deno.test("collectActionVersions reads the original ref of a narrowed tag", () => {
  const yaml = `      - uses: actions/checkout@v6.0.1 # v6
      - uses: actions/setup-node@v4.2.0 # v4.2
      - uses: denoland/setup-deno@v2.0.3
`;
  const { versions, conflicts } = collectActionVersions([yaml]);
  assertEquals([...versions], [
    ["actions/checkout", "v6"],
    ["actions/setup-node", "v4.2"],
    ["denoland/setup-deno", "v2.0.3"],
  ]);
  assertEquals(conflicts.size, 0);
});

Deno.test("collectActionVersions reads a tag bumped out of its comment's family", () => {
  // ex. dependabot bumped `v6.0.1 # v6` without touching the comment
  const yaml = `      - uses: actions/checkout@v7.0.0 # v6
      - uses: actions/setup-node@v5.1.0 # v4.2
`;
  const { versions } = collectActionVersions([yaml]);
  assertEquals([...versions], [
    ["actions/checkout", "v7"],
    ["actions/setup-node", "v5.1"],
  ]);
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

// --- writeOrLint's lockfile mode ---

Deno.test("writeOrLint lockfile mode writes narrowed tags and lints them", async () => {
  const wf = lockfileWorkflow("actions/checkout@v6");
  const { dir, filePath } = tempFilePath();
  try {
    wf.writeOrLint({ filePath, pinDeps: { narrow: () => "v6.0.1" } });
    const written = fs.readFileSync(filePath, "utf8");
    assertStringIncludes(written, "uses: actions/checkout@v6.0.1 # v6\n");

    // regenerating reuses the narrowed tag from the file
    wf.writeOrLint({ filePath, pinDeps: { narrow: failingResolver() } });
    assertEquals(fs.readFileSync(filePath, "utf8"), written);

    const { exitCode } = await captureRun(
      ["--lint"],
      () => wf.writeOrLint({ filePath, pinDeps: "lockfile" }),
    );
    assertEquals(exitCode, undefined);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("writeOrLint lockfile mode --lint fails when the version changed", async () => {
  const { dir, filePath } = tempFilePath();
  try {
    lockfileWorkflow("actions/checkout@v6").writeOrLint({
      filePath,
      pinDeps: { narrow: () => "v6.0.1" },
    });
    const { output, exitCode } = await captureRun(
      ["--lint"],
      () =>
        lockfileWorkflow("actions/checkout@v7").writeOrLint({
          filePath,
          pinDeps: "lockfile",
        }),
    );
    assertEquals(exitCode, 1);
    assertStringIncludes(output, "is out of date");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("writeOrLint lockfile mode does not reuse commit hash pins", async () => {
  // switching an existing workflow from hash pinning to lockfile mode
  const wf = lockfileWorkflow("actions/checkout@v6");
  const { dir, filePath } = tempFilePath();
  try {
    wf.writeOrLint({ filePath, pinDeps: { resolve: () => HASH } });

    const { exitCode } = await captureRun(
      ["--lint"],
      () => wf.writeOrLint({ filePath, pinDeps: "lockfile" }),
    );
    assertEquals(exitCode, 1);

    wf.writeOrLint({ filePath, pinDeps: { narrow: () => "v6.0.1" } });
    assertStringIncludes(
      fs.readFileSync(filePath, "utf8"),
      "uses: actions/checkout@v6.0.1 # v6\n",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("writeOrLint hash mode does not reuse narrowed tags", async () => {
  // switching an existing workflow from lockfile mode back to hash pinning
  const wf = lockfileWorkflow("actions/checkout@v6");
  const { dir, filePath } = tempFilePath();
  try {
    wf.writeOrLint({ filePath, pinDeps: { narrow: () => "v6.0.1" } });

    const { exitCode } = await captureRun(
      ["--lint"],
      () => wf.writeOrLint({ filePath }),
    );
    assertEquals(exitCode, 1);

    wf.writeOrLint({ filePath, pinDeps: { resolve: () => HASH } });
    assertStringIncludes(
      fs.readFileSync(filePath, "utf8"),
      `uses: actions/checkout@${HASH} # v6\n`,
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("writeOrLint lockfile mode keeps a reusable workflow's hash", async () => {
  const wf = workflow({
    name: "ci",
    on: {},
    jobs: [
      { id: "call", uses: "owner/repo/.github/workflows/release.yml@v1" },
      {
        id: "build",
        runsOn: "ubuntu-latest",
        steps: [step({ uses: "actions/checkout@v6" })],
      },
    ],
  });
  const { dir, filePath } = tempFilePath();
  try {
    wf.writeOrLint({
      filePath,
      pinDeps: { narrow: () => "v6.0.1", resolve: () => HASH },
    });
    const written = fs.readFileSync(filePath, "utf8");
    assertStringIncludes(
      written,
      `uses: owner/repo/.github/workflows/release.yml@${HASH} # v1\n`,
    );
    assertStringIncludes(written, "uses: actions/checkout@v6.0.1 # v6\n");

    // regenerating and linting reuse both pins from the file
    const failing = failingResolver();
    wf.writeOrLint({
      filePath,
      pinDeps: { narrow: failing, resolve: failing },
    });
    assertEquals(fs.readFileSync(filePath, "utf8"), written);
    const { exitCode } = await captureRun(
      ["--lint"],
      () => wf.writeOrLint({ filePath, pinDeps: "lockfile" }),
    );
    assertEquals(exitCode, undefined);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("writeOrLint lockfile mode --update-pins narrows again", async () => {
  const wf = lockfileWorkflow("actions/checkout@v6");
  const { dir, filePath } = tempFilePath();
  try {
    wf.writeOrLint({ filePath, pinDeps: { narrow: () => "v6.0.1" } });
    await captureRun(
      ["--update-pins"],
      () => wf.writeOrLint({ filePath, pinDeps: { narrow: () => "v6.0.2" } }),
    );
    assertStringIncludes(
      fs.readFileSync(filePath, "utf8"),
      "uses: actions/checkout@v6.0.2 # v6\n",
    );
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

Deno.test("cli fails when there is no .github/workflows or .github/actions directory", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    const { output, exitCode } = await runCliIn(dir, []);
    assertEquals(exitCode, 1);
    assertStringIncludes(
      output,
      "No .github/workflows or .github/actions directory found.",
    );
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

Deno.test("cli --pull-versions reads versions written in lockfile mode", async () => {
  const dir = createWorkflowsDir({
    script: `const checkout = "actions/checkout@v6";
const node = "actions/setup-node@v4.1.0";
writeOrLint;
`,
  });
  const workflowsDir = join(dir, ".github/workflows");
  fs.writeFileSync(
    join(workflowsDir, "ci.generated.yml"),
    `      - uses: actions/checkout@v7.0.0 # v6
      - uses: actions/setup-node@v4.2.0
`,
  );
  try {
    const { exitCode } = await runCliIn(dir, ["--pull-versions"]);
    assertEquals(exitCode, undefined);
    assertEquals(
      fs.readFileSync(join(workflowsDir, "ci.ts"), "utf8"),
      `const checkout = "actions/checkout@v7";
const node = "actions/setup-node@v4.2.0";
writeOrLint;
`,
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli --pull-versions ignores a hand-written workflow's partial versions", async () => {
  const dir = createWorkflowsDir({
    script: `const checkout = "actions/checkout@v6";\nwriteOrLint;\n`,
  });
  const workflowsDir = join(dir, ".github/workflows");
  fs.writeFileSync(
    join(workflowsDir, "ci.generated.yml"),
    `      - uses: actions/checkout@${HASH} # v7\n`,
  );
  fs.writeFileSync(
    join(workflowsDir, "release.yml"),
    `      - uses: actions/checkout@v4\n`,
  );
  try {
    const { output, exitCode } = await runCliIn(dir, ["--pull-versions"]);
    assertEquals(exitCode, undefined);
    assertEquals(output.includes("conflicting versions"), false);
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

Deno.test("cli generates a composite action in a nested .github/actions folder", async () => {
  // no .github/workflows folder, so this also checks it isn't required
  const dir = createTempDir({
    ".github/actions/setup/action.mjs": generateScript,
  });
  try {
    const { output, exitCode } = await runCliIn(dir, []);
    assertEquals(exitCode, undefined);
    assertStringIncludes(output, "Generating");
    assertStringIncludes(output, join("setup", "action.mjs"));
    const generated = fs.readFileSync(
      join(dir, ".github/actions/setup/ci.generated.yml"),
      "utf8",
    );
    assertStringIncludes(generated, "run: echo hi");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli generates from both .github/workflows and .github/actions", async () => {
  const dir = createTempDir({
    ".github/workflows/ci.mjs": generateScript,
    ".github/workflows/nested/release.mjs": generateScript,
    ".github/actions/setup/action.mjs": generateScript,
  });
  try {
    const { exitCode } = await runCliIn(dir, []);
    assertEquals(exitCode, undefined);
    for (
      const path of [
        ".github/workflows/ci.generated.yml",
        ".github/workflows/nested/ci.generated.yml",
        ".github/actions/setup/ci.generated.yml",
      ]
    ) {
      assertEquals(fs.existsSync(join(dir, path)), true, path);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli fails when neither folder contains a script", async () => {
  const dir = createTempDir({
    ".github/workflows/ci.generated.yml": "name: ci\n",
    ".github/actions/setup/action.yml": "name: setup\n",
  });
  try {
    const { output, exitCode } = await runCliIn(dir, []);
    assertEquals(exitCode, 1);
    assertStringIncludes(
      output,
      "No script files found in .github/workflows or .github/actions",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli --pull-versions reads and updates files in .github/actions", async () => {
  const script = `const checkout = "actions/checkout@v6";\nwriteOrLint;\n`;
  const dir = createTempDir({
    ".github/actions/setup/action.ts": script,
    ".github/actions/setup/action.yml":
      `runs:\n  steps:\n    - uses: actions/checkout@${HASH} # v7\n`,
  });
  try {
    const { output, exitCode } = await runCliIn(dir, ["--pull-versions"]);
    assertEquals(exitCode, undefined);
    // reported relative to the repo root rather than the folder it's in
    assertStringIncludes(
      output,
      `${
        join(".github", "actions", "setup", "action.ts")
      }: actions/checkout@v6`,
    );
    assertEquals(
      fs.readFileSync(join(dir, ".github/actions/setup/action.ts"), "utf8"),
      script.replace("@v6", "@v7"),
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli --pull-versions applies versions across both folders", async () => {
  const script = `const checkout = "actions/checkout@v6";\nwriteOrLint;\n`;
  // the version is only in the workflow yaml, but the action script is
  // updated too
  const dir = createTempDir({
    ".github/workflows/ci.ts": script,
    ".github/workflows/ci.generated.yml":
      `      - uses: actions/checkout@${HASH} # v7\n`,
    ".github/actions/setup/action.ts": script,
  });
  try {
    const { exitCode } = await runCliIn(dir, ["--pull-versions"]);
    assertEquals(exitCode, undefined);
    for (
      const path of [
        ".github/workflows/ci.ts",
        ".github/actions/setup/action.ts",
      ]
    ) {
      assertEquals(
        fs.readFileSync(join(dir, path), "utf8"),
        script.replace("@v6", "@v7"),
        path,
      );
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cli --pull-versions reports conflicts between the two folders", async () => {
  const script = `const checkout = "actions/checkout@v6";\nwriteOrLint;\n`;
  const dir = createTempDir({
    ".github/workflows/ci.ts": script,
    ".github/workflows/ci.generated.yml":
      `      - uses: actions/checkout@${HASH} # v7\n`,
    ".github/actions/setup/action.yml":
      `    - uses: actions/checkout@${OTHER_HASH} # v8\n`,
  });
  try {
    const { output } = await runCliIn(dir, ["--pull-versions"]);
    assertStringIncludes(output, "conflicting versions");
    assertEquals(
      fs.readFileSync(join(dir, ".github/workflows/ci.ts"), "utf8"),
      script,
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

function lockfileWorkflow(uses: string) {
  return workflow({
    name: "ci",
    on: {},
    jobs: [{
      id: "build",
      runsOn: "ubuntu-latest",
      steps: [step({ uses })],
    }],
  });
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

/** Creates a temp directory containing the given files, keyed by relative path. */
function createTempDir(files: Record<string, string>): string {
  const dir = Deno.makeTempDirSync();
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    fs.mkdirSync(dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
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
