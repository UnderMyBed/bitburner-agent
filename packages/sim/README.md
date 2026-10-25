# @bitburner-agent/sim

The headless simulator (environment E1): the real Bitburner engine from `vendor/bitburner-src`, bundled for plain Node, running on a virtual clock and deterministic from a seed. Design: [ADR 0007](../../docs/decisions/0007-headless-engine-simulator.md), architecture §9, and the [S1 spike report](../../docs/spikes/s1-headless-engine.md).

> **Status:** being built in milestone M1 ([epic #4](https://github.com/UnderMyBed/bitburner-agent/issues/4)). So far it boots a new game in a child process on a virtual clock, runs player scripts, and is deterministic from a seed. Saves and scenarios follow in later tasks.

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

const sim = await Simulation.start({
  seed: 1,
  epochMs: Date.UTC(2026, 0, 1),
  fixture: { kind: "new", tutorial: "skipped" },
});
await sim.advance(60 * 60_000);    // one virtual hour
console.log(await sim.summary());  // { virtualMs: 3600000, playtimeMs: 3600000, money: …, … }
console.log(await sim.stateHash()); // sha256 of the game's own save
await sim.close();
```

### Process and requests

- **One process per simulation.** `Simulation.start` forks a fresh child process (`src/host/main.ts`), because game state is global.
  - Options travel in an `init` message, not the environment, so large ones (e.g. saves) fit.
  - `start` resolves once the fixture is booted; it fails with the host's reason if setup fails, or after 60 s.
- **Inputs are checked:**
  - `seed` is an unsigned 32-bit integer (wider values would alias).
  - `epochMs` and every `advance(ms)` are non-negative integers. `NaN` or `Infinity` would corrupt or hang the clock.
- **Requests** go over Node IPC as typed messages (`src/protocol.ts`, `src/rpc.ts`).
  - The host runs them **one at a time**. A call made during an `advance` waits for it to finish; otherwise it would see the game part-way through, at a point set by real IPC timing. Each request also waits for script imports to finish (see [the import barrier](#scripts)).
  - If the process ends, or a message can't be delivered, pending and later calls reject. The error has the exit code (or signal) and the last 8,192 characters of the process's combined stdout and stderr.
- **Nothing happens until `advance(ms)`.** It fires every timer due in the next `ms` virtual milliseconds, in order: the engine's own loop, script timers, everything.
- **`close()`** ends the process; pending calls reject. It's safe to call twice.
- **`diagnostics`** exist for tests and troubleshooting:
  - `clock()`: the engine's view of time
  - `game()`: tutorial state, autosave setting, coding contracts, host boot time, default and pinned locale
  - `random(n)`: samples of the seeded streams
  - `crash(code, message)`

### Fixtures

A fixture is the game state a simulation starts from.
- **`{ kind: "new", tutorial }`** boots a new game through the game's own `Engine.load`. It then does what the UI does once mounted: it emits `MainUILoaded`, which starts saved scripts and autoexec.
- **`tutorial` is required.** A new game starts the interactive tutorial, and `"skipped"` ends it as the Skip button does (`iTutorialEnd`). On v3.0.1 a running tutorial stops finished scripts from being cleaned up, so there is no safe default.
- **Autosave is turned off;** the harness takes its own snapshots. This is a deliberate divergence from a real game, which autosaves every 60 s. Each autosave serialises the game (costly at simulation speed) and, as a side effect, draws one `Math.random`. Gameplay doesn't depend on either.
- **`{ kind: "save", bytes | path, offlineMs? }`** loads a save through the game's own `Engine.load`: migration, offline progress, restarting the saved scripts. See [Saves](#saves).
- **Without a fixture** the engine is loaded but no game is booted. That's only useful for testing the harness, and `summary()`/`stateHash()` refuse.

### Saves

```ts
const bytes = await sim.save();                                    // the game's own save: Steam .json.gz bytes
const later = await Simulation.start({ seed: 1, fixture: { kind: "save", bytes, offlineMs: 3_600_000 } });
```

- **`save()`** returns exactly what the Steam build writes (gzip bytes), from the game's own serialiser. Like hashing, it has no side effects on the run.
- **A save fixture takes its epoch from the save.** The parent reads the save's `Player.lastUpdate` before the host starts, and the epoch is that plus `offlineMs` (default 0). The game's real offline-progress path then credits the offline time: income, playtime, and saved scripts' offline production. Passing `epochMs` with a save fixture is refused.
- **Formats:** `.json.gz` bytes (Steam/Electron) or the web build's base64 export, as `bytes` or from a file `path`.
- **The round trip is exact.** With no offline time, save → load → save gives an identical save, field for field, and the saved scripts are running again.
- **IndexedDB.** The game keeps its save in IndexedDB, so the host provides an in-memory one (`fake-indexeddb`, on `window` and the global), holding the loaded save as a browser would. The pre-v3 migration reads its backup from there.
- **Old saves migrate.** A pre-v3 save makes the game export a backup of the old data before migrating it; that download shows up in the event log. CI checks this with a v2.8.1 save from the game's own migration tests.

**Real Steam saves are personal data.** As test fixtures they go in `packages/sim/fixtures-local/`, which is gitignored and never committed. Tests that use them skip, and say so, when there are none. Saves only ever flow one way: Steam saves may become simulator fixtures, and nothing the simulator produces is ever loaded into Steam (architecture §9.4).

### Events

`await sim.events()` returns what the game did that a browser would have shown or done outside the page, in order, with the virtual time (`at`):
- **`download`:** the game started a file download (an `<a download>` click, e.g. a save export or the pre-v3 backup), with the file name and size. jsdom can't navigate, so the host records it instead.
- **`console`:** an error or warning on the console, from the game or a library. It's also written to stderr, so it appears in the output tail if the process dies.

More event kinds (alerts, dialogs, prompts) come with the browser-parity layer ([#47](https://github.com/UnderMyBed/bitburner-agent/issues/47)).

### Scripts

```ts
await sim.writeFile("home", "hack.js", source);                    // as saving it in the editor
const { pid, error } = await sim.run("home", "hack.js", { threads: 3, args: ["n00dles"] });
await sim.advance(60 * 60_000);
await sim.ps("home");   // [{ pid, filename, threads, args }]
await sim.logs(pid);    // log lines, also for recently finished scripts
await sim.kill(pid);    // false if no such script is running
```

- **These wrap the game's own functions.**
  - `run` does what the terminal's `run` does: the same checks (legacy `.script` files, thread count, RAM), pid allocation and failure messages. When the game refuses, `pid` is 0 and `error` holds its message. Unlike the terminal it takes `threads` and `args` directly, with no flag parsing (`--ram-override`, `--temporary` and `--tail` aren't offered).
  - `writeFile` accepts script and text files.
  - `logs` covers running scripts and the game's list of recently finished ones (`Settings.MaxRecentScriptsCapacity`, 50 by default). For any other pid it throws, whereas `kill` returns false.
- **Script modules.** The game imports scripts from `blob:` URLs, which Node can't import.
  - The host captures each script's source when the game creates its Blob, and hands out short `blob:sim/<n>` URLs served by a synchronous module hook (`src/host/scripts.ts`).
  - Other Blobs, e.g. a save export, keep Node's own object URLs.
  - The game revokes a script's URL right after starting its import, relying on browser semantics. So an import in progress keeps its source until it finishes.
- **The import barrier.** Importing a module takes real time, and virtual time must not move meanwhile. Otherwise when a script starts, and everything that follows, would depend on how fast the machine is. The barrier has two layers:
  - Between every two timers the clock fires, it waits until no import is in flight. This covers a script started mid-advance (e.g. by `ns.run`).
  - Before every request it waits too. This covers the request right after `run`.

  Imports also **finish in the order they were requested**: when two scripts start in the same instant, the first one asked for runs first (and takes the first random draws), however long each import really takes.

  Each layer has its own test with a test hook that slows imports down (`testHooks.importDelayMs`). With the barrier switched off (`testHooks.disableImportBarrier`), the slowed run diverges at once. Test hooks are for the simulator's own tests only: with the barrier off, the determinism guarantee doesn't hold.

### State hash and summary

- **`stateHash()`** is the sha256 of the game's own save JSON (`saveObject.getSaveData()`, decoded), plus the positions of the seeded random streams.
  - The save covers everything the game persists: player, servers, scripts and their logs, factions, companies, the stock market, settings…
  - The random positions are added because the save doesn't record them, and two equal saves could still diverge.
  - **Not covered:** the engine's cycle counters and pending timers. Equal hashes mean equal persisted state and randomness, not a byte-identical process.
  - Hashing has no side effects. Serialising the save draws from `Math.random` (the game builds a throwaway `PlayerObject`), so the host restores the random state afterwards.
- **`summary()`** returns a fixed schema (`GameSummary`):
  - `virtualMs` (since start), `playtimeMs`
  - `bitNodeN`, `bitNodeLevel` (the game's own `getBitNodeLevel`), `sourceFiles`
  - `money`, `hackingLevel`, `hackingExp`
  - `homeRamUsed`, `homeRamMax`, `scripts`
  - `augsInstalled`, `augsQueued`

## Determinism

**The guarantee:** the same seed, epoch, fixture and sequence of calls give the same `stateHash()`, whatever the `advance` step sizes, on any machine. `test/new-game.test.ts` checks this, including golden hashes recorded on one OS and verified on another in CI.

Other packages only use `Simulation`; the rest of this section describes the host side. Each simulation process sets itself up in this order (`installHost`, `src/host/install.ts`). The order matters, because the engine reads these while its modules load (e.g. `Engine._lastUpdate` reads `Date`):

1. **Browser environment** (`installDom`, `src/host/dom.ts`): jsdom globals, plus the two patches from the game's `FixJSDOMEnvironment.ts`. Console and download capture for the event log (`src/host/events.ts`) and an in-memory IndexedDB (`src/host/parity/storage.ts`) go in with it.
   - **Node's built-ins win.** Where Node already provides a standard API (`Blob`, `URL`, `Event`, `crypto`, `performance`…), Node's is kept. The later steps patch some of them: `crypto` (step 3), and `Blob`, `URL.createObjectURL` and `URL.revokeObjectURL` (step 4).
   - **Always jsdom's:** `window`, `document`, `navigator`, `localStorage`, `sessionStorage`.
   - **`window` follows the globals.** The game uses `window.setTimeout` as well as bare `setTimeout` (the engine loop, `ns.sleep`). So `window.setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`Date`/`performance`/`crypto` resolve to the globals at call time, and the virtual clock and seeded randomness cover both. `requestAnimationFrame` runs on those timers too, not on real time.
   - **A fixed user agent,** like the Steam build's. The game hashes `navigator.userAgent` into the saved `Player.identifier`, and jsdom's default names the host OS.
2. **Pinned locale and time zone** (`src/host/parity/locale.ts`):
   - Locale-sensitive built-ins called without a locale use `en-US`, because locale-dependent text ends up in saves (e.g. Dark Net logs call `toLocaleTimeString()`). Calls with an explicit locale are unchanged.
   - The time zone is `UTC`, set on the process.
3. **Seeded randomness** (`installSeededRandom`, `src/host/random.ts`):
   - `Math.random` becomes sfc32 seeded from the seed (`src/host/rng.ts`). jsdom's `window` shares Node's `Math`.
   - `crypto.getRandomValues` and `crypto.randomUUID` get a second, independent stream, so drawing crypto bytes doesn't shift `Math.random`. They keep Web Crypto's contract, errors included.
   - The engine itself draws from `Math.random` while it loads, deterministically.
   - The sfc32 stream is checked against an independent reference implementation and frozen by golden values. Changing it changes every seeded scenario.
4. **Script modules** (`installScriptModules`, `src/host/scripts.ts`): the `Blob`/object-URL capture and module hook, plus the import barrier ([Scripts](#scripts)).
5. **Virtual clock** (`installClock`, `@sinonjs/fake-timers`):
   - `setTimeout`/`setInterval` (and their clears), `Date` and `performance` are virtual, starting at `epochMs`. `performance.now()` starts at 0, like a page that just loaded.
   - Microtasks, `process.nextTick` and `setImmediate` stay real, so promises and I/O work.
   - Between timers, the clock yields to the real event loop through the import barrier, so virtual time never moves while a script is loading. This relies on a fake-timers internal; see the comment in `clock.ts`.
   - Timer callbacks run with `this` set to `window`, as in a browser (fake-timers would pass `null`). The game relies on it: `Engine.start` is passed bare to `setTimeout`.
6. **The engine bundle** (`loadEngine`), which then gets the barrier-aware import function (`setScriptImport`).

## Known gaps

- **TS/JSX player scripts** aren't supported (the swc stub throws). Our in-game code is plain JS.
- **The UI router is still the game's pre-mount stub.** Until the headless router lands, messages (`.msg` files, and the `fl1ght.exe` hint) aren't delivered, `Bladeburner.process()` returns early, and `Router.toPage` calls queue up unused.
- **Script modules whose top-level code awaits a timer can't load.** The import barrier holds virtual time until the import finishes, so the timer never fires. In a browser the script would just start late. The host gives up after 30 s of real time, with an error naming the module, rather than hanging.

These are tracked in the browser-parity audit (`docs/sim/parity.md`, [#28](https://github.com/UnderMyBed/bitburner-agent/issues/28)).

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
| `src/simulation.ts`, `src/options.ts`, `src/rpc.ts`, `src/protocol.ts` | The parent side: `Simulation`, option resolution (epoch, reading saves), the RPC client, the message types |
| `fixtures-local/` | Real Steam saves for local-only tests. Gitignored: never commit them |
| `src/host/` | Code that runs inside a simulation process: `main.ts` (entry), `install.ts` (setup order), DOM, randomness, clock, script modules and the import barrier (`scripts.ts`), the event log (`events.ts`), engine loading; `parity/` holds browser-parity fixes (locale pin, IndexedDB) |
| `scripts/` | `setup-engine.ts`, `build-engine.ts` (run by the root `npm run` scripts) |
| `test/` | Unit and integration tests; `global-setup.ts` builds the bundle; `helpers/` run in child processes |
