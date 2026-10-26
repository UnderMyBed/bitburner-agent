// Property tests (fast-check): whatever the wire does to the Agent's snapshots (duplicates, drops, reordering), however
// often the Agent reconnects or replaces its own connection, and whatever frames still arrive on a replaced one, the
// channel passes on exactly what a reference model says, in order, and counts as missed exactly what it never passed
// on.
import {
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  SNAPSHOT_TIERS,
  type SnapshotTier,
} from "@bitburner-agent/core";
import fc from "fast-check";
import { expect, test } from "vitest";
import { ControlChannel } from "../src/control-channel.ts";
import { ManualClock, MemoryConnection } from "./helpers/fakes.ts";

const TOKEN = "the-token";

type Frame = { session: number; tier: SnapshotTier; sequenceNumber: number };
/**
 * What happens on the wire:
 * - `snapshot`: a frame on the session's current connection;
 * - `reconnect`: the connection drops, and the session connects again;
 * - `replace`: the session opens a new connection while the old one is still open (the old one is replaced, 4000);
 * - `inFlight`: a frame that arrives on the session's previous, replaced connection.
 */
type WireStep =
  | ({ kind: "snapshot" } & Frame)
  | { kind: "reconnect"; session: number }
  | { kind: "replace"; session: number }
  | ({ kind: "inFlight" } & Frame);

/**
 * The Agent sends 1..count per tier, in order, from one session or two (a restart). The wire then duplicates frames,
 * drops some, swaps neighbours, reconnects, replaces, and delivers frames on replaced connections, anywhere.
 */
const wireSteps = fc
  .record({
    sessions: fc.integer({ min: 1, max: 2 }),
    countPerTier: fc.integer({ min: 1, max: 10 }),
    perturbations: fc.array(
      fc.record({
        kind: fc.constantFrom("duplicate", "drop", "swap", "reconnect", "replace", "inFlight"),
        position: fc.nat(),
      }),
      { maxLength: 40 },
    ),
  })
  .map(({ sessions, countPerTier, perturbations }) => {
    const steps: WireStep[] = [];
    for (let session = 1; session <= sessions; session++) {
      steps.push({ kind: "reconnect", session });
      for (let sequenceNumber = 1; sequenceNumber <= countPerTier; sequenceNumber++) {
        for (const tier of SNAPSHOT_TIERS) steps.push({ kind: "snapshot", session, tier, sequenceNumber });
      }
    }
    for (const { kind, position } of perturbations) {
      const index = position % steps.length;
      const step = steps[index] as WireStep;
      if (kind === "duplicate") steps.splice(index, 0, step);
      else if (kind === "drop" && step.kind === "snapshot") steps.splice(index, 1);
      else if (kind === "swap" && index + 1 < steps.length) {
        steps[index] = steps[index + 1] as WireStep;
        steps[index + 1] = step;
      } else if (kind === "reconnect" || kind === "replace") steps.splice(index, 0, { kind, session: step.session });
      else if (kind === "inFlight" && step.kind === "snapshot") steps.splice(index, 0, { ...step, kind: "inFlight" });
    }
    return steps;
  });

function helloFrom(session: number): string {
  return encodeControlMessage({
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    type: "hello",
    token: TOKEN,
    deploymentId: "deployment-a",
    agentSessionId: `session-${session}`,
    game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
  });
}

function frameText({ session, tier, sequenceNumber }: Frame): string {
  return encodeControlMessage({
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    type: "snapshot",
    agentSessionId: `session-${session}`,
    tier,
    sequenceNumber,
    gameTimeMs: sequenceNumber,
    data: null,
  });
}

interface PassedOn {
  key: string;
  sequenceNumber: number;
  missedBefore: number;
}

/** Runs the steps through a real channel. */
function replayThroughChannel(steps: WireStep[]): PassedOn[] {
  const channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
  const passedOn: PassedOn[] = [];
  channel.subscribe((event) => {
    if (event.type !== "snapshotReceived") return;
    const { agentSessionId, tier, sequenceNumber } = event.snapshot;
    passedOn.push({ key: `${agentSessionId}/${tier}`, sequenceNumber, missedBefore: event.missedBefore });
  });
  let current: { session: number; connection: MemoryConnection } | null = null;
  let replaced: { session: number; connection: MemoryConnection } | null = null;
  const open = (session: number) => {
    const connection = new MemoryConnection();
    channel.accept(connection);
    connection.receive(helloFrom(session));
    return { session, connection };
  };
  for (const step of steps) {
    if (step.kind === "reconnect") {
      current?.connection.dropFromGameSide();
      current = open(step.session);
    } else if (step.kind === "replace") {
      replaced = current;
      current = open(step.session);
    } else if (step.kind === "inFlight") {
      replaced?.connection.receiveInFlight(frameText(step));
    } else {
      if (current?.session !== step.session) {
        current?.connection.dropFromGameSide();
        current = open(step.session);
      }
      current.connection.receive(frameText(step));
    }
  }
  return passedOn;
}

/**
 * The reference model: a frame on the current connection passes exactly when its number is above the highest passed on
 * for its session and tier; frames on a replaced connection never pass.
 */
function replayThroughModel(steps: WireStep[]): PassedOn[] {
  const highest = new Map<string, number>();
  const passedOn: PassedOn[] = [];
  for (const step of steps) {
    if (step.kind !== "snapshot") continue;
    const key = `session-${step.session}/${step.tier}`;
    const last = highest.get(key) ?? 0;
    if (step.sequenceNumber <= last) continue;
    highest.set(key, step.sequenceNumber);
    passedOn.push({ key, sequenceNumber: step.sequenceNumber, missedBefore: step.sequenceNumber - last - 1 });
  }
  return passedOn;
}

test("the channel passes on exactly what the reference model does, with the same missed counts", () => {
  fc.assert(
    fc.property(wireSteps, (steps) => {
      expect(replayThroughChannel(steps)).toEqual(replayThroughModel(steps));
    }),
    { numRuns: 1_000 },
  );
});

test("with nothing lost on the wire, every snapshot is passed on once and nothing counts as missed", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 5 }), (count, reconnects) => {
      const steps: WireStep[] = [{ kind: "reconnect", session: 1 }];
      for (let sequenceNumber = 1; sequenceNumber <= count; sequenceNumber++) {
        for (const tier of SNAPSHOT_TIERS) steps.push({ kind: "snapshot", session: 1, tier, sequenceNumber });
        if (sequenceNumber <= reconnects) steps.push({ kind: "reconnect", session: 1 });
      }
      const passedOn = replayThroughChannel(steps);
      expect(passedOn).toHaveLength(count * SNAPSHOT_TIERS.length);
      expect(passedOn.every((snapshot) => snapshot.missedBefore === 0)).toBe(true);
    }),
  );
});
