# @bitburner-agent/bridge

The brain's connections to the game (architecture §6): the control channel to the in-game Agent, and, from #91, the Remote File API server.

> **Status:** M2. The control channel is built ([#87](https://github.com/UnderMyBed/bitburner-agent/issues/87)); the RFA server and deployer ([#91](https://github.com/UnderMyBed/bitburner-agent/issues/91)) and save backups ([#92](https://github.com/UnderMyBed/bitburner-agent/issues/92)) follow.

## The control channel

```ts
import { ControlChannel, startWebSocketServer, systemClock } from "@bitburner-agent/bridge";

const channel = new ControlChannel({ token, clock: systemClock });
channel.subscribe((event) => store.record(event));   // agentConnected, snapshotReceived, …
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
  - under the simulator, over the brain's lockstep driver ([#90](https://github.com/UnderMyBed/bitburner-agent/issues/90)). That driver lives in the brain, so `bridge` never depends on `sim` (architecture §12.2).
- **Events** go to subscribers: `agentConnected`, `agentDisconnected`, `snapshotReceived` (with `missedBefore`, the sequence numbers skipped since the last one) and `connectionRejected` (with the reason).
- **`Clock`:** the channel reads time and sets its hello timeout only through the clock it's given: `systemClock` live, virtual time under the simulator (architecture R11).
- **`startWebSocketServer`** binds `127.0.0.1` and refuses an upgrade whose `Origin` isn't allowed (HTTP 403), reporting it.

## Tests

- `test/control-channel.test.ts`: the rules, against an in-memory connection and a hand-moved clock.
- `test/control-channel.property.test.ts`: fast-check; snapshots with duplicates, drops, reordering and reconnects.
- `test/websocket-server.test.ts`: the real server on a random port.
