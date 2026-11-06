// Builds dist/engine.cjs: the game's source plus bundle/entry.ts, bundled for plain Node (ADR 0007).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PINNED_GAME } from "@bitburner-agent/core";
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
  /**
   * The tsconfig esbuild applies to our bundled sources, and the files it extends (#132): path (relative to
   * src/engine/bundle, forward slashes) → content. The game's own is covered by its commit and working tree.
   */
  tsconfigs: Record<string, string>;
  /**
   * The package.json files at and above our bundled sources and the game's root (#172): path (relative to
   * src/engine/bundle, forward slashes) → the fields esbuild applies to the sources under them, as JSON. The game's
   * root is walked for the repository's above it: the game's own, and those below it (electron/package.json), are
   * covered by its commit and working tree too.
   */
  packageJsons: Record<string, string>;
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
  const sorted = (files: Record<string, string>) =>
    Object.keys(files)
      .sort()
      .map((name) => [name, files[name]]);
  const { vendorCommit, vendorWorkingTree, vendorLockfile, buildScript, esbuildVersion } = inputs;
  const sources = sorted(inputs.bundleSources);
  const tsconfigs = sorted(inputs.tsconfigs);
  const packageJsons = sorted(inputs.packageJsons);
  return createHash("sha256")
    .update(
      JSON.stringify([
        vendorCommit,
        vendorWorkingTree,
        vendorLockfile,
        buildScript,
        sources,
        esbuildVersion,
        tsconfigs,
        packageJsons,
      ]),
    )
    .digest("hex");
}

/**
 * What esbuild takes from a package.json for the sources under it: the nearest one's `type` (a source's module
 * format), `sideEffects` (what tree shaking may drop) and `imports` (`#` specifiers), and, with platform "browser",
 * the nearest one with a `browser` map remaps their imports. The others (`name`, `main`, `exports`, ...) apply only to
 * an import of the package by name, a source's import of its own package included (a self-reference), and the bundle
 * makes none of either package, ours or the game's.
 */
const APPLIED_PACKAGE_FIELDS = ["type", "sideEffects", "browser", "imports"] as const;

/**
 * The package.json files esbuild reads for the sources in each of `dirs` (#172): every one at or above each, as the
 * nearest gives a source its `type`, `sideEffects` and `imports`, and the nearest with a `browser` map can be further
 * up. Walked from each one's real path, which esbuild resolves a linked directory to. Path (relative to `base`'s
 * real path, forward slashes) → the fields esbuild applies (APPLIED_PACKAGE_FIELDS), as JSON, so a dependency's
 * version, which can't change the bundle, doesn't rebuild it. Throws on one that isn't a JSON object, naming it.
 */
export function collectPackageJsons(dirs: string[], base: string): Record<string, string> {
  const packageJsons: Record<string, string> = {};
  const realBase = realpathSync.native(base);
  for (const dir of dirs) {
    for (let current = realpathSync.native(dir); ; current = path.dirname(current)) {
      const file = path.join(current, "package.json");
      const key = path.relative(realBase, file).replaceAll("\\", "/");
      if (!(key in packageJsons) && existsSync(file)) packageJsons[key] = appliedFields(file);
      if (path.dirname(current) === current) break;
    }
  }
  return packageJsons;
}

function appliedFields(file: string): string {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${file} isn't a JSON object, so the engine's fingerprint can't cover it: ${(error as Error).message}`,
    );
  }
  return JSON.stringify(Object.fromEntries(APPLIED_PACKAGE_FIELDS.map((field) => [field, parsed[field]])));
}

/**
 * The tsconfig files esbuild applies to the sources in `linkedDir`: the nearest tsconfig.json at or above its real
 * path, as esbuild finds it, then every file that one extends, in turn (each once, so a cycle ends). Path (relative to
 * that real path, forward slashes) → content. Throws on an `extends` it can't follow (a package's config, a missing
 * file), or a jsconfig.json esbuild would take, rather than leave that config out of the fingerprint.
 */
export function collectTsconfigs(linkedDir: string): Record<string, string> {
  // esbuild resolves a linked directory to its real path, and looks above that.
  const dir = realpathSync.native(linkedDir);
  let nearest = dir;
  while (!existsSync(path.join(nearest, "tsconfig.json"))) {
    // esbuild takes a jsconfig.json where a directory has no tsconfig.json: not followed here, so not allowed.
    if (existsSync(path.join(nearest, "jsconfig.json"))) {
      throw new Error(`${path.join(nearest, "jsconfig.json")} would apply to the bundle: add it to the fingerprint`);
    }
    const parent = path.dirname(nearest);
    if (parent === nearest) return {};
    nearest = parent;
  }
  const configs: Record<string, string> = {};
  const add = (file: string) => {
    const key = path.relative(dir, file).replaceAll("\\", "/");
    if (key in configs) return;
    const content = readFileSync(file, "utf8");
    configs[key] = content;
    for (const extended of extendsOf(content)) add(resolveExtends(file, extended));
  };
  add(path.join(nearest, "tsconfig.json"));
  return configs;
}

/** A tsconfig's `extends`, one name or a list (TypeScript 5), read past its comments. */
function extendsOf(content: string): string[] {
  const withoutComments = content.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, text) => text ?? "");
  const match = /"extends"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])/.exec(withoutComments);
  if (!match?.[1]) return [];
  const value = JSON.parse(match[1].replace(/,\s*\]$/, "]")) as string | string[];
  return typeof value === "string" ? [value] : value;
}

/** A relative `extends` from `file`, with `.json` added where TypeScript would add it. */
function resolveExtends(file: string, extended: string): string {
  if (!extended.startsWith(".") && !path.isAbsolute(extended)) {
    throw new Error(`${file} extends ${extended}, a package's config: add it to the engine's fingerprint (build.ts)`);
  }
  const resolved = path.resolve(path.dirname(file), extended);
  const isFile = (file: string) => existsSync(file) && statSync(file).isFile();
  if (isFile(resolved)) return resolved;
  if (!resolved.endsWith(".json") && isFile(`${resolved}.json`)) return `${resolved}.json`;
  throw new Error(`${file} extends ${extended}, which isn't there`);
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
    // packages/sim/tsconfig.json's: esbuild ignores its `exclude`, which only keeps tsc off the bundle.
    tsconfigs: collectTsconfigs(enginePaths.bundleSourceDir),
    // packages/sim/package.json for our sources, and the repository's above both ours and the game's (the game's own
    // comes along, though its commit covers it).
    packageJsons: collectPackageJsons([enginePaths.bundleSourceDir, enginePaths.gameRoot], enginePaths.bundleSourceDir),
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

/**
 * Whether `file` is inside `dir` (not `dir` itself). On Windows, case and the separator don't count, as its file system
 * ignores them: a drive or folder written in another case is the same place. `path.win32.relative` compares them so.
 */
export function pathIsUnder(file: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relative = paths.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !paths.isAbsolute(relative);
}

/** A metafile input's path, without its namespace (`raw:`, from gameModules; a drive letter is one letter, kept). */
const inputPath = (input: string) => input.replace(/^[A-Za-z][\w-]+:(?=.)/, "");

/**
 * Our bundled sources' bare imports (`react`, `react-dom`, `react-dom/server`, `lodash`: page.ts) resolved as the
 * game's own sources resolve them, to the game's node_modules only (#267). esbuild walks up from the importer, so from
 * our sources it would try packages/sim/node_modules and the repository's node_modules first: a copy hoisted there by
 * one of our dependencies would be bundled beside the game's, and the fingerprint, which covers only the game's
 * lockfile, wouldn't see it. One that resolves anywhere else, or not at all, fails the build, naming it. `#` imports
 * (package.json `imports`) are left to esbuild; a `browser` map's remap of a bare name no longer applies to our sources.
 *
 * It fails closed: if it misses one of our imports (an importer path esbuild writes differently), the build still
 * fails once it ends, on any file it bundled from a node_modules outside the game's. That needs `metafile: true`.
 */
export function gameDependencies(bundleDir: string, gameRoot: string): esbuild.Plugin {
  return {
    name: "game-dependencies",
    setup(build) {
      // Real paths, as esbuild gives the importer's and the result's (a junctioned directory resolves to its target).
      const ourSourcesRealPath = realpathSync.native(bundleDir);
      const gameSources = path.join(gameRoot, "src");
      const gameNodeModules = path.join(gameRoot, "node_modules");
      // Read once: the game's node_modules is installed before a build (checkVendorInstall), and doesn't move during it.
      const gameNodeModulesRealPath = existsSync(gameNodeModules) ? realpathSync.native(gameNodeModules) : undefined;
      const inGameNodeModules = (file: string) =>
        gameNodeModulesRealPath !== undefined &&
        (pathIsUnder(file, gameNodeModulesRealPath) || pathIsUnder(file, gameNodeModules));
      // Not `#` imports: esbuild resolves those through the importer's package.json `imports`.
      build.onResolve({ filter: /^[^./#]/ }, async (args) => {
        // Our own resolve below, from the game's sources, comes back through here: it's left to esbuild.
        if (args.pluginData?.gameDependencies === true) return undefined;
        if (!pathIsUnder(args.importer, ourSourcesRealPath) || path.isAbsolute(args.path)) return undefined;
        const result = await build.resolve(args.path, {
          kind: args.kind,
          resolveDir: gameSources,
          pluginData: { gameDependencies: true },
        });
        const failure =
          result.errors.length > 0
            ? `can't be resolved from the game's sources (${result.errors[0]?.text})`
            : inGameNodeModules(result.path)
              ? undefined
              : `resolves to ${result.path}, not in the game's node_modules`;
        if (failure !== undefined)
          return { errors: [{ text: `${args.path} (imported by ${args.importer}) ${failure}` }] };
        return { path: result.path, namespace: result.namespace, sideEffects: result.sideEffects };
      });
      build.onEnd((result) => {
        if (result.errors.length > 0) return undefined;
        if (result.metafile === undefined) {
          return {
            errors: [{ text: "game-dependencies checks the bundled files from the metafile: set metafile: true" }],
          };
        }
        const workingDir = build.initialOptions.absWorkingDir ?? process.cwd();
        const outside = Object.keys(result.metafile.inputs)
          .map((input) => path.resolve(workingDir, inputPath(input)))
          .filter((file) => file.split(/[\\/]/).includes("node_modules") && !inGameNodeModules(file));
        if (outside.length === 0) return undefined;
        const listed = outside.slice(0, 5).join(", ") + (outside.length > 5 ? `, and ${outside.length - 5} more` : "");
        return { errors: [{ text: `bundled from outside the game's node_modules: ${listed}` }] };
      });
    },
  };
}

/** The esbuild options of the engine's build. */
export function engineBuildOptions(): esbuild.BuildOptions {
  return {
    entryPoints: [path.join(enginePaths.bundleSourceDir, "entry.ts")],
    outfile: enginePaths.bundle,
    bundle: true,
    format: "cjs",
    // The game is built for the web (webpack `target: "web"`), so dependencies resolve their browser variants.
    platform: "browser",
    target: "es2024",
    define: {
      "process.env.NODE_ENV": '"production"',
      // webpack.config.js injects `git rev-parse --short HEAD` of the game's repo. A short hash's length depends on
      // the clone (CI's shallow one gives 7 characters), so it's fixed at PINNED_GAME's: every clone builds the same
      // engine.
      __COMMIT_HASH__: JSON.stringify(gameGit("rev-parse", `--short=${PINNED_GAME.commit.length}`, "HEAD")),
    },
    loader: Object.fromEntries(assetExtensions.split(" ").map((ext) => [`.${ext}`, "empty" as const])),
    jsx: "transform",
    // gameModules first: its aliases (`crypto`, `monaco-editor`, ...) take those names before gameDependencies.
    plugins: [gameModules(), gameDependencies(enginePaths.bundleSourceDir, enginePaths.gameRoot)],
    sourcemap: "linked",
    // gameDependencies checks the bundled files from it, and buildEngine's report reads it.
    metafile: true,
    logLevel: "error",
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

  const result = await esbuild.build({ ...engineBuildOptions(), metafile: true, write: false });
  if (result.metafile === undefined) throw new Error("esbuild returned no metafile");

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
