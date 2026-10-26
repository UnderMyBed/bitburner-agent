// Property tests (fast-check): whatever the wire does to the Agent's snapshots (duplicates, drops, reordering) and
// however often it reconnects, what the channel passes on per session and tier is strictly increasing, never repeated,
// and its missed count covers exactly the sequence numbers it never passed on.
import {
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  SNAPSHOT_TIERS,
  type SnapshotTier,
} from "@bitburner-agent/core";
import fc from "fast-check";
import { expect, test } from "vitest";
import { ControlChannel, type ControlChannelEvent } from "../src/control-channel.ts";
import { ManualClock, MemoryConnection } from "./helpers/fakes.ts";

const TOKEN = "the-token";

/** What the wire delivers: snapshot frames (by session, tier and number), and reconnects in between. */
type WireStep =
  | { kind: "snapshot"; session: number; tier: SnapshotTier; sequenceNumber: number }
  | { kind: "reconnect"; session: number };

/**
 * The Agent sends 1..count per tier, in order, from one session or two (a restart). The wire then duplicates some
 * frames, drops some, swaps neighbours, and reconnects anywhere.
 */
const wireSteps = fc
  .record({
    sessions: fc.integer({ min: 1, max: 2 }),
    countPerTier: fc.integer({ min: 1, max: 12 }),
    perturbations: fc.array(
      fc.record({
        kind: fc.constantFrom("duplicate", "drop", "swap", "reconnect"),
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
      } else if (kind === "reconnect") steps.splice(index, 0, { kind: "reconnect", session: step.session });
    }
    return steps;
  });

function replay(steps: WireStep[]): ControlChannelEvent[] {
  const channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
  const events: ControlChannelEvent[] = [];
  channel.subscribe((event) => events.push(event));
  let connection: MemoryConnection | null = null;
  let connectedSession: number | null = null;
  for (const step of steps) {
    if (step.kind === "reconnect" || step.session !== connectedSession) {
      connection?.dropFromGameSide();
      connection = new MemoryConnection();
      channel.accept(connection);
      connection.receive(
        encodeControlMessage({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "hello",
          token: TOKEN,
          deploymentId: "deployment-a",
          agentSessionId: `session-${step.session}`,
          game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
        }),
      );
      connectedSession = step.session;
      if (step.kind === "reconnect") continue;
    }
    connection?.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "snapshot",
        agentSessionId: `session-${step.session}`,
        tier: step.tier,
        sequenceNumber: step.sequenceNumber,
        gameTimeMs: step.sequenceNumber,
        data: null,
      }),
    );
  }
  return events;
}

test("passed on strictly increasing, never repeated, and missed counts exactly what was never passed on", () => {
  fc.assert(
    fc.property(wireSteps, (steps) => {
      const passedOn = new Map<string, { sequenceNumbers: number[]; missed: number }>();
      for (const event of replay(steps)) {
        if (event.type !== "snapshotReceived") continue;
        const key = `${event.snapshot.agentSessionId}/${event.snapshot.tier}`;
        const stream = passedOn.get(key) ?? { sequenceNumbers: [], missed: 0 };
        stream.sequenceNumbers.push(event.snapshot.sequenceNumber);
        stream.missed += event.missedBefore;
        passedOn.set(key, stream);
      }
      for (const [key, { sequenceNumbers, missed }] of passedOn) {
        for (let index = 1; index < sequenceNumbers.length; index++) {
          expect(sequenceNumbers[index], key).toBeGreaterThan(sequenceNumbers[index - 1] as number);
        }
        const highest = sequenceNumbers.at(-1) as number;
        expect(missed, key).toBe(highest - sequenceNumbers.length);
      }
    }),
    { numRuns: 500 },
  );
});

test("with nothing lost on the wire, every snapshot is passed on once and nothing counts as missed", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 5 }), (count, reconnects) => {
      const steps: WireStep[] = [{ kind: "reconnect", session: 1 }];
      for (let sequenceNumber = 1; sequenceNumber <= count; sequenceNumber++) {
        steps.push({ kind: "snapshot", session: 1, tier: "fast", sequenceNumber });
        if (sequenceNumber <= reconnects) steps.push({ kind: "reconnect", session: 1 });
      }
      const received = replay(steps).filter((event) => event.type === "snapshotReceived");
      expect(received.map((event) => event.snapshot.sequenceNumber)).toEqual(
        Array.from({ length: count }, (_, index) => index + 1),
      );
      expect(received.every((event) => event.missedBefore === 0)).toBe(true);
    }),
  );
});
