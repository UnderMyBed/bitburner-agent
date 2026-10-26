// Builds the in-game scripts: one self-contained ES module per entry in src/entries/, plus a manifest naming the build.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

export const INGAME_PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = path.resolve(INGAME_PACKAGE_ROOT, "../..");
export const ENTRIES_DIRECTORY = path.join(INGAME_PACKAGE_ROOT, "src/entries");
export const DEFAULT_OUTPUT_DIRECTORY = path.join(INGAME_PACKAGE_ROOT, "dist");
export const RAM_BUDGET_FILE = path.join(INGAME_PACKAGE_ROOT, "ram-budget.json");
export const MANIFEST_FILE_NAME = "manifest.json";

export interface BuiltFile {
  sha256: string;
  bytes: number;
}

export interface BundleManifest {
  /** A short hash of every output: the same sources always give the same id. */
  buildId: string;
  /** Each in-game script, by file name (e.g. "boot.js"). */
  files: Record<string, BuiltFile>;
}

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

/**
 * Bundles every entry into `outputDirectory` (emptied first) and writes the manifest. Not minified: the game charges
 * RAM by identifier name, so a minifier's short names could turn a harmless local into `ps` or `rm`
 * (packages/ingame/README.md). No output imports anything at runtime, so the game's stale RAM cache for importers
 * (game issue #2907) can't arise.
 */
export async function buildInGameBundles(outputDirectory = DEFAULT_OUTPUT_DIRECTORY): Promise<BundleManifest> {
  const entryFileNames = readdirSync(ENTRIES_DIRECTORY)
    .filter((fileName) => fileName.endsWith(".ts"))
    .sort();
  if (entryFileNames.length === 0) throw new Error(`No in-game entries in ${ENTRIES_DIRECTORY}`);
  const result = await esbuild.build({
    entryPoints: entryFileNames.map((fileName) => path.join(ENTRIES_DIRECTORY, fileName)),
    // Comments in the output name sources relative to the repository, the same on every machine.
    absWorkingDir: REPOSITORY_ROOT,
    outdir: outputDirectory,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    minify: false,
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
    if (output.imports.length > 0) {
      const imported = output.imports.map((imported) => imported.path).join(", ");
      throw new Error(`${outputPath} imports ${imported} at runtime; in-game bundles must be self-contained`);
    }
  }

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const files: Record<string, BuiltFile> = {};
  for (const output of [...result.outputFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    const fileName = path.basename(output.path);
    writeFileSync(path.join(outputDirectory, fileName), output.text);
    files[fileName] = { sha256: sha256(output.text), bytes: output.contents.byteLength };
  }
  const buildId = sha256(JSON.stringify(Object.entries(files).map(([name, file]) => [name, file.sha256]))).slice(0, 12);
  const manifest: BundleManifest = { buildId, files };
  writeFileSync(path.join(outputDirectory, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The RAM budget of each in-game script, in GB (ram-budget.json). */
export function readRamBudgets(): Record<string, number> {
  return JSON.parse(readFileSync(RAM_BUDGET_FILE, "utf8")) as Record<string, number>;
}
