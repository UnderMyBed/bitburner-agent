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
  batchPlan,
  batchRamGb,
  LANDING_LOST_AFTER_MS,
  type LandingRecord,
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

async function gameWithScripts(): Promise<Simulation> {
  const simulation = await start(NEW_GAME);
  const { source } = await build();
  for (const name of [BATCHER_SCRIPT_NAME, "batch-hack.js", "batch-grow.js", "batch-weaken.js", "hack-loop-root.js"]) {
    await simulation.writeFile("home", FOLDER + name, source(name));
  }
  await simulation.writeFile("home", "read-port.js", READ_PORT);
  await simulation.writeFile("home", "write-port.js", WRITE_PORT);
  await simulation.writeFile("home", "set-port.js", SET_PORT);
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
  const config = { ...n00dlesConfig(), hosts, spacingMs: plan?.spacingMs ?? 0 };
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
