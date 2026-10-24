import path from "node:path";

const simRoot = path.resolve(import.meta.dirname, "../..");

export const enginePaths = {
  /** The pinned game source (git submodule, read-only). */
  gameRoot: path.resolve(simRoot, "../../vendor/bitburner-src"),
  /** Sources bundled together with the game: entry.ts and the module stubs. */
  engineDir: path.join(simRoot, "src/engine"),
  bundle: path.join(simRoot, "dist/engine.cjs"),
  meta: path.join(simRoot, "dist/engine.meta.json"),
};
