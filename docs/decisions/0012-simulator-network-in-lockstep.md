# 0012 — The simulator's network: sockets to the parent, in lockstep

- **Status:** Accepted (2026-10-26)
- **Amends:** [0007](0007-headless-engine-simulator.md) (the simulator was offline)

## Context
The brain talks to the game over two WebSockets that the game's page opens ([architecture §6](../architecture.md#6-bridge)):
- the game's own Remote File API client (RFA);
- our Agent's control channel.

M2's exit criterion needs the whole skeleton to pass in the simulator ([§13](../architecture.md#13-milestones)). Until now the simulator was offline by design: `WebSocket` refused, so a run could never depend on the outside world ([parity audit](../sim/parity.md) 4.6, 4.15).

A socket that's really on the network would break determinism. When a frame arrives depends on real time, so the virtual time at which a script sees it would vary from run to run. The simulator's guarantee is that the same seed and the same calls give the same state hash ([README, Determinism](../../packages/sim/README.md#determinism)).

## Decision
- **The page gets a `WebSocket` stand-in whose other end is the parent process.**
  - Nothing crosses in real time. Frames cross only at requests, so what a script sees can't depend on how fast anything ran.
- **Listening URLs are declared when the simulation starts.**
  - A socket to one of them opens.
  - Any other URL fails, as a refused connection does in a browser.
- **Page → parent:** every connect, sent frame and close goes into an outbox. The parent takes it with a request (`network.take`).
- **Every event reaches the page as a task on the virtual clock.** Each event is its own task, so the page's microtasks run between them.
  - **Events the page causes itself** (a socket opening, a refused connection, its own close completing) arrive 1 virtual ms after the call that caused them. The parent plays no part, so they never depend on how a run is stepped.
  - **The parent's sends and closes** are requests made between advances. They're due at that virtual moment, so they're delivered at the start of the next `advance` or `runUntil`, in request order.
- **The game's own RFA client runs in the simulator.** It starts as the page script does: from a 2 s timer at page load. It reads the game's settings, so the brain's RFA server is tested against the game's real request handlers.
- **The stand-in reproduces only what the RFA client and the Agent use** (YAGNI): text frames, the event order and `readyState`s, `on*` handlers and listeners, and event targets. Anything else (binary frames, sub-protocols, `binaryType`) fails fast with a clear error.

## Consequences
- **Deterministic:** the same seed and the same sequence of calls give the same outbox and state hash, whatever real time the parent takes to reply. While the parent sends nothing, the step sizes don't matter either.
- **Replies take a step.** With a brain attached, its replies arrive at the next `advance`, so the step size becomes part of the call sequence. A brain driven against the simulator runs with a fixed step: the brain's lockstep driver ([#90](https://github.com/UnderMyBed/bitburner-agent/issues/90)).
- **The simulator stays offline otherwise.** `fetch`, `XMLHttpRequest` and `EventSource` still refuse, and so does any socket to a URL nobody declared.
- **A socket outlives the script that opened it**, as in a browser. The Agent has to close its own on exit.
- **Real network behaviour stays untested here:** latency, partial frames, the browser's own handshake and `Origin`. E2 tests those on a real page ([architecture §9.4](../architecture.md#94-environments)).
