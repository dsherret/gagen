import fs from "node:fs";
import process from "node:process";
import { parse } from "@std/yaml/parse";
import {
  narrowYamlContent,
  parseLockfilePins,
  parsePinComments,
  pinParsedYaml,
  pinYamlContent,
} from "./pin.ts";
import type { PinEntry, RefNarrower, RefResolver } from "./pin.ts";

/** Options shared by the `writeOrLint` methods of workflows and actions. */
export interface WriteOrLintOptions {
  filePath: URL;
  header?: string;
  /**
   * How to pin the `uses:` references in the output.
   *
   * - `true` (default) pins them to commit hashes.
   * - `false` leaves them as written.
   * - `"lockfile"` (experimental) is for use with a GitHub Actions workflow
   *   lockfile (`.github/workflows/actions.lock`), which pins each reference
   *   to a commit itself. Partial versions (ex. `v6`) are narrowed to the full
   *   version tag at the same commit (ex. `v6.0.1`) instead of a hash, the same
   *   as `gh actions-lock` does, so it leaves the output as-is. Reusable
   *   workflows from other repositories, which the lockfile does not cover, are
   *   still pinned to commit hashes.
   * - `{ resolve }` pins to commit hashes with a custom resolver.
   * - `{ narrow, resolve }` is lockfile mode with a custom narrower and,
   *   optionally, a custom resolver for the reusable workflows.
   */
  pinDeps?:
    | boolean
    | "lockfile"
    | { resolve: RefResolver }
    | { narrow: RefNarrower; resolve?: RefResolver };
}

/**
 * Writes the generated YAML to `options.filePath`, or with `--lint` compares it
 * against the file already there and exits non-zero when they differ.
 *
 * With `pinDeps` (the default), `uses:` references are pinned to commit hashes
 * (or full version tags in lockfile mode) on write, reusing the pins recorded
 * in the existing file unless `--update-pins` is passed.
 */
export function writeOrLintYaml(
  expected: string,
  options: WriteOrLintOptions,
): void {
  assertKnownFlags();
  const pinning = getPinning(options.pinDeps);

  if (isLintingNow()) {
    const existing = readForLint(options.filePath);
    let parsedExisting: unknown;
    let parsedExpected: unknown;

    if (pinning != null) {
      // compare in the pinned direction: a ref always maps to one hash,
      // while a hash may have been written by more than one ref
      const pins = parsePins(existing, pinning);
      parsedExisting = parse(existing);
      parsedExpected = pinParsedYaml(parse(expected), pins);
    } else {
      parsedExisting = parse(existing);
      parsedExpected = parse(expected);
    }

    if (
      JSON.stringify(parsedExisting) !== JSON.stringify(parsedExpected)
    ) {
      console.error(
        `Error: ${options.filePath} is out of date. Run without --lint to update.`,
      );
      process.exit(1);
    }
  } else {
    let output = expected;
    if (pinning != null) {
      // reuse previously resolved pins from existing file to avoid
      // redundant git ls-remote calls on subsequent runs
      let cache: PinEntry[] | undefined;
      if (!isUpdatingPinsNow()) {
        try {
          const existing = fs.readFileSync(options.filePath, {
            encoding: "utf8",
          });
          cache = parsePins(existing, pinning);
        } catch {
          // file doesn't exist yet
        }
      }
      const result = pinning.kind === "hash"
        ? pinYamlContent(expected, pinning.resolve, cache)
        : narrowYamlContent(
          expected,
          pinning.narrow,
          cache,
          pinning.resolve,
        );
      output = result.content;
    }
    fs.writeFileSync(options.filePath, output);
  }
}

/**
 * Gets if `writeOrLint` will lint the generated files instead of writing them
 * (`--lint`). Useful for skipping work in a script that only makes sense when
 * generating.
 */
export const isLinting: boolean = isLintingNow();

/**
 * Gets if linting should occur, reading the flags on each call.
 *
 * `isLinting` cannot be used internally: it is captured when this module is
 * first imported, which makes the lint path unreachable from a test that sets
 * the flag afterwards.
 */
function isLintingNow(): boolean {
  return process.argv.includes("--lint");
}

/**
 * Gets if `writeOrLint` will re-resolve every pinned action instead of reusing
 * the hashes in the existing file (`--update-pins`).
 */
export const isUpdatingPins: boolean = isUpdatingPinsNow();

/** Gets if pins should be re-resolved, reading the flags on each call. */
function isUpdatingPinsNow(): boolean {
  return process.argv.includes("--update-pins");
}

/** The command line flags that gagen reads. */
export const KNOWN_FLAGS: readonly string[] = [
  "--lint",
  "--update-pins",
  "--pull-versions",
  "--help",
  "-h",
];

/**
 * Exits with an error when the command line has a flag gagen does not know
 * about.
 *
 * Since gagen decides whether to write or lint from the process' flags, a
 * typo like `--lnit` would otherwise be indistinguishable from no flag at all
 * and would silently overwrite the generated files it was meant to check.
 */
export function assertKnownFlags(
  args: readonly string[] = process.argv.slice(2),
): void {
  const unknown = args.filter((arg) =>
    arg.startsWith("-") && !KNOWN_FLAGS.includes(arg)
  );
  if (unknown.length === 0) return;
  console.error(`Unknown flag: ${unknown.join(", ")}`);
  console.error(`Known flags: ${KNOWN_FLAGS.join(", ")}`);
  process.exit(1);
}

/** Reads the file to lint against, failing with a hint when it is missing. */
function readForLint(filePath: URL): string {
  try {
    return fs.readFileSync(filePath, { encoding: "utf8" });
  } catch (err) {
    if (isNotFound(err)) {
      console.error(
        `Error: ${filePath} does not exist. Run without --lint to generate it.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === "ENOENT";
}

/** How `writeOrLint` pins the output, resolved from the `pinDeps` option. */
type Pinning =
  | { kind: "hash"; resolve: RefResolver | undefined }
  | {
    kind: "tag";
    narrow: RefNarrower | undefined;
    resolve: RefResolver | undefined;
  };

function getPinning(
  pinDeps: WriteOrLintOptions["pinDeps"],
): Pinning | undefined {
  if (pinDeps == null || pinDeps === true) {
    return { kind: "hash", resolve: undefined };
  } else if (pinDeps === false) {
    return undefined;
  } else if (pinDeps === "lockfile") {
    return { kind: "tag", narrow: undefined, resolve: undefined };
  } else if ("narrow" in pinDeps) {
    return { kind: "tag", narrow: pinDeps.narrow, resolve: pinDeps.resolve };
  } else {
    return { kind: "hash", resolve: pinDeps.resolve };
  }
}

/** Reads the pins recorded in a file written with the given pinning. */
function parsePins(content: string, pinning: Pinning): PinEntry[] {
  return pinning.kind === "hash"
    ? parsePinComments(content)
    : parseLockfilePins(content);
}
