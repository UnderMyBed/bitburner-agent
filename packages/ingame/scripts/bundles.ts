// Builds the in-game scripts: one self-contained ES module per entry in src/entries/, plus a manifest naming the build.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const INGAME_PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = path.resolve(INGAME_PACKAGE_ROOT, "../..");
export const DEFAULT_OUTPUT_DIRECTORY = path.join(INGAME_PACKAGE_ROOT, "dist");
export const MANIFEST_FILE_NAME = "manifest.json";

export interface BuiltFile {
  sha256: string;
  bytes: number;
}

export interface BundleManifest {
  /** A short hash of every output: the same sources always give the same id, on any machine. */
  buildId: string;
  /** Each in-game script, by file name (e.g. "boot.js"). */
  files: Record<string, BuiltFile>;
}

export interface BuildOptions {
  /** Emptied first. Default: the package's dist/. */
  outputDirectory?: string;
  /** Default: the package's src/entries/. Tests point it elsewhere. */
  entriesDirectory?: string;
}

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
/** Code-unit order, the same on every machine (localeCompare depends on the locale). */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Bundles every entry and writes the manifest. Not minified: the game charges RAM by identifier name, so a minifier's
 * short names could turn a harmless local into `ps` or `rm` (packages/ingame/README.md). No output imports anything at
 * runtime, so the game's stale RAM cache for importers (game issue #2907) can't arise.
 */
export async function buildInGameBundles({
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  entriesDirectory = path.join(INGAME_PACKAGE_ROOT, "src/entries"),
}: BuildOptions = {}): Promise<BundleManifest> {
  const entryFileNames = readdirSync(entriesDirectory)
    .filter((fileName) => fileName.endsWith(".ts"))
    .sort(byCodeUnits);
  if (entryFileNames.length === 0) throw new Error(`No in-game entries in ${entriesDirectory}`);
  const result = await esbuild.build({
    entryPoints: entryFileNames.map((fileName) => path.join(entriesDirectory, fileName)),
    // Comments in the output name sources relative to the repository, whatever directory the build runs from, so the
    // build id is the same on every machine.
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
  // An import esbuild couldn't bundle (a URL; it keeps those external). A dynamic import of a computed name doesn't
  // show here: the tests' check of the bundles' text covers that.
  for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
    if (output.imports.length > 0) {
      const imported = output.imports.map((imported) => imported.path).join(", ");
      throw new Error(`${outputPath} imports ${imported} at runtime; in-game bundles must be self-contained`);
    }
  }

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const files: Record<string, BuiltFile> = {};
  for (const output of [...result.outputFiles].sort((a, b) => byCodeUnits(a.path, b.path))) {
    const fileName = path.basename(output.path);
    writeFileSync(path.join(outputDirectory, fileName), output.text);
    files[fileName] = { sha256: sha256(output.text), bytes: output.contents.byteLength };
  }
  const buildId = sha256(JSON.stringify(Object.entries(files).map(([name, file]) => [name, file.sha256]))).slice(0, 12);
  const manifest: BundleManifest = { buildId, files };
  writeFileSync(path.join(outputDirectory, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
