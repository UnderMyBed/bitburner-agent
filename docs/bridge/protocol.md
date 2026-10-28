# The control channel's protocol

The in-game Agent connects to the brain over a WebSocket and reports snapshots. The brain welcomes it, or tells it to restart onto the deployed code, and tells it what to run: the desired state (architecture §6, D2). This page is the reference for the messages, close codes and rules, and, under [Deploying](#deploying), for how the deployer uses the game's Remote File API. The code is `packages/core/src/control-protocol.ts` (shared by both sides) and `packages/bridge/src/control-channel.ts` (the brain's side).

The desired state started in M3 with one activity, the hack loop ([#134](https://github.com/UnderMyBed/bitburner-agent/issues/134)). It was added to protocol version 1: an Agent ignores a message type it doesn't know. Intents come later in M3.

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

**The fast snapshot is the heartbeat.** The Agent sends it every 2 s, with what it knows itself and the fast worker's data, or `null` when that worker couldn't start or didn't report. Each round ends within 2 s, whatever the workers do, so fast snapshots are never more than 4 s apart. Liveness never depends on a worker getting RAM, and there's no separate heartbeat message.

### Each tier's `data`

The types are in `packages/core/src/snapshots.ts`. Server and player fields keep the game's own names (`ns.getServer`, `ns.getPlayer`). Fields the game leaves undefined are absent: the hacking fields below, for Hacknet servers only. Home and purchased servers have the game's defaults (`moneyMax` 0, so "can be hacked" is `moneyMax > 0`).

| Tier | When | `data` |
|---|---|---|
| `static` | Once per Agent start; resent, unchanged, after each `welcome` | `servers`: every server `scan` reaches from home at the Agent's start, each with `hostname`, `purchasedByPlayer`, `moneyMax`, `minDifficulty`, `requiredHackingSkill`, `numOpenPortsRequired`, `serverGrowth` |
| `slow` | Every 60 s | `resetInfo`: `ns.getResetInfo()` (`lastAugReset`, `lastNodeReset`, `currentNode`, `ownedAugs`, `ownedSF`, `bitNodeOptions`) with its Maps as objects: `ownedAugs` (augmentation → level), `ownedSF` (Source-File → level), `bitNodeOptions.sourceFileOverrides`. `purchasedServers`: their hostnames |
| `medium` | Every 10 s | `player`: `ns.getPlayer()` whole (skills, exp, money, city, location, factions, jobs, karma, multipliers…). `hasTorRouter` and `programs` (the port openers on home, #136). `servers`: every server `scan` reaches now, each with `hostname`, `maxRam`, `cpuCores`, `hasAdminRights`, `backdoorInstalled`, `moneyAvailable`, `hackDifficulty` |
| `fast` | Every 2 s | `degradedTiers`: the tiers skipped on their last attempt (the worker couldn't start, didn't report in its round, or was still running from before). `pageHeapUsedBytes`: the page's JS heap, `null` where the browser doesn't report it. `game`: the fast worker's `money`, `homeRamUsed` (the Agent and the worker included), `homeMaxRam` and `homeProcesses` (each with `pid`, `filename`, `threads`, `args`, `temporary`), or `null` when the fast worker was skipped. `intents` (#141): each intent the Agent holds, in order, as `{ id, done, tries, problem }` (its worker reported it done; the worker's runs, reported or not; the last problem, or why the worker didn't run, or `null`), and `backend`, the backend of the last try: `"sim"`, `"singularity"`, `"ui"`, or `null` before the first (#145). `dialogs` (#143): `{ handled, blocking }`, the game's dialogs the Agent handled since the last fast snapshot, each `{ kind, text }` (`kind` "alert" or "factionInvitation"; `text` up to 1,000 characters), and the text of a dialog it left open, or `null` |

`gameTimeMs` is when the worker read the game: for a resent static, when it was first read; for a fast snapshot without the worker's data, when the round started.

## Brain → Agent

| Message | Meaning |
|---|---|
| `welcome` | Accepted: the Agent sends all four tiers in its next round (a full snapshot), then each at its cadence |
| `restart { deploymentId }` | The Agent isn't running the deployed deployment: it runs `agent/boot.js` and exits, and `boot.js` starts the deployment `agent/current.txt` names (#88). If `boot.js` can't start, the Agent stays |
| `desiredState { hackLoop: { enabled, target, hosts }, intents }` | What the brain wants running in the game, whole each time (#134). In `hackLoop`, `enabled` is the hack loop's switch on the dashboard; `target` is the server to hack, or `null` while none is worth it (servers are rooted, but no loop runs); `hosts` are the servers the loop runs on (at most 1,000). `intents` (#141, at most 100): one-shot actions, each `{ id, action, args }`, done in order, each until the game shows it done, and never again while it stays: `buyTor { vendor }` (a tech vendor), `buyProgram { program }` (a port opener), `upgradeHomeRam { fromRam, vendor }` (home's RAM in GB when the brain asked, a power of two below 2^30), `travel { city }` (one of the six). An intent's `id` is its action and its args' values in their fixed order, as `intentId` makes it ("travel(Aevum)"), so ids are unique. They come from the brain's purchase rules (#136, #138: one purchase at a time) and the owner's manual queue. The Agent converges on the last state it got, and forgets it when it disconnects ([the hack loop](../../packages/ingame/README.md#the-hack-loop), [intents](../../packages/ingame/README.md#intents)) |

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

- **Loopback only:** the server binds `127.0.0.1`. Any web page can open a socket to `localhost`, so the `Origin` header must be one of the configured ones (`file://` for Steam's page, which it loads from disk, as the owner's check on Steam confirmed (#95); the test page's origin on E2).
- **One Agent at a time:** an Agent whose `hello` is accepted replaces the connected one, which is closed with 4000. A restarted Agent is the newest; a stale one is the oldest. A refused connection never displaces the connected Agent.
- **Restart, without loops:** the deployer (#91) tells the channel what it knows:
  - the deployment `agent/current.txt` names, as last read or written;
  - whether the brain is on hold (the game's definition file isn't the pinned one);
  - whether the last deploy failed.

  The channel also holds by itself, for the rest of the brain's run, once an Agent's `hello` reports a game other than `PINNED_GAME`:
  - another `versionNumber`;
  - or another `version` (the version string).

  The commit isn't compared (owner decision 31, #128). Upstream's v3.0.1 tag is a different commit from `stable`'s, with the same source, and Steam's build reports the tag's.

  It welcomes that Agent, and reports a `versionDrift` event after its `agentConnected`, once.

  `restart` is sent when the deployment is known, there's no hold or failed deploy, and the Agent runs another deployment: on `hello` (in place of `welcome`), or to the connected Agent when a deploy completes. So a version hold or a failed deploy never makes the Agent restart.
  - **Once per outdated deployment.** An Agent from a deployment already told to restart is welcomed instead, until the deployed id changes. That stops a loop. Suppose the game reloads a save from before the deploy was autosaved:
    1. `boot.js` starts the old deployment again, which is welcomed and reports.
    2. The deployer reconnects over RFA and reads `current.txt`, which names the old id.
    3. It deploys again, and that change lets the next restart through.
- **The desired state, only to the deployed code, and only what starts nothing while holding** (#134, #141). The brain's controller sets it afresh for each connection. A state that starts nothing new (`desiredStateWhileHolding`: the hack loop off, or as last sent to that connection, and no intents) goes to any connected Agent, whatever the brain knows: it only stops our own loops or the intents (after a Steam update, the brain holds before it ever learns the deployed id). Anything else goes to the connected Agent only if:
  - that Agent was welcomed (not told to restart);
  - it runs the deployment the deployer knows is deployed;
  - there's no hold, no failed deploy, and no version drift.

  Never with the `welcome`: the hack loop on waits until the brain has that Agent's own static and medium snapshots, from its first round, so it's never sent a stale target. The hack loop off goes at once. Each connection is sent a state once, then again only when it changes; after a reconnect or a reload, the Agent gets it again. The Agent acts only on what the brain it's connected to sent: while the brain holds, an Agent sent nothing does nothing, and loops already running keep running.
- **Snapshots in order:** a snapshot whose `sequenceNumber` isn't above the last one passed on for its session and tier is dropped (a duplicate, or one that arrived late). A jump counts the skipped numbers as missed. The numbering stays with the session across reconnects within one run of the brain ([#119](https://github.com/UnderMyBed/bitburner-agent/issues/119)), for the 4 most recent sessions, so a 24/7 run doesn't grow. Property tests check this against a reference model under:
  - duplicated, dropped and reordered frames;
  - reconnects and replacements;
  - frames still in flight to a replaced connection.
- **Time** comes from the brain's injected clock (architecture R11). Every event's `atMs` is from it, so under the simulator they're virtual time (the [lockstep driver](../../packages/brain/README.md#the-lockstep-driver)).

## Deploying

The other channel is the game's own Remote File API (RFA), which the deployer uses ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91), `packages/bridge/src/deployer.ts`).
- The game connects to the brain: `ws://<RemoteFileApiAddress>:<RemoteFileApiPort>`, from game settings kept in the save.
- The brain sends it requests, JSON-RPC 2.0-like: replies are matched by `id`, and errors are plain strings (game source: `src/RemoteFileAPI/`).
- The server binds `127.0.0.1` and allows the same origins as the control channel. The newest connection replaces an older one (closed with 1000), and nothing an older one learns afterwards counts.
- **One game per brain.** On a close it didn't make, the game reconnects after its reconnection delay. Two games on one RFA port would replace each other for ever, deploying in turn.
- **Shared with the save backups** ([#92](https://github.com/UnderMyBed/bitburner-agent/issues/92), [packages/brain](../../packages/brain/README.md#save-backups)): each connection is also used for a `getSaveFile` backup, on its own client. Request ids are unique per connection, so each client takes only its own replies. A backup still waiting when the deployer closes an older connection fails, and is recorded; the new connection's backup follows it.

**What's deployed:** a deployment is the build plus its configuration. Its id is 12 hex digits of a hash of every script, the control port and the token. So a new token (after a lost data directory) is a new deployment, and the Agent is never locked out: the old Agent's `hello` is refused (4003), and before it reconnects it finds `current.txt` names the new deployment and hands over (above). Into `agent/<deploymentId>/` go:
- every script: `agent.js`, the `snapshot-<tier>.js` workers, and a copy of `boot.js` (measured there before `agent/boot.js` changes);
- `config.json` (`{ deploymentId, controlPort }`) and `token.txt`.

**On every RFA connection,** unless on hold:
1. **Version check:** `getDefinitionFile` against the pinned `NetscriptDefinitions.d.ts`, line endings aside. On any difference: hold (for the brain's run), a `versionDrift` event saying from which line, and the channel is told. Nothing else happens.
2. Read `agent/current.txt`, and tell the channel the deployment it names. If that's this deployment, stop: nothing to do. A `deploymentCurrent` event records it, which also shows an earlier failed deploy as resolved (the dashboard's `deployFailed` alert, #93).
3. Push every file into the deployment's folder.
4. `calculateRam` on each script there. One over its budget (`ram-budget.json`; a Singularity worker's, at SF4.3, times 16, the most the game charges with less of SF4, #145) stops the deploy: a `deployFailed` event, the channel is told, and nothing shared has changed.
5. If the brain went on hold meanwhile (an Agent's `hello` reported another game), stop here. Otherwise push `agent/boot.js`, if its content differs.
6. **Push `agent/current.txt`, last: the switch-over.** Tell the channel the new deployment, which sends `restart` to a connected Agent from another one. A `deployed` event names the deployment it replaced.
7. Tidy up: delete the files of the deployer's other folders (12 hex digits; never a player's own `agent/<name>/`). It keeps the one just replaced and the connected Agent's. Scripts go first. The game refuses to delete a running one, and then the rest of that folder (its config and token, which that Agent reads) is kept too. Tidying can't fail the deploy: it's done, and the next one tidies again.

**Failures:**
- A request has 30 s to be answered. The game sends no reply when one of its handlers throws. Then the deploy fails and the brain closes the connection, so the game reconnects after its reconnection delay and the deploy is tried again.
- A game error, or the connection closing mid-deploy, is a `deployFailed` event too. `current.txt` is unchanged, and the next connection tries again. An over-budget build isn't retried on the same connection: it would fail the same way.

**Saved at the next autosave.** A deploy is in the save only after the game's next autosave (every 60 s by default). If the game reloads before then, its next RFA connection deploys again.

**What the version check can't catch.** The RFA can't tell the game's version, only its definition file. So a game whose definitions are unchanged but whose version differs is deployed to when its RFA connection comes before any Agent's `hello`: a fresh save, or a load where the RFA connects first. The Agent's `hello` then holds the brain, and no restart follows; but the deployed code still runs on that game at the next load, since `boot.js` starts what `current.txt` names. The definitions being identical, the API the code uses is the pinned one.
