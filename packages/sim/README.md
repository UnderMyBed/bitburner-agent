# @bitburner-agent/sim

The headless simulator (environment E1): the real Bitburner engine from `vendor/bitburner-src`, bundled for plain Node, running on a virtual clock and deterministic from a seed. Design: [ADR 0007](../../docs/decisions/0007-headless-engine-simulator.md), architecture §9, and the [S1 spike report](../../docs/spikes/s1-headless-engine.md).

> **Status:** being built in milestone M1 ([epic #4](https://github.com/UnderMyBed/bitburner-agent/issues/4)). So far it builds the engine bundle and loads it under a headless DOM. The clock, sessions, scripts, saves and scenarios follow in later tasks.

## Setup

```sh
npm run setup:engine   # once, and after the game submodule changes: installs the game's own dependencies
npm run build:engine   # bundles the engine (also done automatically before tests); add -- --force to rebuild
```

- **`setup:engine`** runs `npm ci --ignore-scripts` inside `vendor/bitburner-src`, with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`. It uses the game's own lockfile, so the simulator runs exactly the dependency versions the game ships with. It only writes the submodule's gitignored `node_modules`; tracked files are never touched.
- **`build:engine`** writes `dist/engine.cjs` (the bundle) and `dist/engine.meta.json`.
  - The meta file holds an inputs fingerprint (game commit, build code, entry sources, esbuild version) plus a bundle report: size, input count, game files, packages.
  - The build is skipped when the fingerprint is unchanged.
  - If the game's dependencies are missing, it fails with an error naming `setup:engine`.

## How the bundle is built

`src/engine/build.ts` bundles `src/engine/entry.ts` together with the game's source using esbuild. The module mapping is **derived from the game's own `jest.config.js`**:

| Import | Jest | Here |
|---|---|---|
| CSS, images, fonts, audio | Mocks | Empty modules |
| `@player`, `@enums` | Path aliases | Same aliases |
| `@nsdefs` (the NS type definitions) | Path alias | Empty module (types only, nothing at runtime) |
| `monaco-editor`, `monaco-vim` | Null mock | Empty CommonJS module (`src/engine/stubs/null.cjs`) |
| `*?raw` (documentation pages) | File mock | **The file's text**, as webpack's `asset/source` does |
| `@swc/wasm-web` (transpiles `.ts`/`.jsx` player scripts) | Mapped to native `@swc/core` | **Stub that throws.** Our in-game code is plain JS; TS/JSX player scripts are a documented parity gap |
| `/utils/Protections` | Null mock | Not needed: the entry never imports `index.tsx`, the only importer |

The entry imports the game's `engine` module, so the bundle contains the whole game and its UI dependencies (React, MUI and so on). That's harmless at runtime and makes loading the bundle exercise the real module graph (S1 found about 900 game files).

## Typecheck boundary

`src/engine/entry.ts` imports the game's source. That source builds under the game's own TypeScript setup (path aliases, JSX, DOM types), so the repo's `tsc` excludes this one file. Everything else here is typechecked as usual.

The entry stays minimal. Its exports must match **`EngineApi`** (`src/engine/api.ts`), the typed interface our code uses; `loadEngine()` checks that at runtime with `assertEngineApi`.

## Loading the engine

```ts
import { installDom } from "./src/host/dom.ts";
import { loadEngine } from "./src/host/load-engine.ts";

installDom();               // must come first: the game touches window/document while its modules load
const engine = loadEngine(); // dist/engine.cjs, checked against EngineApi
```

- **`installDom()`** installs jsdom globals, plus the two patches from the game's `FixJSDOMEnvironment.ts`: `adoptedStyleSheets` and `CSSStyleSheet.replaceSync`.
- **Run it in its own process.** Game state is global, so each simulation gets its own process. The game also starts module-level timers when it loads, so a process that loaded it exits explicitly rather than waiting for them.

## Layout

| Path | What |
|---|---|
| `src/engine/` | Build (`build.ts`, `paths.ts`), the bundle entry, `EngineApi`, module stubs |
| `src/host/` | Code that runs inside a simulation process (DOM, engine loading) |
| `scripts/` | `setup-engine.ts`, `build-engine.ts` (run by the root `npm run` scripts) |
| `test/` | Unit and integration tests; `global-setup.ts` builds the bundle before tests run |
