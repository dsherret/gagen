import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { collectActionVersions, pullVersionsInSource } from "./pin.ts";
import { assertKnownFlags } from "./workflow.ts";

export async function runCli() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return;
  }
  assertKnownFlags(args);

  const workflowsDir = findWorkflowsDir();
  if (workflowsDir == null) {
    console.error("No .github/workflows directory found.");
    process.exit(1);
  }

  if (args.includes("--pull-versions")) {
    pullVersions(workflowsDir);
    return;
  }

  const entries = fs.readdirSync(workflowsDir);

  const extensions = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"];
  const tsFiles = entries
    .filter((f) => extensions.some((ext) => f.endsWith(ext)))
    .sort();

  if (tsFiles.length === 0) {
    console.error("No script files found in .github/workflows");
    process.exit(1);
  }

  const isLinting = args.includes("--lint");
  let ranAny = false;
  for (const file of tsFiles) {
    const fullPath = resolve(workflowsDir, file);
    const content = fs.readFileSync(fullPath, "utf8");
    if (!content.includes("writeOrLint")) continue;
    const label = isLinting ? "Linting" : "Generating";
    const color = isLinting ? "\x1b[36m" : "\x1b[32m";
    console.error(`${color}${label}\x1b[0m ${file}`);
    ranAny = true;
    await import(pathToFileURL(fullPath).href);
  }

  if (!ranAny) {
    console.error(
      "No script files in .github/workflows use writeOrLint — nothing to do.",
    );
    process.exit(1);
  }
}

function pullVersions(workflowsDir: string) {
  const entries = fs.readdirSync(workflowsDir);

  const yamlFiles = entries.filter((f) =>
    f.endsWith(".yml") || f.endsWith(".yaml")
  );
  const yamlContents = yamlFiles.map((f) =>
    fs.readFileSync(resolve(workflowsDir, f), "utf8")
  );
  const { versions, conflicts } = collectActionVersions(yamlContents);

  for (const [action, refs] of conflicts) {
    console.error(
      `\x1b[33mwarning\x1b[0m ${action}: conflicting versions ${
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

  const scriptExtensions = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"];
  const scriptFiles = entries
    .filter((f) => scriptExtensions.some((ext) => f.endsWith(ext)))
    .sort();

  let anyChanges = false;
  for (const file of scriptFiles) {
    const fullPath = resolve(workflowsDir, file);
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
        `\x1b[32mupdated\x1b[0m ${file}: ${change.action}@${change.from} → ${change.to}`,
      );
    }
  }

  if (!anyChanges) {
    console.error("All script files are already up to date.");
  }
}

function findWorkflowsDir(): string | undefined {
  let dir = resolve(".");
  while (true) {
    const candidate = join(dir, ".github", "workflows");
    if (fs.existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function helpText(): string {
  return `gagen — generate GitHub Actions workflows from TypeScript

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
                   versions in the generated yaml files
  -h, --help       show this help text`;
}

if (import.meta.main) {
  await runCli();
}
