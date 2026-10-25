# @bitburner-agent/sim

The headless simulator (environment E1): the real Bitburner engine from `vendor/bitburner-src`, bundled for plain Node, running on a virtual clock and deterministic from a seed. Design: [ADR 0007](../../docs/decisions/0007-headless-engine-simulator.md), architecture §9, and the [S1 spike report](../../docs/spikes/s1-headless-engine.md).

> **Status:** being built in milestone M1 ([epic #4](https://github.com/UnderMyBed/bitburner-agent/issues/4)). So far it builds the engine bundle and runs it in a child process on a virtual clock with seeded randomness. Booting a game, scripts, saves and scenarios follow in later tasks.

## Setup

```sh
npm run setup:engine   # once, and again whenever the game submodule is bumped
npm run build:engine   # bundles the engine (also done automatically before tests); add -- --force to rebuild
```

- **`setup:engine`** installs the game's own dependencies from its lockfile, so the simulator runs exactly the versions the game ships with.
  - It runs `npm ci --ignore-scripts` inside `vendor/bitburner-src`, with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`.
  - On success it writes a stamp recording which lockfile it installed (`node_modules/.bitburner-agent-setup.json`).
  - It only writes the submodule's gitignored `node_modules`; tracked files are never touched.
- **`build:engine`** writes three files to `dist/`:

  | File | What |
  |---|---|
  | `engine.cjs` | The bundle |
  | `engine.cjs.map` | Its source map, back to the game's source |
  | `engine.meta.json` | An inputs fingerprint plus a bundle report: size, input count, game files, packages, stubs used |

  - The build is **skipped** when the fingerprint is unchanged. The fingerprint covers the game's commit, any uncommitted changes in it, the game's lockfile, the build code, our bundled sources and the esbuild version.
  - Outputs are written to temporary files and renamed into place, so a concurrent load never sees a half-written bundle.
- **`npm test` needs setup first.** The test runner builds the bundle before any test runs (`test/global-setup.ts`), including tests in other packages. Watch mode doesn't rebuild it: re-run `build:engine` after changing `src/engine/bundle/`.

## How the bundle is built

`src/engine/build.ts` bundles `src/engine/bundle/entry.ts` together with the game's source using esbuild.
- **Target:** the game is built for the **web** (webpack `target: "web"`), so the bundle uses esbuild's browser platform. Dependencies resolve their browser variants, as in the real game.
- **Module mapping:** derived from the game's own `jest.config.js` and `webpack.config.js`.

| Import | Game (Jest / webpack) | Here |
|---|---|---|
| CSS and assets (images, fonts, audio, video) | Mocked in Jest | Empty modules (same extension list as Jest) |
| `@player`, `@enums` | Path aliases | Same aliases |
| `@nsdefs` (the NS type definitions) | Path alias to the `.d.ts` | No mapping needed: its imports are type-only and erased |
| `monaco-editor`, `monaco-vim` | Null mock in Jest | Empty CommonJS module (`stubs/null.cjs`) |
| `*?raw` (documentation pages) | File mock in Jest; text in webpack | **The file's text**, as webpack does |
| `@swc/wasm-web` (transpiles `.ts`/`.jsx` player scripts) | Native `@swc/core` in Jest | **Stub that throws.** See "Known gaps" |
| `crypto` (Node built-in) | `fallback: { crypto: false }` in webpack | Empty module (`stubs/node-builtin.js`), the same |
| `/utils/Protections` | Null mock in Jest | Not needed: the entry never imports `index.tsx`, the only importer |
| `__COMMIT_HASH__` | webpack injects `git rev-parse --short HEAD` | Same value, so `ns.ui.getGameInfo().commit` matches the game |

The entry imports the game's `engine` module, so the bundle contains the whole game and its UI dependencies (React, MUI and so on), about 16 MB. That's harmless at runtime and makes loading the bundle exercise the real module graph.

## Typecheck boundary

`src/engine/bundle/entry.ts` imports the game's source. That source builds under the game's own TypeScript setup (path aliases, JSX, DOM types), so the repo's `tsc` excludes this one file. Everything else here is typechecked as usual.

The entry stays minimal. Its exports must match **`EngineApi`** (`src/engine/api.ts`), the typed interface our code uses; `loadEngine()` checks that at runtime with `assertEngineApi`. `EngineApi` contains functions only.

## Using a simulation

```ts
import { Simulation } from "@bitburner-agent/sim";

const sim = await Simulation.start({ seed: 1, epochMs: Date.UTC(2026, 0, 1) });
await sim.advance(60 * 60_000); // one virtual hour
console.log(await sim.now());   // epochMs + 3,600,000
await sim.close();
```

- **One process per simulation.** `Simulation.start` forks a fresh child process (`src/host/main.ts`), because game state is global.
  - Options travel in an `init` message, not the environment, so large ones (e.g. saves) fit.
  - The child runs with `TZ=UTC`, so local-time formatting reads the same on every machine.
  - `start` resolves once the engine is loaded; it fails with the host's reason if setup fails, or after 60 s.
- **Inputs are checked:**
  - `seed` is an unsigned 32-bit integer (wider values would alias).
  - `epochMs` and every `advance(ms)` are non-negative integers. `NaN` or `Infinity` would corrupt or hang the clock.
- **Requests** go over Node IPC as typed messages (`src/protocol.ts`, `src/rpc.ts`).
  - The host runs them **one at a time**. A call made during an `advance` waits for it to finish; otherwise it would see the game part-way through, at a point set by real IPC timing.
  - If the process ends, or a message can't be delivered, pending and later calls reject. The error has the exit code (or signal) and the last 8,192 characters of the process's combined stdout and stderr.
- **Nothing happens until `advance(ms)`.** It fires every timer due in the next `ms` virtual milliseconds, in order: the engine's own loop, script timers, everything.
- **`close()`** ends the process; pending calls reject. It's safe to call twice.
- **`diagnostics`** (`clock()`, `random(n)`, `crash(code, message)`) exist for tests and troubleshooting.

## Determinism

Other packages only use `Simulation`; this section describes the host side. Each simulation process sets itself up in this order (`installHost`, `src/host/install.ts`). The order matters, because the engine reads these while its modules load (e.g. `Engine._lastUpdate` reads `Date`):

1. **Browser environment** (`installDom`, `src/host/dom.ts`): jsdom globals, plus the two patches from the game's `FixJSDOMEnvironment.ts`.
   - **Node's built-ins win.** Where Node already provides a standard API (`Blob`, `URL`, `Event`, `crypto`, `performance`…), Node's is kept; later tasks patch these.
   - **Always jsdom's:** `window`, `document`, `navigator`, `localStorage`, `sessionStorage`.
   - **`window` follows the globals.** The game uses `window.setTimeout` as well as bare `setTimeout` (the engine loop, `ns.sleep`). So `window.setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`Date`/`performance`/`crypto` resolve to the globals at call time, and the virtual clock and seeded randomness cover both. `requestAnimationFrame` runs on those timers too, not on real time.
2. **Seeded randomness** (`installSeededRandom`, `src/host/random.ts`):
   - `Math.random` becomes sfc32 seeded from the seed (`src/host/rng.ts`). jsdom's `window` shares Node's `Math`.
   - `crypto.getRandomValues` and `crypto.randomUUID` get a second, independent stream, so drawing crypto bytes doesn't shift `Math.random`. They keep Web Crypto's contract, errors included.
   - The engine itself draws from `Math.random` while it loads, deterministically.
   - The sfc32 stream is checked against an independent reference implementation and frozen by golden values. Changing it changes every seeded scenario.
3. **Virtual clock** (`installClock`, `@sinonjs/fake-timers`):
   - `setTimeout`/`setInterval` (and their clears), `Date` and `performance` are virtual, starting at `epochMs`. `performance.now()` starts at 0, like a page that just loaded.
   - Microtasks, `process.nextTick` and `setImmediate` stay real, so promises and I/O work.
4. **The engine bundle** (`loadEngine`).
## Known gaps

- **TS/JSX player scripts** aren't supported (the swc stub throws). Our in-game code is plain JS. This will be tracked in the browser-parity audit (`docs/sim/parity.md`, [#28](https://github.com/UnderMyBed/bitburner-agent/issues/28)).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "The game's dependencies are not installed" / "are out of date" | Run `npm run setup:engine`. Needed after a fresh clone and after the submodule's lockfile changes. |
| "Simulation failed to start" | The host's own error follows. A `ReferenceError: … is not defined` means the browser environment was missing when the engine loaded; use `installHost`, which gets the order right. |
| A process that loaded the engine never exits on its own | The game's module-level timers keep it alive. `Simulation.close()` ends it; other code that loads the engine must call `process.exit()`. |

## Layout

| Path | What |
|---|---|
| `src/engine/` | Build tooling (`build.ts`, `paths.ts`, `vendor.ts`) and `EngineApi` (`api.ts`) |
| `src/engine/bundle/` | Our sources that get bundled with the game: `entry.ts` and module stubs |
| `src/simulation.ts`, `src/rpc.ts`, `src/protocol.ts` | The parent side: `Simulation`, the RPC client, the message types |
| `src/host/` | Code that runs inside a simulation process: `main.ts` (entry), `install.ts` (setup order), DOM, randomness, clock, engine loading |
| `scripts/` | `setup-engine.ts`, `build-engine.ts` (run by the root `npm run` scripts) |
| `test/` | Unit and integration tests; `global-setup.ts` builds the bundle; `helpers/` run in child processes |
