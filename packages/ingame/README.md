# @bitburner-agent/ingame

The code that runs inside the game: `boot.js`, the Agent and its workers (architecture §5). Each script is a self-contained bundle held to a RAM budget, measured with the game's own calculator in CI.

> **Status:** M2. `boot.js` is built ([#85](https://github.com/UnderMyBed/bitburner-agent/issues/85)); the Agent ([#88](https://github.com/UnderMyBed/bitburner-agent/issues/88)) and its snapshot workers ([#89](https://github.com/UnderMyBed/bitburner-agent/issues/89)) follow.

## Layout

| Path | What |
|---|---|
| `src/entries/<name>.ts` | One in-game script each, built to `dist/<name>.js` |
| `src/ns.ts` | The `NS` type, from `@nsdefs`, for entries to import |
| `src/` | In-game code, typechecked as the game's page sees it: the DOM, no Node, and the NS API from the pinned game's definitions as `@nsdefs` (`src/tsconfig.json`) |
| `scripts/` | The build (Node): `bundles.ts`, and `build.ts`, its command |
| `test/` | Tests (Node), which test the built bundles in the simulator |
| `ram-budget.json` | Each bundle's RAM budget, in GB |

In-game code imports `@bitburner-agent/core` (for the deploy layout) and its own modules. The bundle includes them; nothing is imported at runtime.

## Build

```
npm run build -w @bitburner-agent/ingame
```

It writes `dist/<name>.js` for each entry, and `dist/manifest.json`:

```json
{ "buildId": "<12 hex digits>", "files": { "boot.js": { "sha256": "…", "bytes": … } } }
```

- **Self-contained:** each bundle includes what it imports. The build fails if an output would import anything at runtime. So the game's stale RAM cache for importers (game issue #2907) can't arise.
- **Not minified:** see [RAM](#ram).
- **`buildId`** is a short hash of the outputs: the same sources give the same id, on any machine, since comments in the output name sources relative to the repository (a test checks it).
- **What a bundle includes from imported modules:** what it uses, plus any top-level declaration esbuild can't prove unused, such as a computed constant. Its names are charged like the rest, so shared modules keep top-level constants plain literals (`core`'s deploy layout does).

## RAM

The game charges a script's RAM **by identifier name** (game source: `vendor/bitburner-src/src/Script/RamCalculations.ts`):
- the base cost of 1.6 GB;
- plus every NS function's cost whose name appears anywhere in the script's code: `ns.scan`, but also a property or local variable spelled the same way.

So two rules for in-game code:
- **Never name anything like an NS function.** A local `ps` costs 0.2 GB, `connect` 32 GB (Singularity), `attempt` 10 GB. Tests have tripped on all three. Use verbose names, as the coding standards say anyway.
- **Bundles aren't minified,** because a minifier's short names could become `ps` or `rm`. Size doesn't matter in game.

**Budgets:** `ram-budget.json` gives each bundle a budget in GB. `test/ram-budget.test.ts` builds the bundles, writes them into a simulation, and measures each with the game's own calculator (`sim.staticRamUsage`, the call `run` makes). CI fails when:
- a bundle is over its budget;
- a bundle has no budget, or a budget has no bundle.

The test prints each bundle's RAM against its budget. What each script calls that costs RAM:

| Script | Calls |
|---|---|
| `boot.js` | `isRunning` (0.1 GB), `run` (1.0 GB); `read`, `print`, `tprint` and the log switches cost nothing |

## Deploy layout

Where the in-game code lives on home (`@bitburner-agent/core`, `deploy-layout.ts`):

| Path | What |
|---|---|
| `agent/boot.js` | The one fixed-path script; autoexec runs it on every load of a save |
| `agent/current.txt` | The id of the deployment in use |
| `agent/<deploymentId>/<name>.js` | A deployment's scripts, e.g. `agent.js` |
| `agent/<deploymentId>/config.json`, `token.txt` | Its configuration and the control channel's token (their names go in `core` with the deployer, #91) |

A deployment is a build plus its configuration, so a new token or port is a new deployment too. Its id is a folder name: letters, digits, `-` and `_` (`isValidDeploymentId`). Each one gets its own folder, so a deploy never overwrites a file a running script uses. The deployer ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)) writes `current.txt` last.

## `boot.js`

It starts the deployed Agent if it isn't running, and does nothing else (architecture §5.7):
1. reads `agent/current.txt`;
2. if `agent/<deploymentId>/agent.js` isn't running on home, runs it as a **temporary** script.

It's safe to run any number of times. When nothing is deployed, `current.txt` doesn't hold a deployment id, or the Agent can't start, it says so in the terminal and in its log; for a failed start, the game's own reason (a missing file, too little RAM, a script it can't parse) is in the log too.

**It never stops an Agent.** An Agent from an earlier deployment keeps running until it restarts itself: the deployer tells it to, and it runs `boot.js` and exits ([#88](https://github.com/UnderMyBed/bitburner-agent/issues/88), [#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)).

**Why temporary:** the game saves every running non-temporary script and restarts it on load (game source: `src/NetscriptWorker.ts:241-261`). A temporary Agent isn't saved. So after a load, autoexec (`boot.js`) is the one way back, and a load never starts an old Agent and its workers at once, which wouldn't fit in 8 GB.
