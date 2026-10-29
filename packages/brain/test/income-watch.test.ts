// The money's last rise over the medium snapshots (#184), through a real ControlChannel: what the incomeStalled alert
// reads, and the brain's log lines as a stall starts and ends.
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import { CONTROL_PROTOCOL_VERSION, encodeControlMessage, type SnapshotTier } from "@bitburner-agent/core";
import { beforeEach, expect, test } from "vitest";
import { INCOME_STALLED_AFTER_MS } from "../src/dashboard/alerts.ts";
import { IncomeWatch } from "../src/income-watch.ts";
import { mediumData } from "./helpers/snapshot-fixtures.ts";

const TOKEN = "the-token";
/** The medium tier's period. */
const MEDIUM_MS = 10_000;
let clock: ManualClock;
let channel: ControlChannel;
let target: string | null;
let lines: string[];
let watch: IncomeWatch;
let sequenceNumber = 0;

beforeEach(() => {
  clock = new ManualClock();
  channel = new ControlChannel({ token: TOKEN, clock });
  channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  target = "n00dles";
  lines = [];
  watch = new IncomeWatch({ channel, hackLoopTarget: () => target, log: (line) => lines.push(line) });
});

function connectAgent(): MemoryConnection {
  const connection = new MemoryConnection();
  channel.accept(connection);
  connection.receive(
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "hello",
      token: TOKEN,
      deploymentId: "deployment-a",
      agentSessionId: "session-1",
      game: { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" },
    }),
  );
  return connection;
}
const send = (connection: MemoryConnection, tier: SnapshotTier, data: unknown) =>
  connection.receive(
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "snapshot",
      agentSessionId: "session-1",
      tier,
      sequenceNumber: ++sequenceNumber,
      gameTimeMs: 1_000,
      data,
    }),
  );
/** A medium snapshot with this money, `MEDIUM_MS` after the last. */
const medium = (connection: MemoryConnection, money: number) => {
  clock.advance(MEDIUM_MS);
  send(connection, "medium", mediumData(150, {}, { money }));
};
/** Medium snapshots for `ms`, the money flat. */
const flatFor = (connection: MemoryConnection, ms: number, money: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += MEDIUM_MS) medium(connection, money);
};

test("each rise is noted; a fall (a purchase) isn't one, and the next rise after it is", () => {
  const connection = connectAgent();
  expect(watch.facts()).toBeNull();
  medium(connection, 1_000);
  const firstAtMs = clock.now();
  // The first snapshot starts the watch.
  expect(watch.facts()).toEqual({ money: 1_000, lastRiseAtMs: firstAtMs });
  medium(connection, 5_000);
  const risenAtMs = clock.now();
  medium(connection, 200);
  expect(watch.facts()).toEqual({ money: 200, lastRiseAtMs: risenAtMs });
  medium(connection, 200);
  expect(watch.facts()).toEqual({ money: 200, lastRiseAtMs: risenAtMs });
  medium(connection, 300);
  expect(watch.facts()).toEqual({ money: 300, lastRiseAtMs: clock.now() });
  // Not the Agent's word for a number: ignored.
  clock.advance(MEDIUM_MS);
  send(connection, "medium", { ...mediumData(150, {}), player: { money: "lots" } });
  expect(watch.facts()?.money).toBe(300);
});

test("a stall is logged once as it starts, and once as money rises again", () => {
  const connection = connectAgent();
  medium(connection, 21_434_097);
  const flatFromMs = clock.now();
  flatFor(connection, INCOME_STALLED_AFTER_MS, 21_434_097);
  expect(lines).toEqual([]);
  flatFor(connection, 15 * 60_000, 21_434_097);
  expect(lines).toEqual([
    "income stalled: money hasn't risen for 10 min, at $21,434,097, with the hack loop on against n00dles",
  ]);
  expect(watch.facts()?.lastRiseAtMs).toBe(flatFromMs);
  medium(connection, 21_500_000);
  expect(lines.slice(1)).toEqual(["income stall over: money rose to $21,500,000 after 25 min"]);
});

test("off or with no target, nothing is expected to earn: the 10 minutes start once the loop has a target", () => {
  const connection = connectAgent();
  target = null;
  flatFor(connection, 30 * 60_000, 1_000);
  expect(watch.facts()?.lastRiseAtMs).toBe(clock.now());
  target = "n00dles";
  flatFor(connection, INCOME_STALLED_AFTER_MS, 1_000);
  expect(lines).toEqual([]);
  medium(connection, 1_000);
  expect(lines).toHaveLength(1);
  // Switched off mid-stall: it's over.
  target = null;
  medium(connection, 1_000);
  expect(lines[1]).toBe("income stall over: the hack loop is off or has no target, after 10 min");
});

test("a disconnect ends a stall, and the next Agent is watched afresh", () => {
  const connection = connectAgent();
  flatFor(connection, INCOME_STALLED_AFTER_MS + 2 * MEDIUM_MS, 1_000);
  expect(lines).toHaveLength(1);
  connection.dropFromGameSide();
  expect(lines[1]).toBe("income stall over: the Agent disconnected");
  clock.advance(60 * 60_000);
  const next = connectAgent();
  expect(watch.facts()).toBeNull();
  medium(next, 1_000);
  expect(watch.facts()).toEqual({ money: 1_000, lastRiseAtMs: clock.now() });
  expect(lines).toHaveLength(2);
});

test("the switch turned off and on between two medium snapshots: the 10 minutes start again from the switch", () => {
  const connection = connectAgent();
  flatFor(connection, INCOME_STALLED_AFTER_MS + 2 * MEDIUM_MS, 1_000);
  expect(lines).toHaveLength(1);
  // Off and on again within the medium period: no snapshot saw it off.
  clock.advance(MEDIUM_MS / 2);
  watch.hackLoopSwitched(clock.now());
  const switchedAtMs = clock.now();
  expect(lines[1]).toBe("income stall over: the hack loop was switched off or on");
  expect(watch.facts()?.lastRiseAtMs).toBe(switchedAtMs);
  flatFor(connection, INCOME_STALLED_AFTER_MS - MEDIUM_MS, 1_000);
  expect(lines).toHaveLength(2);
  // Before any snapshot, nothing to restart.
  const fresh = new IncomeWatch({ channel, hackLoopTarget: () => target });
  fresh.hackLoopSwitched(clock.now());
  expect(fresh.facts()).toBeNull();
});
