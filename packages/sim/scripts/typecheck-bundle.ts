// Typechecks the simulator's bundled sources (src/engine/bundle/) against the game's types, with the game's own
// TypeScript and tsconfig (tsconfig.bundle.json; README "Typecheck boundary"). Part of `npm run typecheck`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const tsc = path.resolve(import.meta.dirname, "../../../vendor/bitburner-src/node_modules/typescript/bin/tsc");
if (!existsSync(tsc)) {
  console.error(
    "The game's dependencies are not installed, so the bundled sources can't be typechecked: run `npm run setup:engine`.",
  );
  process.exit(2);
}
const { status } = spawnSync(
  process.execPath,
  [tsc, "-p", path.resolve(import.meta.dirname, "../tsconfig.bundle.json")],
  {
    stdio: "inherit",
  },
);
process.exitCode = status ?? 1;
