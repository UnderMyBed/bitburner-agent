// The batcher's operation scripts and its checks on their landings (#204), in the simulator. Each script lands its call
// at the moment named, whatever the target's security when it starts, and records it; one started too late says so,
// and a hack then doesn't run. The batcher counts a record out of order, a late one, one it can't read, one no
// operation of its own wrote (a previous batcher's) and one never written (lost), loudly; a late hack's record, written
// before its time, makes nothing out of order.
import {
  BATCHER_HEALTH_PORT,
  BATCHER_LANDING_PORT,
  BATCHER_SCRIPT_NAME,
  type BatcherConfig,
  type BatcherHealth,
  batchPlan,
  batchRamGb,
  LANDING_LOST_AFTER_MS,
  type LandingRecord,
} from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { expect, test } from "vitest";
import { NEW_GAME, useInGameBuild, useSimulations } from "./helpers/simulation.ts";

const start = useSimulations();
const build = useInGameBuild();
const FOLDER = "agent/a7a-test/";

/** Drains a port into its log: what the operation scripts wrote, or the batcher's health. */
const READ_PORT = `export async function main(ns) {
  const out = [];
  for (;;) { const data = ns.readPort(ns.args[0]); if (data === "NULL PORT DATA") break; out.push(data); }
  ns.print(JSON.stringify(out));
}`;
/** Logs a port's first entry, leaving it there. */
const PEEK_PORT = "export async function main(ns) { ns.print(JSON.stringify(ns.peek(ns.args[0]))); }";
/** Writes its arguments, parsed from JSON, to a port. */
const WRITE_PORT = `export async function main(ns) {
  for (const each of ns.args.slice(1)) ns.writePort(ns.args[0], JSON.parse(each));
}`;

async function gameWithScripts(): Promise<Simulation> {
  const simulation = await start(NEW_GAME);
  const { source } = await build();
  for (const name of [BATCHER_SCRIPT_NAME, "batch-hack.js", "batch-grow.js", "batch-weaken.js", "hack-loop-root.js"]) {
    await simulation.writeFile("home", FOLDER + name, source(name));
  }
  await simulation.writeFile("home", "read-port.js", READ_PORT);
  await simulation.writeFile("home", "write-port.js", WRITE_PORT);
  await simulation.writeFile("home", "peek-port.js", PEEK_PORT);
  expect((await simulation.run("home", `${FOLDER}hack-loop-root.js`)).error).toBeUndefined();
  await simulation.advance(1_000);
  return simulation;
}

/** What a reader script printed: its line before "Script finished running". */
async function printed(simulation: Simulation, pid: number): Promise<string> {
  const line = (await simulation.logs(pid)).filter((each) => /^[[{"n]/.test(each)).at(-1);
  if (line === undefined) throw new Error(`script ${pid} printed nothing: ${(await simulation.logs(pid)).join(" | ")}`);
  return line;
}

async function readPort<Data>(simulation: Simulation, port: number): Promise<Data[]> {
  const { pid } = await simulation.run("home", "read-port.js", { args: [port] });
  await simulation.advance(100);
  return JSON.parse(await printed(simulation, pid)) as Data[];
}

test("an operation lands at the moment named, started early, at any security, and records it", async () => {
  const simulation = await gameWithScripts();
  const now = await simulation.now();
  // foodnstuff starts at security 10 (minimum 3): its weaken takes longer than at the minimum, and still lands on time.
  const landAt = now + 10 * 60_000;
  const { error } = await simulation.run("home", `${FOLDER}batch-weaken.js`, {
    threads: 2,
    args: ["foodnstuff", landAt, BATCHER_LANDING_PORT, "7.weaken1.0"],
  });
  expect(error).toBeUndefined();
  await simulation.advance(10 * 60_000 + 1_000);
  const [record] = await readPort<LandingRecord>(simulation, BATCHER_LANDING_PORT);
  expect(record).toMatchObject({ id: "7.weaken1.0", landAt, late: false });
  expect((record as LandingRecord).landedAt - landAt).toBeGreaterThanOrEqual(0);
  expect((record as LandingRecord).landedAt - landAt).toBeLessThanOrEqual(1);
  // Two threads' 0.05 each (Constants.ts:10).
  expect((record as LandingRecord).result).toBeCloseTo(0.1, 9);
});

test("started too late: a hack doesn't run and says so; a weaken runs, late, and says so", async () => {
  const simulation = await gameWithScripts();
  const landAt = (await simulation.now()) + 1_000;
  for (const [script, id] of [
    ["batch-hack.js", "1.hack.0"],
    ["batch-weaken.js", "1.weaken1.0"],
  ] as const) {
    await simulation.run("home", FOLDER + script, { args: ["foodnstuff", landAt, BATCHER_LANDING_PORT, id] });
  }
  await simulation.advance(10 * 60_000);
  const records = await readPort<LandingRecord>(simulation, BATCHER_LANDING_PORT);
  const hack = records.find((each) => each.id === "1.hack.0") as LandingRecord;
  const weaken = records.find((each) => each.id === "1.weaken1.0") as LandingRecord;
  expect(hack).toMatchObject({ late: true, skipped: true, result: 0 });
  // Recorded at once: it never waited for a hack.
  expect(hack.landedAt).toBeLessThan(landAt);
  expect(weaken).toMatchObject({ late: true, skipped: false });
  expect(weaken.result).toBeCloseTo(0.05, 9);
  expect(weaken.landedAt).toBeGreaterThan(landAt + 60_000);
});

/** The batcher's health, from its port (A7b's Agent reads it there). */
async function healthOf(simulation: Simulation): Promise<BatcherHealth> {
  const { pid } = await simulation.run("home", "peek-port.js", { args: [BATCHER_HEALTH_PORT] });
  await simulation.advance(1);
  return JSON.parse(await printed(simulation, pid)) as BatcherHealth;
}

const OPERATION_HOSTS = ["foodnstuff", "sigma-cosmetics"];
const MULTS = { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 };
const N00DLES = { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 };
/** The batcher's config on n00dles from the two hosts, core's plan at hacking 50 (the level the exp gives, or less). */
function n00dlesConfig(): BatcherConfig {
  const plan = batchPlan(N00DLES, { skills: { hacking: 50, intelligence: 0 }, mults: MULTS }, batchRamGb([16, 16]));
  if (plan === null) throw new Error("no plan for n00dles on 32 GB");
  return {
    target: "n00dles",
    figures: N00DLES,
    player: { intelligence: 0, mults: MULTS },
    hosts: OPERATION_HOSTS,
    hackShare: plan.hackShare,
    spacingMs: plan.spacingMs,
  };
}

/** A batcher on n00dles from two hosts, at hacking 50, batching for 2 minutes, several batches in flight: its pid. */
async function batchingBatcher(simulation: Simulation): Promise<number> {
  await simulation.diagnostics.gainHackingExp(2_000);
  const { pid, error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, {
    args: [JSON.stringify(n00dlesConfig())],
  });
  expect(error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 5_000) {
    expect(waited, "n00dles prepared within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  // Two minutes in, several batches are in flight.
  await simulation.advance(2 * 60_000);
  return pid;
}

/** The operation scripts running on the hosts: their pid, id and landing time, the latest landing last. */
async function inFlight(simulation: Simulation): Promise<{ pid: number; id: string; landAt: number }[]> {
  const running = [];
  for (const host of OPERATION_HOSTS) {
    for (const process of await simulation.ps(host)) {
      running.push({ pid: process.pid, id: String(process.args[3]), landAt: Number(process.args[1]) });
    }
  }
  return running.sort((a, b) => a.landAt - b.landAt);
}

/** A landing record's JSON, for write-port.js. */
const recordJson = (id: string, landAt: number, extra: Partial<LandingRecord> = {}) =>
  JSON.stringify({ id, landAt, landedAt: landAt, result: 0, late: false, skipped: false, ...extra });

test("a late hack's record, written at once with its later time, makes no other landing out of order", async () => {
  const simulation = await gameWithScripts();
  await batchingBatcher(simulation);
  // Until a hack is in flight.
  let hack: { id: string; landAt: number } | undefined;
  for (let waited = 0; hack === undefined; waited += 1_000) {
    expect(waited, "a hack in flight within a minute").toBeLessThan(60_000);
    await simulation.advance(1_000);
    hack = (await inFlight(simulation)).find((each) => each.id.split(".")[2] === "hack");
  }
  const before = await healthOf(simulation);
  // As a hack started too late writes it: at once, with its landing time still to come.
  await simulation.run("home", "write-port.js", {
    args: [BATCHER_LANDING_PORT, recordJson(hack.id, hack.landAt, { late: true, skipped: true })],
  });
  await simulation.advance(1);
  const counted = await healthOf(simulation);
  // A hack that didn't run is late and skipped, never landed.
  expect(counted.late).toBe(before.late + 1);
  expect(counted.hacksSkipped).toBe(before.hacksSkipped + 1);
  expect(counted.hacksLanded).toBe(before.hacksLanded);
  // At a tight spacing, operations in flight land before a late hack's time; its record must not make them out of
  // order. The latest operation in flight stands in for such a hack: its record, skipped, comes before the rest land.
  const running = await inFlight(simulation);
  const latest = running.at(-1) as { id: string; landAt: number };
  expect((running[0] as { landAt: number }).landAt).toBeLessThan(latest.landAt);
  await simulation.run("home", "write-port.js", {
    args: [BATCHER_LANDING_PORT, recordJson(latest.id, latest.landAt, { late: true, skipped: true })],
  });
  await simulation.advance(2 * 60_000);
  const after = await healthOf(simulation);
  expect(after).toMatchObject({ outOfOrder: 0, desyncs: 0, state: "batching" });
  // Its real script's record came later, already counted: unexpected.
  expect(after.unexpected).toBeGreaterThan(before.unexpected);
});

test("the batcher counts a landing out of order and desyncs, and names a record it can't read", async () => {
  const simulation = await gameWithScripts();
  await batchingBatcher(simulation);
  const running = await inFlight(simulation);
  const first = running[0] as { id: string; landAt: number };
  const last = running.at(-1) as { id: string; landAt: number };
  expect(last.landAt).toBeGreaterThan(first.landAt);
  // The later landing recorded first, then the earlier one: out of order. Then another run's, and junk.
  await simulation.run("home", "write-port.js", {
    args: [
      BATCHER_LANDING_PORT,
      recordJson(last.id, last.landAt),
      recordJson(first.id, first.landAt),
      recordJson("someone-else.0.hack.0", 0),
      JSON.stringify("junk"),
    ],
  });
  await simulation.advance(1_000);
  const after = await healthOf(simulation);
  expect(after).toMatchObject({ outOfOrder: 1, desyncs: 1, state: "recovering" });
  expect(after.unexpected).toBeGreaterThan(0);
  expect(after.problem).toContain("an unreadable landing record");
  // Once what's in flight has landed, it prepares and batches again, the problem past.
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 5_000) {
    expect(waited, "batching again within 10 virtual minutes").toBeLessThan(10 * 60_000);
    await simulation.advance(5_000);
  }
  expect((await healthOf(simulation)).problem).toBeNull();
});

test("an operation that dies is lost, counted 10 s after its time", async () => {
  const simulation = await gameWithScripts();
  await batchingBatcher(simulation);
  const victim = (await inFlight(simulation))[0] as { pid: number; landAt: number };
  const before = await healthOf(simulation);
  expect(await simulation.kill(victim.pid)).toBe(true);
  await simulation.advance(Math.ceil(victim.landAt - (await simulation.now()) + LANDING_LOST_AFTER_MS + 2_000));
  const after = await healthOf(simulation);
  expect(after.lost).toBe(before.lost + 1);
});

test("a new batcher ignores the records of the one before it, still landing, and clears their port", async () => {
  const simulation = await gameWithScripts();
  const firstPid = await batchingBatcher(simulation);
  const first = await healthOf(simulation);
  expect((await inFlight(simulation)).length).toBeGreaterThan(2);
  await simulation.kill(firstPid);
  // A record left on the port before the new one starts, which it clears: never read, so not even unexpected.
  await simulation.run("home", "write-port.js", { args: [BATCHER_LANDING_PORT, recordJson("stale.0.hack.0", 1)] });
  await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(n00dlesConfig())] });
  expect((await healthOf(simulation)).unexpected).toBe(0);
  await simulation.advance(5 * 60_000);
  const second = await healthOf(simulation);
  expect(second.runName).not.toBe(first.runName);
  // The first one's operations landed and wrote their records: counted, never trusted.
  expect(second.unexpected).toBeGreaterThan(0);
  // Its first batches may be short of RAM the first one's operations still hold: #205 starts a new batcher after them.
  expect(second).toMatchObject({ outOfOrder: 0, lost: 0, desyncs: 0, state: "batching", problem: null });
  expect(second.hacksLanded).toBeGreaterThan(0);
});
