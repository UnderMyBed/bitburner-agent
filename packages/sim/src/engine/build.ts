// Builds dist/engine.cjs: the game's source plus entry.ts, bundled for plain Node (ADR 0007).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { enginePaths } from "./paths.ts";

export interface EngineInputs {
  vendorCommit: string;
  buildScript: string;
  /** Path (relative to src/engine) → content. */
  entrySources: Record<string, string>;
  esbuildVersion: string;
}

export interface BundleReport {
  bytes: number;
  inputs: number;
  gameFiles: number;
  packages: string[];
}

export interface BuildResult {
  skipped: boolean;
  fingerprint: string;
  report?: BundleReport;
}

export function engineFingerprint(inputs: EngineInputs): string {
  const sources = Object.keys(inputs.entrySources)
    .sort()
    .map((name) => [name, inputs.entrySources[name]]);
  return createHash("sha256")
    .update(JSON.stringify([inputs.vendorCommit, inputs.buildScript, sources, inputs.esbuildVersion]))
    .digest("hex");
}

export function checkVendorInstall(gameRoot: string = enginePaths.gameRoot): void {
  if (!existsSync(path.join(gameRoot, "node_modules", "react"))) {
    throw new Error(`The game's dependencies are not installed in ${gameRoot}. Run: npm run setup:engine`);
  }
}

function currentInputs(): EngineInputs {
  const entrySources: Record<string, string> = {};
  for (const name of readdirSync(enginePaths.engineDir, { recursive: true, encoding: "utf8" })) {
    const file = path.join(enginePaths.engineDir, name);
    if (!existsSync(file) || !/\.(ts|js|cjs)$/.test(name)) continue;
    entrySources[name.replaceAll("\\", "/")] = readFileSync(file, "utf8");
  }
  return {
    vendorCommit: execFileSync("git", ["-C", enginePaths.gameRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    buildScript: readFileSync(import.meta.filename, "utf8"),
    entrySources,
    esbuildVersion: esbuild.version,
  };
}

/**
 * Module mapping derived from the game's jest.config.js, with these differences (see packages/sim/README.md):
 * `?raw` imports load as text (Jest uses a file mock), and @swc/wasm-web is stubbed (Jest maps it to @swc/core).
 */
function gameModules(gameRoot: string): esbuild.Plugin {
  const stubs = path.join(enginePaths.engineDir, "stubs");
  const aliases: Record<string, string> = {
    "@player": path.join(gameRoot, "src/Player.ts"),
    "@enums": path.join(gameRoot, "src/Enums.ts"),
    "@nsdefs": path.join(stubs, "empty.js"),
    "monaco-editor": path.join(stubs, "null.cjs"),
    "monaco-vim": path.join(stubs, "null.cjs"),
    "@swc/wasm-web": path.join(stubs, "swc.js"),
  };
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
      build.onResolve({ filter: /^(@player|@enums|@nsdefs|monaco-editor|monaco-vim|@swc\/wasm-web)$/ }, (args) => ({
        path: aliases[args.path],
      }));
    },
  };
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
  checkVendorInstall();
  const fingerprint = engineFingerprint(currentInputs());
  if (!force && existsSync(enginePaths.bundle) && existsSync(enginePaths.meta)) {
    const meta = JSON.parse(readFileSync(enginePaths.meta, "utf8")) as { fingerprint?: string };
    if (meta.fingerprint === fingerprint) return { skipped: true, fingerprint };
  }

  const empty = Object.fromEntries(
    ["css", "png", "jpg", "jpeg", "gif", "svg", "webp", "ttf", "woff", "woff2", "mp3", "wav"].map((ext) => [
      `.${ext}`,
      "empty" as const,
    ]),
  );
  const result = await esbuild.build({
    entryPoints: [path.join(enginePaths.engineDir, "entry.ts")],
    outfile: enginePaths.bundle,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node24",
    nodePaths: [path.join(enginePaths.gameRoot, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: empty,
    jsx: "transform",
    plugins: [gameModules(enginePaths.gameRoot)],
    sourcemap: "linked",
    metafile: true,
    logLevel: "error",
  });

  const inputs = Object.keys(result.metafile.inputs);
  const report: BundleReport = {
    bytes: Object.entries(result.metafile.outputs).find(([file]) => file.endsWith("engine.cjs"))?.[1].bytes ?? 0,
    inputs: inputs.length,
    gameFiles: inputs.filter((p) => p.includes("bitburner-src/src/")).length,
    packages: [...new Set(inputs.filter((p) => p.includes("node_modules")).map(packageOf))].sort(),
  };
  mkdirSync(path.dirname(enginePaths.meta), { recursive: true });
  writeFileSync(enginePaths.meta, `${JSON.stringify({ fingerprint, report }, null, 2)}\n`);
  return { skipped: false, fingerprint, report };
}
