# @bitburner-agent/e2

Environment E2 (architecture §9.4): the game built from `vendor/bitburner-src` at the pinned commit, served on 127.0.0.1 and driven by Playwright. It covers what the simulator can't show: the rendered UI, and the page's real network, storage and reload ([#96](https://github.com/UnderMyBed/bitburner-agent/issues/96)).

> **Status:** built in M2 ([v0.2.0](https://github.com/UnderMyBed/bitburner-agent/releases/tag/v0.2.0)): the source build, the Playwright harness, its fixtures and the game clock ([#96](https://github.com/UnderMyBed/bitburner-agent/issues/96)), and the walking skeleton's tests on it ([#97](https://github.com/UnderMyBed/bitburner-agent/issues/97)).

E2 is a heavy tier. Run it on demand when `ingame/` or `bridge/` change, and before every release ([releasing](../../docs/releasing.md) step 2; architecture §9.3, ADR 0004). It isn't part of `npm test` or CI.

## Running it

```
npm run bootstrap      # once: the submodule, npm ci and the game's own dependencies (packages/sim uses them too)
npm run e2:build       # once per pinned commit
npm run e2:install     # once: Playwright's Chromium headless shell
npm run e2             # all E2 tests; npm run e2 -- clock runs the files whose names match
```

- The whole suite takes several minutes on the reference rig (36 tests; the skeleton's five and the effectors' twenty-three start a brain each, which builds the in-game code; `test/effectors.e2.test.ts` alone takes about 4 min). The first `npm run e2` also builds the simulator's engine bundle, through the simulator's global setup, so it takes longer.
- On Linux, Chromium may need system libraries: `npx playwright install-deps chromium`.
- E2 builds and downloads go under the repository's gitignored `.cache/e2/`, so deleting that folder undoes `e2:build` and `e2:install`. The exception is babel's cache, which the game's webpack config keeps in the submodule's gitignored `node_modules/.cache/`. Builds of earlier commits stay there, about 117 MB each, until you delete them.

### `npm run e2:build`

It builds the game with its own webpack config in production mode into `.cache/e2/<commit>/`: `index.html`, and the bundles in `dist/`.
- **The pinned game only.** It builds the commit this repository pins (its gitlink), and refuses a submodule with another commit checked out.
- **Its dependencies must be current.** It refuses them if `npm run setup:engine` hasn't installed the game's current lockfile (the simulator's own check).
- **Cached by commit and inputs.** It's skipped when that commit is built already from the same inputs: the game's lockfile and this package's build code (`src/build.ts`, `src/webpack-config.ts`, `scripts/run-game-webpack.ts`). A change to any of them builds again. A `built.json` written last marks a finished build and its inputs, so a build that stopped part way is redone.
- **The submodule stays clean.** It refuses a submodule with changes, since they'd be built in. Afterwards it compares `git status --porcelain --ignored` (without `node_modules`, where babel's cache goes) and fails if the build added anything. Ignored files count: the game's .gitignore ignores exactly what a build would write there.
- **The game's committed `dist/` files** (achievement icons, favicons, the web manifest) are copied in after webpack, as Steam's build copies the whole folder.
- **It runs from the submodule**, through `scripts/run-game-webpack.ts`. The game's config reads the commit with `git rev-parse` and takes its entry and template relative to the working directory. The build shows the pinned commit, `1da7316ff`. Steam's build shows the v3.0.1 tag's commit, `3162fd2`, which has the same source (#128). It doesn't use the game's `npm run build`, which runs `bash ./tools/build.sh` and isn't portable to Windows.
- **Three changes to the config** (`src/webpack-config.ts`), none to what it builds:
  - the output goes outside the submodule;
  - the minifier runs on one core. By default it uses every core but one, and this machine's test runs keep to one core. Its options otherwise stay webpack's defaults (two compress passes);
  - the separate typecheck process is dropped. The pinned game's types are upstream's business; ours are checked by `npm run typecheck`.

  The webpack CLI can set the output path, but not the other two, hence a config.
- **Time on the reference rig:** 88–89 s from start to exit, of which webpack took 80–87 s.

### `npm run e2:install`

It downloads Playwright's Chromium headless shell into `.cache/e2/browsers/`, not the user's profile. The E2 Vitest config points Playwright there (`PLAYWRIGHT_BROWSERS_PATH`).

- **Why Playwright 1.59.1 and its Chromium 147:** Steam's Bitburner runs Electron 41, which is Chromium 146. No Playwright release ships 146, and 1.59's 147.0.7727.15 is the closest.
- **Why the headless shell:** the tests never need a visible window. To watch one while debugging, install full Chromium (`npx playwright install chromium`, with the same `PLAYWRIGHT_BROWSERS_PATH`) and launch with `headless: false`.

### `npm run e2`

It runs `test/**/*.e2.test.ts` under `vitest.config.ts`, from the repository root: one file at a time, one browser, with the simulator's global setup, since the simulator makes the saves the tests load. The root Vitest config excludes `*.e2.test.ts`.

The package's other tests (`test/*.test.ts`: the static server, the build's checks, the webpack config) need no browser and run with `npm test` in CI.

## Fixtures

`src/game.ts`, with `test/helpers/environment.ts`'s `useE2()` for the browser and server of a test file, and `test/helpers/saves.ts` for saves:

| Fixture | What |
|---|---|
| `launchBrowser()` | Playwright's Chromium headless shell. On any launch failure, its error suggests `npm run e2:install` |
| `serveGame(root)` (`src/server.ts`) | The built game on `http://127.0.0.1:<random port>`, GET only. It also serves a blank page on the same origin (`BLANK_PAGE_PATH`), for writing a save before the game loads |
| `gameFromSave(browser, server, save, { offlineMs, clockDuringLoad })` | A page in a new browser context with the save in its IndexedDB, loaded to the Terminal. `save` is the gzip bytes, exactly what Steam writes to disk; it goes into `bitburnerSave` v2, store `savestring`, key `save` (`vendor/bitburner-src/src/db.ts`). Game time starts at the save's own `lastUpdate` plus `offlineMs` (default 0: no offline progress), as the simulator's save fixture does |
| `freshGame(browser, server, { startTimeMs })` | A brand-new game: an empty context, 8 GB of home RAM, and the tutorial running |
| `exitTutorial(page)` | Clicks "Exit Tutorial" and waits for the tutorial to close |
| `waitForTerminal(page)`, `TERMINAL_INPUT` | The game loaded: its terminal input is on the page |
| `advanceGameTime(page, ms)`, `advanceUntil(page, condition, { realTimeoutMs, gameTimeoutMs })` | Game time, below |
| `typeCommand(page, command)`, `terminalText(page)` | Types a command into the terminal (focusing the input, not clicking it) and presses Enter; the terminal's output so far |
| `closeGame(page)` | Closes the page's browser context |
| `simulatorSave({ gameSettings, prepare })`, `moneyInSave(save)`, `withMoney(save, money)` (`test/helpers/saves.ts`) | A save from the simulator: a new game, with `prepare` writing files, running scripts, moving time or making a harness edit (`diagnostics.joinFactionWithReputation`, #149) first, and `gameSettings` (the Remote API's address and port, autoexec) saved in it, with the game's default autosave (every 60 s) on; `withMoney` gives a save's player that much money |

- **Saves come from the simulator.** That's allowed: saves only flow from Steam into test environments, never back.
- **The game's settings live in the save**, so a test sets the RFA port or autoexec by making the save with them.
- **Reloads aren't blocked.** A production build over `http` asks before unloading (`vendor/bitburner-src/src/index.tsx:53-58`), and the browser shows that prompt once the page has been used (typed in, clicked). With no dialog listener, Playwright's own navigations go through it. `test/game.e2.test.ts` checks the prompt is armed, then reloads. A test that adds a `dialog` listener must accept that prompt itself.
- **A load that fails says why.** If the game doesn't load (in `gameFromSave`, `freshGame`, or `waitForTerminal` after a reload), the error adds:
  - the page's visible text, up to 1,500 characters, or why it couldn't be read (a timeout means a hung page);
  - what the page went through: navigations, page and console errors, failed requests and a crash (the first 5 and last 20);
  - the requests still pending, since a load stuck on a fetch logs nothing else.
- **The page's origin is `http://127.0.0.1:<port>`**, not Steam's `file://`. A brain under test allows it in its config (#87).

## Game time

Playwright's clock is installed in each browser context before the page loads, and paused at the start time. It fakes the page's `Date`, `performance`, timers and `requestAnimationFrame`, so game time moves only when a test moves it. Loading doesn't move it either, so a save loads with no offline progress. (Installed but not paused, the clock flows with real time. `gameFromSave`'s `clockDuringLoad: "running"` does that until the game has loaded, as on Steam, for checking a race between a timer and the load. It then pauses a game cycle ahead of the page's time, since real time passes before the pause lands and the clock can't be set back: game time jumps on by up to a cycle, and timers due in that jump run once.)

Script imports and WebSockets still run in real time. So:
- **`advanceGameTime(page, ms)`** moves game time on one game cycle at a time (`GAME_CYCLE_MS`, 200 ms), and **never more than `MAX_GAME_SPEEDUP` (×20) times as fast as real time**. Between steps the page runs its real-time work (imports, socket messages) in real time. At ×20, the Agent's 5 s worker timeout gives an import or a reply 250 ms of real time.
  - Unpaced, the clock ran at ×126 and more. A reply only 50 ms late then took over 5 s of game time, and the stepped clock would have tripped the Agent's timeout: the review of #96 measured it. `test/pacing.e2.test.ts` keeps that from coming back.
  - Raise the limit only with a test showing real-time work still fits.
- **Wait for real-time work with `advanceUntil`**, on its effect, with a real-time timeout and, where a bound matters, a game-time one. Never advance a fixed amount and hope, and never use fixed sleeps.
- **Move time only through these two.** Calling `page.clock` directly skips the pacing.
- **Check cadences on the snapshots' `gameTimeMs`**, not on when the brain received them.

**Speed on the reference rig** (`test/clock.e2.test.ts`, a fresh game with no scripts): 10 game minutes take 30 s of real time, the ×20 limit. A game hour takes 3 minutes; scripts and a busy page can make it slower.
- **Each step adds an entry to the clock's history.** Playwright replays that history into each new page, which is how a reload keeps game time. A reload after 10 game minutes (3,000 entries) took 650 ms; after a game hour (18,000 entries, measured before the pacing), 420–630 ms. Long runs slow down a little as it grows: for multi-hour tests, a fresh context per hour or so.
**One shim.** Playwright's fake timers call back with `this` null, where a browser's call back with `this` the window. The game relies on the browser's behaviour: `Engine.start` reschedules itself unbound and sets `this.isRunning`. A context init script, registered after the clock's, wraps the faked `setTimeout`, `setInterval` and `requestAnimationFrame` to call back with the window. It's harness instrumentation (architecture §9.4); the game's code is unchanged.

## The skeleton on E2

`test/skeleton.e2.test.ts` is M2's exit criterion on the real page ([#97](https://github.com/UnderMyBed/bitburner-agent/issues/97); architecture §13): "connect, snapshot, reload, reconnect, Agent RAM in an 8 GB fresh start". It uses the game's own Remote File API client and network, a real brain and the built Agent.

- **A real brain** (`test/helpers/brain.ts`): `packages/brain/src/main.ts` in its own process, with a data directory and free ports of the test's own.
  - Its `config.json` is environment E2, so it never supervises Steam's game, and allows the test page's origin. `startBrain` refuses a config that isn't E2: an E0 brain on Windows launches and kills Steam's Bitburner.
  - The config is written once and kept, so a brain started again on the same ports keeps its token.
  - Tests read its store read-only while it runs (`readStore`), and its log is printed when a test fails.
- **Autosave on.** The simulator turns autosave off, and its saves carry that. `simulatorSave` turns the game's default (every 60 s) back on, because a deploy is in the save only after an autosave (#91).
- **Typing focuses the terminal** (`typeCommand`) rather than clicking it: a toast can lie over it, and toasts close on a game timer, so one stays while game time stands still.
- **Cadence is checked on `gameTimeMs`** ([game time](#game-time)).
- **The page heap isn't measured on E2.** Playwright's fake `performance` has a `memory` without `usedJSHeapSize`, so the Agent reads `undefined`, and the fast snapshot's `pageHeapUsedBytes` arrives missing (not `null`, which the Agent sends where there's no `memory` at all). It's measured on Steam, in a release's live run ([releasing](../../docs/releasing.md) step 2).
- **Debugging a failing test.**
  - Run one test with `npm run e2 -- skeleton -t "reconnect"`.
  - When a test fails, each brain it started prints its log (the `brain:` lines: deploys, connections, refusals) under "Brain N's log (<data directory>)".
  - The data directory, with `config.json` and `telemetry.sqlite`, is a temporary `e2-skeleton-*` folder, deleted when the file finishes. To keep it, comment out the `afterAll` in `skeleton.e2.test.ts`.
  - The Agent's own log is in the game: to see it, run headed (see `e2:install`) and `tail` it.
  - A load that fails says why ([fixtures](#fixtures)).

## What the tests show

Results on the reference rig:

| Test | What |
|---|---|
| `test/game.e2.test.ts` | Five checks: <ul><li>a page that isn't the game makes `waitForTerminal` fail with what it showed and its page error;</li><li>a simulator-made save, with money earned by hacking, loads to the Terminal, and the overview shows the save's money;</li><li>with the unload prompt armed, a reload gets through and loads the game again;</li><li>a brand-new game starts in the tutorial, `exitTutorial` closes it, and `free` shows 8.00GB;</li><li>a script autoexec starts on load imports another, sleeps 1 s and prints, all within 5 s of game time: it finished after 1,200 ms.</li></ul> |
| `test/pacing.e2.test.ts` | A WebSocket reply 100 ms late in real time arrives within 5 s of game time: after 1,400 ms. Unpaced, it would have taken over 12 s |
| `test/remote-api.e2.test.ts` | The game's Remote File API client connects to a local WebSocket server named in the save's settings, in 10 loads of 10. Game time runs in real time during each load, so the game's 2 s connection timer (`vendor/bitburner-src/src/index.tsx:37`) races the load. Every load connected 1,600–1,800 ms of game time after the clock was paused, a cycle after the Terminal appeared (200 ms steps): the timer starts when the main bundle runs, late in a load of about 0.7 s, so the settings were always in first. A load in this mode leaves game time still afterwards |
| `test/skeleton.e2.test.ts` | Five tests: <ul><li>**deploy and start:** a save naming the brain's RFA and autoexec `agent/boot.js`; the game connects, the brain deploys and backs up the save; past an autosave and a reload, autoexec starts the Agent, it's welcomed (running the deployed code, not told to restart), and the next RFA connection finds the deploy current;</li><li>**snapshots:** over 2 game minutes every tier in the right number (static exactly once), numbered 1, 2, 3… with none missed, at its cadence in game time; no failed deploy, refused connection, version drift or failed backup rotation. The most an interval was off its period, over five runs: fast 0–40 ms, medium 60–80 ms, slow 80–120 ms;</li><li>**reload:** a reload brings the Agent back through autoexec, in a new session, with a full snapshot;</li><li>**reconnect:** the brain killed (no clean shutdown) and started again on the same ports; the game's RFA client and the Agent reconnected about 3 s of game time after; welcomed again, the Agent sent a full snapshot, its session and every tier's numbering carrying on. (The first rows after a brain restart count stored snapshots as missed: #119.)</li><li>**8 GB fresh start:** a new game, the tutorial exited, the Remote API and autoexec set through the Options UI and the first `run agent/boot.js` typed, as the owner does. Over 2 game minutes (counted before the mem commands, which take game time too), home stays 8 GB, every tier arrives in the right number with none ever skipped for RAM, and each fast snapshot sees the Agent and its own worker, at most 4.85 GB in use. The game's `mem` gives the Agent 2.85 GB, the snapshot workers 2.0–4.45 GB, the hack loop's home workers 2.35 and 4.65 GB, `buy-program.js` 1.75 GB, `upgrade-home-ram.js` 1.65 GB, `travel.js` 2.1 GB, `join-faction.js` 2.1 GB, `buy-augmentation.js` 2.6 GB, `faction-work.js` 1.6 GB, `company-work.js` 2.1 GB, `crime-work.js` 1.6 GB, `class-work.js` 2.1 GB, `buy-server.js` 4.5 GB, `install-augmentations.js` 1.6 GB (the Singularity workers aren't counted: they run only with Singularity, #145), and `boot.js` 2.7 GB, so the peak, computed, is 7.5 GB (Q1, #34, #134, #145); only the simulator's suites see the peak as it happens (`homePeak`). The hack loop, on by default, has rooted n00dles and runs there in the real game (`ps` on n00dles, #134).</li></ul> |
| `test/effectors.e2.test.ts` | Twenty-five tests of the `ui` effectors and the game's dialogs (#136, #138, #141, #143, #147, #149, #151, #153, #156, #158, #159), and safe mode (#160), each closing the "Offline for…" alert the game raises on load (with Escape: the test harness may), unless it's the one under test: <ul><li>**buying:** a save with $1b, home RAM's switch off; the Agent buys the TOR router at Alpha Enterprises and all five port openers on the real page, as a player would, each at its first try (100 s of game time leaves no room for a 30 s retry), and leaves it on the Terminal with no dialog open;</li><li>**the TOR router alone** ($300k, too little for a program): bought, and the page back on the Terminal with no dialog open;</li><li>**a collapsed World section:** with City unmounted, nothing is bought; once it's open again, the next try buys the TOR router;</li><li>**the "Offline for…" alert left open** (#143): the Agent closes it, the brain stores it as a `gameDialog` event, and the TOR router is bought;</li><li>**a faction invitation** (#143): a save in Aevum with $20m, and a travel to Sector-12 queued, earns Sector-12's; the Agent answers "Decide later" (a `gameDialog` event naming Sector-12), no dialog is left, the player hasn't joined, and the Factions page offers "Join!";</li><li>**joining Sector-12** (#147): from the same start, a queued `joinFaction(CyberSec)`, with no invitation, isn't done ("no invitation from CyberSec on the Factions page") and is cancelled; then `joinFaction(Sector-12)` is held at first, passes the brain's gate (two medium snapshots, then a save backup), and the Agent clicks "Join!" on the real Factions page. The backup's `saveBackup` event comes before the first medium snapshot showing Sector-12 joined, and the page ends on the Terminal with no dialog open;</li><li>**buying augmentations** (#149): a save the simulator sets up in CyberSec with reputation (`prepareSave`); Neurotrainer I and NeuroFlux level 1 queued, each confirmed and its alert closed, both paid for (over $5m spent, the hack loop off), the page back on the Terminal with no dialog open;</li><li>**an augmentation the money doesn't cover** (#149): $1m; not done, with the reason as the outcome, no dialog ever opened (a page observer counts them: a click on the disabled "Buy" would open one), and the money untouched;</li><li>**faction work** (#151): CyberSec's hacking contracts, set on the dashboard (`POST /api/work`), start focused on the real page (the Work page's title); unfocused as the owner would, the Agent focuses again within 30 s, without restarting the work (no "You worked for…" alert); a travel queued meanwhile unfocuses for the sidebar, flies and focuses again; once no longer managed, the work is left as it is;</li><li>**safe mode** (#160): the same work converged, then the brain stopped; unfocused as the owner would, the Agent focuses again within 30 s with no brain; past an autosave, a reload, where the game loads the work focused and autoexec's Agent has only `agent/desired-state.json`: it closes the load's "Offline for…" alert, and focuses again after the owner unfocuses;</li><li>**faction work unfocused** (#151): with the Neuroreceptor Management Implant installed in the save (`diagnostics.giveInstalledAugmentation`), the brain sends it unfocused; the Agent starts it and leaves it unfocused on the Terminal, and keeps seeing it converged (from the overview's React props) with no restart;</li><li>**faction work a faction doesn't offer** (#151): CyberSec's field work isn't converged, with the page's reason, and the page is on the Terminal;</li><li>**company work** (#153): a save in New Tokyo (`withCity`); a Waiter at Noodle Bar, set on the dashboard, is applied for (the job is in the next medium snapshot), the hiring alert closed by the worker itself (the dialog watcher never saw it), and worked focused (the Work page's title); unfocused as the owner would, the Agent focuses again within 30 s, neither restarting the work (no "You finished working for…" alert) nor applying again; after a travel to Aevum (unfocused for the sidebar, then focused again) and the owner clicking "Stop working" there, the Agent works the job held again from the sidebar's Job page, with no dialog left;</li><li>**company work in another city** (#153): from Sector-12, not converged ("no Noodle Bar in the city (is the player in its city?)"), and the page is on the Terminal;</li><li>**crime** (#156): shoplifting, set on the dashboard, starts focused at the Slums on the real page (the Work page's "You are attempting to shoplift"); unfocused as the owner would (the game goes to the City, the overview says "You are attempting to Shoplift"), the Agent focuses again within 30 s, with no dialog left;</li><li>**crime unfocused** (#156): with the implant installed, shoplifting is started and left unfocused on the Terminal, and seen converged from the overview 35 s on;</li><li>**a class** (#158): Computer Science at Rothman University, set on the dashboard from a Sector-12 save, is started and left unfocused on the Terminal (a class gains nothing from focus), the overview saying "You are studying Computer Science", still converged 35 s on; then Data Structures in its place ($1m covers 10 minutes of it): the overview says "You are taking a Data Structures course", and the game's "After studying Computer Science for …" alert is closed by the dialog watcher, with no dialog left;</li><li>**a class held back** (#158): with $1,000, Crush Fitness Gym from Sector-12 isn't converged ("… is in Aevum, and the player is in Sector-12 (travel there first)"), nor is Data Structures ("… costs $120 a second: the Agent starts it with 10 minutes of that ($72,000) or more, and the player has $1,000"); no class is under way, the page is on the Terminal with no dialog, and the money untouched;</li><li>**a dialog the Agent doesn't know** (#143): the travel confirmation the owner opened and left stays open for a minute, nothing is bought, and the fast snapshot reports it as blocking; once the owner cancels it, the TOR router follows;</li><li>**a script's `ns.alert` and `ns.prompt`** (#143): the owner's, so both stay open and nothing is bought under them;</li><li>**home RAM** (#138): $1.1m and the programs' switch off (set in the brain's store before it starts: `startBrain`'s `settings`); home goes from 8 GB to 16 GB at Alpha Enterprises and no further, nothing else is bought, and the page is back on the Terminal with no dialog open;</li><li>**travel** (#141): $1m, purchases off; a travel to Aevum queued on the dashboard (`POST /api/intents`, as its page does) is done on the real page, with the game's confirmation and "You are now in Aevum!" alert shown and handled; the ticket is paid, the page ends on the Terminal with no dialog open, and the brain takes the intent off its queue once the Agent reports it done (a page observer checks both dialogs appeared);</li><li>**travel with ASCII art off and the confirmation turned off** (the save's Options): the "Travel to Volhaven" button, and neither dialog;</li><li>**travel without the ticket's money** ($100k): not done, with the reason as the intent's outcome in the fast snapshot, the player still in Sector-12, the page on the Terminal and no dialog left;</li><li>**buying a server** (#159): $1m, purchases and the hack loop off; `buyServer(pserv-0, 8)` queued on the dashboard is bought through the NS API (no page): the medium snapshot has `pserv-0` at 8 GB with root, $440k is paid, and the page is untouched; queued again, it's done with nothing paid and no `pserv-0-0`.</li></ul> |
| `test/clock.e2.test.ts` | 10 minutes of game time, exactly, within the ×20 limit; the engine still running on it (`analyze` finishes after its 1 s of game time; a moving `Date.now()` proves only the clock); and a reload after it, which keeps game time, with the engine running again |

## Layout

| Path | What |
|---|---|
| `src/paths.ts` | `.cache/e2/` and the pinned commit |
| `src/build.ts`, `scripts/build-game.ts` | `e2:build`: the dependency check, the cache by commit and inputs, the clean-submodule checks, the committed `dist/` files |
| `src/webpack-config.ts`, `scripts/run-game-webpack.ts` | The game's webpack config with E2's changes, and the runner started in the submodule |
| `scripts/install-browser.ts` | `e2:install` |
| `src/server.ts` | The static server |
| `src/game.ts` | The fixtures and game time |
| `vitest.config.ts` | `npm run e2` |
| `tsconfig.json` | Node plus the DOM: code passed to `page.evaluate` runs in the page |
| `test/*.e2.test.ts` | E2 tests (browser) |
| `test/helpers/environment.ts` | `useE2()`: the server and browser for a test file |
| `test/helpers/saves.ts` | Simulator-made saves, with the game's default autosave |
| `test/helpers/brain.ts` | A real brain process for a test (`startBrain`, `freeBrainPorts`), and a read-only view of its store (`readStore`) |
| `test/*.test.ts` | Unit tests (no browser, in CI) |
