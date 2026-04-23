import { execSync } from "node:child_process";

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
  if (uses.startsWith("./") || uses.startsWith("docker://")) return undefined;
  const atIndex = uses.lastIndexOf("@");
  if (atIndex === -1) return undefined;
  const beforeAt = uses.substring(0, atIndex);
  const ref = uses.substring(atIndex + 1);
  const parts = beforeAt.split("/");
  if (parts.length < 2) return undefined;
  return {
    owner: parts[0],
    repo: parts[1],
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
  const tagOutput = execSync(
    `git ls-remote "${url}" "refs/tags/${ref}" "refs/tags/${ref}^{}"`,
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

  const branchOutput = execSync(
    `git ls-remote "${url}" "refs/heads/${ref}"`,
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

  const content = yamlStr.replace(
    /^(\s+(?:-\s+)?uses:\s+)(\S+)([^\n]*)$/gm,
    (_match, prefix: string, usesValue: string, rest: string) => {
      const parsed = parseActionUses(usesValue);
      if (!parsed) return `${prefix}${usesValue}${rest}`;

      if (isCommitHash(parsed.ref)) {
        // already pinned — recover the original ref from an inline comment
        // or, failing that, from the legacy footer entries in the cache
        const actionPath = usesValue.substring(0, usesValue.lastIndexOf("@"));
        let originalRef: string | undefined;

        const inlineMatch = rest.match(/^\s*#\s*(\S+)/);
        if (inlineMatch) {
          originalRef = inlineMatch[1];
        } else if (cache) {
          for (const entry of cache) {
            const ep = parseActionUses(entry.original);
            if (
              ep &&
              `${ep.owner}/${ep.repo}` === `${parsed.owner}/${parsed.repo}` &&
              ep.path === parsed.path &&
              entry.hash === parsed.ref
            ) {
              originalRef = ep.ref;
              break;
            }
          }
        }

        if (!originalRef) return `${prefix}${usesValue}${rest}`;

        const original = `${actionPath}@${originalRef}`;
        if (!pins.some((p) => p.original === original)) {
          pins.push({ original, hash: parsed.ref });
        }
        return `${prefix}${usesValue} # ${originalRef}`;
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
      return `${prefix}${actionPath}@${hash} # ${parsed.ref}`;
    },
  );

  return { content, pins };
}

/**
 * Extracts pin entries from file content. Reads the current inline format
 * (`uses: owner/repo@HASH # ref`) and, for backwards compatibility, the
 * legacy footer format (`# gagen:pin owner/repo@ref = HASH`).
 */
export function parsePinComments(content: string): PinEntry[] {
  const pins: PinEntry[] = [];
  const seen = new Set<string>();

  const inlineRe = /^\s+(?:-\s+)?uses:\s+(\S+?)@([0-9a-f]{40})\s+#\s*(\S+)/gm;
  let m;
  while ((m = inlineRe.exec(content)) !== null) {
    const original = `${m[1]}@${m[3]}`;
    if (seen.has(original)) continue;
    seen.add(original);
    pins.push({ original, hash: m[2] });
  }

  const footerRe = /^# gagen:pin (.+) = ([0-9a-f]{40})$/gm;
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
 * Replaces pinned hashes in a parsed YAML object with their original
 * tag/branch refs using the provided pin mapping.
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

      // steps
      if (Array.isArray(jobObj.steps)) {
        for (const s of jobObj.steps) {
          if (typeof s === "object" && s !== null) {
            const stepObj = s as Record<string, unknown>;
            if (
              typeof stepObj.uses === "string" &&
              hashToOriginal.has(stepObj.uses)
            ) {
              stepObj.uses = hashToOriginal.get(stepObj.uses);
            }
          }
        }
      }
    }
  }

  return obj;
}
