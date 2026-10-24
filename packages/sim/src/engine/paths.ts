import path from "node:path";

const simRoot = path.resolve(import.meta.dirname, "../..");

export const enginePaths = {
  /** The pinned game source (git submodule, read-only). */
  gameRoot: path.resolve(simRoot, "../../vendor/bitburner-src"),
  /** Our sources that are bundled together with the game: entry.ts and the module stubs. */
  bundleSourceDir: path.join(simRoot, "src/engine/bundle"),
  bundle: path.join(simRoot, "dist/engine.cjs"),
  meta: path.join(simRoot, "dist/engine.meta.json"),
};
