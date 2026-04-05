import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

export async function runCli() {
  const workflowsDir = findWorkflowsDir();
  if (workflowsDir == null) {
    console.error("No .github/workflows directory found.");
    process.exit(1);
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

  const isLinting = process.argv.includes("--lint");
  for (const file of tsFiles) {
    const fullPath = resolve(workflowsDir, file);
    const content = fs.readFileSync(fullPath, "utf8");
    if (!content.includes("writeOrLint")) continue;
    const label = isLinting ? "Linting" : "Generating";
    const color = isLinting ? "\x1b[36m" : "\x1b[32m";
    console.error(`${color}${label}\x1b[0m ${file}`);
    await import(pathToFileURL(fullPath).href);
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

if (import.meta.main) {
  await runCli();
}
