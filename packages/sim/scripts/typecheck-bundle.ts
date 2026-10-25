// npm run typecheck (its second step): typechecks the simulator's bundled sources (src/engine/bundle/) against the
// game's types, with the game's own TypeScript and tsconfig.bundle.json (README "Typecheck boundary").
// Exits as tsc does: 0 clean, non-zero on errors. Fails with a message if the game's dependencies aren't installed.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { enginePaths } from "../src/engine/paths.ts";
import { checkVendorInstall } from "../src/engine/vendor.ts";

// The same check the engine build makes: missing or stale dependencies would show up as confusing type errors.
try {
  checkVendorInstall(enginePaths.gameRoot);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const tsc = path.join(enginePaths.gameRoot, "node_modules/typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", path.resolve(import.meta.dirname, "../tsconfig.bundle.json")], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
