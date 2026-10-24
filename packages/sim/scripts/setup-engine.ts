// npm run setup:engine: installs the game's own dependencies from its lockfile, inside the submodule.
// Only the submodule's gitignored node_modules is written; tracked files are untouched.
import { execSync } from "node:child_process";
import { enginePaths } from "../src/engine/paths.ts";

execSync("npm ci --ignore-scripts --no-audit --no-fund", {
  cwd: enginePaths.gameRoot,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
});
