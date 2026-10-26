// npm run typecheck (its first step): typechecks every TypeScript config in the repository, each in its own
// environment (CONTRIBUTING, "TypeScript configs"), and fails if any TypeScript file isn't covered by a config, so a
// new folder can't silently go unchecked. Exits 0 when clean, 1 on type errors or uncovered files.
import { execFileSync, spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const typescriptCompiler = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");

const notCheckedHere = [
  // Checked separately, with the game's own TypeScript: packages/sim/scripts/typecheck-bundle.ts.
  "packages/sim/src/engine/bundle/",
  // Throwaway experiments, kept as they were run (architecture §12.2); never typechecked.
  "spikes/",
];

const configPaths = globSync("**/tsconfig.json", {
  cwd: repositoryRoot,
  exclude: (candidate) => ["node_modules", "vendor", ".git", "spikes"].includes(path.basename(candidate)),
})
  .map((configPath) => configPath.split(path.sep).join("/"))
  .sort();

function runCompiler(args: string[]): { status: number; output: string } {
  const result = spawnSync(process.execPath, [typescriptCompiler, ...args], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output: result.stdout + result.stderr };
}

function rootFilesOf(configPath: string): string[] {
  const { status, output } = runCompiler(["-p", configPath, "--showConfig"]);
  if (status !== 0) throw new Error(`tsc --showConfig failed for ${configPath}:\n${output}`);
  const { files = [] } = JSON.parse(output) as { files?: string[] };
  return files.map((file) => path.posix.join(path.posix.dirname(configPath), file));
}

let failed = false;
const coveredFiles = new Set<string>();
for (const configPath of configPaths) {
  for (const file of rootFilesOf(configPath)) coveredFiles.add(path.posix.normalize(file));
  const { status, output } = runCompiler(["-p", configPath]);
  if (status !== 0) {
    failed = true;
    process.stdout.write(output);
  }
}

const typescriptFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", ":!:*.d.ts"],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .split("\n")
  .filter((file) => file !== "" && !notCheckedHere.some((prefix) => file.startsWith(prefix)));
const uncoveredFiles = typescriptFiles.filter((file) => !coveredFiles.has(file));
if (uncoveredFiles.length > 0) {
  failed = true;
  console.error(
    `No tsconfig.json covers these files; add them to a config's "include":\n  ${uncoveredFiles.join("\n  ")}`,
  );
}

console.log(`Typechecked ${configPaths.length} configs: ${configPaths.join(", ")}`);
process.exitCode = failed ? 1 : 0;
