# The control channel's protocol

The in-game Agent connects to the brain over a WebSocket and reports snapshots. The brain welcomes it, or tells it to restart onto the deployed code (architecture §6, D2). This page is the reference for the messages, close codes and rules. The code is `packages/core/src/control-protocol.ts` (shared by both sides) and `packages/bridge/src/control-channel.ts` (the brain's side).

M2 only observes, so nothing else comes down yet. Desired state and intents arrive with the reconciler in M3, as protocol version 2.

## Frames

- Text frames of JSON, one message each. Binary frames aren't part of the protocol.
- Every message has `protocolVersion: 1` and a `type`.
- A message that doesn't parse, has another protocol version, or arrives out of order (anything before `hello`, a second `hello`, a snapshot from another session) closes the connection with **4002**.

## Agent → brain

**`hello`**, the first message on every connection:

| Field | What |
|---|---|
| `token` | The shared secret the deployer wrote to `agent/<deploymentId>/token.txt` |
| `deploymentId` | The deployment the Agent runs from (packages/ingame/README.md, "Deploy layout") |
| `agentSessionId` | New each time the Agent starts; reconnects of the same Agent keep it |
| `game` | `ns.ui.getGameInfo()`: `version`, `versionNumber`, `commit`, `platform` |

**`snapshot`**:

| Field | What |
|---|---|
| `agentSessionId` | The session that took it |
| `tier` | `static`, `slow`, `medium` or `fast` (architecture §5.2) |
| `sequenceNumber` | 1, 2, 3… per session and tier |
| `gameTimeMs` | The game's `Date.now()` when it was taken |
| `data` | The tier's contents (#89) |

**The fast snapshot is the heartbeat.** The Agent sends it every 2 s whatever happens, with what it knows itself and the fast worker's data, or `null` when no worker could run (#89). So liveness never depends on a worker getting RAM, and there's no separate heartbeat message.

## Brain → Agent

| Message | Meaning |
|---|---|
| `welcome` | Accepted; the Agent starts its snapshots |
| `restart { deploymentId }` | The Agent isn't running the deployed deployment: it runs `agent/boot.js` and exits (#88) |

## Close codes

| Code | When |
|---|---|
| HTTP 403 (no connection) | The upgrade's `Origin` isn't an allowed one |
| 4000 | A newer Agent connection replaced this one |
| 4001 | No valid `hello` within 5 s |
| 4002 | A message that doesn't parse, has another protocol version, or comes out of order |
| 4003 | The `hello`'s token is wrong |

Every refusal is reported (`connectionRejected`, with the reason, and the origin for a 403), so a wrong setting shows on the dashboard instead of failing silently.

## Rules

- **Loopback only:** the server binds `127.0.0.1`. Any web page can open a socket to `localhost`, so the `Origin` header must be one of the configured ones (`file://` for Steam's page, which it loads from disk, to be confirmed on Steam by #95; the test page's origin on E2).
- **One Agent at a time:** an Agent whose `hello` is accepted replaces the connected one, which is closed with 4000. A restarted Agent is the newest; a stale one is the oldest. A refused connection never displaces the connected Agent.
- **Restart, without loops:** the deployer (#91) tells the channel what it knows:
  - the deployment `agent/current.txt` names, as last read or written;
  - whether the brain is on hold (a game version it wasn't built for);
  - whether the last deploy failed.

  `restart` is sent when the deployment is known, there's no hold or failed deploy, and the Agent runs another deployment. It's sent once per deployment: on `hello` (in place of `welcome`), or to the connected Agent when a deploy completes. So a version hold or a failed deploy can never make the Agent restart over and over.
- **Snapshots in order:** a snapshot whose `sequenceNumber` isn't above the last one passed on for its session and tier is dropped (a duplicate, or one that arrived late). A jump counts the skipped numbers as missed. The count stays with the session across reconnects. Property tests check this under duplicated, dropped and reordered frames.
- **Time** comes from the brain's injected clock (architecture R11). Every event's `atMs` is from it, so under the simulator they're virtual time (#90).
