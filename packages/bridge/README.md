# @bitburner-agent/bridge

The brain's connections to the game (architecture §6): the control channel to the in-game Agent, and the Remote File API, over which the deployer deploys the in-game code and the brain backs up the game's save.

> **Status:** M2. Built: the control channel ([#87](https://github.com/UnderMyBed/bitburner-agent/issues/87)), the RFA client and deployer ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)), and the RFA's `getSaveFile` for the save backups ([#92](https://github.com/UnderMyBed/bitburner-agent/issues/92)). The backups themselves are in [`packages/brain`](../brain/README.md#save-backups), which owns the data directory.

## The control channel

```ts
import { ControlChannel, startWebSocketServer, systemClock } from "@bitburner-agent/bridge";

const channel = new ControlChannel({ token, clock: systemClock });
recordChannelEvents(channel, store, { environment, brainRelease });   // the brain's: every event into the store
const server = await startWebSocketServer({
  port: 12526,
  allowedOrigins: ["file://"],
  onConnection: (connection) => channel.accept(connection),
  onRejectedOrigin: (origin) => channel.reportRejectedOrigin(origin),
});
// The Deployer (below) tells the channel the deployment state: channel.setDeploymentState({ deployedId, hold, deployFailed })
```

The protocol, close codes and rules are in [docs/bridge/protocol.md](../../docs/bridge/protocol.md).

- **`ControlChannel`** is the session logic. It sees only a `Connection` (`send`, `close`, message and close listeners), so it runs the same over any transport:
  - live and on E2, over `startWebSocketServer`;
  - under the simulator, over the brain's [lockstep driver](../brain/README.md#the-lockstep-driver). That driver lives in the brain, so `bridge` never depends on `sim` (architecture §12.2).
- **Events** go to subscribers: `agentConnected`, `agentDisconnected`, `snapshotReceived` (with `missedBefore`, the sequence numbers skipped since the last one), `connectionRejected` (with the reason) and `versionDrift` (an Agent on a game other than the pinned one: the channel then holds, and never sends `restart` again).
- **`Clock`:** the channel reads time and sets its hello timeout only through the clock it's given: `systemClock` live, virtual time under the simulator (architecture R11).
- **A listener that throws** can't stop the other listeners or leave the channel half-changed: events go out once its state is settled. Its error goes to `onListenerError`, by default raised afterwards as an uncaught exception, so the brain fails fast and is restarted rather than carry on without its store.
- **Bounded for 24/7 runs:** the channel keeps the sequence numbering of the last `REMEMBERED_SESSIONS` (4) Agent sessions only.
- **`startWebSocketServer`** binds `127.0.0.1` and refuses an upgrade whose `Origin` isn't allowed (HTTP 403), reporting it. Nothing a client sends can crash the brain: invalid UTF-8, a binary frame or one over the size limit closes that connection only (1009 for size). A port already in use rejects the start.
  - **The size limit** is `maxFrameBytes`: by default `MAX_FRAME_BYTES` (16 MiB), well over the control channel's largest frame. The brain gives the RFA server `REMOTE_FILE_API_MAX_FRAME_BYTES` (128 MiB), since a `getSaveFile` reply is about twice the gzip save's size.

## The deployer and the Remote File API

```ts
import { Deployer, startWebSocketServer, systemClock } from "@bitburner-agent/bridge";

const deployer = new Deployer({ build, controlPort, token, pinnedDefinitions, channel, clock: systemClock });
const server = await startWebSocketServer({
  port: 12525,
  allowedOrigins: ["file://"],
  onConnection: (connection) => void deployer.accept(connection),
  onRejectedOrigin: (origin) => channel.reportRejectedOrigin(`${origin} (Remote File API)`),
});
```

The deploy steps are in [docs/bridge/protocol.md, "Deploying"](../../docs/bridge/protocol.md#deploying).

- **`RfaClient`** sends the game's RFA requests over a `Connection`, all for home: `pushFile`, `getFile` (null for a missing file), `deleteFile`, `getFileNames`, `calculateRam`, `getDefinitionFile`, and `getSaveFile` (the game's own save: `{ identifier, binary, save }`, the save as gzip bytes, one character per byte, on Steam).
  - Replies are matched by `id`, whatever their order; a frame that isn't a reply is ignored.
  - **Ids are unique per connection, not per client,** so several clients can share one: the deployer and the brain's save backups each have their own on the game's RFA connection, and each takes only its own replies.
  - A request fails with an `RfaError` whose `kind` says why: `game` (the game's own error, a plain string, or a reply of the wrong type), `timeout` (no reply within 30 s) or `closed` (the connection closed).
- **`Deployer`** takes each RFA connection (`accept`, which closes an older one) and deploys over it: the version check, then the deployment, atomically. Nothing a replaced connection learns afterwards counts. `accept`'s promise settles when that's done. A failed deploy is a `deployFailed` event; the promise rejects only on a bug, which then crashes the brain (fail fast).
  - **`build`** is the in-game build (`InGameBuild`: each script by file name, and each one's RAM budget). It must have `boot.js` and `agent.js`, and a budget for every script, or the deployer refuses to start.
  - **`deploymentId`** (`deploymentIdOf`): a hash of every script, the control port and the token.
  - **Hold:** a definition file other than the pinned one, or the channel's `versionDrift`, holds the deployer for the brain's run. It checks again just before it changes anything shared, so a drift reported mid-deploy stops that deploy too.
  - **Events:** `deployed` (with the deployment it replaced), `deploymentCurrent` (a connection found it already in place: nothing to deploy), `deployFailed` (with the reason) and `versionDrift`. A listener that throws can't stop the others or the deploy: its error goes to `onListenerError` (by default raised afterwards as an uncaught exception).
  - It tells the control channel (`setDeploymentState`) what `current.txt` names, any hold, and whether the last deploy failed, so the channel restarts an outdated Agent only when that's safe.
- **`EventListeners`** (`src/event-listeners.ts`) holds a part's subscribers: the deployer's, and the brain's save backups'. A listener that throws can't stop the others: its error goes to `onListenerError`, by default raised afterwards as an uncaught exception (`raiseAsUncaught`, which the control channel uses too).

## Tests

- `test/control-channel.test.ts`: the rules, against an in-memory connection and a hand-moved clock.
- `test/control-channel.property.test.ts`: fast-check; snapshots with duplicates, drops, reordering and reconnects.
- `test/websocket-server.test.ts`: the real server on a random port.
- `test/rfa-client.test.ts` and `test/deployer.test.ts`: against `FakeRfaGame` (`test/helpers/fakes.ts`), which answers as the game's `MessageHandlers.ts` and `removeFile` do, with their messages (it checks only file extensions, not whole paths). It can drop the connection, stay silent, or report a close late as `ws` does. Its `getSaveFile` answers with a Steam-style save (`steamSaveFile`).
- **For other packages' tests:** `@bitburner-agent/bridge/test-helpers` exports these fakes (`FakeRfaGame`, `MemoryConnection`, `ManualClock`, `steamSaveFile`). The brain's save-backup tests use them.
- The game's real RFA code is covered in the simulator: `packages/brain/test/deploy.test.ts`, `save-backup-round-trip.test.ts` and the skeleton suite, where the deployer and the save backups share the game's connection.

