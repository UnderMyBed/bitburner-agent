# @bitburner-agent/bridge

The brain's connections to the game (architecture §6): the control channel to the in-game Agent, and the Remote File API, over which the deployer deploys the in-game code.

> **Status:** M2. Built: the control channel ([#87](https://github.com/UnderMyBed/bitburner-agent/issues/87)), and the RFA client and deployer ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)). Save backups ([#92](https://github.com/UnderMyBed/bitburner-agent/issues/92)) follow.

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
channel.setDeploymentState({ deployedId, hold: false, deployFailed: false });   // from the deployer
```

The protocol, close codes and rules are in [docs/bridge/protocol.md](../../docs/bridge/protocol.md).

- **`ControlChannel`** is the session logic. It sees only a `Connection` (`send`, `close`, message and close listeners), so it runs the same over any transport:
  - live and on E2, over `startWebSocketServer`;
  - under the simulator, over the brain's [lockstep driver](../brain/README.md#the-lockstep-driver). That driver lives in the brain, so `bridge` never depends on `sim` (architecture §12.2).
- **Events** go to subscribers: `agentConnected`, `agentDisconnected`, `snapshotReceived` (with `missedBefore`, the sequence numbers skipped since the last one), `connectionRejected` (with the reason) and `versionDrift` (an Agent on a game other than the pinned one: the channel then holds, and never sends `restart` again).
- **`Clock`:** the channel reads time and sets its hello timeout only through the clock it's given: `systemClock` live, virtual time under the simulator (architecture R11).
- **A listener that throws** can't stop the other listeners or leave the channel half-changed: events go out once its state is settled. Its error goes to `onListenerError`, by default raised afterwards as an uncaught exception, so the brain fails fast and is restarted rather than carry on without its store.
- **Bounded for 24/7 runs:** the channel keeps the sequence numbering of the last `REMEMBERED_SESSIONS` (4) Agent sessions only.
- **`startWebSocketServer`** binds `127.0.0.1` and refuses an upgrade whose `Origin` isn't allowed (HTTP 403), reporting it. Nothing a client sends can crash the brain: invalid UTF-8, a binary frame or one over `MAX_FRAME_BYTES` (16 MiB) closes that connection only. A port already in use rejects the start.

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

- **`RfaClient`** sends the game's RFA requests over a `Connection`, all for home: `pushFile`, `getFile` (null for a missing file), `deleteFile`, `getFileNames`, `calculateRam`, `getDefinitionFile`. Replies are matched by `id`, whatever their order. A request fails with an `RfaError` on the game's own error (a plain string), on no reply within 30 s, or when the connection closes.
- **`Deployer`** takes each RFA connection (`accept`, which closes an older one) and deploys over it: the version check, then the deployment, atomically. `accept`'s promise settles when that's done and never rejects.
  - **`build`** is the in-game build (`InGameBuild`: each script by file name, and each one's RAM budget). It must have `boot.js` and `agent.js`, and a budget for every script, or the deployer refuses to start.
  - **`deploymentId`** (`deploymentIdOf`): a hash of every script, the control port and the token.
  - **Hold:** a definition file other than the pinned one, or the channel's `versionDrift`, holds the deployer for the brain's run: it deploys nothing more.
  - **Events:** `deployed` (with the deployment it replaced), `deployFailed` (with the reason) and `versionDrift`.
  - It tells the control channel (`setDeploymentState`) what `current.txt` names, any hold, and whether the last deploy failed, so the channel restarts an outdated Agent only when that's safe.

## Tests

- `test/control-channel.test.ts`: the rules, against an in-memory connection and a hand-moved clock.
- `test/control-channel.property.test.ts`: fast-check; snapshots with duplicates, drops, reordering and reconnects.
- `test/websocket-server.test.ts`: the real server on a random port.
- `test/rfa-client.test.ts` and `test/deployer.test.ts`: against `FakeRfaGame` (`test/helpers/fakes.ts`), which answers as the game's `MessageHandlers.ts` does.
- The game's real RFA code is covered in the simulator: `packages/brain/test/deploy.test.ts`.
