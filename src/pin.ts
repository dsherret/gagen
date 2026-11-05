import { execFileSync } from "node:child_process";

export interface PinEntry {
  /** the original uses value, e.g. "actions/checkout@v6" */
  original: string;
  /**
   * the ref the original is pinned to, which is a commit hash or, in lockfile
   * mode, a full version tag (ex. "v6.0.1")
   */
  pinned: string;
}

/**
 * What a `uses:` ref is pinned to: a commit hash, or a full version tag when
 * the commit is pinned by `.github/workflows/actions.lock` instead.
 */
export type PinKind = "hash" | "tag";

const SHA_RE = /^[0-9a-f]{40}$/;

export function isCommitHash(ref: string): boolean {
  return SHA_RE.test(ref);
}

export function parseActionUses(
  uses: string,
): { owner: string; repo: string; path: string; ref: string } | undefined {
  // local actions and docker images are not pinnable
  if (uses.startsWith("./") || uses.startsWith("../")) return undefined;
  if (uses.startsWith("docker://")) return undefined;
  const atIndex = uses.lastIndexOf("@");
  if (atIndex === -1) return undefined;
  const beforeAt = uses.substring(0, atIndex);
  const ref = uses.substring(atIndex + 1);
  if (ref.length === 0) return undefined;
  const parts = beforeAt.split("/");
  if (parts.length < 2) return undefined;
  const owner = parts[0];
  const repo = parts[1];
  if (owner.length === 0 || repo.length === 0) return undefined;
  return {
    owner,
    repo,
    path: parts.slice(2).join("/"),
    ref,
  };
}

export function resolveRef(
  owner: string,
  repo: string,
  ref: string,
): string {
  const url = `https://github.com/${owner}/${repo}`;
  // note: run git directly rather than through a shell so that refs
  // containing shell metacharacters are passed along verbatim
  const tagOutput = execFileSync(
    "git",
    ["ls-remote", url, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();

  if (tagOutput) {
    const lines = tagOutput.split("\n");
    for (const line of lines) {
      if (line.includes("^{}")) {
        return line.split(/\s+/)[0];
      }
    }
    return lines[0].split(/\s+/)[0];
  }

  const branchOutput = execFileSync(
    "git",
    ["ls-remote", url, `refs/heads/${ref}`],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();

  if (branchOutput) {
    return branchOutput.split(/\s+/)[0];
  }

  throw new Error(`Could not resolve ref "${ref}" for ${owner}/${repo}`);
}

export type RefResolver = (
  owner: string,
  repo: string,
  ref: string,
) => string;

/**
 * Narrows a partial version ref (ex. `v6` or `v6.1`) to the highest full
 * version tag (ex. `v6.1.2`) in its family that points at the same commit,
 * or gets undefined when there is no such tag.
 *
 * This is the same narrowing `gh actions-lock` does when it first locks a
 * workflow, so a workflow gagen narrowed is left as-is by it.
 */
export function narrowRef(
  owner: string,
  repo: string,
  ref: string,
): string | undefined {
  if (!isNarrowableVersionRef(ref)) return undefined;
  const tagCommits = listTagCommits(owner, repo);
  // a partial version is almost always a tag, but fall back to resolving it
  // as a branch for the repos that move a `v1` branch instead
  const commit = tagCommits.get(ref) ?? resolveRef(owner, repo, ref);
  return pickNarrowedTag(ref, commit, tagCommits);
}

/**
 * Gets the full version tag a partial version ref narrows to (ex. `v6.0.1`
 * for `v6`), or undefined to leave the ref as written.
 */
export type RefNarrower = (
  owner: string,
  repo: string,
  ref: string,
) => string | undefined;

/**
 * Picks the tag `ref` narrows to among the tags at the same commit, matching
 * `gh actions-lock`: the highest full version in the ref's family (ex. `v6`
 * narrows to `v6.x.y` and `v6.1` to `v6.1.y`).
 */
export function pickNarrowedTag(
  ref: string,
  commit: string,
  tagCommits: ReadonlyMap<string, string>,
): string | undefined {
  const refVersion = parseVersionRef(ref);
  if (refVersion == null || isFullVersion(refVersion)) return undefined;
  let best: { tag: string; version: VersionRef } | undefined;
  for (const [tag, tagCommit] of tagCommits) {
    if (tagCommit !== commit) continue;
    const version = parseVersionRef(tag);
    if (version == null || !narrowsVersion(version, refVersion)) continue;
    if (best == null || isHigherVersion(version, best.version)) {
      best = { tag, version };
    }
  }
  return best?.tag;
}

/**
 * Parses the output of `git ls-remote --tags` into the commit each tag points
 * at, using the peeled commit of annotated tags.
 */
export function parseTagCommits(output: string): Map<string, string> {
  const tagCommits = new Map<string, string>();
  const peeledSuffix = "^{}";
  const tagPrefix = "refs/tags/";
  for (const line of output.split("\n")) {
    const [commit, refName] = line.trim().split(/\s+/);
    if (commit == null || refName == null) continue;
    if (!refName.startsWith(tagPrefix)) continue;
    const isPeeled = refName.endsWith(peeledSuffix);
    const tag = refName.substring(
      tagPrefix.length,
      isPeeled ? refName.length - peeledSuffix.length : refName.length,
    );
    // the peeled line of an annotated tag names the commit, while the plain
    // line names the tag object, so the peeled line wins
    if (isPeeled || !tagCommits.has(tag)) {
      tagCommits.set(tag, commit);
    }
  }
  return tagCommits;
}

/**
 * Resolves non-SHA refs in YAML content to commit hashes, writing the
 * original ref as an inline comment after the pinned `uses:` value.
 */
export function pinYamlContent(
  yamlStr: string,
  resolve: RefResolver = resolveRef,
  cache?: readonly PinEntry[],
): { content: string; pins: PinEntry[] } {
  const pins: PinEntry[] = [];
  const resolved = new Map<string, string>();
  if (cache) {
    for (const entry of cache) {
      resolved.set(entry.original, entry.pinned);
    }
  }

  const content = rewriteUsesLines(yamlStr, (usesValue, parsed, rest) => {
    const actionPath = usesValue.substring(0, usesValue.lastIndexOf("@"));
    if (isCommitHash(parsed.ref)) {
      // already pinned — recover the original ref from an inline comment
      // or, failing that, from the legacy footer entries in the cache
      const originalRef = parsePinComment(rest) ??
        findCachedRef(parsed, cache);
      if (!originalRef) return undefined;

      const original = `${actionPath}@${originalRef}`;
      if (!pins.some((p) => p.original === original)) {
        pins.push({ original, pinned: parsed.ref });
      }
      return { value: usesValue, comment: originalRef };
    }

    let hash = resolved.get(usesValue);
    if (!hash) {
      hash = resolve(parsed.owner, parsed.repo, parsed.ref);
      resolved.set(usesValue, hash);
    }
    if (!pins.some((p) => p.original === usesValue)) {
      pins.push({ original: usesValue, pinned: hash });
    }
    return { value: `${actionPath}@${hash}`, comment: parsed.ref };
  });

  return { content, pins };
}

/**
 * Narrows partial version refs in YAML content (ex. `v6`) to full version
 * tags (ex. `v6.0.1`), writing the original ref as an inline comment after
 * the narrowed `uses:` value.
 *
 * This is the pinning used alongside a `.github/workflows/actions.lock`
 * lockfile: the lockfile pins each tag to a commit, so the output keeps tags
 * rather than commit hashes. Refs that are not partial versions (branches,
 * full versions and commit hashes) are left as written.
 *
 * The exception is a reusable workflow from another repository, which the
 * lockfile does not cover, so it is still pinned to a commit hash.
 */
export function narrowYamlContent(
  yamlStr: string,
  narrow: RefNarrower = narrowRef,
  cache?: readonly PinEntry[],
  resolve: RefResolver = resolveRef,
): { content: string; pins: PinEntry[] } {
  const pins: PinEntry[] = [];
  const pinned = new Map<string, string | undefined>();
  for (const entry of cache ?? []) {
    pinned.set(entry.original, entry.pinned);
  }

  const content = rewriteUsesLines(yamlStr, (usesValue, parsed) => {
    const isWorkflow = isReusableWorkflow(parsed);
    if (
      isWorkflow
        ? isCommitHash(parsed.ref)
        : !isNarrowableVersionRef(parsed.ref)
    ) {
      return undefined;
    }

    let ref: string | undefined;
    if (pinned.has(usesValue)) {
      ref = pinned.get(usesValue);
    } else {
      ref = isWorkflow
        ? resolve(parsed.owner, parsed.repo, parsed.ref)
        : narrow(parsed.owner, parsed.repo, parsed.ref);
      pinned.set(usesValue, ref);
    }
    if (ref == null) return undefined;

    if (!pins.some((p) => p.original === usesValue)) {
      pins.push({ original: usesValue, pinned: ref });
    }
    const actionPath = usesValue.substring(0, usesValue.lastIndexOf("@"));
    return { value: `${actionPath}@${ref}`, comment: parsed.ref };
  });

  return { content, pins };
}

/**
 * Extracts the pin entries written by lockfile mode: the narrowed tags of
 * actions and the commit hashes of reusable workflows.
 *
 * The hashes of actions are left out so that a file switched over from
 * hash pinning gets narrowed tags instead of keeping its hashes.
 */
export function parseLockfilePins(content: string): PinEntry[] {
  const workflowPins = parsePinComments(content, "hash").filter((pin) => {
    const parsed = parseActionUses(pin.original);
    return parsed != null && isReusableWorkflow(parsed);
  });
  return [...parsePinComments(content, "tag"), ...workflowPins];
}

/**
 * Extracts pin entries from file content.
 *
 * For commit hashes, this reads the current inline format
 * (`uses: owner/repo@HASH # ref`) and, for backwards compatibility, the
 * legacy footer format (`# gagen:pin owner/repo@ref = HASH`). For tags, it
 * reads the inline format written by lockfile mode
 * (`uses: owner/repo@v6.0.1 # v6`).
 */
export function parsePinComments(
  content: string,
  kind: PinKind = "hash",
): PinEntry[] {
  const pins: PinEntry[] = [];
  const seen = new Set<string>();

  for (const line of content.split("\n")) {
    const usesLine = parseUsesLine(line);
    if (usesLine == null) continue;
    const entry = parseInlinePin(usesLine.scalar, usesLine.rest);
    if (entry == null || entry.kind !== kind || seen.has(entry.original)) {
      continue;
    }
    seen.add(entry.original);
    pins.push({ original: entry.original, pinned: entry.pinned });
  }

  if (kind === "hash") {
    // note: `$` in multiline mode also matches before the carriage return of
    // a crlf line ending, so this reads crlf files as-is
    const footerRe = /^# gagen:pin (.+) = ([0-9a-f]{40})$/gm;
    let m;
    while ((m = footerRe.exec(content)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      pins.push({ original: m[1], pinned: m[2] });
    }
  }

  return pins;
}

/**
 * Collects the pinned version for each action across a set of generated
 * YAML files. If an action appears in multiple files with different
 * versions, it is returned as a conflict instead — conflicts must be
 * resolved manually since there is no single correct target version.
 *
 * The version of a pinned `uses:` value is the original ref in its comment,
 * while an unpinned one (ex. a full version tag written in lockfile mode) is
 * its own version.
 */
export function collectActionVersions(
  yamlContents: readonly string[],
): {
  versions: Map<string, string>;
  conflicts: Map<string, string[]>;
} {
  const seen = new Map<string, Set<string>>();
  for (const content of yamlContents) {
    for (const uses of parseVersionedUses(content)) {
      const parsed = parseActionUses(uses);
      if (!parsed) continue;
      const action = parsed.path
        ? `${parsed.owner}/${parsed.repo}/${parsed.path}`
        : `${parsed.owner}/${parsed.repo}`;
      let set = seen.get(action);
      if (!set) {
        set = new Set<string>();
        seen.set(action, set);
      }
      set.add(parsed.ref);
    }
  }
  const versions = new Map<string, string>();
  const conflicts = new Map<string, string[]>();
  for (const [action, set] of seen) {
    if (set.size === 1) {
      versions.set(action, [...set][0]);
    } else {
      conflicts.set(action, [...set]);
    }
  }
  return { versions, conflicts };
}

export interface VersionChange {
  action: string;
  from: string;
  to: string;
}

/**
 * Rewrites literal `"owner/repo@<ref>"` (or single-quoted) strings in
 * source code to use the target version from the given map. Only matches
 * literals with a single owner/repo[/path]@ref shape; variables, template
 * substitutions, and non-string forms are left alone.
 */
export function pullVersionsInSource(
  source: string,
  versions: ReadonlyMap<string, string>,
): { content: string; changes: VersionChange[] } {
  const changes: VersionChange[] = [];
  const content = source.replace(
    /(["'])([^"'@\s/]+\/[^"'@\s/]+(?:\/[^"'@\s]+)?)@([^"'\s]+)\1/g,
    (match, quote: string, action: string, ref: string) => {
      const target = versions.get(action);
      if (!target || target === ref) return match;
      changes.push({ action, from: ref, to: target });
      return `${quote}${action}@${target}${quote}`;
    },
  );
  return { content, changes };
}

/**
 * Replaces the tag/branch ref of every `uses` value in a parsed YAML object
 * with the hash (or full version tag) it is pinned to in the given pin
 * mapping.
 *
 * This is the direction to compare in when linting. Mapping an original ref
 * to a hash is a function, whereas the reverse is not: two refs commonly
 * resolve to the same commit (ex. `v1` and `v1.0.0` when the major tag points
 * at the latest patch), so a hash on its own does not say which ref wrote it.
 */
export function pinParsedYaml(
  obj: unknown,
  pins: readonly PinEntry[],
): unknown {
  if (pins.length === 0) return obj;

  const originalToPinned = new Map<string, string>();
  for (const pin of pins) {
    const actionPath = pin.original.substring(0, pin.original.lastIndexOf("@"));
    originalToPinned.set(pin.original, `${actionPath}@${pin.pinned}`);
  }

  pinUsesValues(obj, originalToPinned);
  return obj;
}

/**
 * Replaces pinned hashes in a parsed YAML object with their original
 * tag/branch refs using the provided pin mapping.
 *
 * Prefer `pinParsedYaml` when comparing a generated file against its source:
 * a hash may correspond to more than one ref, so this direction is lossy.
 */
export function unpinParsedYaml(
  obj: unknown,
  pins: PinEntry[],
): unknown {
  if (pins.length === 0 || typeof obj !== "object" || obj === null) return obj;

  const hashToOriginal = new Map<string, string>();
  for (const pin of pins) {
    const atIndex = pin.original.lastIndexOf("@");
    const actionPath = pin.original.substring(0, atIndex);
    hashToOriginal.set(`${actionPath}@${pin.pinned}`, pin.original);
  }

  const record = obj as Record<string, unknown>;
  if (record.jobs && typeof record.jobs === "object") {
    for (
      const jobValue of Object.values(
        record.jobs as Record<string, unknown>,
      )
    ) {
      if (typeof jobValue !== "object" || jobValue === null) continue;
      const jobObj = jobValue as Record<string, unknown>;

      // reusable workflow uses
      if (
        typeof jobObj.uses === "string" &&
        hashToOriginal.has(jobObj.uses)
      ) {
        jobObj.uses = hashToOriginal.get(jobObj.uses);
      }

      // steps (including steps nested inside parallel: blocks)
      if (Array.isArray(jobObj.steps)) {
        for (const s of jobObj.steps) {
          unpinStep(s, hashToOriginal);
        }
      }
    }
  }

  return obj;
}

/** Reverts a pinned hash on a single step, recursing into `parallel:` blocks. */
function unpinStep(
  step: unknown,
  hashToOriginal: Map<string, string>,
): void {
  if (typeof step !== "object" || step === null) return;
  const stepObj = step as Record<string, unknown>;
  if (
    typeof stepObj.uses === "string" &&
    hashToOriginal.has(stepObj.uses)
  ) {
    stepObj.uses = hashToOriginal.get(stepObj.uses);
  }
  if (Array.isArray(stepObj.parallel)) {
    for (const child of stepObj.parallel) {
      unpinStep(child, hashToOriginal);
    }
  }
}

/** Rewrites every `uses` value found anywhere in the tree. */
function pinUsesValues(
  node: unknown,
  originalToPinned: ReadonlyMap<string, string>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      pinUsesValues(item, originalToPinned);
    }
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "uses" && typeof value === "string") {
      const pinned = originalToPinned.get(value);
      if (pinned != null) record[key] = pinned;
    } else {
      pinUsesValues(value, originalToPinned);
    }
  }
}

type ParsedUses = NonNullable<ReturnType<typeof parseActionUses>>;

/**
 * Calls `rewrite` for each action `uses:` line in the YAML and replaces the
 * line's value and comment with what it returns. Lines it returns undefined
 * for are left untouched.
 */
function rewriteUsesLines(
  yamlStr: string,
  rewrite: (
    usesValue: string,
    parsed: ParsedUses,
    rest: string,
  ) => { value: string; comment: string } | undefined,
): string {
  const lines = yamlStr.split("\n");
  for (const [index, line] of lines.entries()) {
    const usesLine = parseUsesLine(line);
    if (usesLine == null) continue;
    const { prefix, scalar, rest, cr } = usesLine;

    // the yaml serializer quotes some values (ex. `docker://` images), so
    // work with the unquoted value and put the quotes back on the way out
    const { quote, value: usesValue } = splitQuotedScalar(scalar);
    const parsed = parseActionUses(usesValue);
    if (!parsed) continue;

    const result = rewrite(usesValue, parsed, rest);
    if (result == null) continue;
    lines[index] =
      `${prefix}${quote}${result.value}${quote} # ${result.comment}${cr}`;
  }
  return lines.join("\n");
}

/**
 * Gets the `uses:` values of a generated file with the version each one
 * should have in the source scripts: the original ref of a pinned value, or
 * the value itself when it is an unpinned full version tag.
 *
 * Other unpinned refs are left out because the folders also hold workflows
 * that were not generated, whose versions say nothing about the scripts'.
 * Lockfile mode leaves full version tags unpinned, so those are read to pick
 * up a bump of them (ex. by Dependabot).
 */
function parseVersionedUses(content: string): string[] {
  const result: string[] = [];
  for (const line of content.split("\n")) {
    const usesLine = parseUsesLine(line);
    if (usesLine == null) continue;
    const entry = parseInlinePin(usesLine.scalar, usesLine.rest);
    if (entry != null) {
      result.push(entry.original);
      continue;
    }
    const { value } = splitQuotedScalar(usesLine.scalar);
    const parsed = parseActionUses(value);
    if (parsed == null) continue;
    const version = parseVersionRef(parsed.ref);
    if (version == null || !isFullVersion(version)) continue;
    result.push(value);
  }
  // pins in the legacy footer format
  for (const pin of parsePinComments(content, "hash")) {
    result.push(pin.original);
  }
  return result;
}

/** The parts of a yaml `uses:` line. */
interface UsesLine {
  /** the indentation, list dash, key, and the spacing after it */
  prefix: string;
  /** the value, which the yaml serializer sometimes quotes */
  scalar: string;
  /** what follows the value, which is the pin comment when there is one */
  rest: string;
  /** the carriage return of a crlf line ending */
  cr: string;
}

/**
 * Splits a yaml `uses:` line into its parts, or gets undefined when the line
 * is not one. Both the pin writer and the pin reader go through this so that
 * they cannot drift apart on the format.
 *
 * The carriage return is kept out of `rest` because the writer replaces
 * `rest` with a freshly built comment: folding the two together would leave
 * an lf ending behind on every line that got pinned.
 */
function parseUsesLine(line: string): UsesLine | undefined {
  // a `uses:` key is always indented, either directly or after a list dash
  let index = skipSpaces(line, 0);
  if (index === 0) return undefined;
  if (line.startsWith("-", index)) {
    const afterDash = skipSpaces(line, index + 1);
    if (afterDash === index + 1) return undefined;
    index = afterDash;
  }

  const key = "uses:";
  if (!line.startsWith(key, index)) return undefined;
  const valueStart = skipSpaces(line, index + key.length);
  if (valueStart === index + key.length) return undefined;

  let valueEnd = valueStart;
  while (valueEnd < line.length && !isLineSpace(line[valueEnd])) {
    valueEnd++;
  }
  if (valueEnd === valueStart) return undefined;

  const trailing = line.substring(valueEnd);
  const hasCr = trailing.endsWith("\r");
  return {
    prefix: line.substring(0, valueStart),
    scalar: line.substring(valueStart, valueEnd),
    rest: hasCr ? trailing.substring(0, trailing.length - 1) : trailing,
    cr: hasCr ? "\r" : "",
  };
}

/** Gets the index of the first character that is not a space or tab. */
function skipSpaces(line: string, index: number): number {
  while (index < line.length && isLineSpace(line[index])) {
    index++;
  }
  return index;
}

function isLineSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r";
}

/**
 * Parses a pin out of the value and trailing text of a `uses:` line, which is
 * either a commit hash (ex. `owner/repo@<sha>` followed by ` # v1`) or a full
 * version tag narrowed from a partial one (ex. `owner/repo@v1.2.3` followed
 * by ` # v1`).
 */
function parseInlinePin(
  scalar: string,
  rest: string,
): PinEntry & { kind: PinKind } | undefined {
  const { value } = splitQuotedScalar(scalar);
  const atIndex = value.lastIndexOf("@");
  if (atIndex === -1) return undefined;
  const pinned = value.substring(atIndex + 1);
  const ref = parsePinComment(rest);
  if (ref == null) return undefined;
  const actionPath = value.substring(0, atIndex);
  if (isCommitHash(pinned)) {
    return { kind: "hash", original: `${actionPath}@${ref}`, pinned };
  }
  const originalRef = originalRefOfTag(pinned, ref);
  if (originalRef == null) return undefined;
  return { kind: "tag", original: `${actionPath}@${originalRef}`, pinned };
}

/**
 * Gets the partial version a full version tag stands for, given the ref in
 * its pin comment (ex. `v6.0.1` with a `v6` comment stands for `v6`).
 *
 * When the tag is outside the comment's family, the tag was bumped without
 * its comment (ex. by Dependabot changing `v6.0.1 # v6` to `v7.0.0 # v6`).
 * Then it stands for the same precision of the new tag (`v7`), so the bump is
 * seen as a version change instead of being taken to still be `v6`. That
 * precision is unclear for a comment with a suffix (ex. `v6-beta`), so then
 * the tag is not taken to be a pin.
 */
function originalRefOfTag(tag: string, commentRef: string): string | undefined {
  const tagVersion = parseVersionRef(tag);
  const commentVersion = parseVersionRef(commentRef);
  if (tagVersion == null || !isFullVersion(tagVersion)) return undefined;
  if (commentVersion == null || isFullVersion(commentVersion)) return undefined;
  if (narrowsVersion(tagVersion, commentVersion)) return commentRef;
  if (commentVersion.rest !== "") return undefined;
  const { prefix } = commentVersion;
  return commentVersion.minor == null
    ? `${prefix}${tagVersion.major}`
    : `${prefix}${tagVersion.major}.${tagVersion.minor}`;
}

/**
 * Gets if the parsed `uses:` value is a reusable workflow, which
 * `gh actions-lock` does not lock.
 */
function isReusableWorkflow(parsed: ParsedUses): boolean {
  return parsed.path.startsWith(".github/workflows/");
}

const tagCommitsByRepo = new Map<string, Map<string, string>>();

/**
 * Lists the commit of every tag in the repository, remembering the list for
 * the rest of the process so that each repository is only listed once.
 */
function listTagCommits(owner: string, repo: string): Map<string, string> {
  const url = `https://github.com/${owner}/${repo}`;
  let tagCommits = tagCommitsByRepo.get(url);
  if (tagCommits == null) {
    const output = execFileSync(
      "git",
      ["ls-remote", "--tags", url],
      { encoding: "utf8", timeout: 30_000 },
    );
    tagCommits = parseTagCommits(output);
    tagCommitsByRepo.set(url, tagCommits);
  }
  return tagCommits;
}

/** Gets the ref recorded in the inline comment of a pinned `uses:` line. */
function parsePinComment(rest: string): string | undefined {
  const start = skipSpaces(rest, 0);
  if (rest[start] !== "#") return undefined;
  const refStart = skipSpaces(rest, start + 1);
  let refEnd = refStart;
  while (refEnd < rest.length && !isLineSpace(rest[refEnd])) {
    refEnd++;
  }
  if (refEnd === refStart) return undefined;
  return rest.substring(refStart, refEnd);
}

/** Gets the ref a cached pin recorded for an action already pinned to a hash. */
function findCachedRef(
  parsed: { owner: string; repo: string; path: string; ref: string },
  cache: readonly PinEntry[] | undefined,
): string | undefined {
  for (const entry of cache ?? []) {
    const cached = parseActionUses(entry.original);
    if (
      cached &&
      cached.owner === parsed.owner &&
      cached.repo === parsed.repo &&
      cached.path === parsed.path &&
      entry.pinned === parsed.ref
    ) {
      return cached.ref;
    }
  }
  return undefined;
}

/** Splits the surrounding quotes, if any, off a yaml scalar. */
function splitQuotedScalar(scalar: string): { quote: string; value: string } {
  for (const quote of ["'", '"']) {
    if (
      scalar.length >= 2 &&
      scalar.startsWith(quote) &&
      scalar.endsWith(quote)
    ) {
      return { quote, value: scalar.slice(1, -1) };
    }
  }
  return { quote: "", value: scalar };
}

/** A version-shaped ref like `v6`, `v6.1`, `6.1.2` or `v2.0.0-rc.1`. */
interface VersionRef {
  prefix: string;
  major: number;
  minor: number | undefined;
  patch: number | undefined;
  /** what follows the numbers (ex. `-rc.1`), which is empty when nothing does */
  rest: string;
}

/**
 * Gets if the ref is a version that `gh actions-lock` would narrow, which is
 * any version-shaped ref that isn't a full version (ex. `v6`, `v6.1` or
 * `v2.0.0-rc.1`).
 */
function isNarrowableVersionRef(ref: string): boolean {
  const version = parseVersionRef(ref);
  return version != null && !isFullVersion(version);
}

/**
 * Parses a version ref made of an optional `v` prefix, then one to three dot
 * separated numbers, then anything else (ex. a `-rc.1` pre-release suffix).
 * This is the same leniency as `gh actions-lock`, so the refs it would narrow
 * are narrowed here as well.
 */
function parseVersionRef(ref: string): VersionRef | undefined {
  if (isCommitHash(ref)) return undefined;
  const prefix = ref.startsWith("v") ? "v" : "";
  const numbers: number[] = [];
  let index = prefix.length;
  while (numbers.length < 3) {
    let start = index;
    if (numbers.length > 0) {
      // a number after the first must follow a dot
      if (ref[index] !== ".") break;
      start++;
    }
    let end = start;
    while (end < ref.length && isDigit(ref[end])) {
      end++;
    }
    if (end === start) break;
    numbers.push(Number(ref.substring(start, end)));
    index = end;
  }
  if (numbers.length === 0) return undefined;
  return {
    prefix,
    major: numbers[0],
    minor: numbers[1],
    patch: numbers[2],
    rest: ref.substring(index),
  };
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/** Gets if the version is a major.minor.patch version with no suffix. */
function isFullVersion(version: VersionRef): boolean {
  return version.patch != null && version.rest === "";
}

/**
 * Gets if the full version `full` is in the family of `ref`, matching
 * `gh actions-lock`: the same major for a major only ref like `v6`, otherwise
 * the same major and minor, where a missing minor counts as 0 (ex. `v6-beta`
 * is in the `v6.0` family).
 */
function narrowsVersion(full: VersionRef, ref: VersionRef): boolean {
  if (!isFullVersion(full) || full.major !== ref.major) return false;
  const isMajorOnly = ref.minor == null && ref.rest === "";
  return isMajorOnly || full.minor === (ref.minor ?? 0);
}

/**
 * Gets if full version `a` is higher than full version `b`, preferring the
 * `v` prefixed tag when they are the same version.
 */
function isHigherVersion(a: VersionRef, b: VersionRef): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return (a.minor ?? 0) > (b.minor ?? 0);
  if (a.patch !== b.patch) return (a.patch ?? 0) > (b.patch ?? 0);
  return a.prefix === "v" && b.prefix !== "v";
}
