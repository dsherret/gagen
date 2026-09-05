import fs from "node:fs";
import process from "node:process";
import { parse } from "@std/yaml/parse";
import { parsePinComments, pinParsedYaml, pinYamlContent } from "./pin.ts";
import type { PinEntry, RefResolver } from "./pin.ts";

/** Options shared by the `writeOrLint` methods of workflows and actions. */
export interface WriteOrLintOptions {
  filePath: URL;
  header?: string;
  pinDeps?: boolean | { resolve: RefResolver };
}

/**
 * Writes the generated YAML to `options.filePath`, or with `--lint` compares it
 * against the file already there and exits non-zero when they differ.
 *
 * With `pinDeps` (the default), `uses:` references are pinned to commit hashes
 * on write, reusing the hashes recorded in the existing file unless
 * `--update-pins` is passed.
 */
export function writeOrLintYaml(
  expected: string,
  options: WriteOrLintOptions,
): void {
  assertKnownFlags();
  const pinDeps = options.pinDeps ?? true;

  if (isLintingNow()) {
    const existing = readForLint(options.filePath);
    let parsedExisting: unknown;
    let parsedExpected: unknown;

    if (pinDeps) {
      // compare in the pinned direction: a ref always maps to one hash,
      // while a hash may have been written by more than one ref
      const pins = parsePinComments(existing);
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
    if (pinDeps) {
      const resolve = typeof pinDeps === "object" ? pinDeps.resolve : undefined;
      // reuse previously resolved hashes from existing file to avoid
      // redundant git ls-remote calls on subsequent runs
      let cache: PinEntry[] | undefined;
      if (!isUpdatingPins()) {
        try {
          const existing = fs.readFileSync(options.filePath, {
            encoding: "utf8",
          });
          cache = parsePinComments(existing);
        } catch {
          // file doesn't exist yet
        }
      }
      const result = pinYamlContent(expected, resolve, cache);
      output = result.content;
    }
    fs.writeFileSync(options.filePath, output);
  }
}

/** Gets if linting would occur when using `writeOrLint`. */
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

/** Gets if pins should be re-resolved when using `writeOrLint`. */
export function isUpdatingPins(): boolean {
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
