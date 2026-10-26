// npm run typecheck (its first step): typechecks every TypeScript config in the repository, each in its own
// environment (CONTRIBUTING, "TypeScript configs"), and fails if any TypeScript file isn't covered by a config, so a
// new folder can't silently go unchecked. Exits 0 when clean, 1 on type errors or uncovered files.
import path from "node:path";
import { typecheckRepository } from "./src/typecheck.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const { configResults, uncoveredFiles } = typecheckRepository(repositoryRoot);

const failedConfigs = configResults.filter((result) => !result.passed);
for (const { configPath, report } of failedConfigs) {
  console.log(`${configPath}:\n${report}`);
}
if (uncoveredFiles.length > 0) {
  console.error(
    `No tsconfig.json covers these files; add them to a config's "include", or use a .ts extension:\n  ${uncoveredFiles.join("\n  ")}`,
  );
}

const configSummary = `configs: ${configResults.length}, failed: ${failedConfigs.length}`;
const coverageSummary = `uncovered files: ${uncoveredFiles.length}`;
console.log(
  `Typecheck: ${configSummary}; ${coverageSummary} (${configResults.map((result) => result.configPath).join(", ")})`,
);
process.exitCode = failedConfigs.length > 0 || uncoveredFiles.length > 0 ? 1 : 0;
