# @bitburner-agent/sim

The headless simulator (environment E1): the real Bitburner engine from `vendor/bitburner-src`, bundled for plain Node, running on a virtual clock and deterministic from a seed. Design: [ADR 0007](../../docs/decisions/0007-headless-engine-simulator.md), architecture §9, and the [S1 spike report](../../docs/spikes/s1-headless-engine.md).

> **Status:** being built in milestone M1 ([epic #4](https://github.com/UnderMyBed/bitburner-agent/issues/4)). It boots a new game, a save or a BitNode with chosen Source-Files in a child process on a virtual clock. It runs player scripts with a headless UI router, and is deterministic from a seed. Scenario files run across seeds in parallel from the CLI.

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
| `@swc/wasm-web` (transpiles `.ts`/`.jsx` player scripts) | Native `@swc/core` in Jest | **Stub that throws.** See "Differences from a browser" |
| `crypto` (Node built-in) | `fallback: { crypto: false }` in webpack | Empty module (`stubs/node-builtin.js`), the same |
| `/utils/Protections` | Null mock in Jest | Not needed: the entry never imports `index.tsx`, the only importer |
| `__COMMIT_HASH__` | webpack injects `git rev-parse --short HEAD` | Same value, so `ns.ui.getGameInfo().commit` matches the game |

The entry imports the game's `engine` module, so the bundle contains the whole game and its UI dependencies (React, MUI and so on), about 16 MB. That's harmless at runtime and makes loading the bundle exercise the real module graph.

## Typecheck boundary

The files in `src/engine/bundle/` (`entry.ts`, `router.ts`, `page.ts`) import the game's source. That source builds under the game's own TypeScript setup (path aliases, JSX, DOM types), so the repo's `tsc` excludes this folder. Everything else here is typechecked as usual. esbuild only strips types, so nothing typechecks these files: tests are their only guard, so keep them small.

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
  - `epochMs` and every `advance(ms)` are non-negative integers. `NaN` or `Infinity` would corrupt or hang the clock. `epochMs` is required, except with a save fixture, which refuses it; `offlineMs` is a non-negative integer.
  - `prompts` rules each need a non-empty `match` and a text or `true`/`false` answer.
  - A BitNode fixture's `n` and Source-File numbers are 1-15, written as plain integers. Source-File levels are 1-3, except SF12's, which go to 1,000,000.
- **Requests** go over Node IPC as typed messages (`src/protocol.ts`, `src/rpc.ts`).
  - The host runs them **one at a time**. A call made during an `advance` waits for it to finish; otherwise it would see the game part-way through, at a point set by real IPC timing. Each request also waits for script imports to finish (see [the import barrier](#scripts)).
  - If the process ends, or a message can't be delivered, pending and later calls reject. The error has the exit code (or signal) and the last 8,192 characters of the process's combined stdout and stderr.
- **Nothing happens until `advance(ms)` (or `runUntil`).** It fires every timer due in the next `ms` virtual milliseconds, in order: the engine's own loop, script timers, everything.
- **`close()`** ends the process; pending calls reject. It's safe to call twice.
- **`diagnostics`** exist for tests and troubleshooting:
  - `clock()`: the engine's view of time
  - `game()`: tutorial state, autosave setting, the current page and `Player.focus`, the current BitNode's multipliers, exploits earned (always none), whether the game thinks it's under a test runner (always false), coding contracts, host boot time, default and pinned locale
  - `random(n)`: samples of the seeded streams
  - `toPage(page, flume?)` and `back()`: navigate as game code does (see [Pages](#pages-and-the-bitverse)). **Test-only:** they change game state (going to the BitVerse kills every script), and scenarios must not use them.
  - `destroyBitNode(n)`: destroys the current BitNode and enters BitNode `n`, as the BitVerse's portal does after a real destroy, granting the current BitNode's Source-File. **Test-only**, like `toPage`; scenarios use `runUntil`'s `onBitVerse`.
  - `bitNodeMultipliers(n, level)`: the game's own `getBitNodeMultipliers`, for comparison
  - `setHomeRam(gb)`: sets home's RAM (a power of 2 GB). A harness edit, for test and benchmark scenarios (`homeRamGb`).
  - `heap()`: the process's V8 heap in use, in bytes, after a full garbage collection. The collector is reached privately, so `gc` never appears where scripts could see it.
  - `profile("start" | "stop")`: a CPU profile of the process, through the inspector. Stopping returns it (the `.cpuprofile` format). One at a time.
  - `crash(code, message)`

### Fixtures

A fixture is the game state a simulation starts from.
- **`{ kind: "new", tutorial }`** boots a new game through the game's own `Engine.load`.
  - **`tutorial` is required.** A new game starts the interactive tutorial, and `"skipped"` ends it as the Skip button does (`iTutorialEnd`). On v3.0.1 a running tutorial stops finished scripts from being cleaned up, so there is no safe default.
- **`{ kind: "bitnode", n, sourceFiles }`** starts BitNode `n` with the given Source-Files (`{ [BitNode]: level }`, e.g. `{ 4: 3 }`). It boots a new game, sets the Source-Files, and enters the BitNode through the game's own `enterBitNode` (`RedPill.tsx`), as `b1t_flum3.exe` does. That resets everything for the new BitNode without granting a Source-File. The game's own tests set up the same way.
  - **The level** is the BitNode's own Source-File level + 1, capped at 3 except in BitNode 12, as the game's `getBitNodeLevel` computes it. So `{ n: 4, sourceFiles: { 4: 2 } }` is BN4.3, and so is `{ 4: 3 }`.
  - **It is a player with these Source-Files and no other history.** Compared with arriving by a real destroy of BitNode d (the portal's `enterBitNode(false, …)`, from the same Source-Files with SF d one level lower), the saved player and home server are identical, except:
    - A real destroy with SF5 adds 300 intelligence exp, and the first destroy of BN1 shows a congratulation dialog: the flume path does neither (`prestigeSourceFile`'s `isFlume` checks).
    - A real destroy shows the Source-File dialog ("You received a Source-File…"); the fixture's event log has none.
    - What a real player carries between BitNodes starts fresh: intelligence earned in earlier BitNodes, Covenant sleeves and sleeve memory, faction discovery, total playtime, achievements, exploits.
  - **Some fixtures are states no player can reach,** such as BN4 with no Source-Files: `b1t_flum3.exe` needs a Source-File. They're a convenience for tests.
  - **The tutorial is over,** as for anyone entering a BitNode.
  - **BitNode 6** opens on the Bladeburner cinematic; the fixture leaves it as the Continue button does. BitNodes 3, 6, 7, 10 and 13 (and 12 above SF12.100) show the game's welcome dialog 200 ms after entry: it arrives as an `alert` event in the first `advance`.
  - **If entering the BitNode fails,** which puts the game in recovery mode, the simulation fails to start.
- **`{ kind: "save", bytes | path, offlineMs? }`** loads a save through the game's own `Engine.load`: migration, offline progress, restarting the saved scripts. See [Saves](#saves).
- **After loading, every fixture does what the UI does once mounted:** it picks the start page (see [Pages](#pages-and-the-bitverse)) and emits `MainUILoaded`, which starts saved scripts and autoexec. A BitNode fixture does this on its new game, before entering the BitNode, as in a browser, where the UI is already up when a player flumes.
- **For every fixture, autosave is turned off;** the harness takes its own snapshots. This is a deliberate divergence from a real game, which autosaves every 60 s. Each autosave serialises the game (costly at simulation speed) and, as a side effect, draws one `Math.random`. Gameplay doesn't depend on either.
- **Without a fixture** the engine is loaded but no game is booted. That's only useful for testing the harness, and `summary()`/`stateHash()` refuse.

### Saves

```ts
const bytes = await sim.save();                                    // the game's own save: Steam .json.gz bytes
const later = await Simulation.start({ seed: 1, fixture: { kind: "save", bytes, offlineMs: 3_600_000 } });
```

- **`save()`** returns exactly what the Steam build writes (gzip bytes), from the game's own serialiser. Like hashing, it has no side effects on the run.
- **Compression takes no virtual time.** The game gzips with `CompressionStream`, which Node runs on a thread pool in real time, so a script awaiting a save (e.g. `ns.singularity.getSaveData`) would see virtual time move by however long the machine took. The host's stand-in (`src/host/parity/compression.ts`) does the same gzip work synchronously.
- **A save fixture takes its epoch from the save.** The parent reads the save's `Player.lastUpdate` before the host starts, and the epoch is that plus `offlineMs` (default 0). The game's real offline-progress path then credits the offline time: income, playtime, and saved scripts' offline production. Passing `epochMs` with a save fixture is refused.
- **Formats:** `.json.gz` bytes (Steam/Electron) or the web build's base64 export, as `bytes` or from a file `path` (the only form a JSON scenario can use). Plain JSON, or a damaged file, is refused with a message saying so.
- **What loading changes:**
  - A save the simulator made round-trips **exactly**: with no offline time, save → load → save gives an identical save, field for field, and the saved scripts are running again.
  - Any other save gets two settings overridden on load: `AutosaveInterval` (0) and `SuppressAutosaveDisabledWarnings` (true).
  - The game itself changes state on load in places. For example, an IPvGO game where the AI is to move spends 2 of its stored cycles each time it's loaded (`Go/boardAnalysis/goAI.ts`). That's the game's behaviour, not the harness's.
- **IndexedDB.** The game keeps its save in IndexedDB, so the host provides an in-memory one (`fake-indexeddb`, on `window` and the global), holding the loaded save as a browser would. The pre-v3 migration reads its backup from there.
- **Old saves migrate.** A pre-v3 save makes the game export a backup of the old data before migrating it; that download shows up in the event log. CI checks this with a v2.8.1 save from the game's own migration tests.

**Real Steam saves are personal data.** As test fixtures they go in `packages/sim/fixtures-local/`, which is gitignored and never committed. Tests that use them skip, and say so, when there are none. Saves only ever flow one way: Steam saves may become simulator fixtures, and nothing the simulator produces is ever loaded into Steam (architecture §9.4).

### Events

```ts
const { events, next } = await sim.events();   // everything so far
const newer = await sim.events(next);          // only what happened since
```

The log records what the game did that a browser would have shown or done outside the page, in order. Each event has `at`, the virtual time; 0 means it happened while the host was still being set up.
- **`download`:** the game started a file download (an `<a download>` click, e.g. a save export or the pre-v3 backup), with the file name and size. jsdom can't navigate, so the host records it instead.
- **`alert`:** a popup the game raised (`ns.alert`, a message arriving, any `dialogBoxCreate`), as text. React content is rendered to text with the game's theme, and HTML is parsed. The UI drops an alert identical to one still queued; the log keeps every one.
- **`toast`:** a toast (`ns.toast`, achievements, saves…), with its text and `variant`. The UI drops toasts while a page hides messages; the log keeps them.
- **`error`:** an error the game reports in its error popup: a script error, or a promise rejection nobody handled. It has `errorType`, `message`, `host`, `script` and `pid`. Each popup is closed at once, as its Close button does, so every error is reported, repeats included. The exception: a save whose settings suppress error popups gets none, as its player would see none.
- **`prompt`:** an `ns.prompt`, with its `text`, `kind` (boolean, text or select) and `choices`. Also the `answer` a rule gave it, or `null` when nobody answered (`answeredBy`: `"rule"` or `"nobody"`). See [Prompts](#prompts).
- **`console`:** an error or warning on the console, from the game or a library, or an uncaught error, which starts `Uncaught` as a browser logs it. In the game's own loop such an error stops the loop, as in a browser, so a scenario should treat it as a failure.
  - It's also written to stderr, so it appears in the output tail if the process dies.
  - File paths on this machine are replaced by `<repo>`, so the log reads the same everywhere.
  - Node's own process warnings (`(node:<pid>) …`) are left out: they're about the host, not the game.
- **`bitverseReached`:** the game went to the BitVerse page, with `flume` and the `destroyedBitNode`. See [Pages](#pages-and-the-bitverse).
- **`bitnodeDestroyed`:** the game left BitNode `destroyed` for BitNode `entered` by destroying it, through Singularity's `destroyW0r1dD43m0n` or the BitVerse after a backdoor. **`bitnodeFlumed`:** it left BitNode `left` for `entered` without destroying it (b1t_flum3.exe, `b1tflum3`).
  - Both are recorded at the moment the game entered the BitNode: after the timer (and its microtasks), or the request, that did it, whichever way it got there. A BitNode fixture's own entry isn't an event.
  - A destroy is told from a flume by the Source-File: a destroy raises the left BitNode's, a flume doesn't. At its cap (3) both leave the same state, so there a destroy is told by w0r1d_d43m0n, which every destroy backdoors first. Only two flumes into the same BitNode within one virtual ms would go unseen.

The host keeps the most recent 10,000 events. A page reports how many older ones were `dropped`, so a long run of noisy scripts can't grow memory without limit.

The same seed, prompt rules and calls give the same log (`test/page.test.ts`).

### Prompts

There is no player at the screen. By default `ns.prompt` behaves as it would with nobody there, and rules can stand in for a player:

```ts
const sim = await Simulation.start({ seed: 1, epochMs, fixture, prompts: [{ match: "Continue", answer: true }] });
```

- **Rules:** the first rule whose `match` is part of the prompt's text (case-sensitive) answers it at once. The answer must be one a player could give: `true`/`false` for a yes/no prompt, text for a text prompt, one of the `choices` for a select prompt. Any other answer fails the script's `ns.prompt` call, so a mistaken rule shows up.
- **No matching rule:** the prompt stays open and the script waits, as with nobody at the screen. A newer prompt closes it as dismissing does, as in the game: `""` for a text or select prompt, `false` for anything else.
- Every prompt is a `prompt` event.

### Pages and the BitVerse

Game logic reads which page the player is on and navigates between pages. In the browser, `GameRoot` provides that Router when it renders. Headless nothing renders, so the simulator provides a headless router with the same behaviour, bundled with the game (`src/engine/bundle/router.ts`):
- **The start page** follows the save, as the game decides it: the BitVerse if the BitNode is finished, the Work page if work is in progress, otherwise the Terminal. A save the game can't make sense of starts on the Recovery page.
- **Page state and history** are the real router's: game logic sees the current page (Singularity's `isBusy`, `ns.spawn`, Bladeburner, message delivery), and `back()` walks a 10-page history.
- **Side effects** are the real router's: going to the Travel page moves the player to the Travel Agency, leaving the Work page ends focus, and going to the BitVerse kills every script and checks achievements. The Work page also does what its component does: once the work ends, it goes back to the Terminal.
- **The BitVerse** is where a player picks the next BitNode, in the UI. Headless, arriving there records a `bitverseReached` event, also when a save starts there. Then the game waits: navigating there killed every script, and a save that starts there restarts only its saved scripts. What enters the next BitNode is up to the run: see `onBitVerse` in [Running until something happens](#running-until-something-happens). `ns.singularity.destroyW0r1dD43m0n` and `b1tflum3` skip the BitVerse and enter the next BitNode directly.
- **Entering BitNode 6** lands on the Bladeburner cinematic, which only its Continue button leaves. Headless, as with a player who never clicks, the game stays there with messages hidden until something navigates to the Terminal. (A BitNode fixture leaves it, and so does `onBitVerse: { enter: 6 }`.)
- **The page is part of the state hash.** The save doesn't hold it, and it decides what happens next.

The [parity audit](../../docs/sim/parity.md#2-the-router-srcuigameroottsx) lists every router behaviour and its test.

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
  - The host captures each script's source when the game creates its Blob, and hands out short `blob:sim/<n>` URLs served by a synchronous module hook (`src/host/scripts.ts`). Stack frames don't show these URLs: they show the `//# sourceURL=home/<file>` the game appends, as in a browser.
  - Other Blobs, e.g. a save export, keep Node's own object URLs.
  - The game revokes a script's URL right after starting its import, relying on browser semantics. So an import in progress keeps its source until it finishes.
- **The import barrier.** Importing a module takes real time, and virtual time must not move meanwhile. Otherwise when a script starts, and everything that follows, would depend on how fast the machine is. The barrier has two layers:
  - Between every two timers the clock fires, it waits until no import is in flight. This covers a script started mid-advance (e.g. by `ns.run`).
  - Before every request it waits too. This covers the request right after `run`.

  Imports also **finish in the order they were requested**: when two scripts start in the same instant, the first one asked for runs first (and takes the first random draws), however long each import really takes.

  Each layer has its own test with a test hook that slows imports down (`testHooks.importDelayMs`). With the barrier switched off (`testHooks.disableImportBarrier`), the slowed run diverges at once. Test hooks are for the simulator's own tests only: with the barrier off, the determinism guarantee doesn't hold.

### Running until something happens

```ts
const { now, stoppedBy } = await sim.runUntil(24 * 3_600_000, {
  stopWhen: [{ event: "bitnodeDestroyed" }, { summary: { field: "money", op: ">=", value: 1e9 } }],
  onBitVerse: { enter: 2 },
});
```

`runUntil(ms, …)` advances like `advance(ms)`, firing the same timers with the same semantics, so the state is the same however a run is cut up. It goes in steps, to each moment a timer is due, and checks the stop conditions at the start and after each step: a run stops right after the moment a condition first holds, wherever the pieces of a run are cut.
- **Stop conditions** (the first to hold stops the run):
  - `{ event }`: a `bitnodeDestroyed`, `bitnodeFlumed` or `bitverseReached` event. By default, one during this call; `eventsFrom: 0` counts every event since the game booted (a log position, as `EventPage.next`).
  - `{ scriptExited: filename }`: a script with that filename (its full path, as `ps` shows it) has run, and none is running now. A script that hasn't started yet hasn't exited.
  - `{ summary: { field, op, value } }`: a numeric `GameSummary` field (not `virtualMs`: the run's length is `ms`) compared with `<`, `<=`, `==`, `>=` or `>`.
- **`onBitVerse`:** what happens at the BitVerse, where a player picks the next BitNode.
  - `"stop"` ends the run there.
  - `{ enter: n }` enters BitNode `n` at once, as a player clicking its portal would. That destroys the current BitNode, unless the BitVerse was reached by flume, and leaves BitNode 6's cinematic as Continue does.
  - Without it, the game waits at the BitVerse.
- **It fails** (rejects) if the game goes into recovery mode, or the game loop falls behind virtual time by more than `stalledLoopMs` (default 10 s): an uncaught error in the loop stops it, as in a browser, and time would otherwise go on over a frozen game.
- It resolves with the virtual `now` and `stoppedBy`: the index of the condition that held, `"bitverse"`, or `null` if it ran the full time.

### State hash and summary

- **`stateHash()`** is the sha256 of the game's own save JSON (`saveObject.getSaveData()`, decoded), plus the positions of the seeded random streams.
  - The save covers everything the game persists: player, servers, scripts and their logs, factions, companies, the stock market, settings…
  - The random positions and the router's page history are added because the save doesn't record them, and two equal saves could still diverge.
  - **Not covered:** the engine's cycle counters and pending timers. Equal hashes mean equal persisted state and randomness, not a byte-identical process.
  - Hashing has no side effects. Serialising the save draws from `Math.random` (the game builds a throwaway `PlayerObject`), so the host restores the random state afterwards.
- **`summary()`** returns a fixed schema (`GameSummary`):
  - `virtualMs` (since start), `playtimeMs`
  - `bitNodeN`, `bitNodeLevel` (the game's own `getBitNodeLevel`), `sourceFiles`
  - `money`, `hackingLevel`, `hackingExp`
  - `homeRamUsed`, `homeRamMax`, `scripts`
  - `augsInstalled`, `augsQueued`

## Scenarios

Scenario files run a described workload across many seeds in parallel, with per-seed results and an aggregate (the repeatability metric of architecture §9.3):

```
npm run sim -- packages/sim/scenarios/lean.json [--seeds 1..8] [--workers 4] [--json out.json]
```

[docs/sim/scenarios.md](../../docs/sim/scenarios.md) is the reference: the scenario file, stop and fail conditions, results, the aggregate, the CLI, and the workloads in `scenarios/` (lean, batch, churn, copies) mapped to spike S1's measurements.

## Benchmarks

The benchmark measures each workload's speed and the heap over a 7-virtual-day lean run. It appends a row to [docs/sim/benchmarks.md](../../docs/sim/benchmarks.md), unless the row regressed compared with the last row from the same machine (`--accept` records it anyway). It runs before every release and isn't part of CI.

```
npm run bench -w @bitburner-agent/sim [-- --dry-run | --accept]
npm run bench -w @bitburner-agent/sim -- --profile <workload> [--out file.cpuprofile]
```

`--profile` writes a CPU profile of one run (to `.reports/` by default) and prints the functions with the most self time. The benchmarks doc covers what's measured, the regression rules and profiling.

## Determinism

**The guarantee:** the same seed, epoch, fixture, prompt rules and sequence of calls give the same `stateHash()`, whatever the `advance` or `runUntil` step sizes, on any machine. `test/new-game.test.ts` checks this, including golden hashes recorded on one OS and verified on another in CI.

Other packages only use `Simulation`; the rest of this section describes the host side. Each simulation process sets itself up in this order (`installHost`, `src/host/install.ts`). The order matters, because the engine reads these while its modules load (e.g. `Engine._lastUpdate` reads `Date`):

1. **Browser environment** (`installDom`, `src/host/dom.ts`): jsdom globals, plus the two patches from the game's `FixJSDOMEnvironment.ts`. Alongside it, `installHost` also sets up:
   - machine-independent stack traces (first, so every stack read afterwards is normalised), then console capture (so nothing is missed) and download capture, for the event log (`src/host/events.ts`)
   - an in-memory IndexedDB (`src/host/parity/storage.ts`)
   - synchronous gzip streams (`src/host/parity/compression.ts`)
   - no network (`src/host/parity/network.ts`), and uncaught errors raised on `window` as a browser does (`src/host/parity/errors.ts`)
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
   - Timer callbacks run with `this` set to `window`, as in a browser (fake-timers would pass `null`). The game relies on it: `Engine.start` is passed bare to `setTimeout`. An exception a callback throws is logged as uncaught, and the clock carries on; fake-timers would rethrow it.
6. **The engine bundle** (`loadEngine`), after removing `JEST_WORKER_ID` from the environment (the game reads it while loading). Then the page's globals (`installPageGlobals`), the barrier-aware import function (`setScriptImport`), the event listener (`setGameEventListener`) and the prompt rules (`setPromptAnswerer`).

## Browser globals, errors and network

Besides the Router ([Pages](#pages-and-the-bitverse)) and the UI's events, the browser page gives the game and its scripts a few things the simulator reproduces (`src/engine/bundle/page.ts`, `src/host/parity/`, `src/host/scripts.ts`):
- **Globals.** `sprintf`, `vsprintf`, lodash's `_`, `React` and `ReactDOM` are globals for scripts. `window.print` and `window.prompt` throw, as the game makes them. In a browser `window` is the global object; here they are two objects. These globals are one binding either way (accessors on `window`), but a property a script adds later to one isn't on the other.
- **Uncaught errors** are handled as a browser does, and the simulation carries on:
  - A rejected promise nobody handled is raised on `window`. The game's own listener ignores the `ScriptDeath` of killed scripts and reports anything else as an error.
  - An exception nobody caught, in a timer callback, a microtask or an event listener, is logged.
  - A string passed to `setTimeout` is evaluated as code.
  - Both kinds also go to stderr, except a ScriptDeath, so a host bug's error isn't mistaken for only a game one.
- **Stack traces** name repository files as `<repo>/…` with forward slashes, the same on every machine (`src/host/paths.ts`). The game saves some in its crash reports.
- **Offline.** `fetch` fails as with no connection, so `ns.wget` returns false; `XMLHttpRequest`, `WebSocket` and `EventSource` refuse.
- **Imports.** As from a browser's `blob:` modules, scripts can import other scripts and `data:` URLs, and relative paths, bare names and `node:` built-ins don't resolve. `http(s):` URLs fail because the simulation is offline.

## Differences from a browser

Deliberate differences, and the gaps still open:

- **No rendered UI.** Nothing is drawn, so scripts that read the game's page (its DOM: HUD values, buttons) fail headless. That covers parts of the legacy fork and our own `ui` effectors. They're tested on a real browser build instead (environment E2, architecture §9.4).
- **TS/JSX player scripts** aren't supported (the swc stub throws). Our in-game code is plain JS.
- **No windows and no network.** Tail windows don't exist: `getRunningScript().tailProperties` is always `null`, and `ns.ui`'s tail calls do nothing. `ns.ui.windowSize()` is a fixed 1024×768. The simulation is offline ([Browser globals, errors and network](#browser-globals-errors-and-network)).
- **A simulated player at the UI.** Prompt rules answer at once, and error popups are closed at once ([Prompts](#prompts), [Events](#events)).
- **Node's globals are visible to scripts** (`process`, `Buffer`, `setImmediate`), which a browser doesn't have. A gap: [#57](https://github.com/UnderMyBed/bitburner-agent/issues/57).
- **Script modules whose top-level code awaits a timer can't load.** The import barrier holds virtual time until the import finishes, so the timer never fires. In a browser the script would just start late. The host gives up after 30 s of real time, with an error naming the module, rather than hanging.

The [browser-parity audit](../../docs/sim/parity.md) lists every difference from a browser and what the simulator does about it; its [summary](../../docs/sim/parity.md#summary) lists the open gaps and the deliberate differences.

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
| `src/engine/bundle/` | Our sources that get bundled with the game: `entry.ts`, the headless router (`router.ts`), the page's globals and UI capture (`page.ts`), and module stubs |
| `src/scenario/` | Scenario specs (`spec.ts`), the runner and pool (`run.ts`), the CLI's table (`report.ts`) |
| `src/bench/` | Benchmark results as `benchmarks.md` rows and the regression check (`report.ts`), profile summaries (`profile.ts`) |
| `scenarios/` | Workload scenarios (lean, batch, churn, copies) and their scripts |
| `src/simulation.ts`, `src/options.ts`, `src/rpc.ts`, `src/protocol.ts` | The parent side: `Simulation`, option resolution (epoch, reading saves), the RPC client, the message types |
| `fixtures-local/` | Real Steam saves for local-only tests. Gitignored: never commit them |
| `src/host/` | Code that runs inside a simulation process: `main.ts` (entry), `install.ts` (setup order), DOM, randomness, clock, script modules and the import barrier (`scripts.ts`), the event log (`events.ts`), prompt rules (`prompts.ts`), machine-independent paths (`paths.ts`), heap and CPU profile measurement (`measure.ts`), engine loading |
| `src/host/parity/` | Browser-parity fixes: locale pin, IndexedDB, synchronous gzip, uncaught errors and stack traces, no network |
| `scripts/` | `setup-engine.ts`, `build-engine.ts`, `run-scenario.ts` (run by the root `npm run` scripts), `bench.ts` (`npm run bench -w @bitburner-agent/sim`) |
| `test/` | Unit and integration tests; `global-setup.ts` builds the bundle; `helpers/` holds child-process probes and save helpers (decoding, and editing saves into test fixtures) |
