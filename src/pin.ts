import { execFileSync } from "node:child_process";

export interface PinEntry {
  /** the original uses value, e.g. "actions/checkout@v6" */
  original: string;
  /** the resolved commit hash */
  hash: string;
}

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
      resolved.set(entry.original, entry.hash);
    }
  }

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

    if (isCommitHash(parsed.ref)) {
      // already pinned — recover the original ref from an inline comment
      // or, failing that, from the legacy footer entries in the cache
      const actionPath = usesValue.substring(0, usesValue.lastIndexOf("@"));
      const originalRef = parsePinComment(rest) ??
        findCachedRef(parsed, cache);
      if (!originalRef) continue;

      const original = `${actionPath}@${originalRef}`;
      if (!pins.some((p) => p.original === original)) {
        pins.push({ original, hash: parsed.ref });
      }
      lines[index] =
        `${prefix}${quote}${usesValue}${quote} # ${originalRef}${cr}`;
      continue;
    }

    let hash = resolved.get(usesValue);
    if (!hash) {
      hash = resolve(parsed.owner, parsed.repo, parsed.ref);
      resolved.set(usesValue, hash);
    }
    if (!pins.some((p) => p.original === usesValue)) {
      pins.push({ original: usesValue, hash });
    }

    const actionPath = usesValue.substring(0, usesValue.lastIndexOf("@"));
    lines[index] =
      `${prefix}${quote}${actionPath}@${hash}${quote} # ${parsed.ref}${cr}`;
  }

  return { content: lines.join("\n"), pins };
}

/**
 * Extracts pin entries from file content. Reads the current inline format
 * (`uses: owner/repo@HASH # ref`) and, for backwards compatibility, the
 * legacy footer format (`# gagen:pin owner/repo@ref = HASH`).
 */
export function parsePinComments(content: string): PinEntry[] {
  const pins: PinEntry[] = [];
  const seen = new Set<string>();

  for (const line of content.split("\n")) {
    const usesLine = parseUsesLine(line);
    if (usesLine == null) continue;
    const entry = parseInlinePin(usesLine.scalar, usesLine.rest);
    if (entry == null || seen.has(entry.original)) continue;
    seen.add(entry.original);
    pins.push(entry);
  }

  // note: `$` in multiline mode also matches before the carriage return of a
  // crlf line ending, so this reads crlf files as-is
  const footerRe = /^# gagen:pin (.+) = ([0-9a-f]{40})$/gm;
  let m;
  while ((m = footerRe.exec(content)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    pins.push({ original: m[1], hash: m[2] });
  }

  return pins;
}

/**
 * Collects the pinned version for each action across a set of generated
 * YAML files. If an action appears in multiple files with different
 * versions, it is returned as a conflict instead — conflicts must be
 * resolved manually since there is no single correct target version.
 */
export function collectActionVersions(
  yamlContents: readonly string[],
): {
  versions: Map<string, string>;
  conflicts: Map<string, string[]>;
} {
  const seen = new Map<string, Set<string>>();
  for (const content of yamlContents) {
    for (const pin of parsePinComments(content)) {
      const parsed = parseActionUses(pin.original);
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
 * with the hash it is pinned to in the given pin mapping.
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
    originalToPinned.set(pin.original, `${actionPath}@${pin.hash}`);
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
    hashToOriginal.set(`${actionPath}@${pin.hash}`, pin.original);
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
 * Parses a pin out of the value and trailing text of a `uses:` line
 * (ex. `owner/repo@<sha>` followed by ` # v1`).
 */
function parseInlinePin(scalar: string, rest: string): PinEntry | undefined {
  const { value } = splitQuotedScalar(scalar);
  const atIndex = value.lastIndexOf("@");
  if (atIndex === -1) return undefined;
  const hash = value.substring(atIndex + 1);
  if (!isCommitHash(hash)) return undefined;
  const ref = parsePinComment(rest);
  if (ref == null) return undefined;
  const actionPath = value.substring(0, atIndex);
  return { original: `${actionPath}@${ref}`, hash };
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
      entry.hash === parsed.ref
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
