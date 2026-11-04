// The batcher's operation scripts and its checks on their landings (#204), in the simulator. Each script lands its call
// at the moment named, whatever the target's security when it starts, and records it; one started too late says so,
// and a hack then doesn't run. The batcher counts a record out of order, a late one, one it can't read, one no
// operation of its own wrote (a previous batcher's) and one never written (lost), loudly; a late hack's record, written
// before its time, makes nothing out of order.
import {
  BATCHER_CONFIG_PORT,
  BATCHER_HEALTH_PORT,
  BATCHER_LANDING_PORT,
  BATCHER_SCRIPT_NAME,
  type BatcherConfig,
  type BatcherHealth,
  batchHoldsMs,
  batchPeakRamGb,
  batchPlan,
  batchRamGb,
  batchThreads,
  hackSharePerThread,
  LANDING_LOST_AFTER_MS,
  type LandingRecord,
  leastSpacingMs,
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

async function gameWithScripts(): Promise<Simulation> {
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
    await simulation.writeFile("home", FOLDER + name, source(name));
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
  // Two threads' 0.05 each (Server/data/Constants.ts:10).
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
async function inFlight(
  simulation: Simulation,
): Promise<{ pid: number; id: string; landAt: number; target: string }[]> {
  const running = [];
  for (const host of OPERATION_HOSTS) {
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

test("sharing (#224): only while batching and asked, on the room the reserve leaves, every 5 s; off, its RAM comes back", async () => {
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
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 1_000) {
    expect(waited, "batching within 20 virtual minutes").toBeLessThan(20 * 60_000);
    expect((await sharesRunning(simulation)).threads).toBe(0);
    preparingLooks += 1;
    await simulation.advance(1_000);
  }
  expect(preparingLooks, "preparing for a while, with room beside the wave").toBeGreaterThan(20);
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
  for (const [index, startedAt] of starts.entries()) {
    // Seen a second at a time: at most one round every 5 s.
    if (index > 0) expect(startedAt - (starts[index - 1] as number)).toBeGreaterThanOrEqual(SHARE_ROUND_MS - 1_000);
  }
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

test("no share while a last wave lands, nor until the batches planned beside it have (#226's review)", async () => {
  const simulation = await gameWithScripts();
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
  for (let waited = 0; sharedAt === null; waited += 1_000) {
    expect(waited, "sharing within 10 virtual minutes").toBeLessThan(10 * 60_000);
    const health = await healthOf(simulation);
    expect(health).toMatchObject({ batchesShort: 0, late: 0, lost: 0, desyncs: 0 });
    if ((await sharesRunning(simulation)).threads > 0) {
      // Not before the batches planned beside the wave have landed: their hacks first.
      expect(health.hacksLanded).toBeGreaterThan(0);
      sharedAt = await simulation.now();
    }
    await simulation.advance(1_000);
  }
  await simulation.advance(2 * 60_000);
  expect(await healthOf(simulation)).toMatchObject({ batchesShort: 0, late: 0, lost: 0, desyncs: 0 });
});

test("no share for a minute after a batch comes up short of RAM (#226's review): the batches come first", async () => {
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
  // free RAM at the same moment in both, and (#231's review) gives it back after the first short, so the rounds start
  // again once the hold-off after a short is over.
  const unshared = n00dlesConfig();
  const shared = { ...unshared, sharing: { reserveGb: 1_000, homeKeptGb: 8, cores: {} } };
  /**
   * The batcher's first short, from its start, the hosts' free RAM taken from 3 minutes into batching, once a batch
   * is planned whose hack isn't out, and again each second as landings free it, then given back at the first short;
   * then its counts 4 minutes after it, past the minute's hold-off after a short (`SHARE_AFTER_SHORT_MS`), and whether
   * home shared again by then.
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
      if (first !== null && waited >= first.afterMs + 240_000) return { first, after: health, sharedAgain };
      await simulation.advance(1_000);
    }
  };
  const withShare = await firstShortOf(shared);
  // Short while home shared beside it, its health says: threads running, none of them on its hosts.
  expect(withShare.first.health.sharing).toMatchObject({ wanted: true, hostsRamGb: 0 });
  expect(withShare.first.health.sharing?.threads).toBeGreaterThan(0);
  expect(withShare.sharedAgain, "home shared again after the hold-off").toBe(true);
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

test("a new plan while the old one's batches still land (#232): fitted to the RAM as held, trimmed, never short", async () => {
  // #229's augmentations suite: as cloud servers were bought back after an install, the brain's plan moved from fewer,
  // larger batches to more, smaller ones. The old plan's hacks, out last, and the new one's weakens and grows, out
  // first, ran at once: 2 to 3% over the hosts' RAM, split across many, and a hack came up short. Here, on six 16 GB
  // hosts (a hack's 1.75 GB beside the 1.8 GB of the rest), a plan of 28 hack threads, each fitting the RAM, then one
  // of 1: the batcher trims the new plan's batches until the old one's have landed, and none is short.
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
    return { ...n00dlesConfig(), hosts, hackShare: hackThreads * hackSharePerThread(N00DLES, player), spacingMs };
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
  for (let minute = 0; minute < 6; minute++) {
    await simulation.advance(60_000);
    expect(await healthOf(simulation), `${minute + 1} min after the new plan`).toMatchObject({
      batchesShort: 0,
      desyncs: 0,
      late: 0,
      lost: 0,
    });
  }
  const after = await healthOf(simulation);
  // Trimmed while the old plan's batches landed; then the new plan's own, in full.
  expect(after.batchesTrimmed).toBeGreaterThan(0);
  expect(after.batchesStarted - before.batchesStarted).toBeGreaterThan(20);
  expect(after.hacksLanded - before.hacksLanded).toBeGreaterThan(20);
});
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
  // It shared on its hosts all the same, beside the batches.
  expect(mostShared).toBeGreaterThan(0);
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
