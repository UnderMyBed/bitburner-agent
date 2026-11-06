// The batcher's operation scripts and its checks on their landings (#204), in the simulator. Each script lands its call
// at the moment named, whatever the target's security when it starts, and records it; one started too late says so,
// and a hack then doesn't run. The batcher counts a record out of order, a late one, one it can't read, one no
// operation of its own wrote (a previous batcher's) and one never written (lost), loudly; a late hack's record, written
// before its time, makes nothing out of order.
import {
  BATCH_RAM_WAIT_LOOK_MS,
  BATCH_RAM_WAIT_MS,
  BATCH_START_SLACK_MS,
  BATCHER_CONFIG_PORT,
  BATCHER_HEALTH_PORT,
  BATCHER_LANDING_PORT,
  BATCHER_SCRIPT_NAME,
  type BatcherConfig,
  type BatcherHealth,
  type BatchShort,
  batchHoldsMs,
  batchPeakRamGb,
  batchPlan,
  batchRamGb,
  batchThreads,
  hackSharePerThread,
  hackThreadsForShare,
  LANDING_LOST_AFTER_MS,
  type LandingRecord,
  leastSpacingMs,
  operationTimeMs,
  type RamWait,
  SHARE_RAM_GB,
  SHARE_ROUND_MS,
  SHARE_SCRIPT_NAME,
  shareReserveGb,
  WORKER_REPORT_PORT,
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
/** Copies a script from home to a server (the deployer's folders are on home). */
const COPY_TO = "export async function main(ns) { ns.scp(ns.args[1], ns.args[0], 'home'); }";
/** Writes its arguments, parsed from JSON, to a port. */
/** Replaces a port's contents with its argument, parsed from JSON: the Agent's config write (#205). */
const SET_PORT = `export async function main(ns) { ns.clearPort(ns.args[0]); ns.writePort(ns.args[0], JSON.parse(ns.args[1])); }`;
const WRITE_PORT = `export async function main(ns) {
  for (const each of ns.args.slice(1)) ns.writePort(ns.args[0], JSON.parse(each));
}`;
/** Logs its argument hosts' free RAM, GB, by host. */
const FREE_RAM = `export async function main(ns) {
  const free = (host) => ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
  ns.print(JSON.stringify(Object.fromEntries(ns.args.map((host) => [host, free(host)]))));
}`;
/** A player's own script, idle for an hour: 1.6 GB a thread. */
const IDLE = "export async function main(ns) { await ns.asleep(3_600_000); }";

/**
 * A new game with the batcher's scripts in its folder, and the helpers. `edit`, given, changes a script's bundled source
 * before it's written: a test's fault injection (#261's review), never a hook in the batcher itself.
 */
async function gameWithScripts(edit?: (name: string, source: string) => string): Promise<Simulation> {
  const simulation = await start(NEW_GAME);
  const { source } = await build();
  for (const name of [
    BATCHER_SCRIPT_NAME,
    "batch-hack.js",
    "batch-grow.js",
    "batch-weaken.js",
    SHARE_SCRIPT_NAME,
    "hack-loop-root.js",
  ]) {
    await simulation.writeFile("home", FOLDER + name, edit === undefined ? source(name) : edit(name, source(name)));
  }
  await simulation.writeFile("home", "read-port.js", READ_PORT);
  await simulation.writeFile("home", "write-port.js", WRITE_PORT);
  await simulation.writeFile("home", "set-port.js", SET_PORT);
  await simulation.writeFile("home", "peek-port.js", PEEK_PORT);
  await simulation.writeFile("home", "free-ram.js", FREE_RAM);
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

/**
 * Takes the hosts' free RAM with a player's own idle script (#232), as much as its 1.6 GB threads hold, so no batch
 * operation fits beside it: the pids, to kill it with.
 */
async function fillHosts(simulation: Simulation, hosts: string[]): Promise<number[]> {
  const { pid } = await simulation.run("home", "free-ram.js", { args: hosts });
  await simulation.advance(1);
  const free = JSON.parse(await printed(simulation, pid)) as Record<string, number>;
  const pids: number[] = [];
  for (const host of hosts) {
    const threads = Math.floor((free[host] ?? 0) / 1.6 + 1e-9);
    if (threads === 0) continue;
    await simulation.writeFile(host, "idle.js", IDLE);
    const started = await simulation.run(host, "idle.js", { threads });
    expect(started.error).toBeUndefined();
    pids.push(started.pid);
  }
  return pids;
}

async function readPort<Data>(simulation: Simulation, port: number): Promise<Data[]> {
  const { pid } = await simulation.run("home", "read-port.js", { args: [port] });
  await simulation.advance(100);
  return JSON.parse(await printed(simulation, pid)) as Data[];
}

/**
 * The page's monotonic clock, `performance.now()` (#251): the batcher's and its operations' clock, which a wall-clock
 * step (`stepWallClock`) leaves where it was.
 */
async function monotonicNow(simulation: Simulation): Promise<number> {
  return (await simulation.diagnostics.clock()).enginePerformanceNow;
}

test("an operation lands at the moment named, started early, at any security, and records it", async () => {
  const simulation = await gameWithScripts();
  const now = await monotonicNow(simulation);
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
  // Two threads' 0.05 each (Server/data/Constants.ts:10).
  expect((record as LandingRecord).result).toBeCloseTo(0.1, 9);
});

test("the moment named is on the page's monotonic clock (#251): the wall clock stepped either way, none lands off it", async () => {
  const simulation = await gameWithScripts();
  const landAt = (await monotonicNow(simulation)) + 10 * 60_000;
  // Started after a step forward and after a step back, each a few seconds (run #3's was +2,678 ms), and stepped again
  // while they're in flight: each lands at its moment, never late, as the game's timers never step.
  await simulation.diagnostics.stepWallClock(3_000);
  await simulation.run("home", `${FOLDER}batch-weaken.js`, {
    args: ["foodnstuff", landAt, BATCHER_LANDING_PORT, "1.weaken1.0"],
  });
  await simulation.diagnostics.stepWallClock(-5_000);
  await simulation.run("home", `${FOLDER}batch-weaken.js`, {
    args: ["foodnstuff", landAt + 20, BATCHER_LANDING_PORT, "1.weaken2.0"],
  });
  await simulation.advance(60_000);
  await simulation.diagnostics.stepWallClock(4_000);
  await simulation.advance(10 * 60_000);
  const records = await readPort<LandingRecord>(simulation, BATCHER_LANDING_PORT);
  expect(records.map(({ id, late }) => ({ id, late }))).toEqual([
    { id: "1.weaken1.0", late: false },
    { id: "1.weaken2.0", late: false },
  ]);
  for (const [index, record] of records.entries()) {
    expect(record.landAt).toBe(landAt + 20 * index);
    expect(record.landedAt - record.landAt).toBeGreaterThanOrEqual(0);
    expect(record.landedAt - record.landAt).toBeLessThanOrEqual(1);
  }
});

test("started too late: a hack doesn't run and says so; a weaken runs, late, and says so", async () => {
  const simulation = await gameWithScripts();
  const landAt = (await monotonicNow(simulation)) + 1_000;
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
async function batchingBatcher(simulation: Simulation, config = n00dlesConfig()): Promise<number> {
  await simulation.diagnostics.gainHackingExp(2_000);
  const { pid, error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, {
    args: [JSON.stringify(config)],
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
async function inFlight(
  simulation: Simulation,
  hosts = OPERATION_HOSTS,
): Promise<{ pid: number; id: string; landAt: number; target: string }[]> {
  const running = [];
  for (const host of hosts) {
    for (const process of await simulation.ps(host)) {
      running.push({
        pid: process.pid,
        id: String(process.args[3]),
        landAt: Number(process.args[1]),
        target: String(process.args[0]),
      });
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

test.each([
  ["forward", 3_000],
  ["back", -3_000],
])(
  "the wall clock stepped %s 3 s with batches in flight (#251): none out of step, late, lost or short",
  async (_, ms) => {
    const simulation = await gameWithScripts();
    // On home, made 4 TB: batches of one hack thread 400 ms apart, so the step spans several, as run #3's did.
    await simulation.diagnostics.setHomeRam(4_096);
    const atFifty = { skills: { hacking: 50, intelligence: 0 }, mults: MULTS };
    const threads = batchThreads(N00DLES, atFifty, 1);
    const spacingMs = 400;
    expect(leastSpacingMs(threads, batchHoldsMs(N00DLES, atFifty, threads), batchRamGb([2_048]))).toBeLessThan(
      spacingMs,
    );
    const hackShare = hackSharePerThread(N00DLES, atFifty);
    const config = { ...n00dlesConfig(), hosts: ["home"], hackShare, spacingMs };
    await batchingBatcher(simulation, config);
    // Its hacks landing, every 400 ms.
    await healthOnceThat(simulation, (health) => health.hacksLanded > 0, 1_000, 5 * 60_000, "hacks landing");
    const before = await healthOf(simulation);
    expect((await inFlight(simulation, ["home"])).length).toBeGreaterThan(10);
    // Run #3's: Windows Time stepped the PC's clock +2,678 ms, and the batcher, timed on it, counted 1,615 desyncs.
    await simulation.diagnostics.stepWallClock(ms);
    // A second on, the last hack is one since the step, stamped on the wall clock as it is now: its order is the
    // monotonic clock's, so a step back doesn't hold the hack before it last.
    await simulation.advance(1_000);
    const justAfter = await healthOf(simulation);
    expect(justAfter.lastHack?.atMs).toBeLessThanOrEqual(await simulation.now());
    expect(justAfter.lastHack?.atMs).toBeGreaterThan((await simulation.now()) - 1_000);
    await simulation.advance(2 * 60_000);
    const after = await healthOf(simulation);
    expect(outOfStep(after)).toEqual(outOfStep(before));
    expect(after).toMatchObject({ state: "batching", problem: null, ramWaits: before.ramWaits });
    expect(after.hacksLanded).toBeGreaterThan(before.hacksLanded);
    // The stamps the brain reads are the wall clock's, the step and all: its health's time, and its last hack's, a
    // moment ago (one lands every 400 ms).
    const wallNow = await simulation.now();
    expect(Math.abs(after.atMs - wallNow)).toBeLessThan(5_000);
    expect(after.lastHack?.atMs).toBeLessThanOrEqual(wallNow);
    expect(after.lastHack?.atMs).toBeGreaterThan(wallNow - 2_000);
  },
);

test("batching, it sleeps on the monotonic clock until its next order (#251): a minute's timers, a few a second, no spin", async () => {
  const simulation = await gameWithScripts();
  await batchingBatcher(simulation);
  const firedBefore = await simulation.diagnostics.timersFired();
  await simulation.advance(60_000);
  const fired = (await simulation.diagnostics.timersFired()) - firedBefore;
  console.log(`#251: ${fired} timers fired in a virtual minute of batching n00dles (the game's loop's 300 among them)`);
  // Its sleeps on the wall clock (`lookAt` less `Date.now()`) would all be 0: about 250 wakes a second.
  expect(fired).toBeLessThan(5_000);
});

/** What a health says went out of step, or short. */
const outOfStep = ({ desyncs, outOfOrder, outOfBounds, late, lost, batchesShort, hacksSkipped }: BatcherHealth) => ({
  desyncs,
  outOfOrder,
  outOfBounds,
  late,
  lost,
  batchesShort,
  hacksSkipped,
});

test("the wall clock stepped on while preparing, and back while sharing beside a next target's wave (#251): none out of step", {
  timeout: 120_000,
}, async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const plan = batchPlan(N00DLES, { skills: { hacking: 50, intelligence: 0 }, mults: MULTS }, batchRamGb([16, 16]));
  if (plan === null) throw new Error("no plan for n00dles on 32 GB");
  const sharing = { reserveGb: shareReserveGb(plan.peakRamGb, 0), homeKeptGb: 8, cores: {} };
  const foodnstuff = { moneyMax: 50_000_000, minDifficulty: 3, requiredHackingSkill: 1, serverGrowth: 5 };
  const next = { target: "foodnstuff", figures: foodnstuff, ramGb: 16 };
  const config: BatcherConfig = { ...n00dlesConfig(), hosts: SHARING_HOSTS, sharing, next };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  // Preparing n00dles, a wave in flight: stepped on.
  await simulation.advance(5_000);
  expect(await healthOf(simulation)).toMatchObject({ state: "preparing", wavesStarted: 1 });
  await simulation.diagnostics.stepWallClock(3_000);
  await healthOnceThat(simulation, (health) => health.state === "batching", 5_000, 20 * 60_000, "batching");
  // Batching, sharing, and foodnstuff's waves going out beside the batches: stepped back.
  const sharingNow = await healthOnceThat(
    simulation,
    (health) => (health.sharing?.threads ?? 0) > 0 && (health.next?.wavesStarted ?? 0) > 0,
    1_000,
    5 * 60_000,
    "sharing beside a next target's wave",
  );
  await simulation.diagnostics.stepWallClock(-3_000);
  let sharedAfter = 0;
  for (let elapsed = 0; elapsed < 2 * 60_000; elapsed += 5_000) {
    await simulation.advance(5_000);
    if (((await healthOf(simulation)).sharing?.threads ?? 0) > 0) sharedAfter += 1;
  }
  const after = await healthOf(simulation);
  // Nothing out of step through the step on while preparing, nor through the step back.
  expect(sharingNow).toMatchObject({ desyncs: 0, late: 0, lost: 0, batchesShort: 0, outOfBounds: 0 });
  expect(outOfStep(after)).toEqual(outOfStep(sharingNow));
  expect(after.state).toBe("batching");
  expect(after.hacksLanded).toBeGreaterThan(sharingNow.hacksLanded);
  // Its share rounds went on, and so did foodnstuff's waves, or it's ready.
  expect(sharedAfter).toBeGreaterThan(5);
  expect((after.next?.wavesStarted ?? 0) > (sharingNow.next?.wavesStarted ?? 0) || after.next?.ready).toBe(true);
});

test("a batcher before #251's wait, on the wall clock, is read as such: waited for, not for ever", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  // An older batcher's health, its latest landing 30 s from now on the wall clock (a step since doesn't matter much).
  const latestLandAt = (await simulation.now()) + 30_000;
  await simulation.run("home", "set-port.js", { args: [BATCHER_HEALTH_PORT, JSON.stringify({ latestLandAt })] });
  await simulation.advance(1);
  await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(n00dlesConfig())] });
  await simulation.advance(10_000);
  const waiting = await healthOf(simulation);
  expect(waiting.wavesStarted).toBe(0);
  // Published on its own clock, so the next batcher waits for it too.
  const untilMs = (waiting.latestLandAt ?? 0) - (await monotonicNow(simulation));
  expect(untilMs).toBeGreaterThan(19_000);
  expect(untilMs).toBeLessThanOrEqual(20_000);
  await simulation.advance(21_000);
  expect((await healthOf(simulation)).wavesStarted).toBeGreaterThan(0);
});

test("a record from a batcher before #251, its time the wall clock's, never stops the grows being looked at", async () => {
  const simulation = await gameWithScripts();
  await batchingBatcher(simulation);
  const before = await healthOf(simulation);
  // Another run's (not counted but as unexpected), landed now on the wall clock: far past every landing on this one.
  const wallNow = await simulation.now();
  await simulation.run("home", "write-port.js", {
    args: [BATCHER_LANDING_PORT, recordJson("older.0.grow.0", wallNow, { result: 1 })],
  });
  await simulation.advance(2 * 60_000);
  const after = await healthOf(simulation);
  expect(after.unexpected).toBe(before.unexpected + 1);
  // A grow every spacing (some 30 s here) is looked at; one landing just before the record may not be.
  expect(after.moneyLooks ?? 0).toBeGreaterThanOrEqual((before.moneyLooks ?? 0) + 2);
  expect(after.growsNotLooked ?? 0).toBeLessThanOrEqual((before.growsNotLooked ?? 0) + 1);
});

/** Advances in steps of `stepMs` until `done` holds, within `withinMs`: the health then. */
async function healthOnceThat(
  simulation: Simulation,
  done: (health: BatcherHealth) => boolean,
  stepMs: number,
  withinMs: number,
  what: string,
): Promise<BatcherHealth> {
  for (let waited = 0; ; waited += stepMs) {
    const health = await healthOf(simulation);
    if (done(health)) return health;
    expect(waited, `${what} within ${withinMs / 1000} virtual seconds: ${JSON.stringify(health)}`).toBeLessThan(
      withinMs,
    );
    await simulation.advance(stepMs);
  }
}

test("a grow short of the hack before it (#234): the money after it below full, counted, then the drift", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  // On home, made 1 TB: room for batches of half n00dles' money, whose grow needs 8 threads (n00dles' plan, a few %,
  // needs 1, the least there is, which no figures could make short).
  await simulation.diagnostics.setHomeRam(1_024);
  const atFifty = { skills: { hacking: 50, intelligence: 0 }, mults: MULTS };
  const hackShare = 0.5;
  const configFor = (figures: typeof N00DLES): BatcherConfig => {
    const threads = batchThreads(figures, atFifty, hackThreadsForShare(hackShare, figures, atFifty));
    const spacingMs = leastSpacingMs(threads, batchHoldsMs(figures, atFifty, threads), batchRamGb([512]));
    if (spacingMs === null) throw new Error("no batch of half n00dles' money fits 512 GB");
    return { ...n00dlesConfig(), figures, hackShare, spacingMs, hosts: ["home"] };
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  // Told the truth, it prepares n00dles and batches: each grow leaves it full.
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(configFor(N00DLES))] });
  const truthful = await healthOnceThat(simulation, (each) => (each.moneyLooks ?? 0) > 3, 1_000, 20 * 60_000, "looks");
  expect(truthful).toMatchObject({ moneyLooksBelowFull: 0, leastMoneyAfterGrow: 1, desyncs: 0 });
  // Then figures that say n00dles grows 4 times as fast as it does (a move, #206: n00dles is ready, so at once): each
  // batch's grow has about a quarter of the threads it needs.
  const overstated = configFor({ ...N00DLES, serverGrowth: 4 * N00DLES.serverGrowth });
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(overstated)] });
  // In steps of 20 ms, under the time from one batch's grow to the next one's hack (#235's review): the look below
  // full comes before the drift is a desync.
  const short = await healthOnceThat(
    simulation,
    (each) => (each.moneyLooksBelowFull ?? 0) > 0 || each.desyncs > 0,
    20,
    5 * 60_000,
    "a grow short",
  );
  expect(short).toMatchObject({ moneyLooksBelowFull: 1, desyncs: 0, leastMoneyAfterGrowOn: "n00dles" });
  // The grow made up for a part of the hack's half only.
  expect(short.leastMoneyAfterGrow).toBeLessThan(1 - hackShare / 4);
  // The next hack takes its share of less, and its grow comes up short again: the drift reaches the bounds' floor, a
  // desync, at a hack's start.
  const desynced = await healthOnceThat(simulation, (each) => each.desyncs > 0, 20, 5 * 60_000, "the drift a desync");
  expect(desynced.outOfBounds).toBeGreaterThan(0);
  // The grows landing while it recovers aren't looked at (#235's review): their money isn't theirs to answer for.
  const recovered = await healthOnceThat(
    simulation,
    (each) => each.state !== "recovering",
    200,
    10 * 60_000,
    "recovered",
  );
  expect(recovered.moneyLooks).toBe(desynced.moneyLooks);
  expect(recovered.growsNotLooked ?? 0).toBeGreaterThan(desynced.growsNotLooked ?? 0);
});

test("an operation that dies is lost, counted 10 s after its time", async () => {
  const simulation = await gameWithScripts();
  await batchingBatcher(simulation);
  const victim = (await inFlight(simulation))[0] as { pid: number; landAt: number };
  const before = await healthOf(simulation);
  expect(await simulation.kill(victim.pid)).toBe(true);
  await simulation.advance(Math.ceil(victim.landAt - (await monotonicNow(simulation)) + LANDING_LOST_AFTER_MS + 2_000));
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
  // It waited for the first one's latest landing (#205), so none of its batches was short of RAM those still held.
  expect(second).toMatchObject({
    outOfOrder: 0,
    lost: 0,
    desyncs: 0,
    batchesShort: 0,
    state: "batching",
    problem: null,
  });
  expect(second.hacksLanded).toBeGreaterThan(0);
});

test("with no argument, it reads its config from its port (#205): none yet is a problem; a new target is a move (#206)", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const { pid, error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  await simulation.advance(2_000);
  expect(await healthOf(simulation)).toMatchObject({ problem: "no config on its port yet", target: "" });
  // A config it can't read: said so.
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify({ target: "n00dles" })] });
  await simulation.advance(2_000);
  expect((await healthOf(simulation)).problem).toContain("its config can't be read");
  // A config: the problem gone, and it prepares and batches.
  const config = n00dlesConfig();
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 5_000) {
    expect(waited, "batching within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  await simulation.advance(2 * 60_000);
  const batching = await healthOf(simulation);
  expect(batching).toMatchObject({ target: "n00dles", problem: null, desyncs: 0 });
  expect(batching.hacksLanded).toBeGreaterThan(0);
  // New hosts, hot: they get the operation scripts, and the batches go on there, none short.
  const newHosts = { ...config, hosts: ["joesguns", "hong-fang-tea"] };
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(newHosts)] });
  await simulation.advance(3 * 60_000);
  const onNewHosts = await healthOf(simulation);
  expect(onNewHosts).toMatchObject({ batchesShort: batching.batchesShort, desyncs: 0, problem: null });
  expect((await simulation.ps("joesguns")).some((process) => process.filename.includes("batch-"))).toBe(true);
  // A new target, a move (#206): it prepares the new one beside the batches out, on the RAM they leave, and they
  // still land, hacks and all; no desync, nothing lost or skipped.
  const foodnstuff = { moneyMax: 50_000_000, minDifficulty: 3, requiredHackingSkill: 1, serverGrowth: 5 };
  const before = await healthOf(simulation);
  expect(before.batchesPending).toBeGreaterThan(0);
  await simulation.run("home", "set-port.js", {
    args: [BATCHER_CONFIG_PORT, JSON.stringify({ ...newHosts, target: "foodnstuff", figures: foodnstuff })],
  });
  // Read at once: the write wakes it (#211), so it doesn't wait for its next landing or launch.
  const moving = await healthOf(simulation);
  expect(moving).toMatchObject({ state: "preparing", target: "foodnstuff" });
  expect(moving.hacksSkipped).toBe(before.hacksSkipped);
  await simulation.advance(5 * 60_000);
  const moved = await healthOf(simulation);
  expect(moved).toMatchObject({ state: "preparing", target: "foodnstuff", desyncs: 0, lost: 0, outOfOrder: 0 });
  expect(moved.hacksSkipped).toBe(before.hacksSkipped);
  // Its waves take the RAM the batches out leave: started by now.
  expect(moved.wavesStarted).toBeGreaterThan(before.wavesStarted);
  // Each batch planned on n00dles hacked it after the move: none left, every one landed.
  expect(moved.batchesPending).toBe(0);
  expect(moved.hacksLanded).toBeGreaterThanOrEqual(before.hacksLanded + before.batchesPending);
  expect((await simulation.ps("home")).some((process) => process.pid === pid)).toBe(true);
});

test("one started while another waits waits too (#211): on, off, on, off, on, and none of its batches short", async () => {
  const simulation = await gameWithScripts();
  const firstPid = await batchingBatcher(simulation);
  const first = await healthOf(simulation);
  const latestInFlight = Math.max(...(await inFlight(simulation)).map((each) => each.landAt));
  await simulation.kill(firstPid);
  const second = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, {
    args: [JSON.stringify(n00dlesConfig())],
  });
  await simulation.advance(1_000);
  const waiting = await healthOf(simulation);
  expect(waiting.runName).not.toBe(first.runName);
  // It publishes the time it waits for, so a batcher started now waits for it too.
  expect(waiting.latestLandAt).toBeGreaterThanOrEqual(latestInFlight);
  await simulation.kill(second.pid);
  await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(n00dlesConfig())] });
  await simulation.advance(5 * 60_000);
  const third = await healthOf(simulation);
  expect(third.runName).not.toBe(waiting.runName);
  expect(third).toMatchObject({ state: "batching", batchesShort: 0, desyncs: 0, lost: 0, problem: null });
  expect(third.hacksLanded).toBeGreaterThan(0);
});

test("batcher-deploy.js (#205): ours on runOn once, another deployment's and extra copies stopped, none when off", async () => {
  const simulation = await gameWithScripts();
  const { source } = await build();
  const ours = "agent/0123456789ab/";
  const older = "agent/fedcba987654/";
  for (const folder of [ours, older]) {
    for (const name of [
      BATCHER_SCRIPT_NAME,
      "batch-hack.js",
      "batch-grow.js",
      "batch-weaken.js",
      "hack-loop-root.js",
    ]) {
      await simulation.writeFile("home", folder + name, source(name));
    }
  }
  await simulation.writeFile("home", `${ours}batcher-deploy.js`, source("batcher-deploy.js"));
  await simulation.writeFile("home", "copy-to.js", COPY_TO);
  // Another deployment's batcher on foodnstuff and on sigma-cosmetics, and two copies of ours on sigma-cosmetics.
  await simulation.run("home", "copy-to.js", { args: ["foodnstuff", `${older}${BATCHER_SCRIPT_NAME}`] });
  await simulation.run("home", "copy-to.js", { args: ["sigma-cosmetics", `${ours}${BATCHER_SCRIPT_NAME}`] });
  await simulation.run("home", "copy-to.js", { args: ["sigma-cosmetics", `${older}${BATCHER_SCRIPT_NAME}`] });
  await simulation.advance(1_000);
  await simulation.run("foodnstuff", `${older}${BATCHER_SCRIPT_NAME}`);
  // Another deployment's, on the host ours is wanted on too: never taken for ours.
  await simulation.run("sigma-cosmetics", `${older}${BATCHER_SCRIPT_NAME}`);
  await simulation.run("sigma-cosmetics", `${ours}${BATCHER_SCRIPT_NAME}`);
  // A second copy needs other arguments to run beside the first: a config, which it keeps.
  const second = await simulation.run("sigma-cosmetics", `${ours}${BATCHER_SCRIPT_NAME}`, {
    args: [JSON.stringify(n00dlesConfig())],
  });
  expect(second.error).toBeUndefined();
  await simulation.advance(1_000);
  const batchers = async () => {
    const found: string[] = [];
    for (const host of ["home", "foodnstuff", "sigma-cosmetics", "joesguns"]) {
      for (const process of await simulation.ps(host)) {
        if (process.filename.endsWith(`/${BATCHER_SCRIPT_NAME}`)) found.push(`${host}:${process.filename}`);
      }
    }
    return found.sort();
  };
  const deploy = async (args: string[]) => {
    await simulation.run("home", `${ours}batcher-deploy.js`, { args });
    await simulation.advance(500);
    // What the deploy worker reported, as the Agent reads it.
    const reports = await readPort<{ data: unknown }>(simulation, WORKER_REPORT_PORT);
    return reports.at(-1)?.data;
  };
  expect(await deploy(["sigma-cosmetics"])).toEqual({
    running: "sigma-cosmetics",
    started: false,
    stopped: 3,
    problem: null,
  });
  expect(await batchers()).toEqual([`sigma-cosmetics:${ours}${BATCHER_SCRIPT_NAME}`]);
  // Moved: copied to joesguns and started there, the one on sigma-cosmetics stopped.
  expect(await deploy(["joesguns"])).toEqual({ running: "joesguns", started: true, stopped: 1, problem: null });
  expect(await batchers()).toEqual([`joesguns:${ours}${BATCHER_SCRIPT_NAME}`]);
  // A host it can't run on: said so.
  expect(await deploy(["CSEC"])).toMatchObject({
    running: null,
    started: false,
    problem: expect.stringContaining("CSEC"),
  });
  // Off: none.
  expect(await deploy([])).toMatchObject({ running: null, started: false, problem: null });
  expect(await batchers()).toEqual([]);
});

/** The threads of the operations in flight against `target`, on the operation hosts. */
async function threadsAgainst(simulation: Simulation, target: string): Promise<number> {
  let threads = 0;
  for (const host of OPERATION_HOSTS) {
    for (const process of await simulation.ps(host)) {
      if (process.filename.includes("batch-") && process.args[0] === target) threads += process.threads;
    }
  }
  return threads;
}

test("the next target (#206): prepared beside the target on at most its RAM, so a move to it batches at once", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  // foodnstuff (growth 5) prepared on the hosts, slowly; n00dles, the next, on at most 7.2 GB: 4 threads.
  const foodnstuff = { moneyMax: 50_000_000, minDifficulty: 3, requiredHackingSkill: 1, serverGrowth: 5 };
  const config = {
    ...n00dlesConfig(),
    target: "foodnstuff",
    figures: foodnstuff,
    next: { target: "n00dles", figures: N00DLES, ramGb: 7.2 },
  };
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
  await simulation.advance(2_000);
  expect((await healthOf(simulation)).next).toEqual({ target: "n00dles", wavesStarted: 1, ready: false });
  for (let waited = 0; (await healthOf(simulation)).next?.ready !== true; waited += 10_000) {
    expect(waited, "n00dles prepared within 60 virtual minutes").toBeLessThan(60 * 60_000);
    expect(await threadsAgainst(simulation, "n00dles")).toBeLessThanOrEqual(4);
    await simulation.advance(10_000);
  }
  const ready = await healthOf(simulation);
  expect(ready).toMatchObject({ state: "preparing", target: "foodnstuff", desyncs: 0, lost: 0, late: 0 });
  expect(ready.next?.wavesStarted).toBeGreaterThan(1);
  // The move: n00dles prepared, it batches at once, with no wave of its own.
  const { next: _next, ...rest } = config;
  await simulation.run("home", "set-port.js", {
    args: [BATCHER_CONFIG_PORT, JSON.stringify({ ...rest, target: "n00dles", figures: N00DLES })],
  });
  await simulation.advance(2_000);
  const moved = await healthOf(simulation);
  expect(moved).toMatchObject({ state: "batching", target: "n00dles", next: null, desyncs: 0 });
  await simulation.advance(3 * 60_000);
  const batching = await healthOf(simulation);
  expect(batching).toMatchObject({ state: "batching", desyncs: 0, lost: 0, late: 0, outOfBounds: 0 });
  expect(batching.hacksLanded).toBeGreaterThan(0);
});

test("a last wave on a target at its minimum, with room beside it, starts the batches at once (#206)", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  // n00dles from a fresh start's 4%, at its minimum security already: one grow wave; on six hosts, room for batches.
  const hosts = [...OPERATION_HOSTS, "joesguns", "nectar-net", "hong-fang-tea", "harakiri-sushi"];
  const plan = batchPlan(N00DLES, { skills: { hacking: 50, intelligence: 0 }, mults: MULTS }, batchRamGb([16]));
  // The plan for one host's RAM beside the wave on six: room to spare, counted a thread short on each (#232).
  const config = { ...n00dlesConfig(), hosts, hackShare: plan?.hackShare ?? 0, spacingMs: plan?.spacingMs ?? 0 };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  await simulation.advance(1_000);
  const started = await healthOf(simulation);
  // The wave out, and batching already: the batches' hacks land a hack's time after the wave, not a weaken's.
  expect(started).toMatchObject({ state: "batching", wavesStarted: 1 });
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 1_000) {
    expect(waited, "a hack within a weaken's time and a hack's").toBeLessThan(6 * 60_000);
    await simulation.advance(1_000);
  }
  const landed = await healthOf(simulation);
  expect(landed).toMatchObject({ desyncs: 0, late: 0, lost: 0, outOfBounds: 0, batchesShort: 0 });
});

test("a move back to a target its batches still land on waits for them, no wave among them (#216's review)", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  const config = n00dlesConfig();
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 5_000) {
    expect(waited, "hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  const before = await healthOf(simulation);
  expect(before.batchesPending).toBeGreaterThan(0);
  // Away to foodnstuff and straight back: n00dles' batches are all still landing.
  const foodnstuff = { moneyMax: 50_000_000, minDifficulty: 3, requiredHackingSkill: 1, serverGrowth: 5 };
  await simulation.run("home", "set-port.js", {
    args: [BATCHER_CONFIG_PORT, JSON.stringify({ ...config, target: "foodnstuff", figures: foodnstuff })],
  });
  await simulation.advance(1_000);
  expect((await healthOf(simulation)).target).toBe("foodnstuff");
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
  expect(await healthOf(simulation)).toMatchObject({ state: "preparing", target: "n00dles" });
  // No n00dles preparation wave while its batches land; then it batches n00dles again, in step.
  const n00dlesWaves = async () =>
    (await inFlight(simulation)).filter((each) => /.pd+./.test(each.id) && each.target === "n00dles").length;
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 1_000) {
    expect(waited, "batching again within 10 virtual minutes").toBeLessThan(10 * 60_000);
    if ((await healthOf(simulation)).batchesPending > 0) expect(await n00dlesWaves()).toBe(0);
    await simulation.advance(1_000);
  }
  await simulation.advance(2 * 60_000);
  expect(await healthOf(simulation)).toMatchObject({ desyncs: 0, late: 0, lost: 0, outOfBounds: 0 });
});

/** Logs the game's share bonus now (`ns.getSharePower()`, NetworkShare/Share.ts:55-57). */
const SHARE_POWER = "export async function main(ns) { ns.print(JSON.stringify([ns.getSharePower()])); }";
/** Grows n00dles until its money is at its maximum. */
const GROW_TO_MAXIMUM = `export async function main(ns) {
  while (ns.getServerMoneyAvailable("n00dles") < ns.getServerMaxMoney("n00dles")) await ns.grow("n00dles");
}`;
/** Six no-port servers of 16 GB: the batches' plan takes two's worth, the share the room the reserve leaves. */
const SHARING_HOSTS = [...OPERATION_HOSTS, "joesguns", "nectar-net", "hong-fang-tea", "harakiri-sushi"];

/** The share processes running on the hosts: their threads, and each round's name (`<run>.s<round>.<part>`). */
async function sharesRunning(simulation: Simulation): Promise<{ threads: number; rounds: string[] }> {
  let threads = 0;
  const rounds = new Set<string>();
  for (const host of SHARING_HOSTS) {
    for (const process of await simulation.ps(host)) {
      if (!process.filename.endsWith(`/${SHARE_SCRIPT_NAME}`)) continue;
      threads += process.threads;
      rounds.add(String(process.args[0]).split(".").slice(0, 2).join("."));
    }
  }
  return { threads, rounds: [...rounds] };
}

test("sharing (#224): on its hosts only while batching and asked, every 5 s; off, its RAM back", async () => {
  const simulation = await gameWithScripts();
  await simulation.writeFile("home", "share-power.js", SHARE_POWER);
  await simulation.diagnostics.gainHackingExp(2_000);
  // n00dles grown to its maximum from foodnstuff, its security left above its minimum (a grow's 0.004 a thread): its
  // last wave, a little weaken, lands before it batches, so the batcher prepares for a weaken's time, with room beside it.
  await simulation.writeFile("foodnstuff", "grow.js", GROW_TO_MAXIMUM);
  expect((await simulation.run("foodnstuff", "grow.js", { threads: 8 })).error).toBeUndefined();
  await simulation.advance(15 * 60_000);
  expect((await simulation.ps("foodnstuff")).some((process) => process.filename === "grow.js")).toBe(false);
  const plan = batchPlan(N00DLES, { skills: { hacking: 50, intelligence: 0 }, mults: MULTS }, batchRamGb([16, 16]));
  if (plan === null) throw new Error("no plan for n00dles on 32 GB");
  const reserveGb = shareReserveGb(plan.peakRamGb, 0);
  const sharing = { reserveGb, homeKeptGb: 8, cores: {} };
  const config = { ...n00dlesConfig(), hosts: SHARING_HOSTS, sharing };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
  // Preparing: asked, but no share, the waves have the RAM.
  let preparingLooks = 0;
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 100) {
    expect(waited, "batching within 20 virtual minutes").toBeLessThan(20 * 60_000);
    expect((await sharesRunning(simulation)).threads).toBe(0);
    preparingLooks += 1;
    await simulation.advance(100);
  }
  expect(preparingLooks, "preparing for a while, with room beside the wave").toBeGreaterThan(200);
  // Batching, seen within 100 ms: its hosts share at once (#242's review), a look as they may, not home's next, up to
  // 5 s on.
  for (let waited = 0; (await sharesRunning(simulation)).threads === 0; waited += 50) {
    expect(waited, "sharing on its hosts within 300 ms of batching").toBeLessThan(300);
    await simulation.advance(50);
  }
  // Batching: a round at most every 5 s, each on the room the reserve leaves of the 96 GB, to at most 80% of it.
  const firstSeen = new Map<string, number>();
  let samplesSharing = 0;
  let countedOther = 0;
  let bonusChecked = false;
  const SAMPLES = 90;
  for (let sample = 0; sample < SAMPLES; sample++) {
    await simulation.advance(1_000);
    const running = await sharesRunning(simulation);
    for (const round of running.rounds) if (!firstSeen.has(round)) firstSeen.set(round, await simulation.now());
    if (running.threads > 0) samplesSharing += 1;
    expect(running.threads * 4, "within the room the reserve leaves").toBeLessThanOrEqual(96 - reserveGb);
    expect(running.threads * 4, "within 80% of the hosts' RAM").toBeLessThanOrEqual(0.8 * 96);
    const health = await healthOf(simulation);
    expect(health).toMatchObject({ desyncs: 0, late: 0, lost: 0, batchesShort: 0, outOfBounds: 0 });
    expect(health.sharing?.wanted).toBe(true);
    // The threads it counts are the ones running: a round's count ends as its threads do, never added to the next's.
    if (health.sharing?.threads !== running.threads) countedOther += 1;
    // The bonus it reports is the game's own, while the threads it counts are the ones running.
    if (!bonusChecked && running.threads > 0 && health.sharing?.threads === running.threads) {
      const { pid } = await simulation.run("home", "share-power.js");
      await simulation.advance(1);
      const [power] = JSON.parse(await printed(simulation, pid)) as [number];
      expect(power).toBeGreaterThan(1);
      expect(health.sharing.bonus).toBeCloseTo(power, 12);
      expect(health.sharing.ramGb).toBe(running.threads * 4);
      // All of it on its hosts (#230): home, 8 GB, keeps its 8.
      expect(health.sharing.hostsRamGb).toBe(running.threads * 4);
      bonusChecked = true;
    }
  }
  expect(bonusChecked, "a look with its count of threads running").toBe(true);
  expect(countedOther, "looks whose count wasn't the threads running").toBeLessThanOrEqual(2);
  // Each round's threads end after 10 s, and the next starts as their RAM comes back: sharing almost all the time.
  expect(samplesSharing).toBeGreaterThan(SAMPLES * 0.85);
  const starts = [...firstSeen.values()].sort((a, b) => a - b);
  expect(starts.length).toBeGreaterThanOrEqual(SAMPLES / 15);
  // Seen a second at a time (#242's review): one round every 5 s, each at least 4 s from the last, and about 18 in the
  // 90 s. On the simulator's page a half's RAM comes back on time, so no top-up adds a round. Halves in step, as without
  // the 5 s between looks or with a top-up that never ends, start in pairs (18 in 9 pairs); a top-up past a half's fair
  // share, one never spent, or a round beside a half ending adds rounds (19 or 21, a second from another).
  for (const [index, startedAt] of starts.entries()) {
    const previous = starts[index - 1];
    if (previous !== undefined) expect(startedAt - previous).toBeGreaterThanOrEqual(SHARE_ROUND_MS - 1_000);
  }
  expect(starts.length).toBeLessThanOrEqual((SAMPLES / SHARE_ROUND_MS) * 1_000 + 2);
  // A reserve that leaves no room: the rounds stop, and the threads end, their RAM back.
  await simulation.run("home", "set-port.js", {
    args: [BATCHER_CONFIG_PORT, JSON.stringify({ ...config, sharing: { ...sharing, reserveGb: 96 } })],
  });
  await simulation.advance(12_000);
  expect((await sharesRunning(simulation)).threads).toBe(0);
  expect((await healthOf(simulation)).sharing).toMatchObject({ wanted: true, threads: 0, roomGb: 0 });
  // Asked again, then no longer (the faction work over): no new round, the last ends within 10 s, and it says none.
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
  // Its looks for room, none found, come every 100 ms: the room back is taken within a second, not a round's 5 s.
  await simulation.advance(1_000);
  expect((await sharesRunning(simulation)).threads).toBeGreaterThan(0);
  const { sharing: _sharing, ...unshared } = config;
  // Off and on again within a round's 5 s (#242's review): looked at again at once, its health whole, the bonus
  // possible never under the one running.
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(unshared)] });
  await simulation.advance(300);
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
  await simulation.advance(200);
  const toggled = (await healthOf(simulation)).sharing;
  expect(toggled).toMatchObject({ wanted: true, homeGb: 8, homeKeptGb: 8 });
  expect(toggled?.threads).toBeGreaterThan(0);
  expect(toggled?.possibleBonus).toBeGreaterThanOrEqual(toggled?.bonus ?? Number.POSITIVE_INFINITY);
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(unshared)] });
  await simulation.advance(12_000);
  expect((await sharesRunning(simulation)).threads).toBe(0);
  for (const host of SHARING_HOSTS) {
    expect(
      (await simulation.ps(host)).some((process) => process.filename.endsWith(SHARE_SCRIPT_NAME)),
      host,
    ).toBe(false);
  }
  const after = await healthOf(simulation);
  expect(after.sharing).toBeNull();
  expect(after).toMatchObject({ state: "batching", desyncs: 0, late: 0, lost: 0, batchesShort: 0, problem: null });
  await simulation.advance(60_000);
  expect((await sharesRunning(simulation)).threads).toBe(0);
  // Asked again, then a move (#226's review): the new target's first wave waits for the share threads to end, so it has
  // their RAM, then goes out.
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
  await simulation.advance(2_000);
  expect((await sharesRunning(simulation)).threads).toBeGreaterThan(0);
  const beforeMove = await healthOf(simulation);
  const foodnstuff = { moneyMax: 50_000_000, minDifficulty: 3, requiredHackingSkill: 1, serverGrowth: 5 };
  await simulation.run("home", "set-port.js", {
    args: [BATCHER_CONFIG_PORT, JSON.stringify({ ...config, target: "foodnstuff", figures: foodnstuff })],
  });
  await simulation.advance(500);
  expect(await healthOf(simulation)).toMatchObject({ state: "preparing", wavesStarted: beforeMove.wavesStarted });
  expect((await sharesRunning(simulation)).threads).toBeGreaterThan(0);
  await simulation.advance(10_000);
  expect((await sharesRunning(simulation)).threads).toBe(0);
  expect((await healthOf(simulation)).wavesStarted).toBeGreaterThan(beforeMove.wavesStarted);
});

/** The share threads running on home. */
async function sharesOnHome(simulation: Simulation): Promise<number> {
  return (await simulation.ps("home"))
    .filter((process) => process.filename.endsWith(`/${SHARE_SCRIPT_NAME}`))
    .reduce((sum, process) => sum + process.threads, 0);
}

/** Polls the game's share bonus every 10 ms for its argument's ms: how many polls found it ×1.0, of how many. */
const SHARE_POWER_POLL = `export async function main(ns) {
  let atOne = 0, polls = 0, least = Infinity;
  for (const until = performance.now() + ns.args[0]; performance.now() < until; await ns.asleep(10)) {
    const power = ns.getSharePower();
    polls += 1;
    least = Math.min(least, power);
    if (power <= 1) atOne += 1;
  }
  ns.print(JSON.stringify({ atOne, polls, least }));
}`;

test("sharing in two halves (#242): as one ends the other holds, never x1.0 between rounds", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.setHomeRam(64);
  await simulation.writeFile("home", "share-power-poll.js", SHARE_POWER_POLL);
  await simulation.diagnostics.gainHackingExp(2_000);
  const plan = batchPlan(N00DLES, { skills: { hacking: 50, intelligence: 0 }, mults: MULTS }, batchRamGb([16, 16]));
  if (plan === null) throw new Error("no plan for n00dles on 32 GB");
  const sharing = { reserveGb: shareReserveGb(plan.peakRamGb, 0), homeKeptGb: 8, cores: {} };
  const config = { ...n00dlesConfig(), hosts: SHARING_HOSTS, sharing };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  for (let waited = 0; (await sharesRunning(simulation)).threads === 0; waited += 1_000) {
    expect(waited, "sharing on its hosts within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(1_000);
  }
  // Past the first round's half alone, into the halves' rhythm.
  await simulation.advance(10_000);
  // The game's bonus, every 10 ms for 40 s, four rounds' ends: before #242, all the threads ended at once, and nothing
  // shared until the next round took their RAM, a landing's 20 ms here, as long as the page's lag on a busy one.
  const { pid } = await simulation.run("home", "share-power-poll.js", { args: [40_000] });
  let samplesWithTwoRounds = 0;
  /** Every round seen over the 40 s. */
  const roundsSeen = new Set<string>();
  let mostInOneRound = 0;
  let mostThreads = 0;
  let healthChecked = 0;
  for (let second = 0; second < 40; second++) {
    await simulation.advance(1_000);
    const roundThreads = new Map<string, number>();
    for (const host of [...SHARING_HOSTS, "home"]) {
      for (const process of await simulation.ps(host)) {
        if (!process.filename.endsWith(`/${SHARE_SCRIPT_NAME}`)) continue;
        const round = String(process.args[0]).split(".").slice(0, 2).join(".");
        roundThreads.set(round, (roundThreads.get(round) ?? 0) + process.threads);
        roundsSeen.add(round);
      }
    }
    if (roundThreads.size >= 2) samplesWithTwoRounds += 1;
    mostInOneRound = Math.max(mostInOneRound, ...roundThreads.values());
    const total = [...roundThreads.values()].reduce((sum, threads) => sum + threads, 0);
    mostThreads = Math.max(mostThreads, total);
    // The bonus possible on the RAM free (#242): the share's threads and the room, never under what runs; with both
    // halves out, within a few threads' worth of it.
    const { sharing: reported } = await healthOf(simulation);
    expect(reported?.possibleBonus).toBeGreaterThanOrEqual(reported?.bonus ?? Number.POSITIVE_INFINITY);
    if (roundThreads.size >= 2 && reported?.threads === total) {
      expect((reported.possibleBonus ?? 0) - reported.bonus).toBeLessThan(0.01);
      healthChecked += 1;
    }
    // Home's RAM, and free beyond the 8 kept, as the game has it.
    expect(reported).toMatchObject({ homeGb: 64, homeKeptGb: 8 });
    expect(reported?.homeFreeGb).toBeGreaterThanOrEqual(0);
    expect(reported?.homeFreeGb).toBeLessThan(SHARE_RAM_GB);
  }
  const polled = JSON.parse(await printed(simulation, pid)) as { atOne: number; polls: number; least: number };
  console.log(`#242: the share's bonus polled every 10 ms for 40 s: ${JSON.stringify(polled)}`);
  expect(polled.polls).toBeGreaterThan(3_000);
  expect(polled.atOne).toBe(0);
  expect(samplesWithTwoRounds).toBeGreaterThanOrEqual(35);
  console.log(`#242: rounds seen over 40 s: ${roundsSeen.size}`);
  // Every 20 ms for 21 s, past four halves' ends (#242's review): a round starts only once the half it replaces has
  // ended on every host, never beside a half ending (over 9.5 s old) on one while another host has room.
  const firstSeenAt = new Map<string, number>();
  let newBesideEnding = 0;
  let newRounds = 0;
  for (let elapsed = 0; elapsed < 21_000; elapsed += 20) {
    await simulation.advance(20);
    const rounds = new Set<string>();
    for (const host of [...SHARING_HOSTS, "home"]) {
      for (const process of await simulation.ps(host)) {
        if (process.filename.endsWith(`/${SHARE_SCRIPT_NAME}`)) {
          rounds.add(String(process.args[0]).split(".").slice(0, 2).join("."));
        }
      }
    }
    const fresh = [...rounds].filter((round) => !firstSeenAt.has(round));
    const ending = [...rounds].some((round) => elapsed - (firstSeenAt.get(round) ?? elapsed) > 9_500);
    if (elapsed > 0 && fresh.length > 0) {
      newRounds += 1;
      if (ending) newBesideEnding += 1;
    }
    for (const round of fresh) firstSeenAt.set(round, elapsed);
  }
  expect(newRounds).toBeGreaterThanOrEqual(3);
  expect(newBesideEnding).toBe(0);
  // Each round about half of the most shared at once.
  expect(mostInOneRound).toBeLessThanOrEqual(Math.ceil(mostThreads / 2) + 1);
  expect(healthChecked).toBeGreaterThan(0);
  expect(await healthOf(simulation)).toMatchObject({ batchesShort: 0, late: 0, lost: 0, desyncs: 0 });
});

test("home shares while the batcher prepares (#242); the waves wait only for its hosts' share", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.setHomeRam(64);
  await simulation.diagnostics.gainHackingExp(2_000);
  // n00dles from a fresh start's 4% on two 16 GB hosts: several waves, a few minutes preparing.
  const config = { ...n00dlesConfig(), sharing: { reserveGb: 0, homeKeptGb: 8, cores: {} } };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  let preparingLooks = 0;
  let sharingWhilePreparing = 0;
  const onHome: number[] = [];
  /** Each round's threads on home, by its name. */
  const homeRounds = new Map<string, number>();
  let firstHalfChecked = false;
  for (let waited = 0; (await healthOf(simulation)).state === "preparing"; waited += 1_000) {
    expect(waited, "batching within 20 virtual minutes: the waves never held by home's share").toBeLessThan(
      20 * 60_000,
    );
    await simulation.advance(1_000);
    const health = await healthOf(simulation);
    if (health.state !== "preparing") break;
    preparingLooks += 1;
    // None on its hosts while it prepares: the waves have their RAM.
    expect(health.sharing?.hostsRamGb).toBe(0);
    expect((await inFlight(simulation)).filter(({ id }) => !/\.p\d+\./.test(id))).toEqual([]);
    const threadsOnHome = await sharesOnHome(simulation);
    onHome.push(threadsOnHome);
    for (const process of await simulation.ps("home")) {
      if (!process.filename.endsWith(`/${SHARE_SCRIPT_NAME}`)) continue;
      const round = String(process.args[0]).split(".").slice(0, 2).join(".");
      homeRounds.set(round, Math.max(homeRounds.get(round) ?? 0, process.threads));
    }
    if (threadsOnHome > 0 && (health.sharing?.threads ?? 0) > 0) sharingWhilePreparing += 1;
    // Its first round, half of home's room (#242): the bonus possible is the whole room's, a half's worth more.
    if (!firstHalfChecked && threadsOnHome > 0) {
      expect((health.sharing?.possibleBonus ?? 0) - (health.sharing?.bonus ?? 0)).toBeGreaterThan(0.02);
      firstHalfChecked = true;
    }
  }
  expect(preparingLooks, "preparing for a while").toBeGreaterThan(30);
  // Home shared all along but its first seconds and the turns of its halves, seen a second at a time.
  expect(sharingWhilePreparing).toBeGreaterThan(preparingLooks - 5);
  // Both halves out nearly all the time: a half's RAM taken again within moments of its end, not a round's 5 s later.
  const most = Math.max(...onHome);
  expect(onHome.filter((threads) => threads >= most - 1).length).toBeGreaterThan(0.8 * onHome.length);
  // Each round a half of it, so the other half holds as one ends.
  expect(homeRounds.size).toBeGreaterThan(preparingLooks / 6);
  expect(Math.max(...homeRounds.values())).toBeLessThanOrEqual(Math.ceil(most / 2));
  expect(await healthOf(simulation)).toMatchObject({ state: "batching", desyncs: 0, late: 0, lost: 0 });
});

/**
 * A busy page's late release on home: looking every 10 ms, as a share half's RAM comes back (8 GB or more free above
 * the 8 GB home keeps and the test's looks), takes half of it for `holdMs`, so the batcher's look finds only the rest;
 * once a release, until the share has the rest.
 */
const HOLD_HALF_ON_RELEASE = `export async function main(ns) {
  const [holdMs] = ns.args;
  for (let round = 0; ; round++) {
    const freeGb = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") - 9.65;
    if (freeGb >= 8) {
      ns.exec("brief.js", "home", Math.floor(freeGb / 2 / 1.6 + 1e-9), holdMs, round);
      await ns.asleep(holdMs + 50);
      // Once a release: until the share has taken the rest.
      while (ns.getServerMaxRam("home") - ns.getServerUsedRam("home") - 9.65 >= 4) await ns.asleep(10);
    }
    await ns.asleep(10);
  }
}`;

/** Each share round on home now, by its name (`<run>.s<round>`), and its threads. */
async function homeRoundsNow(simulation: Simulation): Promise<Map<string, number>> {
  const rounds = new Map<string, number>();
  for (const process of await simulation.ps("home")) {
    if (!process.filename.endsWith(`/${SHARE_SCRIPT_NAME}`)) continue;
    const round = String(process.args[0]).split(".").slice(0, 2).join(".");
    rounds.set(round, (rounds.get(round) ?? 0) + process.threads);
  }
  return rounds;
}

test("a half's RAM taken again as it comes back (#242's review), and topped up after a late release", {
  timeout: 300_000,
}, async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.setHomeRam(64);
  await simulation.diagnostics.gainHackingExp(2_000);
  // n00dles from a fresh start's 4% on one 16 GB host: preparing for minutes, home alone sharing beside the waves.
  const config = {
    ...n00dlesConfig(),
    hosts: ["foodnstuff"],
    sharing: { reserveGb: 0, homeKeptGb: 8, cores: {} },
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  await simulation.advance(12_000);
  // Every 20 ms for 21 s, past two halves' ends: each round that ends is followed by another within 60 ms, its RAM's
  // release (20 ms) and a wake, not at the next second's look.
  let seen = await homeRoundsNow(simulation);
  const endedAt = new Map<string, number>();
  const startedAt = new Map<string, number>();
  for (let elapsed = 20; elapsed <= 21_000; elapsed += 20) {
    await simulation.advance(20);
    const now = await homeRoundsNow(simulation);
    for (const round of seen.keys()) if (!now.has(round)) endedAt.set(round, elapsed);
    for (const round of now.keys()) if (!seen.has(round)) startedAt.set(round, elapsed);
    seen = now;
  }
  expect((await healthOf(simulation)).state).toBe("preparing");
  expect(endedAt.size).toBeGreaterThanOrEqual(3);
  for (const [round, endMs] of endedAt) {
    const next = [...startedAt.values()].filter((startMs) => startMs >= endMs).sort((a, b) => a - b)[0];
    expect(next, `a round after ${round} ended at ${endMs} ms`).toBeDefined();
    expect((next as number) - endMs, `the round after ${round}`).toBeLessThanOrEqual(60);
  }
  const full = [...(await homeRoundsNow(simulation)).values()].reduce((sum, threads) => sum + threads, 0);
  // Then a busy page's late release: half of each half's RAM is taken for 300 ms as it comes back, so the round that
  // replaces it starts short. It looks again 100 ms on, and on, and takes the rest once it's free: both halves out
  // nearly all the time (the holder's own script takes a thread's RAM), not one short for a round's 5 s.
  await simulation.writeFile("home", "brief.js", BRIEF);
  await simulation.writeFile("home", "hold-half-on-release.js", HOLD_HALF_ON_RELEASE);
  const holding = await simulation.run("home", "hold-half-on-release.js", { args: [300] });
  expect(holding.error).toBeUndefined();
  let samples = 0;
  let nearlyFull = 0;
  for (let second = 0; second < 60; second++) {
    await simulation.advance(1_000);
    const total = [...(await homeRoundsNow(simulation)).values()].reduce((sum, threads) => sum + threads, 0);
    samples += 1;
    if (total >= full - 2) nearlyFull += 1;
  }
  await simulation.kill(holding.pid);
  console.log(`#242's review: home's halves nearly full in ${nearlyFull} of ${samples} seconds beside late releases`);
  expect(nearlyFull).toBeGreaterThan(0.8 * samples);
});

test("while asked, its health goes out at least every 10 s, though nothing in it changes (#242's review)", {
  timeout: 300_000,
}, async () => {
  // Preparing foodnstuff from its security of 10 at hacking 50: a weaken of minutes, nothing else changing, and home
  // (8 GB) with nothing to share. Before, the health went out only each minute, and the brain, which reads one
  // unchanged for 20 s as a stopped batcher's, counted no sharing at all.
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const foodnstuff = { moneyMax: 50_000_000, minDifficulty: 3, requiredHackingSkill: 1, serverGrowth: 5 };
  const config = {
    ...n00dlesConfig(),
    target: "foodnstuff",
    figures: foodnstuff,
    sharing: { reserveGb: 0, homeKeptGb: 8, cores: {} },
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  await simulation.advance(5_000);
  const stamps: number[] = [];
  /** Each stamp's health with its stamp zeroed: one the same as the stamp before was sent again, not changed. */
  const contents: string[] = [];
  for (let second = 0; second < 60; second += 2) {
    const health = await healthOf(simulation);
    expect(health.state).toBe("preparing");
    expect(health.sharing?.wanted).toBe(true);
    if (stamps.at(-1) !== health.atMs) {
      stamps.push(health.atMs);
      contents.push(JSON.stringify({ ...health, atMs: 0 }));
    }
    await simulation.advance(2_000);
  }
  const sentAgain = contents.filter((content, index) => index > 0 && content === contents[index - 1]).length;
  expect(sentAgain, "healths sent again unchanged").toBeGreaterThanOrEqual(2);
  const gaps = stamps.slice(1).map((stamp, index) => stamp - (stamps[index] as number));
  console.log(`#242's review: health stamps ${gaps.length + 1}, the longest between ${Math.max(...gaps)} ms`);
  expect(gaps.length).toBeGreaterThanOrEqual(5);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(12_000);
});

test("sharing (#224) uses home's RAM above what it keeps for the Agent, beside its hosts (#226's review)", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.setHomeRam(64);
  await simulation.diagnostics.gainHackingExp(2_000);
  // A reserve that leaves its hosts no room: only home shares.
  const config = { ...n00dlesConfig(), sharing: { reserveGb: 1_000, homeKeptGb: 8, cores: {} } };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 5_000) {
    expect(waited, "batching within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  await simulation.advance(30_000);
  const onHome = (await simulation.ps("home")).filter((process) => process.filename.endsWith(SHARE_SCRIPT_NAME));
  const threads = onHome.reduce((sum, process) => sum + process.threads, 0);
  // 64 GB less the batcher's 3.85 and the 8 kept: 13 threads, at most.
  expect(threads).toBeGreaterThan(0);
  expect(threads * 4).toBeLessThanOrEqual(64 - 3.85 - 8);
  expect((await sharesRunning(simulation)).threads).toBe(0);
  // None on its hosts (#230): home is beside them.
  expect((await healthOf(simulation)).sharing).toMatchObject({ threads, hostsRamGb: 0 });
});

test("no share on its hosts while a last wave lands (#226's review); home's goes on (#242)", async () => {
  const simulation = await gameWithScripts();
  // A large home beside them (#242's review): it shares through it all, the wave's RAM not its own.
  await simulation.diagnostics.setHomeRam(64);
  await simulation.diagnostics.gainHackingExp(2_000);
  // n00dles from a fresh start's 4%, at its minimum: one large grow wave, and the batches start beside it at once, the
  // first planned while it lands (a plan on 20 GB, 50 s apart, where the wave leaves 24).
  const plan = batchPlan(N00DLES, { skills: { hacking: 50, intelligence: 0 }, mults: MULTS }, 20);
  if (plan === null) throw new Error("no plan for n00dles on 20 GB");
  const sharing = { reserveGb: shareReserveGb(plan.peakRamGb, 0), homeKeptGb: 8, cores: {} };
  const config = {
    ...n00dlesConfig(),
    hosts: SHARING_HOSTS,
    hackShare: plan.hackShare,
    spacingMs: plan.spacingMs,
    sharing,
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  await simulation.advance(1_000);
  expect(await healthOf(simulation)).toMatchObject({ state: "batching", wavesStarted: 1 });
  let sharedAt: number | null = null;
  let looksBefore = 0;
  let homeSharedBefore = 0;
  for (let waited = 0; sharedAt === null; waited += 1_000) {
    expect(waited, "sharing within 10 virtual minutes").toBeLessThan(10 * 60_000);
    const health = await healthOf(simulation);
    expect(health).toMatchObject({ batchesShort: 0, late: 0, lost: 0, desyncs: 0 });
    looksBefore += 1;
    if ((await sharesOnHome(simulation)) > 0) homeSharedBefore += 1;
    if ((await sharesRunning(simulation)).threads > 0) {
      // Not before the batches planned beside the wave have landed: their hacks first.
      expect(health.hacksLanded).toBeGreaterThan(0);
      sharedAt = await simulation.now();
    }
    await simulation.advance(1_000);
  }
  // Home shared while the wave and the batches beside it landed, all but its first look.
  expect(looksBefore).toBeGreaterThan(5);
  expect(homeSharedBefore).toBeGreaterThanOrEqual(looksBefore - 1);
  await simulation.advance(2 * 60_000);
  expect(await healthOf(simulation)).toMatchObject({ batchesShort: 0, late: 0, lost: 0, desyncs: 0 });
});

test("no share on its hosts for a minute after a batch comes up short of RAM (#226's review)", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  // No reserve, and six hosts for a plan on two: a share takes any room. Once batching, a player's own script takes
  // the hosts' free RAM, and batches planned before come up short (#232: the batcher plans none its RAM can't hold).
  const config = { ...n00dlesConfig(), hosts: SHARING_HOSTS, sharing: { reserveGb: 0, homeKeptGb: 8, cores: {} } };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  for (let waited = 0; (await sharesRunning(simulation)).threads === 0; waited += 1_000) {
    expect(waited, "sharing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(1_000);
  }
  // Once a batch is planned whose hack isn't out, its RAM taken, again as the share threads end.
  for (let waited = 0; (await healthOf(simulation)).batchesPending === 0; waited += 100) {
    expect(waited, "a batch planned within 2 virtual minutes").toBeLessThan(2 * 60_000);
    await simulation.advance(100);
  }
  const fillers: number[] = [];
  for (let waited = 0; (await healthOf(simulation)).batchesShort === 0; waited += 1_000) {
    expect(waited, "a batch short within 2 virtual minutes").toBeLessThan(2 * 60_000);
    fillers.push(...(await fillHosts(simulation, SHARING_HOSTS)));
    await simulation.advance(1_000);
  }
  // Its record says what held the RAM (#246's review): the share's threads on its hosts among it, and the player's.
  const [short] = (await healthOf(simulation)).shorts ?? [];
  console.log(`#246's review: a short beside the share on its hosts: ${JSON.stringify(short)}`);
  expect(short?.sharingGb).toBeGreaterThan(0);
  expect(short?.othersGb).toBeGreaterThan(0);
  // The room back at once; a round started before the short ends within 10 s, and none starts after it for a minute.
  for (const pid of fillers) await simulation.kill(pid);
  await simulation.advance(10_500);
  for (let sample = 0; sample < 45; sample++) {
    expect((await sharesRunning(simulation)).threads, `${sample + 10} s after the first short`).toBe(0);
    await simulation.advance(1_000);
  }
  // And after the minute, it shares again.
  for (let waited = 0; (await sharesRunning(simulation)).threads === 0; waited += 1_000) {
    expect(waited, "sharing again within 2 virtual minutes of the hold-off").toBeLessThan(2 * 60_000);
    await simulation.advance(1_000);
  }
});

test("a batch short beside a share on home alone isn't the share's (#230): the same batches come up short without it", async () => {
  // #229's augmentations suite: after an install, home (64 GB) shares beside the hosts, whose reserve leaves them none;
  // batches came up short of their own (#232), and the share was blamed. Here, a player's own script takes the hosts'
  // free RAM at the same moment in both, and (#231's review) gives it back after the first short. Home shares through
  // the hold-off after a short (#242): the hold-off keeps the share off the batches' hosts, and home isn't one.
  const unshared = n00dlesConfig();
  const shared = { ...unshared, sharing: { reserveGb: 1_000, homeKeptGb: 8, cores: {} } };
  /**
   * The batcher's first short, from its start, the hosts' free RAM taken from 3 minutes into batching, once a batch
   * is planned whose hack isn't out, and again each second as landings free it, then given back at the first short;
   * then its counts 4 minutes after it, past the minute's hold-off after a short (`SHARE_AFTER_SHORT_MS`), whether
   * home shared again by then, and of the looks within the hold-off, from 15 s to 55 s after it, those home shared at.
   */
  const firstShortOf = async (config: BatcherConfig) => {
    const simulation = await gameWithScripts();
    await simulation.diagnostics.setHomeRam(64);
    await simulation.diagnostics.gainHackingExp(2_000);
    await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
    const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
    expect(error).toBeUndefined();
    const startedAt = await simulation.now();
    let batchingAt: number | null = null;
    let fillers: number[] | null = null;
    let first: { afterMs: number; health: BatcherHealth } | null = null;
    let sharedAgain = false;
    const holdOff = { looks: 0, shared: 0 };
    for (let waited = 0; ; waited += 1_000) {
      expect(waited, "a batch short within 20 virtual minutes").toBeLessThan(20 * 60_000);
      const health = await healthOf(simulation);
      // None of its hosts' RAM shared, ever: the reserve leaves them none.
      expect((await sharesRunning(simulation)).threads).toBe(0);
      expect(health.sharing?.hostsRamGb ?? 0).toBe(0);
      if (batchingAt === null && health.state === "batching") batchingAt = waited;
      if (batchingAt !== null && fillers === null && waited >= batchingAt + 180_000 && health.batchesPending > 0) {
        fillers = [];
      }
      if (fillers !== null && first === null) fillers.push(...(await fillHosts(simulation, OPERATION_HOSTS)));
      if (first === null && health.batchesShort > 0) {
        first = { afterMs: (await simulation.now()) - startedAt, health };
        for (const pid of fillers ?? []) await simulation.kill(pid);
      }
      if (first !== null && waited > first.afterMs + 70_000 && (health.sharing?.threads ?? 0) > 0) sharedAgain = true;
      if (first !== null && waited > first.afterMs + 15_000 && waited < first.afterMs + 55_000) {
        holdOff.looks += 1;
        if ((health.sharing?.threads ?? 0) > 0) holdOff.shared += 1;
      }
      if (first !== null && waited >= first.afterMs + 240_000) return { first, after: health, sharedAgain, holdOff };
      await simulation.advance(1_000);
    }
  };
  const withShare = await firstShortOf(shared);
  // Short while home shared beside it, its health says: threads running, none of them on its hosts.
  expect(withShare.first.health.sharing).toMatchObject({ wanted: true, hostsRamGb: 0 });
  expect(withShare.first.health.sharing?.threads).toBeGreaterThan(0);
  expect(withShare.sharedAgain, "home shared again after the hold-off").toBe(true);
  // And through it (#242): before, home stopped for the minute too.
  expect(withShare.holdOff.looks).toBeGreaterThan(35);
  expect(withShare.holdOff.shared).toBe(withShare.holdOff.looks);
  const without = await firstShortOf(unshared);
  expect(without.first.health.sharing).toBeNull();
  expect(without.first.afterMs).toBe(withShare.first.afterMs);
  const counts = ({ batchesStarted, batchesShort, hacksSkipped }: BatcherHealth) => ({
    batchesStarted,
    batchesShort,
    hacksSkipped,
  });
  expect(counts(without.first.health)).toEqual(counts(withShare.first.health));
  expect(counts(without.after)).toEqual(counts(withShare.after));
});

test.each(["not sharing", "sharing"])(
  "a new plan while the old one's batches still land (#232), %s: fitted to the RAM as held, trimmed, never short",
  async (sharingOrNot) => {
    // #229's augmentations suite: as cloud servers were bought back after an install, the brain's plan moved from
    // fewer, larger batches to more, smaller ones. The old plan's hacks, out last, and the new one's weakens and grows,
    // out first, ran at once: 2 to 3% over the hosts' RAM, split across many, and a hack came up short. Here, on six
    // 16 GB hosts (a hack's 1.75 GB beside the 1.8 GB of the rest), a plan of 28 hack threads, each fitting the RAM,
    // then one of 1: the batcher trims the new plan's batches until the old one's have landed, and none is short.
    // Sharing with no reserve (#232's review), a round takes only the room beside them: the trims are the old plan's,
    // not the share's.
    const sharing = sharingOrNot === "sharing" ? { sharing: { reserveGb: 0, homeKeptGb: 8, cores: {} } } : {};
    const simulation = await gameWithScripts();
    await simulation.diagnostics.gainHackingExp(2_000);
    const hosts = SHARING_HOSTS;
    const player = { skills: { hacking: 50, intelligence: 0 }, mults: MULTS };
    const ramGb = batchRamGb(hosts.map(() => 16));
    const configOf = (hackThreads: number): BatcherConfig => {
      const threads = batchThreads(N00DLES, player, hackThreads);
      const holds = batchHoldsMs(N00DLES, player, threads);
      const spacingMs = leastSpacingMs(threads, holds, ramGb);
      if (spacingMs === null) throw new Error(`no spacing for ${hackThreads} hack threads on ${ramGb} GB`);
      // Each plan alone peaks within the RAM.
      expect(batchPeakRamGb(threads, holds, spacingMs)).toBeLessThanOrEqual(ramGb);
      return {
        ...n00dlesConfig(),
        hosts,
        hackShare: hackThreads * hackSharePerThread(N00DLES, player),
        spacingMs,
        ...sharing,
      };
    };
    const setConfig = (config: BatcherConfig) =>
      simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
    await setConfig(configOf(28));
    const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
    expect(error).toBeUndefined();
    for (let waited = 0; (await healthOf(simulation)).hacksLanded < 3; waited += 5_000) {
      expect(waited, "the first plan's hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
      await simulation.advance(5_000);
    }
    const before = await healthOf(simulation);
    expect(before).toMatchObject({ batchesShort: 0, batchesTrimmed: 0 });
    await setConfig(configOf(1));
    let mostShared = 0;
    for (let seconds = 5; seconds <= 360; seconds += 5) {
      await simulation.advance(5_000);
      mostShared = Math.max(mostShared, (await sharesRunning(simulation)).threads);
      expect(await healthOf(simulation), `${seconds} s after the new plan`).toMatchObject({
        batchesShort: 0,
        batchesTrimmedBySharing: 0,
        desyncs: 0,
        late: 0,
        lost: 0,
      });
    }
    const after = await healthOf(simulation);
    // Shared on its hosts beside them, when asked.
    expect(mostShared > 0).toBe(sharingOrNot === "sharing");
    // Trimmed while the old plan's batches landed; then the new plan's own, in full.
    expect(after.batchesTrimmed).toBeGreaterThan(0);
    expect(after.batchesStarted - before.batchesStarted).toBeGreaterThan(20);
    expect(after.hacksLanded - before.hacksLanded).toBeGreaterThan(20);
  },
);
test("a player's own scripts on its hosts (#232): the batches fitted to the RAM they leave, trimmed, never short", async () => {
  // The brain plans on the hosts' RAM, not knowing what else runs there: half of each host's taken, the batcher plans
  // its batches on the rest.
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  for (const host of SHARING_HOSTS) {
    await simulation.writeFile(host, "idle.js", IDLE);
    expect((await simulation.run(host, "idle.js", { threads: 5 })).error).toBeUndefined();
  }
  const player = { skills: { hacking: 50, intelligence: 0 }, mults: MULTS };
  const plan = batchPlan(N00DLES, player, batchRamGb(SHARING_HOSTS.map(() => 16)));
  if (plan === null) throw new Error("no plan for n00dles on six hosts");
  const config = { ...n00dlesConfig(), hosts: SHARING_HOSTS, hackShare: plan.hackShare, spacingMs: plan.spacingMs };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).hacksLanded < 10; waited += 5_000) {
    expect(waited, "ten hacks landed within 20 virtual minutes").toBeLessThan(20 * 60_000);
    expect(await healthOf(simulation)).toMatchObject({ batchesShort: 0, desyncs: 0, late: 0, lost: 0 });
    await simulation.advance(5_000);
  }
  await simulation.advance(3 * 60_000);
  const health = await healthOf(simulation);
  expect(health).toMatchObject({ batchesShort: 0, desyncs: 0, late: 0, lost: 0 });
  expect(health.batchesTrimmed).toBeGreaterThan(0);
});

test("a share round never takes the RAM the batches planned will hold (#232), whatever the reserve", async () => {
  // No reserve (a brain's reserve can't count batches planned beside a new plan's): only the batcher's own count of the
  // RAM the batches will hold over a round's 10 s keeps the share off it. The plan on two thirds of six hosts' RAM.
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const player = { skills: { hacking: 50, intelligence: 0 }, mults: MULTS };
  const plan = batchPlan(N00DLES, player, (batchRamGb(SHARING_HOSTS.map(() => 16)) * 2) / 3);
  if (plan === null) throw new Error("no plan for n00dles on four hosts' RAM");
  const config = {
    ...n00dlesConfig(),
    hosts: SHARING_HOSTS,
    hackShare: plan.hackShare,
    spacingMs: plan.spacingMs,
    sharing: { reserveGb: 0, homeKeptGb: 8, cores: {} },
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  let mostShared = 0;
  for (let waited = 0; waited < 10 * 60_000; waited += 1_000) {
    mostShared = Math.max(mostShared, (await sharesRunning(simulation)).threads);
    await simulation.advance(1_000);
  }
  const health = await healthOf(simulation);
  expect(health).toMatchObject({ state: "batching", batchesShort: 0, desyncs: 0, late: 0, lost: 0 });
  expect(health.hacksLanded).toBeGreaterThan(10);
  // Nor a batch planned beside a round trimmed for its threads (#232's review): the share's failure too. The plan the
  // same throughout, none trimmed at all: a round's threads count as the batcher's own until their scripts end.
  expect(health.batchesTrimmedBySharing).toBe(0);
  expect(health.batchesTrimmed).toBe(0);
  // It shared on its hosts all the same, beside the batches.
  expect(mostShared).toBeGreaterThan(0);
});
test("larger batches beside a round's threads (#232's review): trimmed for them, the share's", async () => {
  // A round leaves the batches planned and due their RAM, at the plan's size. Small batches a second apart, then, just
  // after a round, batches of a quarter of n00dles' money at the same spacing: the next is planned within a second,
  // and at hacking 1,000 n00dles' weaken (9.3 s) has all its operations out together before the newer half's 10 s
  // end (#242: a round is half of what the share may hold). So each batch planned while it holds is trimmed for the
  // share's threads on its hosts, and counted apart, the share's (`share starved batches` in the run report), never
  // short. Home, 8 GB, keeps all of it: the share is its hosts'.
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(1e17);
  const hacking = (await simulation.summary()).hackingLevel;
  expect(hacking).toBeGreaterThan(900);
  const player = { skills: { hacking, intelligence: 0 }, mults: MULTS };
  const ramGb = batchRamGb(SHARING_HOSTS.map(() => 16));
  const configOf = (planGb: number): BatcherConfig => {
    const plan = batchPlan(N00DLES, player, planGb);
    if (plan === null) throw new Error(`no plan for n00dles on ${planGb} GB`);
    return {
      ...n00dlesConfig(),
      hosts: SHARING_HOSTS,
      hackShare: plan.hackShare,
      spacingMs: plan.spacingMs,
      sharing: { reserveGb: 0, homeKeptGb: 8, cores: {} },
    };
  };
  const setConfig = (config: BatcherConfig) =>
    simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(config)] });
  // Small batches a second apart: the next after a new config is planned within a second.
  const small = { ...configOf(ramGb / 4), spacingMs: 1_000 };
  small.hackShare = configOf(ramGb / 4).hackShare / 8;
  await setConfig(small);
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).hacksLanded < 3; waited += 1_000) {
    expect(waited, "hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(1_000);
  }
  // A round just started: the larger plan at once.
  const firstRounds = (await sharesRunning(simulation)).rounds;
  for (let waited = 0; ; waited += 100) {
    expect(waited, "a new round within a minute").toBeLessThan(60_000);
    const { rounds } = await sharesRunning(simulation);
    if (rounds.some((round) => !firstRounds.includes(round))) break;
    await simulation.advance(100);
  }
  // Two halves out at least, all the room the batches leave.
  expect((await sharesRunning(simulation)).rounds.length).toBeGreaterThanOrEqual(2);
  expect((await healthOf(simulation)).batchesTrimmedBySharing).toBe(0);
  await setConfig({ ...small, hackShare: 0.25 });
  await simulation.advance(30_000);
  const health = await healthOf(simulation);
  expect(health).toMatchObject({ batchesShort: 0, desyncs: 0, late: 0, lost: 0 });
  expect(health.batchesTrimmedBySharing).toBeGreaterThan(0);
  expect(health.batchesTrimmed).toBeGreaterThanOrEqual(health.batchesTrimmedBySharing ?? 0);
});
test("a share on home and on its hosts at once (#231's review): its health counts only the hosts' part", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.setHomeRam(64);
  await simulation.diagnostics.gainHackingExp(2_000);
  // No reserve: its six hosts share their free RAM, and home its RAM above the 8 kept.
  const config = { ...n00dlesConfig(), hosts: SHARING_HOSTS, sharing: { reserveGb: 0, homeKeptGb: 8, cores: {} } };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  let checked = false;
  for (let waited = 0; !checked; waited += 1_000) {
    expect(waited, "sharing on home and its hosts at once within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(1_000);
    const onHosts = (await sharesRunning(simulation)).threads;
    const onHome = (await simulation.ps("home"))
      .filter((process) => process.filename.endsWith(SHARE_SCRIPT_NAME))
      .reduce((sum, process) => sum + process.threads, 0);
    const health = await healthOf(simulation);
    if (onHosts === 0 || onHome === 0 || health.sharing?.threads !== onHosts + onHome) continue;
    expect(health.sharing.hostsRamGb).toBe(onHosts * 4);
    expect(health.sharing.ramGb).toBe((onHosts + onHome) * 4);
    checked = true;
  }
});

test("without its share script (#224), it batches all the same, and says it can't share, loudly", async () => {
  const simulation = await gameWithScripts();
  await simulation.writeFile("home", "remove.js", "export async function main(ns) { ns.rm(ns.args[0], 'home'); }");
  await simulation.run("home", "remove.js", { args: [FOLDER + SHARE_SCRIPT_NAME] });
  await simulation.diagnostics.gainHackingExp(2_000);
  const config = { ...n00dlesConfig(), hosts: SHARING_HOSTS, sharing: { reserveGb: 0, homeKeptGb: 8, cores: {} } };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 5_000) {
    expect(waited, "batching within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  await simulation.advance(3 * 60_000);
  const health = await healthOf(simulation);
  expect(health.problem).toMatch(/^can't copy its share script to /);
  expect(health.sharing).toMatchObject({ wanted: true, threads: 0 });
  expect(health.sharing?.roomGb).toBeGreaterThan(4);
  expect(health).toMatchObject({ state: "batching", desyncs: 0, late: 0, lost: 0, batchesShort: 0 });
  expect(health.hacksLanded).toBeGreaterThan(0);
  expect((await sharesRunning(simulation)).threads).toBe(0);
});

/** Logs its argument servers' figures, as the static snapshot has them, from the game itself. */
const FIGURES = `export async function main(ns) {
  const figures = {};
  for (const host of ns.args) {
    figures[host] = {
      moneyMax: ns.getServerMaxMoney(host),
      minDifficulty: ns.getServerMinSecurityLevel(host),
      requiredHackingSkill: ns.getServerRequiredHackingLevel(host),
      serverGrowth: ns.getServerGrowth(host),
    };
  }
  ns.print(JSON.stringify(figures));
}`;
/** Weakens and grows its target to its minimum security and maximum money: prepared, as the batcher leaves it. */
const PREPARE_FULLY = `export async function main(ns) {
  const [target] = ns.args;
  const above = () => ns.getServerSecurityLevel(target) - ns.getServerMinSecurityLevel(target);
  for (;;) {
    if (above() > 1) await ns.weaken(target);
    else if (ns.getServerMoneyAvailable(target) < ns.getServerMaxMoney(target)) await ns.grow(target);
    else if (above() > 0) await ns.weaken(target);
    else return;
  }
}`;

/** The hacks in flight on the six hosts: each one's target and landing. */
async function hacksInFlight(simulation: Simulation): Promise<{ target: string; landAt: number }[]> {
  const hacks = [];
  for (const host of SHARING_HOSTS) {
    for (const process of await simulation.ps(host)) {
      if (!process.filename.endsWith("/batch-hack.js")) continue;
      hacks.push({ target: String(process.args[0]), landAt: Number(process.args[1]) });
    }
  }
  return hacks;
}

/** The game's figures of `hosts`, read from the game. */
async function figuresOf(simulation: Simulation, hosts: string[]): Promise<Record<string, BatcherConfig["figures"]>> {
  await simulation.writeFile("home", "figures.js", FIGURES);
  const { pid } = await simulation.run("home", "figures.js", { args: hosts });
  await simulation.advance(1);
  return JSON.parse(await printed(simulation, pid)) as Record<string, BatcherConfig["figures"]>;
}

test("a move to a prepared target (#236): batches at once beside a dropped next target's wave, hardly idle", {
  timeout: 300_000,
}, async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const figures = await figuresOf(simulation, ["joesguns", "harakiri-sushi"]);
  const joesguns = figures.joesguns as BatcherConfig["figures"];
  const harakiri = figures["harakiri-sushi"] as BatcherConfig["figures"];
  // joesguns prepared beforehand on a large home, as a next target the batcher had prepared would be. Its grows' exp
  // takes hacking to about 170.
  await simulation.diagnostics.setHomeRam(8_192);
  await simulation.writeFile("home", "prepare-fully.js", PREPARE_FULLY);
  const preparer = await simulation.run("home", "prepare-fully.js", { threads: 3_000, args: ["joesguns"] });
  expect(preparer.error).toBeUndefined();
  for (let waited = 0; (await simulation.ps("home")).some((each) => each.pid === preparer.pid); waited += 10_000) {
    expect(waited, "joesguns prepared within 30 virtual minutes").toBeLessThan(30 * 60_000);
    await simulation.advance(10_000);
  }
  // Batching n00dles on four fifths of the six hosts, as the brain plans the batches beside a next target.
  const player = { skills: { hacking: (await simulation.summary()).hackingLevel, intelligence: 0 }, mults: MULTS };
  const ramGb = batchRamGb(SHARING_HOSTS.map(() => 16));
  const n00dlesPlan = batchPlan(N00DLES, player, ramGb * 0.8);
  const joesgunsPlan = batchPlan(joesguns, player, ramGb);
  if (n00dlesPlan === null || joesgunsPlan === null) throw new Error("no plan on the six hosts");
  const batchingN00dles: BatcherConfig = {
    ...n00dlesConfig(),
    hosts: SHARING_HOSTS,
    hackShare: n00dlesPlan.hackShare,
    spacingMs: n00dlesPlan.spacingMs,
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(batchingN00dles)] });
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 5_000) {
    expect(waited, "n00dles' hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  await simulation.advance(60_000);
  // harakiri-sushi sent to prepare next: its first wave goes out at once on its fifth, beside batches planned a weaken
  // ahead (#236: before, the pending orders' RAM summed left it none). A weaken at its starting security: minutes.
  const withNext = { ...batchingN00dles, next: { target: "harakiri-sushi", figures: harakiri, ramGb: ramGb * 0.2 } };
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(withNext)] });
  await simulation.advance(1_000);
  expect((await healthOf(simulation)).next).toEqual({ target: "harakiri-sushi", wavesStarted: 1, ready: false });
  const harakiriWave = (await inFlight(simulation, SHARING_HOSTS)).filter((each) => each.target === "harakiri-sushi");
  const waveLandsAt = Math.max(...harakiriWave.map((each) => each.landAt));
  expect(waveLandsAt - (await monotonicNow(simulation))).toBeGreaterThan(2 * 60_000);

  // Right after a batch on n00dles is planned (#237's review): a wait for RAM is said at once, not 10 s on.
  const startedBefore = (await healthOf(simulation)).batchesStarted;
  for (let waited = 0; (await healthOf(simulation)).batchesStarted === startedBefore; waited += 100) {
    expect(waited, "a batch planned within a minute").toBeLessThan(60_000);
    await simulation.advance(100);
  }
  // The move: to joesguns, prepared, the next dropped with its wave still out.
  const before = await healthOf(simulation);
  // On the page's monotonic clock, as the landings in flight are (#251).
  const movedAt = await monotonicNow(simulation);
  const toJoesguns: BatcherConfig = {
    ...batchingN00dles,
    target: "joesguns",
    figures: joesguns,
    hackShare: joesgunsPlan.hackShare,
    spacingMs: joesgunsPlan.spacingMs,
  };
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(toJoesguns)] });
  // A landing on harakiri-sushi recorded early, with its later time, as one that lands a little off its time on a
  // busy page would be: joesguns' and n00dles' landings after it, earlier, are in order on their own targets (#236).
  const early = harakiriWave.at(-1) as { id: string; landAt: number };
  await simulation.run("home", "write-port.js", { args: [BATCHER_LANDING_PORT, recordJson(early.id, early.landAt)] });
  let lastOldHackAt = 0;
  let firstNewHackAt = Number.POSITIVE_INFINITY;
  let silentlyWaiting = 0;
  let saidItWaits = 0;
  let timesNamed = 0;
  for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += 2_000) {
    await simulation.advance(2_000);
    for (const { target, landAt } of await hacksInFlight(simulation)) {
      if (target === "n00dles") lastOldHackAt = Math.max(lastOldHackAt, landAt);
      if (target === "joesguns") firstNewHackAt = Math.min(firstNewHackAt, landAt);
    }
    // Never a silent `batching` with no batch (#236): while none fits, the problem says what holds the RAM.
    const health = await healthOf(simulation);
    if (health.state === "batching" && health.batchesStarted === before.batchesStarted) {
      if (health.problem?.startsWith("no batch on joesguns fits the RAM yet: it's held by its operations on ")) {
        saidItWaits += 1;
        // The time it names is the wall clock's, as the brain reads it (#251): within minutes of now.
        const landingAt = /landing at (\S+)$/.exec(health.problem)?.[1];
        if (landingAt !== undefined) {
          timesNamed += 1;
          expect(Math.abs(Date.parse(landingAt) - (await simulation.now()))).toBeLessThan(10 * 60_000);
        }
      } else silentlyWaiting += 1;
    }
  }
  const after = await healthOf(simulation);
  const joesgunsWeakenMs = operationTimeMs("weaken1", joesguns, player);
  console.log(
    `#236's move: harakiri-sushi's wave lands ${((waveLandsAt - movedAt) / 1000).toFixed(0)} s after it; n00dles' ` +
      `last hack ${((lastOldHackAt - movedAt) / 1000).toFixed(0)} s after it, joesguns' first ` +
      `${((firstNewHackAt - movedAt) / 1000).toFixed(0)} s (a weaken: ${(joesgunsWeakenMs / 1000).toFixed(0)} s): idle ` +
      `${((firstNewHackAt - lastOldHackAt) / 1000).toFixed(0)} s; ${saidItWaits} looks waiting for RAM, said so`,
  );
  expect(silentlyWaiting).toBe(0);
  expect(timesNamed).toBeGreaterThan(0);
  // joesguns' first hack lands a weaken after the move, and the seconds n00dles' batches take to free the RAM for one,
  // long before harakiri-sushi's wave: before #236, one spacing after the wave, 194 s in, idle 161 s. Those seconds are
  // about 30 (15 looks): the move comes right after a batch is planned (#237's review), so n00dles' batches hold the
  // most RAM then; 45 s leaves a margin over them (before that change, the move came anywhere in a spacing: 14 s).
  expect(firstNewHackAt - movedAt).toBeLessThan(joesgunsWeakenMs + 45_000);
  expect(firstNewHackAt).toBeLessThan(waveLandsAt);
  // Its health says the move and its idle time, as the hacks in flight showed them.
  expect(after.lastMove).toMatchObject({ from: "n00dles", to: "joesguns" });
  expect(after.lastMove?.idleMs).toBeCloseTo(Math.max(0, firstNewHackAt - lastOldHackAt), -1);
  expect(after.lastMove?.idleMs).toBeLessThan(60_000);
  expect(after.lastHack?.target).toBe("joesguns");
  // In step, though joesguns' batches land among n00dles' and harakiri-sushi's (the order is each target's own).
  expect(after).toMatchObject({ state: "batching", desyncs: 0, late: 0, lost: 0, outOfBounds: 0, batchesShort: 0 });
  expect(after.batchesStarted).toBeGreaterThan(before.batchesStarted + 10);
});

test("batching with no batch that fits the RAM says so, and why (#236), until one does", async () => {
  const simulation = await gameWithScripts();
  // n00dles prepared by a first batcher, whose operations then all land.
  await simulation.kill(await batchingBatcher(simulation));
  await simulation.advance(3 * 60_000);
  // A player's own scripts take the hosts' RAM, then a batcher starts on n00dles, prepared: it batches, and none fits.
  const idle = await fillHosts(simulation, OPERATION_HOSTS);
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, {
    args: [JSON.stringify(n00dlesConfig())],
  });
  expect(error).toBeUndefined();
  await simulation.advance(30_000);
  const waiting = await healthOf(simulation);
  expect(waiting).toMatchObject({
    state: "batching",
    batchesStarted: 0,
    problem: "no batch on n00dles fits the RAM yet: it's held by scripts not its own",
  });
  // The RAM back: batches, and the problem gone.
  for (const pid of idle) await simulation.kill(pid);
  await simulation.advance(30_000);
  const batching = await healthOf(simulation);
  expect(batching).toMatchObject({ state: "batching", problem: null, desyncs: 0, batchesShort: 0 });
  expect(batching.batchesStarted).toBeGreaterThan(0);
});

test("a next target with no room for a wave for a minute is said (#236), until it gets one", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(n00dlesConfig())] });
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 5_000) {
    expect(waited, "hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  // foodnstuff sent to prepare next on less RAM than a thread's: no room for a wave. The batches planned on the rest,
  // as the brain plans them beside a next target.
  const foodnstuff = { moneyMax: 50_000_000, minDifficulty: 3, requiredHackingSkill: 1, serverGrowth: 5 };
  const rest = batchPlan(
    N00DLES,
    { skills: { hacking: 50, intelligence: 0 }, mults: MULTS },
    batchRamGb([16, 16]) * 0.6,
  );
  if (rest === null) throw new Error("no plan for n00dles on the rest");
  const withNext = (ramGb: number) => ({
    ...n00dlesConfig(),
    hackShare: rest.hackShare,
    spacingMs: rest.spacingMs,
    next: { target: "foodnstuff", figures: foodnstuff, ramGb },
  });
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(withNext(1))] });
  await simulation.advance(30_000);
  // Under a minute: not yet.
  expect((await healthOf(simulation)).problem).toBeNull();
  // Past it (the batcher looks again at its next wake, a minute at most): said.
  await simulation.advance(2 * 60_000);
  const starved = await healthOf(simulation);
  expect(starved.next).toEqual({ target: "foodnstuff", wavesStarted: 0, ready: false });
  expect(starved.problem).toBe("no RAM to prepare foodnstuff next beside the batches for a minute");
  // Room for it: a wave, and the problem gone.
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(withNext(7.2))] });
  await simulation.advance(5_000);
  const fed = await healthOf(simulation);
  expect(fed.next?.wavesStarted).toBeGreaterThan(0);
  expect(fed).toMatchObject({ problem: null, desyncs: 0, batchesShort: 0 });
});

test("batching, a stretch with no batch that fits after the first is said too (#237's review), and clears", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(n00dlesConfig())] });
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 5_000) {
    expect(waited, "hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  expect((await healthOf(simulation)).problem).toBeNull();
  // A player's own scripts take each bit of RAM the batches free, every second for 100 s: no batch fits.
  const idle: number[] = [];
  for (const host of OPERATION_HOSTS) await simulation.writeFile(host, "idle.js", IDLE);
  const problems = new Set<string>();
  let saidWithinHalfAMinute = false;
  for (let second = 0; second < 100; second++) {
    const { pid } = await simulation.run("home", "free-ram.js", { args: OPERATION_HOSTS });
    await simulation.advance(1);
    const free = JSON.parse(await printed(simulation, pid)) as Record<string, number>;
    for (const host of OPERATION_HOSTS) {
      const threads = Math.floor((free[host] ?? 0) / 1.6 + 1e-9);
      if (threads === 0) continue;
      const started = await simulation.run(host, "idle.js", { threads, args: [second] });
      expect(started.error).toBeUndefined();
      idle.push(started.pid);
    }
    await simulation.advance(1_000);
    const problem = (await healthOf(simulation)).problem;
    if (problem !== null) problems.add(problem);
    if (problem !== null && second < 30) saidWithinHalfAMinute = true;
  }
  // Said once none had fitted for a minute (not for a gap among batches in step), once, with what holds the RAM and
  // the next of it to land.
  const said = [...problems];
  expect(saidWithinHalfAMinute).toBe(false);
  expect(said).toHaveLength(1);
  for (const problem of said) {
    expect(problem).toMatch(
      /^no batch on n00dles fits the RAM yet: it's held by (its operations on n00dles|scripts not its own)/,
    );
  }
  // The RAM back: batches again, and the problem gone. (A batch planned before the scripts took its RAM is short: the
  // player's doing.)
  for (const pid of idle) await simulation.kill(pid);
  await simulation.advance(30_000);
  expect(await healthOf(simulation)).toMatchObject({ state: "batching", problem: null, desyncs: 0 });
});

test("a next target on all the RAM the batches leave (#237's re-review): prepared beside them, no batch trimmed", {
  timeout: 300_000,
}, async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  // A home of 1 PB, late in a cycle: n00dles' batches leave most of it idle.
  const homeGb = 1_048_576;
  await simulation.diagnostics.setHomeRam(homeGb);
  const figures = await figuresOf(simulation, ["harakiri-sushi"]);
  const player = { skills: { hacking: (await simulation.summary()).hackingLevel, intelligence: 0 }, mults: MULTS };
  // The RAM the batches count on, less the batcher's own on home (it runs there).
  const ramGb = batchRamGb([homeGb - 8]);
  const plan = batchPlan(N00DLES, player, ramGb);
  if (plan === null) throw new Error("no plan for n00dles on home");
  const leftGb = ramGb - plan.peakRamGb;
  expect(leftGb).toBeGreaterThan(ramGb * 0.2);
  const batching: BatcherConfig = {
    ...n00dlesConfig(),
    hosts: ["home"],
    hackShare: plan.hackShare,
    spacingMs: plan.spacingMs,
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(batching)] });
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 5_000) {
    expect(waited, "n00dles' hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  await simulation.advance(60_000);
  // harakiri-sushi to prepare next on all the RAM n00dles' batches leave, as the brain sends it while n00dles earns.
  const before = await healthOf(simulation);
  const withNext = {
    ...batching,
    next: { target: "harakiri-sushi", figures: figures["harakiri-sushi"], ramGb: leftGb },
  };
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(withNext)] });
  await simulation.advance(5 * 60_000);
  const after = await healthOf(simulation);
  console.log(
    `#237's next on the leftover RAM: ${Math.round(leftGb)} of ${Math.round(ramGb)} GB; next ${JSON.stringify(after.next)}; ` +
      `${after.batchesStarted - before.batchesStarted} batches, ${(after.batchesTrimmed ?? 0) - (before.batchesTrimmed ?? 0)} trimmed`,
  );
  expect(after.next?.wavesStarted).toBeGreaterThan(0);
  expect(after.batchesStarted).toBeGreaterThan(before.batchesStarted + 10);
  // The batches keep their RAM: none trimmed or short beside the next's waves, all in step.
  expect(after.batchesTrimmed).toBe(before.batchesTrimmed);
  expect(after).toMatchObject({ batchesShort: 0, desyncs: 0, late: 0, lost: 0, problem: null });
});

/** A player's script that ends its argument's ms after it starts: 1.6 GB a thread. */
const BRIEF = "export async function main(ns) { await ns.asleep(Number(ns.args[0])); }";
/**
 * A player's script that, every `everyMs`, takes each host's free RAM with `brief.js` threads ending `holdMs` on: RAM
 * that frees a moment after the batches counted on it, as a busy page's late timers leave an operation's (#246). Home
 * keeps 1.65 GB, for the test's look at the health (1.6 GB), and no batch operation (1.7 GB at least).
 */
/** Writes to a port every `everyMs`, waking whatever waits on it: a busy batcher's landing records, coming that often. */
const PING_PORT = `export async function main(ns) {
  const [port, everyMs] = ns.args;
  for (;;) {
    ns.writePort(port, 0);
    await ns.asleep(everyMs);
  }
}`;
const HOLD_BRIEFLY = `export async function main(ns) {
  const [holdMs, everyMs, ...hosts] = ns.args;
  for (let round = 0; ; round++) {
    for (const host of hosts) {
      const keptGb = host === "home" ? 1.65 : 0;
      const threads = Math.floor((ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - keptGb) / 1.6 + 1e-9);
      if (threads > 0) ns.exec("brief.js", host, threads, holdMs, round);
    }
    await ns.asleep(everyMs);
  }
}`;

test("an operation whose RAM frees a moment late waits for it (#246), within its wait; longer, it's short, and why", {
  timeout: 300_000,
}, async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(6_000_000);
  // Home for the player's script beside the batcher.
  await simulation.diagnostics.setHomeRam(64);
  for (const host of SHARING_HOSTS) await simulation.writeFile(host, "brief.js", BRIEF);
  await simulation.writeFile("home", "hold-briefly.js", HOLD_BRIEFLY);
  // n00dles batched on the six hosts' RAM, at hacking about 300: a batch every few seconds, its operations in 30 s.
  const player = { skills: { hacking: (await simulation.summary()).hackingLevel, intelligence: 0 }, mults: MULTS };
  const plan = batchPlan(N00DLES, player, batchRamGb(SHARING_HOSTS.map(() => 16)));
  if (plan === null) throw new Error("no plan for n00dles on the six hosts");
  const config = { ...n00dlesConfig(), hosts: SHARING_HOSTS, hackShare: plan.hackShare, spacingMs: plan.spacingMs };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 5_000) {
    expect(waited, "hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  const before = await healthOf(simulation);
  expect(before).toMatchObject({ batchesShort: 0, ramWaits: 0, shorts: [], waits: [] });
  // For two minutes, every 100 ms, the hosts' free RAM held 40 ms: an operation due then finds no room until it frees.
  const holding = await simulation.run("home", "hold-briefly.js", { args: [40, 100, ...SHARING_HOSTS] });
  expect(holding.error).toBeUndefined();
  const waits = new Map<string, RamWait>();
  for (let elapsed = 0; elapsed < 2 * 60_000; elapsed += 1_000) {
    // The wall clock stepped 3 s on, then back, while orders wait (#251): no wait is longer for it.
    if (elapsed === 30_000) await simulation.diagnostics.stepWallClock(3_000);
    if (elapsed === 60_000) await simulation.diagnostics.stepWallClock(-3_000);
    await simulation.advance(1_000);
    for (const each of (await healthOf(simulation)).waits ?? []) waits.set(`${each.atMs} ${each.operation}`, each);
  }
  await simulation.kill(holding.pid);
  await simulation.advance(1_000);
  const waited = await healthOf(simulation);
  console.log(
    `#246: ${waited.batchesStarted - before.batchesStarted} batches beside RAM held 40 ms in each 100 (a batch ` +
      `every ${config.spacingMs} ms); ${waited.ramWaits} operations waited for it, the longest ` +
      `${waited.longestRamWaitMs} ms; ${waited.batchesShort} short; a wait: ${JSON.stringify([...waits.values()][0])}`,
  );
  // They waited, no longer than the RAM was held, and none was short or late: each landed in step.
  expect(waited.ramWaits).toBeGreaterThan(3);
  expect(waited.longestRamWaitMs).toBeGreaterThan(0);
  expect(waited.longestRamWaitMs).toBeLessThanOrEqual(45);
  expect(waited).toMatchObject({ batchesShort: 0, shorts: [], late: 0, lost: 0, desyncs: 0 });
  expect(waited.batchesStarted - before.batchesStarted).toBeGreaterThan(5);
  // Each wait says why (#246's review): the player's script held the RAM, at least a 1.6 GB thread of it, and had it
  // been free the operation would have fitted; no share threads. Those seen (the health keeps the last 5, looked at each
  // second), each within the wait.
  expect(waits.size).toBeGreaterThan(3);
  expect(waits.size).toBeLessThanOrEqual(waited.ramWaits ?? 0);
  for (const each of waits.values()) {
    expect(each.waitedMs).toBeGreaterThan(0);
    expect(each.waitedMs).toBeLessThan(BATCH_RAM_WAIT_MS);
    expect(each.othersGb).toBeGreaterThanOrEqual(1.6);
    expect(each.sharingGb).toBe(0);
    expect(each.freeGb + each.othersGb).toBeGreaterThanOrEqual(each.threads * 1.7);
  }
  // Again for a minute, the batcher woken every 3 ms besides (on its config port, unread with its config as its argument), as
  // a busy one's landing records would: waits are tried again, and end, whatever wakes it (#246's review).
  await simulation.writeFile("home", "ping-port.js", PING_PORT);
  const pinging = await simulation.run("home", "ping-port.js", { args: [BATCHER_CONFIG_PORT, 3] });
  const holdingAgain = await simulation.run("home", "hold-briefly.js", { args: [40, 100, ...SHARING_HOSTS] });
  expect(pinging.error ?? holdingAgain.error).toBeUndefined();
  await simulation.advance(60_000);
  await simulation.kill(holdingAgain.pid);
  await simulation.kill(pinging.pid);
  await simulation.advance(1_000);
  const pinged = await healthOf(simulation);
  console.log(
    `#246, woken every 3 ms: ${(pinged.ramWaits ?? 0) - (waited.ramWaits ?? 0)} more waits; ${pinged.batchesShort} short`,
  );
  expect(pinged.ramWaits).toBeGreaterThan(waited.ramWaits ?? 0);
  expect(pinged).toMatchObject({ batchesShort: 0, late: 0, lost: 0, desyncs: 0 });
  expect(pinged.longestRamWaitMs).toBeLessThanOrEqual(45);
  // Held 300 ms in each 400, past the wait: a batch is short, a failure still, given up within a look of the wait's
  // end, never started past it (#246's review), and its health says when, what, and why.
  const startedAt = await simulation.now();
  const holdingLonger = await simulation.run("home", "hold-briefly.js", { args: [300, 400, ...SHARING_HOSTS] });
  expect(holdingLonger.error).toBeUndefined();
  for (let waitedMs = 0; (await healthOf(simulation)).batchesShort === 0; waitedMs += 1_000) {
    expect(waitedMs, "a batch short within 2 virtual minutes").toBeLessThan(2 * 60_000);
    await simulation.advance(1_000);
  }
  const short = await healthOf(simulation);
  await simulation.kill(holdingLonger.pid);
  expect(short.shorts).toHaveLength(short.batchesShort);
  const [first] = short.shorts ?? [];
  console.log(`#246: held 300 ms in each 400, the first short: ${JSON.stringify(first)}`);
  expect(first).toMatchObject({ target: "n00dles", failedOn: null, sharingGb: 0 });
  expect(first?.atMs).toBeGreaterThanOrEqual(startedAt);
  expect(first?.waitedMs).toBeGreaterThanOrEqual(BATCH_RAM_WAIT_MS);
  expect(first?.waitedMs).toBeLessThan(BATCH_RAM_WAIT_MS + 2 * BATCH_RAM_WAIT_LOOK_MS);
  // The player's script held the RAM it needed.
  const { threads = 0, freeGb = 0, othersGb = 0 } = first ?? {};
  expect(othersGb).toBeGreaterThanOrEqual(1.6);
  expect(freeGb + othersGb).toBeGreaterThanOrEqual(threads * 1.7);
  // A wait that ran out is a short, never a wait: those counted all started within it.
  expect(short.longestRamWaitMs).toBeLessThan(BATCH_RAM_WAIT_MS);
  for (const each of short.waits ?? []) expect(each.waitedMs).toBeLessThan(BATCH_RAM_WAIT_MS);
});

test("RAM a landing frees late (#246's review): the wait or short says its own operations past their landing held it", {
  timeout: 300_000,
}, async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2e16);
  const figures = await figuresOf(simulation, ["joesguns"]);
  const joesguns = figures.joesguns as BatcherConfig["figures"];
  expect(joesguns.requiredHackingSkill).toBeGreaterThan(1);
  const player = { skills: { hacking: (await simulation.summary()).hackingLevel, intelligence: 0 }, mults: MULTS };
  const ramGb = batchRamGb(SHARING_HOSTS.map(() => 16));
  const configOn = (share: number) => {
    const plan = batchPlan(N00DLES, player, ramGb * share);
    if (plan === null) throw new Error(`no plan for n00dles on ${share} of the hosts`);
    return { ...n00dlesConfig(), hosts: SHARING_HOSTS, hackShare: plan.hackShare, spacingMs: plan.spacingMs };
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME);
  expect(error).toBeUndefined();
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(configOn(0.6))] });
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 5_000) {
    expect(waited, "hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  // joesguns sent to prepare next on all the room the batches leave, at hacking about 1,000, its figures saying it
  // needs hacking 1, not 10: its weaken's time, so reckoned, is about 40% short at its starting security, and the wave
  // lands some 7 s after its time (under the 10 s that makes it lost), its RAM held meanwhile, as a landing a busy page
  // runs late holds it a moment.
  const lying = { ...joesguns, requiredHackingSkill: 1 };
  await simulation.run("home", "set-port.js", {
    args: [
      BATCHER_CONFIG_PORT,
      JSON.stringify({ ...configOn(0.6), next: { target: "joesguns", figures: lying, ramGb } }),
    ],
  });
  for (let waited = 0; ((await healthOf(simulation)).next?.wavesStarted ?? 0) === 0; waited += 1_000) {
    expect(waited, "a wave on joesguns within a minute").toBeLessThan(60_000);
    await simulation.advance(1_000);
  }
  // The next dropped, its wave out, and the batches planned on all the RAM: those started once the wave was due to
  // land find its RAM still held.
  await simulation.run("home", "set-port.js", { args: [BATCHER_CONFIG_PORT, JSON.stringify(configOn(1))] });
  const records = new Map<string, RamWait | BatchShort>();
  for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += 1_000) {
    await simulation.advance(1_000);
    const health = await healthOf(simulation);
    for (const each of [...(health.waits ?? []), ...(health.shorts ?? [])]) {
      records.set(`${each.atMs} ${each.operation}`, each);
    }
  }
  const after = await healthOf(simulation);
  const pastLanding = [...records.values()].filter((each) => each.pastLandingGb > 0);
  const lateLanding = [...records.values()].filter((each) => (each.landingLagMs ?? 0) > 1_000);
  console.log(
    `#246's review, RAM freed late: ${after.late} late; ${after.ramWaits} waits, ${after.batchesShort} short; ` +
      `${pastLanding.length} held by its own past their landing, ${lateLanding.length} beside a landing over 1 s ` +
      "late; " +
      `one: ${JSON.stringify(pastLanding[0])}`,
  );
  // The wave landed late, as reckoned: the stand-in for a late landing.
  expect(after.late).toBeGreaterThan(0);
  // What held the RAM was its own operations past their landing, and the landing recorded meanwhile ran late.
  expect(pastLanding.length).toBeGreaterThan(0);
  expect(lateLanding.length).toBeGreaterThan(0);
  // Nothing else ran on its hosts: none of it read as scripts not its own, nor as its share threads.
  for (const each of pastLanding) expect(each).toMatchObject({ othersGb: 0, sharingGb: 0 });
});

/**
 * n00dles batched on the six hosts at the hacking level `hackingExp` gives, by a batcher given its config, a batch of one
 * hack thread as often as the RAM holds: the config, its hacks landed.
 */
async function batchingOnSixHosts(simulation: Simulation, hackingExp: number): Promise<BatcherConfig> {
  await simulation.diagnostics.gainHackingExp(hackingExp);
  for (const host of SHARING_HOSTS) await simulation.writeFile(host, "brief.js", BRIEF);
  await simulation.writeFile("home", "hold-briefly.js", HOLD_BRIEFLY);
  const player = { skills: { hacking: (await simulation.summary()).hackingLevel, intelligence: 0 }, mults: MULTS };
  const threads = batchThreads(N00DLES, player, 1);
  const spacingMs = leastSpacingMs(
    threads,
    batchHoldsMs(N00DLES, player, threads),
    batchRamGb(SHARING_HOSTS.map(() => 16)),
  );
  if (spacingMs === null) throw new Error("no batch of one hack thread fits the six hosts");
  const hackShare = hackSharePerThread(N00DLES, player);
  const config = { ...n00dlesConfig(), hosts: SHARING_HOSTS, hackShare, spacingMs };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 5_000) {
    expect(waited, "hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  return config;
}

/** Every wait and short the health kept over `forMs`, looked at each second. */
async function waitsAndShortsOver(simulation: Simulation, forMs: number) {
  const waits = new Map<string, RamWait>();
  const shorts = new Map<string, BatchShort>();
  for (let elapsed = 0; elapsed < forMs; elapsed += 1_000) {
    await simulation.advance(1_000);
    const health = await healthOf(simulation);
    if (elapsed % 5_000 === 0) console.log();
    for (const each of health.waits ?? []) waits.set(`${each.atMs} ${each.operation}`, each);
    for (const each of health.shorts ?? []) shorts.set(`${each.atMs} ${each.operation}`, each);
  }
  return { waits: [...waits.values()], shorts: [...shorts.values()] };
}

test("waiting for RAM, a grow or weaken gives up once the security leaves it no time to land; and a give-up as a landing is recorded counts that landing's RAM as its own (#246's verification)", {
  timeout: 300_000,
}, async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(6_000_000);
  // joesguns (needs hacking 10) prepared by a player's script on a home of 32 TB: its security weighs on its times, 4%
  // a point at its minimum of 5, so a little more than its batches leave makes a weaken seconds longer.
  await simulation.diagnostics.setHomeRam(32_768);
  await simulation.writeFile("home", "prepare-fully.js", PREPARE_FULLY);
  const preparer = await simulation.run("home", "prepare-fully.js", { threads: 3_000, args: ["joesguns"] });
  expect(preparer.error).toBeUndefined();
  for (let waited = 0; (await simulation.ps("home")).some((each) => each.pid === preparer.pid); waited += 10_000) {
    expect(waited, "joesguns prepared within 30 virtual minutes").toBeLessThan(30 * 60_000);
    await simulation.advance(10_000);
  }
  const joesguns = (await figuresOf(simulation, ["joesguns"])).joesguns as BatcherConfig["figures"];
  // The six hosts and home for its operations: batches of one hack thread every 80 ms, a landing every 20 ms, on a
  // plan for half of home, the rest left for the player's hack.
  const hosts = [...SHARING_HOSTS, "home"];
  for (const host of hosts) await simulation.writeFile(host, "brief.js", BRIEF);
  await simulation.writeFile("home", "hold-briefly.js", HOLD_BRIEFLY);
  await simulation.writeFile("home", "hack-once.js", "export async function main(ns) { await ns.hack(ns.args[0]); }");
  const player = { skills: { hacking: (await simulation.summary()).hackingLevel, intelligence: 0 }, mults: MULTS };
  const threads = batchThreads(joesguns, player, 1);
  const holds = batchHoldsMs(joesguns, player, threads);
  const spacingMs = leastSpacingMs(threads, holds, batchRamGb([...SHARING_HOSTS.map(() => 16), 16_384 - 8]));
  expect(spacingMs).toBe(80);
  const config = {
    ...n00dlesConfig(),
    target: "joesguns",
    figures: joesguns,
    hosts,
    hackShare: hackSharePerThread(joesguns, player),
    spacingMs: 80,
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).hacksLanded === 0; waited += 5_000) {
    expect(waited, "hacks landing within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  // RAM held 40 ms in each 100, so operations wait; and a player's hack of 500 threads, its security up by 1 (a
  // weaken seconds longer), so the batcher stops hacking and lets its batches land, their grows and weakens still going
  // out. A wait that finds no time left gives up at its next look: often as a landing's record wakes it, the landing's
  // script not yet torn down (the game frees its RAM after the record is read, killWorkerScript.ts:124).
  const raising = await simulation.run("home", "hack-once.js", { threads: 500, args: ["joesguns"] });
  const holding = await simulation.run("home", "hold-briefly.js", { args: [40, 100, ...hosts] });
  expect(holding.error ?? raising.error).toBeUndefined();
  const { waits, shorts } = await waitsAndShortsOver(simulation, 60_000);
  await simulation.kill(holding.pid);
  const gaveUpEarly = shorts.filter(
    (each) => each.operation !== "hack" && each.slackMs !== null && each.waitedMs < BATCH_RAM_WAIT_MS,
  );
  const drainedHeld = gaveUpEarly.filter((each) => each.pastLandingGb > 0);
  console.log(
    `#246's verification, security raised: ${waits.length} waits, ${shorts.length} shorts, ${gaveUpEarly.length} given ` +
      `up early for want of time, ${drainedHeld.length} of them beside a landing's RAM not yet freed; one: ` +
      JSON.stringify(drainedHeld[0] ?? gaveUpEarly[0]),
  );
  // Waiting, they gave up before their wait was over: started, they'd have landed late, out of step (row 1).
  expect(gaveUpEarly.length).toBeGreaterThan(0);
  for (const each of gaveUpEarly) expect(each.slackMs).toBeLessThan(BATCH_START_SLACK_MS);
  // And none that waited started without the time to land on it.
  for (const each of waits) {
    if (each.slackMs !== null) expect(each.slackMs).toBeGreaterThanOrEqual(BATCH_START_SLACK_MS);
  }
  // Given up as a landing was recorded, its script not yet torn down: its RAM is its own past landing (row 2), and the
  // landing on time.
  expect(drainedHeld.length).toBeGreaterThan(0);
  for (const each of drainedHeld) expect(each.landingLagMs).toBe(0);
});

/**
 * n00dles prepared by a batcher at the hacking level `hackingExp` gives, then batched for 20 s by one told the player's
 * hacks are 60 times as fast as they are, beside RAM held 60 ms in each 100: its health, and the waits it kept, looked
 * at each second. Its operations, so reckoned, all start late: what's looked at is only its books.
 */
async function fastBatcherHealth(
  hackingExp: number,
  edit?: (name: string, source: string) => string,
): Promise<{ health: BatcherHealth; waits: RamWait[] }> {
  const simulation = await gameWithScripts(edit);
  await simulation.diagnostics.setHomeRam(64);
  const honest = await batchingOnSixHosts(simulation, hackingExp);
  const first = (await simulation.ps("home")).find((each) => each.filename.endsWith(BATCHER_SCRIPT_NAME));
  if (first === undefined) throw new Error("no batcher on home");
  await simulation.kill(first.pid);
  await simulation.advance(60_000);
  const fast = { ...MULTS, hacking_speed: 60 };
  const player = { skills: { hacking: (await simulation.summary()).hackingLevel, intelligence: 0 }, mults: fast };
  const threads = batchThreads(N00DLES, player, 1);
  const ramGb = batchRamGb(SHARING_HOSTS.map(() => 16));
  const spacingMs = leastSpacingMs(threads, batchHoldsMs(N00DLES, player, threads), ramGb);
  if (spacingMs === null) throw new Error("no batch of one hack thread fits at 60 times the speed");
  const config = {
    ...honest,
    player: { intelligence: 0, mults: fast },
    hackShare: hackSharePerThread(N00DLES, player),
    spacingMs,
  };
  const holding = await simulation.run("home", "hold-briefly.js", { args: [60, 100, ...SHARING_HOSTS] });
  expect(holding.error).toBeUndefined();
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  const { waits } = await waitsAndShortsOver(simulation, 20_000);
  const health = await healthOf(simulation);
  await simulation.kill(holding.pid);
  console.log(
    `#246's verification, at ${hackingExp} exp: ${health.batchesStarted} batches, ${health.hacksHeldForBatch} hacks ` +
      `held for their batch, ${health.ordersDropped} orders dropped, ${health.ramWaits} waits, ${health.batchesShort} short`,
  );
  return { health, waits };
}

test("a hack waits with its batch's orders waiting for RAM, never out without them (#246's verification)", {
  timeout: 300_000,
}, async () => {
  // At hacking about 1,000, a weaken reckoned at 160 ms: a batch's hack starts some 50 ms after its grow, still the last
  // out, as a late game's would (a hack time under ~64 ms), and a grow waiting for RAM is still there when it's due.
  const { health, waits } = await fastBatcherHealth(2e16);
  // Held while their batch's orders waited, then out or short with them; no order ever found its batch gone. Not waits
  // for RAM: each wait counted is one that found no room itself.
  expect(health.hacksHeldForBatch).toBeGreaterThan(0);
  expect(health.ordersDropped).toBe(0);
  for (const each of waits) {
    expect(each.slackMs === null).toBe(each.operation === "hack");
    expect(typeof each.freeGb).toBe("number");
  }
});

test("a batch's hack goes out last however fast it is (#253): no order finds its batch gone", {
  timeout: 300_000,
}, async () => {
  // At hacking about 22,000, a weaken reckoned at 8 ms: the lead outweighs the times, and a batch's grow and weakens,
  // each started only its own hold before its landing, would go out after its hack. Out, the hack takes the batch off
  // the books, and those after it found it gone (9 at #250). Held to go out before it (core's `batchHoldsMs`), they
  // start, or wait for RAM with the hack held beside them, or the batch is short and its hack skipped.
  const { health } = await fastBatcherHealth(1e300);
  expect(health.batchesStarted).toBeGreaterThanOrEqual(10);
  expect(health.hacksLanded).toBeGreaterThan(0);
  expect(health.ordersDropped).toBe(0);
});

/** The bundled batcher.js with the holds before #253 (`BATCH_HACK_LAST_BY_MS` -Infinity: no hold extended). */
const withHoldsBefore253 = (name: string, source: string) => {
  if (name !== BATCHER_SCRIPT_NAME) return source;
  const gap = /\bBATCH_HACK_LAST_BY_MS = 1;/g;
  expect(source.match(gap)?.length, "the gap's declaration, once, in the bundled batcher.js").toBe(1);
  return source.replace(gap, "BATCH_HACK_LAST_BY_MS = -Infinity;");
};

test("with the holds before #253, an order that finds its batch gone is counted, never silent (#246's verification)", {
  timeout: 300_000,
}, async () => {
  // A test's fault (#261's review): the grow and weakens started only their own hold before their landing, after a hack
  // of a weaken reckoned at 8 ms. Out first, the hack takes the batch off the books, and they find it gone (9 at #250).
  const { health } = await fastBatcherHealth(1e300, withHoldsBefore253);
  expect(health.batchesStarted).toBeGreaterThan(0);
  expect(health.ordersDropped).toBeGreaterThan(0);
});
