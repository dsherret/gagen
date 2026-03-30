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

/** Resolves non-SHA refs in YAML content to commit hashes. */
export function pinYamlContent(
  yamlStr: string,
  resolve: RefResolver = resolveRef,
): { content: string; pins: PinEntry[] } {
  const pins: PinEntry[] = [];
  const seen = new Map<string, string>();

  const content = yamlStr.replace(
    /^(\s+(?:-\s+)?uses:\s+)(.+)$/gm,
    (_match, prefix: string, usesValue: string) => {
      const trimmed = usesValue.trim();
      const parsed = parseActionUses(trimmed);
      if (!parsed || isCommitHash(parsed.ref)) return `${prefix}${usesValue}`;

      let hash = seen.get(trimmed);
      if (!hash) {
        hash = resolve(parsed.owner, parsed.repo, parsed.ref);
        seen.set(trimmed, hash);
        pins.push({ original: trimmed, hash });
      }

      const pinned = trimmed.replace(`@${parsed.ref}`, `@${hash}`);
      return `${prefix}${pinned}`;
    },
  );

  return { content, pins };
}

/** Formats pin entries as comments to append to the file. */
export function formatPinComments(pins: PinEntry[]): string {
  if (pins.length === 0) return "";
  const lines = pins.map((p) => `# gagen:pin ${p.original} = ${p.hash}`);
  return "\n" + lines.join("\n") + "\n";
}

/** Extracts pin entries from file content. */
export function parsePinComments(content: string): PinEntry[] {
  const pins: PinEntry[] = [];
  const re = /^# gagen:pin (.+) = ([0-9a-f]{40})$/gm;
  let match;
  while ((match = re.exec(content)) !== null) {
    pins.push({ original: match[1], hash: match[2] });
  }
  return pins;
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
