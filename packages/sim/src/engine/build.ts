// Builds dist/engine.cjs: the game's source plus bundle/entry.ts, bundled for plain Node (ADR 0007).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { enginePaths } from "./paths.ts";
import { checkVendorInstall, lockfileHash } from "./vendor.ts";

/** Everything that can change the bundle. */
export interface EngineInputs {
  vendorCommit: string;
  /** Uncommitted changes in the game's working tree (normally empty: the submodule is read-only). */
  vendorWorkingTree: string;
  /** The game's lockfile, which pins the dependency versions that get bundled. */
  vendorLockfile: string;
  buildScript: string;
  /** Path (relative to src/engine/bundle, forward slashes) → content. */
  bundleSources: Record<string, string>;
  esbuildVersion: string;
}

export interface BundleReport {
  bytes: number;
  inputs: number;
  gameFiles: number;
  packages: string[];
  /** Our stub modules that the mapping actually used. */
  stubs: string[];
}

export interface BuildResult {
  skipped: boolean;
  fingerprint: string;
  report?: BundleReport;
}

export function engineFingerprint(inputs: EngineInputs): string {
  const sources = Object.keys(inputs.bundleSources)
    .sort()
    .map((name) => [name, inputs.bundleSources[name]]);
  const { vendorCommit, vendorWorkingTree, vendorLockfile, buildScript, esbuildVersion } = inputs;
  return createHash("sha256")
    .update(JSON.stringify([vendorCommit, vendorWorkingTree, vendorLockfile, buildScript, sources, esbuildVersion]))
    .digest("hex");
}

export function collectBundleSources(dir: string): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const file = path.join(dir, name);
    if (statSync(file).isFile()) sources[name.replaceAll("\\", "/")] = readFileSync(file, "utf8");
  }
  return sources;
}

const gameGit = (...args: string[]) =>
  execFileSync("git", ["-C", enginePaths.gameRoot, ...args], { encoding: "utf8" }).trim();

export function collectEngineInputs(): EngineInputs {
  return {
    vendorCommit: gameGit("rev-parse", "HEAD"),
    vendorWorkingTree: gameGit("status", "--porcelain") + gameGit("diff", "HEAD"),
    vendorLockfile: lockfileHash(enginePaths.gameRoot),
    buildScript: readFileSync(import.meta.filename, "utf8"),
    bundleSources: collectBundleSources(enginePaths.bundleSourceDir),
    esbuildVersion: esbuild.version,
  };
}

// The module mapping, derived from the game's jest.config.js and webpack.config.js. Differences from Jest, all
// documented in packages/sim/README.md: `?raw` imports load as text (Jest uses a file mock), `@swc/wasm-web` is a
// stub (Jest maps it to native @swc/core), `@nsdefs` needs no mapping (its imports are type-only and erased), and the
// script module cache gets strong `WeakRef`/`FinalizationRegistry` stand-ins (`holdModules`).
const stubDir = path.join(enginePaths.bundleSourceDir, "stubs");
const aliases: Record<string, string> = {
  "@player": path.join(enginePaths.gameRoot, "src/Player.ts"),
  "@enums": path.join(enginePaths.gameRoot, "src/Enums.ts"),
  "monaco-editor": path.join(stubDir, "null.cjs"),
  "monaco-vim": path.join(stubDir, "null.cjs"),
  "@swc/wasm-web": path.join(stubDir, "swc.js"),
  // webpack.config.js: `fallback: { crypto: false }`.
  crypto: path.join(stubDir, "node-builtin.js"),
};
/** The asset extensions jest.config.js maps to mocks; here they become empty modules. */
const assetExtensions = "css less jpg jpeg png gif eot otf webp svg ttf woff woff2 mp4 webm wav mp3 m4a aac oga";

function gameModules(): esbuild.Plugin {
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const aliasFilter = new RegExp(`^(${Object.keys(aliases).map(escapeRegExp).join("|")})$`);
  return {
    name: "game-modules",
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
        namespace: "raw",
      }));
      build.onLoad({ filter: /.*/, namespace: "raw" }, (args) => ({
        contents: readFileSync(args.path, "utf8"),
        loader: "text",
      }));
      build.onResolve({ filter: aliasFilter }, (args) => ({ path: aliases[args.path] }));
      build.onLoad({ filter: new RegExp(`^${escapeRegExp(moduleCacheFile)}$`) }, (args) => ({
        contents: holdModules(readFileSync(args.path, "utf8")),
        loader: "ts",
      }));
    },
  };
}

/** The game's script module cache (NetscriptJSEvaluator.ts:41-47, :223-224). */
const moduleCacheFile = path.join(enginePaths.gameRoot, "src", "NetscriptJSEvaluator.ts");

/**
 * The game's module cache holds each compiled module through a `WeakRef` and drops its entry from a
 * `FinalizationRegistry` callback. A module the collector frees comes back fresh, its module-level state reset, so
 * results would depend on when the collector runs (#73). This imports strong stand-ins into that file alone
 * (stubs/strong-refs.ts), so the cache holds every module, as upstream dev's does. The import goes on the file's first
 * line, so its line numbers stay the game's. Throws once the cache no longer uses them, so the patch goes when a
 * version bump makes it unnecessary.
 */
export function holdModules(source: string): string {
  if (!/moduleCache\.set\([^;]*new WeakRef\(/.test(source) || !/cleanup = new FinalizationRegistry\(/.test(source)) {
    throw new Error(
      "NetscriptJSEvaluator.ts's module cache no longer uses a WeakRef and a FinalizationRegistry: remove " +
        "holdModules, as the module-cache row in docs/sim/parity.md lists (#73).",
    );
  }
  const stub = path.join(stubDir, "strong-refs.ts").replaceAll("\\", "/");
  return `import { WeakRef, FinalizationRegistry } from ${JSON.stringify(stub)}; ${source}`;
}

function packageOf(input: string): string {
  const parts =
    input
      .split(/node_modules[\\/]/)
      .pop()
      ?.split(/[\\/]/) ?? [];
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] ?? "");
}

export async function buildEngine({ force = false } = {}): Promise<BuildResult> {
  checkVendorInstall(enginePaths.gameRoot);
  const fingerprint = engineFingerprint(collectEngineInputs());
  if (!force && existsSync(enginePaths.bundle) && existsSync(enginePaths.meta)) {
    const meta = JSON.parse(readFileSync(enginePaths.meta, "utf8")) as { fingerprint?: string };
    if (meta.fingerprint === fingerprint) return { skipped: true, fingerprint };
  }

  const result = await esbuild.build({
    entryPoints: [path.join(enginePaths.bundleSourceDir, "entry.ts")],
    outfile: enginePaths.bundle,
    bundle: true,
    format: "cjs",
    // The game is built for the web (webpack `target: "web"`), so dependencies resolve their browser variants.
    platform: "browser",
    target: "es2024",
    nodePaths: [path.join(enginePaths.gameRoot, "node_modules")],
    define: {
      "process.env.NODE_ENV": '"production"',
      // webpack.config.js injects `git rev-parse --short HEAD` of the game's repo.
      __COMMIT_HASH__: JSON.stringify(gameGit("rev-parse", "--short", "HEAD")),
    },
    loader: Object.fromEntries(assetExtensions.split(" ").map((ext) => [`.${ext}`, "empty" as const])),
    jsx: "transform",
    plugins: [gameModules()],
    sourcemap: "linked",
    metafile: true,
    write: false,
    logLevel: "error",
  });

  // Write each output to a temporary file and rename it, so a concurrent load never sees a half-written bundle.
  mkdirSync(path.dirname(enginePaths.bundle), { recursive: true });
  for (const file of result.outputFiles) {
    writeFileSync(`${file.path}.tmp`, file.contents);
    renameSync(`${file.path}.tmp`, file.path);
  }
  const inputs = Object.keys(result.metafile.inputs);
  const report: BundleReport = {
    bytes: result.outputFiles.find((f) => f.path.endsWith("engine.cjs"))?.contents.byteLength ?? 0,
    inputs: inputs.length,
    gameFiles: inputs.filter((p) => p.includes("bitburner-src/src/")).length,
    packages: [...new Set(inputs.filter((p) => p.includes("node_modules")).map(packageOf))].sort(),
    stubs: inputs.filter((p) => p.includes("engine/bundle/stubs/")).map((p) => p.slice(p.indexOf("stubs/"))),
  };
  writeFileSync(enginePaths.meta, `${JSON.stringify({ fingerprint, report }, null, 2)}\n`);
  return { skipped: false, fingerprint, report };
}
