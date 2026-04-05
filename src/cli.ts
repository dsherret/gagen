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

  const tsFiles = entries
    .filter((f) => f.endsWith(".ts"))
    .sort();

  if (tsFiles.length === 0) {
    console.error("No TypeScript files found in .github/workflows");
    process.exit(1);
  }

  for (const file of tsFiles) {
    const fullPath = resolve(workflowsDir, file);
    await import(pathToFileURL(fullPath).href);
  }
}

if (import.meta.main) {
  await runCli();
}
