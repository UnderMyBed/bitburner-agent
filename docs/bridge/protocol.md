# The control channel's protocol

The in-game Agent connects to the brain over a WebSocket and reports snapshots. The brain welcomes it, or tells it to restart onto the deployed code (architecture §6, D2). This page is the reference for the messages, close codes and rules. The code is `packages/core/src/control-protocol.ts` (shared by both sides) and `packages/bridge/src/control-channel.ts` (the brain's side).

M2 only observes, so nothing else comes down yet. Desired state and intents arrive with the reconciler in M3, as protocol version 2.

## Frames

- Text frames of JSON, one message each, of at most 16 MiB (a static-tier snapshot is well under 1 MB). Each of these closes only its own connection:
  - a binary frame: 1003;
  - invalid UTF-8: 1007;
  - a larger frame: 1009.
- The Agent connects to `ws://127.0.0.1:<port>`, not `localhost`: the brain listens on the IPv4 loopback only.
- Identifiers and version strings are at most 256 characters. The brain keeps only the fields it knows. `data` is passed on as sent, and is untrusted.
- Every message has `protocolVersion: 1` and a `type`.
- A message that doesn't parse, has another protocol version, or arrives out of order (anything before `hello`, a second `hello`, a snapshot from another session) closes the connection with **4002**.

## Agent → brain

**`hello`**, the first message on every connection:

| Field | What |
|---|---|
| `token` | The shared secret the deployer wrote to `agent/<deploymentId>/token.txt` |
| `deploymentId` | The deployment the Agent runs from ([deploy layout](../../packages/ingame/README.md#deploy-layout)) |
| `agentSessionId` | New each time the Agent starts; reconnects of the same Agent keep it |
| `game` | `ns.ui.getGameInfo()`: `version`, `versionNumber`, `commit`, `platform` |

**`snapshot`**:

| Field | What |
|---|---|
| `agentSessionId` | The session that took it |
| `tier` | `static`, `slow`, `medium` or `fast` (architecture §5.2) |
| `sequenceNumber` | 1, 2, 3… per session and tier |
| `gameTimeMs` | The game's `Date.now()` when it was taken |
| `data` | The tier's contents: see below |

**The fast snapshot is the heartbeat.** The Agent sends it every 2 s whatever happens, with what it knows itself and the fast worker's data, or `null` when no worker could run. So liveness never depends on a worker getting RAM, and there's no separate heartbeat message.

### Each tier's `data`

The types are in `packages/core/src/snapshots.ts`. Server and player fields keep the game's own names (`ns.getServer`, `ns.getPlayer`). Fields the game leaves undefined are absent.

| Tier | When | `data` |
|---|---|---|
| `static` | Once per Agent start; resent, unchanged, after each `welcome` | `servers`: every server `scan` reaches from home, each with `hostname`, `maxRam`, `cpuCores`, `purchasedByPlayer`, and, for hackable ones, `moneyMax`, `minDifficulty`, `requiredHackingSkill`, `numOpenPortsRequired` |
| `slow` | Every 60 s | `resetInfo`: `ns.getResetInfo()` with its Maps as objects (`ownedAugs`: augmentation → level, `ownedSF`: Source-File → level, `bitNodeOptions.sourceFileOverrides`), plus `lastAugReset`, `lastNodeReset`, `currentNode`. `purchasedServers`: their hostnames |
| `medium` | Every 10 s | `player`: `ns.getPlayer()` whole (skills, exp, money, city, location, factions, jobs, karma, multipliers…). `servers`: each reachable server's `hostname`, `hasAdminRights`, `backdoorInstalled`, `moneyAvailable`, `hackDifficulty` |
| `fast` | Every 2 s | `degradedTiers`: the tiers whose worker couldn't start or didn't report on its last attempt. `pageHeapUsedBytes`: the page's JS heap, `null` where the browser doesn't report it. `game`: the fast worker's `money`, `homeRamUsed` (the Agent and the worker included), `homeMaxRam` and `homeProcesses` (each with `pid`, `filename`, `threads`, `args`, `temporary`), or `null` when the worker couldn't run |

`gameTimeMs` is when the worker read the game (for the fast tier without a worker, when the round started).

## Brain → Agent

| Message | Meaning |
|---|---|
| `welcome` | Accepted: the Agent sends all four tiers in its next round (a full snapshot), then each at its cadence |
| `restart { deploymentId }` | The Agent isn't running the deployed deployment: it runs `agent/boot.js` and exits, and `boot.js` starts the deployment `agent/current.txt` names (#88). If `boot.js` can't start, the Agent stays |

Once welcomed, the Agent sleeps between snapshot rounds, so it acts on a message or a close at its next round: within 2 s.

## Close codes, and what the Agent does

| Code | When | The Agent ([#88](https://github.com/UnderMyBed/bitburner-agent/issues/88)) |
|---|---|---|
| HTTP 403 (no connection) | The upgrade's `Origin` isn't an allowed one | Reconnects with backoff |
| 4000 | A newer Agent connection replaced this one | **Exits, without reconnecting.** The newest Agent wins, and a replaced one is stale: if both reconnected, they would replace each other for ever |
| 4001 | No valid `hello` within 5 s | Reconnects with backoff |
| 4002 | A message that doesn't parse, has another protocol version, or comes out of order | Reconnects with backoff |
| 4003 | The `hello`'s token is wrong | Reconnects with backoff (a new token means a new deployment, which the check below catches) |
| 1003, 1007, 1009 | A binary frame, invalid UTF-8, a frame over 16 MiB | Reconnects with backoff |

Before each reconnect, the Agent reads `agent/current.txt` (which costs no RAM). If it holds a valid id of another deployment, the Agent runs `agent/boot.js` and exits; if it's empty, missing or invalid, the Agent reconnects. If `boot.js` can't start (home is too full), the Agent carries on, so one is always running. After a 4000, it exits without reading it. The backoff is 1 s, doubling to 30 s, back to 1 s after a `welcome` ([the Agent's lifecycle](../../packages/ingame/README.md#the-agent)).

Every refusal is reported (`connectionRejected`, with the reason, and the origin for a 403), so a wrong setting shows on the dashboard instead of failing silently.

## Rules

- **Loopback only:** the server binds `127.0.0.1`. Any web page can open a socket to `localhost`, so the `Origin` header must be one of the configured ones (`file://` for Steam's page, which it loads from disk, to be confirmed on Steam by #95; the test page's origin on E2).
- **One Agent at a time:** an Agent whose `hello` is accepted replaces the connected one, which is closed with 4000. A restarted Agent is the newest; a stale one is the oldest. A refused connection never displaces the connected Agent.
- **Restart, without loops:** the deployer (#91) tells the channel what it knows:
  - the deployment `agent/current.txt` names, as last read or written;
  - whether the brain is on hold (a game version it wasn't built for);
  - whether the last deploy failed.

  `restart` is sent when the deployment is known, there's no hold or failed deploy, and the Agent runs another deployment: on `hello` (in place of `welcome`), or to the connected Agent when a deploy completes. So a version hold or a failed deploy never makes the Agent restart.
  - **Once per outdated deployment.** An Agent from a deployment already told to restart is welcomed instead, until the deployed id changes. That stops a loop. Suppose the game reloads a save from before the deploy was autosaved:
    1. `boot.js` starts the old deployment again, which is welcomed and reports.
    2. The deployer reconnects over RFA and reads `current.txt`, which names the old id.
    3. It deploys again, and that change lets the next restart through.
- **Snapshots in order:** a snapshot whose `sequenceNumber` isn't above the last one passed on for its session and tier is dropped (a duplicate, or one that arrived late). A jump counts the skipped numbers as missed. The numbering stays with the session across reconnects, for the 4 most recent sessions, so a 24/7 run doesn't grow. Property tests check this against a reference model under:
  - duplicated, dropped and reordered frames;
  - reconnects and replacements;
  - frames still in flight to a replaced connection.
- **Time** comes from the brain's injected clock (architecture R11). Every event's `atMs` is from it, so under the simulator they're virtual time (the [lockstep driver](../../packages/brain/README.md#the-lockstep-driver)).
