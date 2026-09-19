import fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { collectActionVersions, pullVersionsInSource } from "./pin.ts";
import { assertKnownFlags } from "./write.ts";

const SCRIPT_EXTENSIONS = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"];
const YAML_EXTENSIONS = [".yml", ".yaml"];

export async function runCli() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText());

    return;
  }

  assertKnownFlags(args);

  const workflowsDir = findDir("workflows");
  const actionsDir = findDir("actions");

  if (!workflowsDir && !actionsDir) {
    console.error("No .github/workflows directory found.");
    process.exit(1);
  }

  if (args.includes("--pull-versions")) {
    pullVersions([workflowsDir, actionsDir].filter((dir) => dir !== undefined));

    return;
  }

  const workflows = workflowsDir ? findScriptFiles(workflowsDir) : [];
  const actions = actionsDir ? findScriptFiles(actionsDir) : [];

  if (!workflows.length && !actions.length) {
    console.error(
      "No script files found in .github/workflows or .github/actions",
    );
    
    process.exit(1);
  }

  if (!await writeOrLint([...workflows, ...actions], args)) {
    console.error(
      "No script files in .github/workflows and .github/actions use writeOrLint — nothing to do.",
    );

    process.exit(1);
  }
}

function pullVersions(dirs: string[]) {
  const yamlContents = findGeneratedYamlFiles(dirs).map((f) =>
    fs.readFileSync(f, "utf8")
  );
  const { versions, conflicts } = collectActionVersions(yamlContents);

  for (const [action, refs] of conflicts) {
    console.error(
      `\x1b[33mwarning\x1b[0m ${action}: conflicting versions stored in YAML files ${
        refs.join(", ")
      } — skipping`,
    );
  }

  if (versions.size === 0) {
    if (conflicts.size === 0) {
      console.error("No pinned versions found in generated YAML files.");
    }
    return;
  }

  const repoRoot = repoRootOf(dirs);
  const scriptFiles = dirs.flatMap((dir) => findScriptFiles(dir)).sort();

  let anyChanges = false;
  for (const fullPath of scriptFiles) {
    const content = fs.readFileSync(fullPath, "utf8");
    const { content: updated, changes } = pullVersionsInSource(
      content,
      versions,
    );
    if (changes.length === 0) continue;
    anyChanges = true;
    fs.writeFileSync(fullPath, updated);
    for (const change of changes) {
      console.error(
        `\x1b[32mupdated\x1b[0m ${
          relative(repoRoot, fullPath)
        }: ${change.action}@${change.from} → ${change.to}`,
      );
    }
  }

  if (!anyChanges) {
    console.error("All script files are already up to date.");
  }
}

async function writeOrLint(
  files: string[],
  args: string[],
): Promise<boolean> {
  const isLinting = args.includes("--lint");

  let ranAny: boolean = false;

  for (const file of files.sort()) {
    const content = fs.readFileSync(file, "utf8");

    if (!content.includes("writeOrLint")) {
      continue;
    }

    const label = isLinting ? "Linting" : "Generating";
    const color = isLinting ? "\x1b[36m" : "\x1b[32m";

    console.error(`${color}${label}\x1b[0m ${file}`);

    ranAny = true;

    await import(pathToFileURL(file).href);
  }

  return ranAny;
}

function findGeneratedYamlFiles(dirs: string[]): string[] {
  const files = dirs.flatMap((dir) => findFiles(dir, YAML_EXTENSIONS));
  const repoRoot = repoRootOf(dirs);
  for (const name of ["action.yml", "action.yaml"]) {
    const candidate = join(repoRoot, name);
    if (fs.existsSync(candidate)) files.push(candidate);
  }
  return files;
}

function repoRootOf(dirs: string[]): string {
  return dirname(dirname(dirs[0]));
}

function findScriptFiles(dir: string): string[] {
  return findFiles(dir, SCRIPT_EXTENSIONS);
}

function findFiles(dir: string, extensions: readonly string[]): string[] {
  const results: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);

    const files = entry.isDirectory()
      ? findFiles(fullPath, extensions)
      : extensions.some((ext) => entry.name.endsWith(ext))
      ? [fullPath]
      : [];

    results.push(...files);
  }

  return results;
}

function findDir(folderName: string): string | undefined {
  let dir = resolve(".");
  while (true) {
    const candidate = join(dir, ".github", folderName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function helpText(): string {
  return `gagen — generate GitHub Actions workflows and composite actions from TypeScript

Usage:
  gagen [options]

Runs every script in the closest .github/workflows directory that uses
\`writeOrLint\`.

Options:
  --lint           verify the generated files are up to date instead of
                   writing them, exiting non-zero when they are not
  --update-pins    re-resolve every pinned action instead of reusing the
                   hashes stored in the generated files
  --pull-versions  update the action versions in the scripts to match the
                   versions in the generated yaml files (the workflows, the
                   composite actions under .github/actions and a root
                   action.yml)
  -h, --help       show this help text`;
}

if (import.meta.main) {
  await runCli();
}
