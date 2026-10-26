# @bitburner-agent/e2

Environment E2 (architecture §9.4): the game built from `vendor/bitburner-src` at the pinned commit, served on 127.0.0.1 and driven by Playwright. It covers what the simulator can't show: the rendered UI, and the page's real network, storage and reload ([#96](https://github.com/UnderMyBed/bitburner-agent/issues/96)). The skeleton's E2 tests build on it ([#97](https://github.com/UnderMyBed/bitburner-agent/issues/97)).

E2 is a heavy tier. Run it on demand when `ingame/` or `bridge/` change, and before every release (architecture §9.3, ADR 0004). It isn't part of `npm test` or CI.

## Running it

```
npm run setup:engine   # once: the game's own dependencies (packages/sim uses them too)
npm run e2:build       # once per pinned commit
npm run e2:install     # once: Playwright's Chromium headless shell
npm run e2
```

Everything E2 builds and downloads goes under the repository's gitignored `.cache/e2/`. Deleting that folder undoes it all.

### `npm run e2:build`

It builds the game with its own webpack config in production mode into `.cache/e2/<commit>/`: `index.html`, and the bundles in `dist/` (about 117 MB with source maps).
- **Cached by commit.** It's skipped when that commit is built already. A `built.json` written last marks a finished build, so a build that stopped part way is redone.
- **The submodule stays clean.** It refuses a submodule with changes, since they'd be built in. It checks `git status --porcelain` again afterwards, and fails if the build left anything. Every other path the build writes is gitignored in the submodule: its `node_modules` and babel's cache.
- **It runs from the submodule**, through `scripts/webpack-in-game.ts`, because the game's config reads the commit with `git rev-parse` and takes its entry and template relative to the working directory. The build shows the pinned commit, `1da7316ff`, as Steam's does. It doesn't use the game's `npm run build`, which runs `bash ./tools/build.sh` and isn't portable to Windows.
- **Three changes to the config** (`src/webpack-config.ts`), none to the game's code:
  - the output goes outside the submodule;
  - the minifier runs on one core;
  - the separate typecheck process is dropped. The pinned game's types are upstream's business; ours are checked by `npm run typecheck`.
- **Time on the reference rig:** 89 s, of which webpack took 80 s.

### `npm run e2:install`

It downloads Playwright's Chromium headless shell into `.cache/e2/browsers/`, not the user's profile. The E2 Vitest config points Playwright there (`PLAYWRIGHT_BROWSERS_PATH`).

- **Why Playwright 1.59.1 and its Chromium 147:** Steam's Bitburner runs Electron 41, which is Chromium 146. No Playwright release ships 146, and 1.59's 147.0.7727.15 is the closest.
- **Why the headless shell:** the tests never need a visible window.

### `npm run e2`

It runs `test/**/*.e2.test.ts` under `vitest.config.ts`: one file at a time, one browser, with the simulator's global setup, since the simulator makes the saves the tests load. The root Vitest config excludes `*.e2.test.ts`.

The package's other tests (`test/*.test.ts`: the static server, the build's checks, the webpack config) need no browser and run with `npm test` in CI.

## Fixtures

`src/game.ts`, with `test/helpers/environment.ts`'s `useE2()` for the browser and server of a test file:

| Fixture | What |
|---|---|
| `launchBrowser()` | Playwright's Chromium headless shell. It says to run `e2:install` if that's missing |
| `serveGame(directory)` (`src/server.ts`) | The built game on `http://127.0.0.1:<random port>`. It also serves a blank page on the same origin, for writing a save before the game loads |
| `gameFromSave(browser, server, bytes, { startTimeMs })` | A page in a new browser context with the save in its IndexedDB, loaded to the Terminal. The save goes into `bitburnerSave` v2, store `savestring`, key `save`, as gzip bytes, exactly what Steam writes to disk (`src/db.ts`). Start the clock at the save's `lastUpdate` for no offline progress |
| `freshGame(browser, server)` | A brand-new game: an empty context, 8 GB of home RAM, and the tutorial running |
| `exitTutorial(page)` | Clicks "Exit Tutorial" and waits for the tutorial to close |
| `advanceGameTime(page, ms)`, `advanceUntil(page, condition, { realTimeoutMs, gameTimeoutMs })` | Game time, below |
| `closeGame(page)` | Closes the page's browser context |

- **Saves come from the simulator** (`Simulation.save()`, with `gameSettings` for the Remote API's address and port, and for autoexec). That's allowed: saves only flow from Steam into test environments, never back.
- **The game's settings live in the save**, so a test sets the RFA port or autoexec by making the save with them.
- **Reloads aren't blocked.** A production build over `http` asks before unloading (`src/index.tsx`), and the browser shows that prompt once the page has been used (typed in, clicked). With no dialog listener, Playwright's own navigations go through it; `test/game.e2.test.ts` reloads after typing to check. A test that adds a `dialog` listener must accept that prompt itself.
- **The page's origin is `http://127.0.0.1:<port>`**, not Steam's `file://`. A brain under test allows it in its config (#87).

## Game time

Playwright's clock is installed in each browser context before the page loads, and paused at the start time. It fakes the page's `Date`, `performance`, timers and `requestAnimationFrame`, so game time moves only when a test moves it. Loading a save doesn't move it either, so a save loads with no offline progress.

Script imports and WebSockets still run in real time. So:
- **`advanceGameTime(page, ms)`** moves game time on one game cycle at a time (`GAME_CYCLE_MS`, 200 ms). After each cycle it lets the page run whatever real-time work is ready: one real task, through a `MessageChannel`, which the clock doesn't fake. A long jump of game time therefore can't overtake a worker's import or a socket reply. For example, the Agent's 5 s worker timeout won't fire falsely.
- **Tests wait for conditions with `advanceUntil`**, with a real-time timeout and optionally a game-time one. They never use fixed sleeps.
- **Check cadences on the snapshots' `gameTimeMs`**, not on when the brain received them.

**Speed:** an hour of game time takes 29 s of real time on the reference rig, ×126 (`test/clock.e2.test.ts`). That's on a fresh game with no scripts running; scripts and a busy page make it slower.

**One shim.** Playwright's fake timers call back with `this` null, where a browser's call back with `this` the window. The game relies on the browser's behaviour: `Engine.start` reschedules itself unbound and sets `this.isRunning`. A context init script, registered after the clock's, wraps the faked `setTimeout`, `setInterval` and `requestAnimationFrame` to call back with the window. It's harness instrumentation (architecture §9.4); the game's code is unchanged.

## What the tests show

| Test | What |
|---|---|
| `test/game.e2.test.ts` | A simulator-made save, with money earned by hacking, loads to the Terminal, and the overview shows the save's money. A reload after typing gets through the unload prompt and loads the game again. A brand-new game starts in the tutorial, and `exitTutorial` closes it |
| `test/remote-api.e2.test.ts` | The game's Remote File API client connects to a local WebSocket server named in the save's settings, in 10 loads of 10. Every load connected at 2,000 ms of game time: the game's own timer (`src/index.tsx`), so the settings are always loaded first |
| `test/clock.e2.test.ts` | An hour of game time, exactly, and the speed-up above |

## Layout

| Path | What |
|---|---|
| `src/paths.ts` | `.cache/e2/` and the pinned commit |
| `src/build.ts`, `scripts/build-game.ts` | `e2:build`: the cache, the clean-submodule checks |
| `src/webpack-config.ts`, `scripts/webpack-in-game.ts` | The game's webpack config with E2's changes, and the runner started in the submodule |
| `scripts/install-browser.ts` | `e2:install` |
| `src/server.ts` | The static server |
| `src/game.ts` | The fixtures and game time |
| `vitest.config.ts` | `npm run e2` |
| `test/*.e2.test.ts` | E2 tests (browser) |
| `test/*.test.ts` | Unit tests (no browser, in CI) |
