# @bitburner-agent/sim

The headless simulator (environment E1): the real Bitburner engine from `vendor/bitburner-src`, bundled for plain Node. When complete, it will run on a virtual clock, deterministic from a seed. Design: [ADR 0007](../../docs/decisions/0007-headless-engine-simulator.md), architecture §9, and the [S1 spike report](../../docs/spikes/s1-headless-engine.md).

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

- **One process per simulation.** `Simulation.start` forks a fresh child process (`src/host/main.ts`), because game state is global. It resolves once the engine is loaded.
- **Requests** go over Node IPC as typed request/response messages (`src/protocol.ts`, `src/rpc.ts`).
  - If the process dies, every pending call rejects with its exit code (or signal) and the last 8 KB of its output.
  - Later calls reject immediately.
- **Nothing happens until `advance(ms)`.** It fires every timer due in the next `ms` virtual milliseconds, in order: the engine's own loop, script timers, everything.
- **`diagnostics`** (`clock()`, `random(n)`, `crash(code, message)`) exist for tests and troubleshooting.

## Determinism

Each simulation process installs its environment in this order (`installHost`, `src/host/install.ts`). The order matters, because the engine reads these while its modules load (e.g. `Engine._lastUpdate` reads `Date`):

1. **DOM** (`installDom`): see below.
2. **Seeded randomness** (`installSeededRandom`):
   - `Math.random` becomes sfc32 seeded from the scenario seed (`src/host/rng.ts`). jsdom's `window` shares Node's `Math`.
   - `crypto.getRandomValues` and `crypto.randomUUID` get a second, independent seeded stream, so drawing crypto bytes doesn't shift `Math.random`.
   - The sfc32 stream is checked against an independent reference implementation and frozen by golden values. Changing it changes every seeded scenario.
3. **Virtual clock** (`installClock`, `@sinonjs/fake-timers`):
   - `setTimeout`/`setInterval` (and their clears), `Date` and `performance` are virtual, starting at `epochMs`. `performance.now()` starts at 0, like a page that just loaded.
   - Microtasks, `process.nextTick` and `setImmediate` stay real, so promises and I/O work.
4. **The engine bundle** (`loadEngine`).
## Inside a simulation process

Host-internal: other packages use `Simulation`. `installHost` runs these steps in order.

**`installDom()`** (`src/host/dom.ts`) installs jsdom globals, plus the two patches from the game's `FixJSDOMEnvironment.ts`:
- **Node's built-ins win.** Where Node already provides a standard API (`Blob`, `URL`, `Event`, `crypto`, `performance`…), Node's is kept; later tasks patch these.
- **Always jsdom's:** `window`, `document`, `navigator`, `localStorage`, `sessionStorage`.
- **`window` follows the globals.** The game uses `window.setTimeout` as well as bare `setTimeout` (the engine loop, `ns.sleep`). So `window.setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`Date`/`performance`/`crypto` resolve to the globals at call time, and the virtual clock and seeded randomness cover both. `requestAnimationFrame` runs on those timers too, not on real time.

**One simulation per process.** Game state is global. The game also starts module-level timers when it loads, so a process that loaded it must exit explicitly rather than waiting for them.

## Known gaps

- **TS/JSX player scripts** aren't supported (the swc stub throws). Our in-game code is plain JS. This will be tracked in the browser-parity audit (`docs/sim/parity.md`, [#28](https://github.com/UnderMyBed/bitburner-agent/issues/28)).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "The game's dependencies are not installed" / "are out of date" | Run `npm run setup:engine`. Needed after a fresh clone and after the submodule's lockfile changes. |
| `ReferenceError: <something> is not defined` while loading the bundle | `installDom()` didn't run before `loadEngine()`. |
| A process that loaded the engine never exits | The game's module-level timers keep it alive. Call `process.exit()` when done. |

## Layout

| Path | What |
|---|---|
| `src/engine/` | Build tooling (`build.ts`, `paths.ts`, `vendor.ts`) and `EngineApi` (`api.ts`) |
| `src/engine/bundle/` | Our sources that get bundled with the game: `entry.ts` and module stubs |
| `src/simulation.ts`, `src/rpc.ts`, `src/protocol.ts` | The parent side: `Simulation`, the RPC client, the message types |
| `src/host/` | Code that runs inside a simulation process: `main.ts` (entry), `install.ts` (setup order), DOM, randomness, clock, engine loading |
| `scripts/` | `setup-engine.ts`, `build-engine.ts` (run by the root `npm run` scripts) |
| `test/` | Unit and integration tests; `global-setup.ts` builds the bundle; `helpers/` run in child processes |
