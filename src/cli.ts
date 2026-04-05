import fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

export async function runCli() {
  const workflowsDir = resolve(".github/workflows");

  let entries: string[];
  try {
    entries = fs.readdirSync(workflowsDir);
  } catch {
    console.error("No .github/workflows directory found.");
    process.exit(1);
  }

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

if (import.meta.main) {
  await runCli();
}
