// Bundles the real game engine (vendor/bitburner-src) plus a thin entry module for plain Node.
// Mirrors the module mapping the game's own jest.config.js applies, nothing more.
import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const game = path.resolve(here, "../../vendor/bitburner-src");
const stub = path.join(here, "stubs");

const gamePlugin = {
  name: "game-modules",
  setup(build) {
    // `import x from "./foo.md?raw"`: webpack asset/source, i.e. the file's text.
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
      namespace: "raw",
    }));
    build.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text",
    }));
    const aliases = {
      "@player": path.join(game, "src/Player.ts"),
      "@enums": path.join(game, "src/Enums.ts"),
      // Type-only module (NetscriptDefinitions.d.ts); nothing to load at runtime.
      "@nsdefs": path.join(stub, "empty.js"),
      "monaco-editor": path.join(stub, "null.cjs"),
      "monaco-vim": path.join(stub, "null.cjs"),
      // Only used to transpile .ts/.jsx player scripts; the spike runs plain .js scripts.
      "@swc/wasm-web": path.join(stub, "swc.js"),
    };
    build.onResolve({ filter: /^(@player|@enums|@nsdefs|monaco-editor|monaco-vim|@swc\/wasm-web)$/ }, (args) => ({
      path: aliases[args.path],
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(here, "engine-entry.ts")],
  outfile: path.join(here, "dist/engine.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  // Resolve the game's dependencies from its own lockfile install.
  nodePaths: [path.join(game, "node_modules")],
  define: { "process.env.NODE_ENV": '"production"' },
  loader: {
    ".css": "empty",
    ".png": "empty", ".jpg": "empty", ".jpeg": "empty", ".gif": "empty", ".svg": "empty", ".webp": "empty",
    ".ttf": "empty", ".woff": "empty", ".woff2": "empty", ".mp3": "empty", ".wav": "empty",
  },
  jsx: "transform",
  plugins: [gamePlugin],
  sourcemap: "linked",
  metafile: true,
  logLevel: "warning",
  logOverride: { "unsupported-dynamic-import": "silent" },
});

const inputs = Object.keys(result.metafile.inputs);
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
const packageOf = (p) => {
  const parts = p.split(/node_modules[\\/]/).pop().split(/[\\/]/);
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
};
const deps = new Set(inputs.filter((p) => p.includes("node_modules")).map(packageOf));
console.log(`bundle: ${(bytes / 1e6).toFixed(1)} MB, ${inputs.length} inputs, ${inputs.filter((p) => p.includes("bitburner-src/src")).length} game source files`);
console.log(`packages: ${[...deps].sort().join(", ")}`);
