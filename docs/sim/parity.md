# Browser parity audit

The simulator runs the real game headless: Node, jsdom, a virtual clock, no React rendering (architecture §9.1, ADR 0007). The game also relies on things a browser and its mounted UI provide without being asked. This page lists every such thing we found, and what the simulator does about each one.

- **Game version audited:** v3.0.1 (`vendor/bitburner-src` at `1da7316ff`). Citations are `file:line` in that tree unless they start with `packages/`.
- **Re-audit** whenever the pinned version moves. The version-bump steps (#22) include it. Start from the sources in [How the audit was done](#how-the-audit-was-done), and diff them against the previous pin.
- **Dispositions:**
  - **handled**: the simulator reproduces it. The test that proves it is named.
  - **irrelevant**: no effect on game state or on what a script sees, or reachable only through UI clicks or terminal typing, which don't exist headless. The reason is given.
  - **gap**: it behaves differently headless. Each gap has an issue.
  - **by design**: a deliberate difference, documented where users of the simulator will see it.

## Summary

The headless router (§2) was the big gap; this audit's task (#28) closes it. The remaining gaps are all tracked in #47:

| Gap | Effect headless | Issue |
|---|---|---|
| Unhandled promise rejections (§4, 4.1) | **The simulation process crashes.** A real browser swallows a killed script's `ScriptDeath`, e.g. a script that calls `ns.sleep` without `await` and is then killed. | #47 |
| `ns.prompt` has no UI to answer it (§3, 3.1) | A script awaiting `ns.prompt` waits forever | #47 |
| `globalThis.React` / `ReactDOM` not set (§4, 4.3) | Scripts that build React content for `ns.printRaw`, `tprintRaw` or tail titles throw `ReferenceError` | #47 |
| Script realm: `globalThis !== window` (§4, 4.4) | Globals that libraries set on `window` (`sprintf`, lodash `_`) aren't visible to scripts as bare names, and the reverse | #47 |
| `window.prompt` / `window.print` don't throw (§4, 4.5) | jsdom's stubs return `undefined` where the game makes them throw | #47 |
| `ns.wget` does real network I/O (§4, 4.6) | Not reproducible | #47 |
| `JEST_WORKER_ID` in the environment (§4, 4.7) | Would skip Darknet's 6 s migration delay | #47 |
| `node:` imports from player scripts (§8) | A script can import Node built-ins; a browser would refuse | #47 |
| Crash reports name machine paths (§3, 3.4) | `CRASH_REPORT_*.txt` on home holds a stack with local file paths | #47 |
| Tail-window state (§3, 3.8), `ns.ui.windowSize()` (§4, 4.8) | `tailProperties` is always `null`; the window is always 1024×768 | #47 |

Two by-design differences, both listed under "Known gaps" in the [simulator README](../../packages/sim/README.md#known-gaps): no rendered UI (scripts that read the game's page find nothing), and no TS/JSX player scripts.

## 1. Loading and the game loop (`src/engine.tsx`)

| # | What | Disposition |
|---|---|---|
| 1.1 | `Engine._lastUpdate` reads `Date` at module load (`engine.tsx:80`) | **handled**: the clock is installed before the engine loads (`packages/sim/src/host/install.ts`). Test: `simulation.test.ts` ("the engine sees the virtual epoch when its modules load"). |
| 1.2 | `Engine.start` runs on `window.setTimeout` (`engine.tsx:441`) and sets `this.isRunning`, with `this` = `window` (`:416`) | **handled**: `window` timers follow the faked globals (`packages/sim/src/host/dom.ts`); timer callbacks get `this` = `window` (`packages/sim/src/host/clock.ts`). Tests: `dom.test.ts` ("window and globalThis share one set of timers…"); `new-game.test.ts` ("the game runs on the virtual clock…"), which needs the loop to run at all. |
| 1.3 | Offline time = `new Date()` − `Player.lastUpdate` (`engine.tsx:258-264`) | **handled**: follows the virtual clock; a save fixture's epoch is its `lastUpdate` + `offlineMs`. Test: `saves.test.ts` ("the epoch comes from the save; offline time…"). |
| 1.4 | Saved scripts start only on `MainUILoaded` (`engine.tsx:277` → `NetscriptWorker.ts:227-263`), which `GameRoot` emits on mount (`GameRoot.tsx:524`) | **handled**: emitted after boot (`packages/sim/src/engine/bundle/entry.ts`). Test: `saves.test.ts` ("running scripts are restored…"). |
| 1.5 | `?noscript` in `window.location.href` skips loading scripts (`NetscriptWorker.ts:236`) | **handled**: the jsdom URL has no query (`dom.ts`). |
| 1.6 | `startExploits()` timers (`engine.tsx:240` → `Exploits/loops.ts`) | **handled**: see §5. |
| 1.7 | Autosave: IndexedDB, Electron notify, toast (`engine.tsx:225-235`, `SaveObject.ts:235-263`) | **by design**: autosave is off (`AutosaveInterval = 0`, warnings suppressed); the harness snapshots instead. The README says so. IndexedDB itself is provided (§8). |
| 1.8 | `GameCycleEvents` re-render, only if it has subscribers (`engine.tsx:435-439`); the only subscriber is a React hook (`ui/React/hooks.ts:28`) | **irrelevant**: no subscribers headless, so it's skipped, and it has no game-state effect. |
| 1.9 | Offline-summary alert, "new update" dialog, `wv` user-agent dialog spam (`engine.tsx:356-379`, `SaveObject.ts:540-587`) | **irrelevant**: dialogs only (§3); the fixed user agent has no `wv`. |
| 1.10 | A new game runs the interactive tutorial (`engine.tsx:390`), which blocks hacknet purchases and script kills until the tutorial UI advances it | **by design**: every new-game fixture chooses `tutorial: "running"` or `"skipped"`; "skipped" does what the Skip button does. README "Fixtures". Tests: `new-game.test.ts` ("tutorial is required…"), `scripts.test.ts` ("a running tutorial keeps finished scripts…"). |
| 1.11 | `globalThis.Bitburner` (development builds only, `engine.tsx:395-411`); `globalThis.openDevMenu` (`:412`, emits only the April-fools animation) | **irrelevant**: production build in both; no game-state effect. |

## 2. The Router (`src/ui/GameRoot.tsx`)

Game logic reads the current page and navigates. `GameRoot` builds the real Router when it renders (`GameRoot.tsx:246-291`); until then the game has a stub (`:119-150`) that always reports the loading screen, hides messages, and queues navigation with a console error. Headless nothing renders, so without the simulator's own router every page read was wrong and every navigation was dropped.

The simulator's headless router (`packages/sim/src/engine/bundle/router.ts`) takes over at the point `GameRoot` first renders. Page changes are synchronous, as in the real game: React 17's `ReactDOM.render` (`index.tsx:17`) re-renders synchronously when state is set outside a React event handler, which is how game logic and scripts navigate. All tests below are in `packages/sim/test/router.test.ts`, and each fails on the stub.

| # | What | Disposition |
|---|---|---|
| 2.1 | **Page state.** `Router.page()` is read by Singularity's `isBusy` (`NetscriptFunctions/Singularity.ts:587`), `ns.spawn` (`NetscriptFunctions.ts:660`), `Bladeburner.process` (`Bladeburner/Bladeburner.ts:1353`), `Infiltration.cancel` (`Infiltration/Infiltration.ts:224`), the INDECISIVE achievement timer (`Achievements/Achievements.ts:552`) and error display (`ErrorHandling/DisplayError.ts:14`) | **handled**. Tests: "pages change synchronously…", "reaching the BitVerse kills every script, is reported, and game logic sees it" (`isBusy`, `ns.spawn`). Bladeburner reads the same `page()`; it gets a direct test with the BitNode fixtures (#29). |
| 2.2 | **History**: newest first, 10 pages kept (`GameRoot.tsx:99`, `:199-204`); `back()` does nothing with one page left (`:286-288`) | **handled**. Test: "pages change synchronously, with the real router's 10-page history". |
| 2.3 | **Start page** (`determineStartPage`, `GameRoot.tsx:152-173`): Recovery in recovery mode; BitVerse if the BitNode is finished (the w0r1d_d43m0n backdoor); Work if work is in progress; else Terminal | **handled**. Tests: "a new game starts on the Terminal", "a save with work in progress starts on the Work page", "a save whose BitNode is finished starts at the BitVerse…". Recovery mode follows the game's own `RecoveryMode` flag. |
| 2.4 | **Messages hidden** on Recovery, ImportSave, BitVerse, Infiltration, BladeburnerCinematic (`GameRoot.tsx:238-249`). Read by message delivery (`Message/MessageHelpers.tsx:56`) and the autosave warning (`engine.tsx:452`) | **handled**. Tests: "messages are delivered on the Terminal (the stub hides them everywhere)", "…and hides messages there". |
| 2.5 | `toPage(Travel)` moves the player to the Travel Agency (`GameRoot.tsx:253-255`). Reached by `ns.singularity.goToLocation("Travel Agency")` (`Singularity.ts:225-226`) | **handled**. Test: "going to the Travel page takes the player to the Travel Agency". |
| 2.6 | `toPage(BitVerse)` kills every script (`prestigeWorkerScripts`) and checks achievements (`GameRoot.tsx:256-259`). Reached by backdooring w0r1d_d43m0n (terminal `Terminal.ts:274`, `:386`; `ns.singularity.installBackdoor`, `Singularity.ts:552-553`) and `b1t_flum3.exe -q` (`Programs/Programs.ts:317`) | **handled**. Tests: "reaching the BitVerse kills every script…", "arriving at the BitVerse checks achievements straight away". |
| 2.7 | Leaving the Work page ends focus (`GameRoot.tsx:269-275`). Singularity's work functions navigate to Work when focusing and to Terminal when not (`Singularity.ts:289-291` and the like; `setFocus`, `:571-577`) and rely on this to clear `Player.focus` | **handled**. Test: "focused work shows the Work page; leaving it stops focusing, as the real router does". |
| 2.8 | **Arriving at the BitVerse** is where the player picks the next BitNode, through the BitVerse UI (`BitNode/ui/PortalModal.tsx:126` → `enterBitNode`). Nothing headless can click it | **handled**: the router reports a `bitverseReached` sim event with `flume` and the destroyed BitNode, including for a save that starts there. What happens next is the scenario's choice (#30). Tests: as 2.6 and 2.3. Note: `ns.singularity.destroyW0r1dD43m0n` and `b1tflum3` enter the next BitNode directly (`Singularity.ts:1148`, `:1190`) and never visit the BitVerse. |
| 2.9 | `toPage(Options, {tab})` on the Options page emits `GameOptionsPageEvents` (`GameRoot.tsx:260-267`) | **irrelevant**: its only subscriber is the Options page component (`GameOptions/ui/GameOptionsRoot.tsx:48`). |
| 2.10 | `allowRouting(false)` blocks navigation (`GameRoot.tsx:248`, `:251`) | **irrelevant**: only the import-save comparison page calls it (`ui/React/ImportSaveComparison.tsx:117`, `:135`). The headless router keeps the same switch. |
| 2.11 | Navigation before mount is queued and replayed on mount with an error popup (`GameRoot.tsx:117`, `:500-522`) | **irrelevant**: no game logic that runs during `Engine.load` navigates (every `Router.toPage` call site is a script, terminal, UI or prestige path). If one ever did, the stub's `console.error` would appear in the sim event log. |
| 2.12 | Page components' own effects | **irrelevant** for the pages game logic routes to: the BitVerse page's only effect is a 5-minute lore popup (`BitNode/ui/BitverseRoot.tsx:126-140`). Other pages render state; they don't change it. Re-check on every bump. |

## 3. Dialogs, alerts, toasts, prompts and other emitters

The game's `EventEmitter.emit` calls subscribers synchronously and does nothing without any (`utils/EventEmitter.ts:13-21`). Most UI emitters only have React subscribers, so headless they're no-ops. What matters is whether game logic or a script waits on an answer.

| # | What | Disposition |
|---|---|---|
| 3.1 | `ns.prompt` returns a promise that only the prompt modal resolves (`NetscriptFunctions.ts:1367-1373`, `ui/React/PromptManager.tsx:31-40`). Terminal `rm` confirmations work the same way (`Terminal/commands/rm.ts:140-146`) | **gap** (#47): an awaited `ns.prompt` never returns. |
| 3.2 | Terminal coding contracts await a modal (`CodingContract/Contract.ts:158-173`, `Terminal/Terminal.ts:536-600`) | **irrelevant**: terminal only; `ns.codingcontract.attempt` doesn't use it. |
| 3.3 | `dialogBoxCreate` / `AlertEvents` (`ui/React/DialogBox.tsx`, `ui/React/AlertManager.tsx`): about 200 call sites, including `ns.alert` and every message | **irrelevant** to game state (no caller reads a result). Capturing the text in the event log is #47. |
| 3.4 | `exceptionAlert` also writes `CRASH_REPORT_<time>.txt` to home, with the error's stack (`utils/helpers/exceptionAlert.tsx:12-29`) | **gap** (#47): the stack names this machine's file paths, so the saved state can differ between machines. Only when an exception alert fires. |
| 3.5 | Toasts (`SnackbarEvents`, `ui/React/Snackbar.tsx`): `ns.toast`, achievements, exploits, hospitalisation, saves | **irrelevant**: state changes before the toast. |
| 3.6 | Faction invitations (`Faction/FactionHelpers.tsx:25-33`, `Faction/ui/FactionInvitationManager.tsx`) | **irrelevant**: the invitation is recorded before the event; the modal's Join only calls `joinFaction`. Headless equals a player who never clicks Join; the agent joins through `ns.singularity.joinFaction`. |
| 3.7 | `BitFlumeEvent` (`run b1t_flum3.exe` without `-q`, `Programs/Programs.ts:320`) | **irrelevant**: terminal only; its modal's button navigates to the BitVerse (§2). |
| 3.8 | Tail windows (`ui/React/LogBoxManager.tsx`) set `RunningScript.tailProps` (`:191`) | **gap** (#47, minor): `getRunningScript().tailProperties` is always `null`, and `ns.ui` tail resize/move/render calls do nothing. |
| 3.9 | UI-only re-render emitters: `GoEvents`, `StaneksGiftEvents`, `DarknetEvents`, `TerminalEvents`, `ITutorialEvents`, `OverviewEventEmitter`, `KeyBindingEvents`, `EditorEvents`, `GameOptionsPageEvents`, `ThemeEvents`, `Apr1Events`, `ErrorState.ErrorUpdate`, `DocumentationPopUpEvents`, `RemoteFileApiConnectionEvents`, `Infiltration.updateEvent` | **irrelevant**: re-render only. |
| 3.10 | Module-level subscribers that do run headless: number formats (`ui/formatNumber.ts:30-47`), gang upgrade text (`Gang/GangMemberUpgrade.ts:18`), infiltration's hospitalisation hook (`Infiltration/Infiltration.ts:82-88`) | **handled**: they run as in the browser; formats follow the pinned locale (§8). Infiltration can't start without the UI. |

## 4. Globals and the script realm

`src/index.tsx` isn't bundled; the simulator's entry imports the engine directly. So nothing in it runs: Protections, Electron set-up, the `globalThis.React` assignment, the `window.print`/`window.prompt` overrides, the theme re-render, the Remote API connection.

| # | What | Disposition |
|---|---|---|
| 4.1 | The game handles unhandled promise rejections with a `window` `unhandledrejection` listener that ignores `ScriptDeath` (`engine.tsx:241` → `UncaughtPromiseHandler.ts:3-8`, `utils/ErrorHandler.ts:10-13`) | **gap** (#47): Node never raises that event on the jsdom window, and the host has no process handler, so Node's default ends the process. Seen: a script that calls `ns.sleep` without `await` crashes the simulation. |
| 4.2 | `utils/Protections.ts`: makes `Number`, `Object`, `String` and the IndexedDB globals read-only (`index.tsx:1`) | **irrelevant** to correct scripts; headless a script *could* overwrite them. Our code doesn't. |
| 4.3 | `globalThis.React`, `globalThis.ReactDOM` (`index.tsx:15-16`), used by scripts for `printRaw`/`tprintRaw`/tail titles | **gap** (#47). |
| 4.4 | In a browser `globalThis === window`. Headless, `window`, `document`, `navigator` and storage on `globalThis` are jsdom's, but `globalThis` itself is Node's (`packages/sim/src/host/dom.ts`). Libraries that set globals on `window` while loading therefore don't reach scripts' bare names: sprintf-js's `sprintf`/`vsprintf`, and lodash's `_` (webpack's AMD path), which spike S1 found the legacy fork uses | **gap** (#47). |
| 4.5 | `window.print` and `window.prompt` throw a "you meant ns.print/ns.prompt" error (`index.tsx:60-70`) | **gap** (#47, minor): jsdom's stubs return `undefined`. |
| 4.6 | `ns.wget` uses `fetch` (`NetscriptFunctions.ts:1375-1390`) | **gap** (#47): Node's real `fetch` is kept, so it reaches the network. |
| 4.7 | `CONSTANTS.isInTestEnvironment` reads `process.env.JEST_WORKER_ID` (`Constants.ts:9`); when set, `ns.dnet.induceServerMigration` skips its delay (`NetscriptFunctions/Darknet.ts:444`) | **gap** (#47): `process` doesn't exist in a browser; the host must make sure the variable isn't set. |
| 4.8 | `ns.ui.windowSize()` (`NetscriptFunctions/UserInterface.ts:121-123`) | **gap** (#47, minor): jsdom's fixed 1024×768. |
| 4.9 | `Player.identifier` hashes `Date`, the user agent, the window size and `Math.random` (`PersonObjects/Player/PlayerObject.ts:160-167`); `ns.ui.getGameInfo().platform` reads the user agent (`UserInterface.ts:179-186`) | **handled**: deterministic (virtual `Date`, the fixed Steam user agent, seeded randomness), and the platform reads "Steam". Tests: `dom.test.ts` ("the user agent is fixed…"), `simulation.test.ts` ("randomness in the host is the seeded stream…"). |
| 4.10 | `document`/`window` in a script's source cost RAM (`Script/RamCalculations.ts:185-192`) | **handled**: pure source analysis, unchanged. |
| 4.11 | Electron bridge calls during saves and achievements (`Electron.tsx:171-216`) | **irrelevant**: each returns early without `window.electronBridge`. |

## 5. Exploits (`src/Exploits/`)

Exploits are saved state with a gameplay effect (`Exploits/applyExploits.ts`), so a simulator that triggered one by accident would change results.

| Exploit | Detection | Disposition |
|---|---|---|
| TimeCompression | `performance.now()` deltas between 15 s timers (`Exploits/loops.ts:15-31`) | **handled**: `performance` and the timers share the virtual clock, so 15 s of virtual time reads as 15 s. It would fire if `performance` stayed real while timers ran fast. The no-exploits test is #47. |
| PrototypeTampering | `(55).toExponential()` every 15 min (`loops.ts:4-13`) | **handled**: virtual `setInterval`; fires only if a script really patches `Number.prototype`. |
| Bypass | `ns.bypass(document)` (`NetscriptFunctions/Extra.ts:21-37`) | **handled**: the script's `document` is the game's (one jsdom). |
| UndocumentedFunctionCall, INeedARainbow, EditSaveFile | Script calls or the save itself | **handled**: no browser involved. |
| Unclickable, N00dles, YoureNotMeantToAccessThis, TrueRecursion, RealityAlteration | Mounted components, trusted clicks, iframes, a debugger | **irrelevant**: can't happen headless (and the dev menu is forbidden anyway). |

## 6. Randomness and time

| # | What | Disposition |
|---|---|---|
| 6.1 | `Math.random` and Web Crypto | **handled**: two seeded streams (`packages/sim/src/host/random.ts`). Tests: `random.test.ts`; `new-game.test.ts` ("seeded randomness drives the game…"). |
| 6.2 | `WHRNG` seeded from `Player.totalPlaytime`: IPvGO AI moves, cheats and board obstacles (`Go/boardAnalysis/goAI.ts:184`, `Go/effects/netscriptGoImplementation.ts:512`, `Go/boardState/offlineNodes.ts:13`) | **handled**: playtime advances only with game cycles, which run on the virtual clock. |
| 6.3 | `SFC32RNG("BN<n>.<lvl>")` for the gang faction's augmentation list (`Faction/FactionHelpers.tsx:185`); Darknet King-of-the-Hill from the server password (`DarkNet/effects/authentication.ts:218`) | **handled**: pure functions of game state. |
| 6.4 | Unstable Circadian Modulator bonus from the current hour (`Augmentation/CircadianModulator.ts:113`), at module load and on each reset | **handled**: reads the virtual `Date`. Different `epochMs` values can give different bonuses, so it's part of the scenario's inputs. |
| 6.5 | Wall-clock gates: stock-market ticks (`StockMarket/StockMarket.ts:247-250`), Darknet timers, offline script income (`Script/ScriptHelpers.ts:20`), file and save timestamps | **handled**: virtual `Date` advances with the cycles. |
| 6.6 | Casino RNGs seeded from `Date` (`Casino/RNG.ts:9-34`, `Casino/Roulette.tsx:110`) | **irrelevant**: casino games are UI only. |
| 6.7 | Loading a save where the IPvGO AI is to move spends 2 of its stored cycles each time (`Go/boardAnalysis/goAI.ts`) | **handled**: this is the game's own load path, not the harness. Documented in the README ("what loading changes"). |

## 7. Other browser reads in game logic

A search of game logic (outside `ui/`) for `localStorage`, `matchMedia`, `visibilityState`, `hasFocus` and `requestAnimationFrame` finds nothing that changes state. The rest:

| # | What | Disposition |
|---|---|---|
| 7.1 | `exportGame` (also `ns.singularity.exportGame`) applies the export bonus, then downloads through an `<a download>` click (`SaveObject.ts:277-289`, `utils/FileUtils.ts`) | **handled**: the bonus is game logic; the download becomes a `download` sim event. Test: `saves.test.ts`. |
| 7.2 | IndexedDB save, load and delete (`db.ts`) | **handled**: in-memory IndexedDB (`packages/sim/src/host/parity/storage.ts`). Test: `saves.test.ts`. |
| 7.3 | `CompressionStream` decides gzip versus base64 saves (`utils/SaveDataUtils.ts:15`) | **handled**: synchronous gzip streams (`packages/sim/src/host/parity/compression.ts`). Test: `saves.test.ts`. A browser compresses asynchronously, in real time; here it takes no virtual time. Only the save's own completion moves, and nothing in game state depends on when a save finishes. |
| 7.4 | The FROZE achievement reads `location.href` (`Achievements/Achievements.ts:249-253`); `location.reload()` after an import (`SaveObject.ts:335`) | **handled** / **irrelevant**: the URL is a normal launch's; imports are UI only. |
| 7.5 | `navigator.language` (documentation language), user agent for key labels and error reports | **irrelevant**: text only. |

## 8. The simulator's own parity layer

What the host provides so the above works. Each is in `packages/sim/src/host/`.

| What | Where | Test |
|---|---|---|
| jsdom globals, plus the game's two jsdom patches (`adoptedStyleSheets`, `replaceSync`, from its `FixJSDOMEnvironment.ts`) | `dom.ts` | `dom.test.ts` |
| Node's built-ins kept over jsdom's (`Blob`, `URL`, `Event`, `crypto`, `performance`), so `blob:` modules and timers work | `dom.ts` | `dom.test.ts`, `scripts.test.ts` ("only script Blobs become simulated modules…") |
| `window` timers, `Date`, `performance` and `crypto` follow the globals; `requestAnimationFrame` runs on virtual timers | `dom.ts` | `dom.test.ts` |
| Fixed Steam user agent | `dom.ts` | `dom.test.ts` |
| Timer callbacks run with `this` = `window` | `clock.ts` | `new-game.test.ts` ("the game runs on the virtual clock…") |
| Default locale pinned to `en-US`; `TZ=UTC` | `parity/locale.ts`, `src/simulation.ts` | `locale.test.ts`, `locale-case.test.ts`, `new-game.test.ts` |
| In-memory IndexedDB | `parity/storage.ts` | `saves.test.ts` |
| Synchronous gzip streams | `parity/compression.ts` | `saves.test.ts` |
| `blob:` script modules: revoke-after-import, imports complete in order, the import barrier | `scripts.ts` | `scripts.test.ts` |
| `MainUILoaded` after boot; the headless router | `src/engine/bundle/entry.ts`, `router.ts` | `saves.test.ts`, `router.test.ts` |
| React's scheduler uses the real `setImmediate` | none needed | **irrelevant**: no React tree is rendered (`ReactDOM.render` never runs) |
| The game's `moduleCache` holds modules by `WeakRef` (`NetscriptJSEvaluator.ts`), so whether rewriting a file back to old content recompiles depends on garbage collection | none needed | **irrelevant** to results: imports complete in order regardless (`scripts.test.ts`) |
| Script modules that `await` a timer at top level can't load (the barrier holds virtual time) | `scripts.ts` watchdog fails loudly after 30 s real time | **by design**; README "Known gaps" |
| Player scripts can import `node:` built-ins | `scripts.ts` resolve hook | **gap** (#47) |
| TS/JSX player scripts (the game's swc is stubbed) | `src/engine/bundle/stubs/swc.js` | **by design**; README "Known gaps" |

## How the audit was done

Read in full: `src/index.tsx`, `src/ui/GameRoot.tsx`, `src/engine.tsx`, `src/Exploits/`. Then searched the game's source for:
- every `UIEventEmitter` subscriber, and every `Router.` call
- the dialog, alert, toast and prompt emitters, and every other `EventEmitter` with a subscriber outside React
- reads of and writes to `window`, `globalThis`, `document`, `navigator`, `location` and browser storage outside `ui/`
- `WHRNG`, `SFC32RNG`, seeds, `Date` and `playtime` in random-number and gating code
