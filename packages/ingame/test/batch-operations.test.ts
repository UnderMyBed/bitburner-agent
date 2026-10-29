// The batcher's operation scripts and its checks on their landings (#204), in the simulator. Each script lands its call
// at the moment named, whatever the target's security when it starts, and records it; one started too late says so,
// and a hack then doesn't run. The batcher counts a record out of order, a late one, and one it can't read, loudly.
import {
  BATCHER_HEALTH_PORT,
  BATCHER_LANDING_PORT,
  BATCHER_SCRIPT_NAME,
  type BatcherConfig,
  type BatcherHealth,
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
  expect(hack).toMatchObject({ late: true, result: 0 });
  // Recorded at once: it never waited for a hack.
  expect(hack.landedAt).toBeLessThan(landAt);
  expect(weaken).toMatchObject({ late: true });
  expect(weaken.result).toBeCloseTo(0.05, 9);
  expect(weaken.landedAt).toBeGreaterThan(landAt + 60_000);
});

/** The batcher's health, from its port (A7b's Agent reads it there). */
async function healthOf(simulation: Simulation): Promise<BatcherHealth> {
  const { pid } = await simulation.run("home", "peek-port.js", { args: [BATCHER_HEALTH_PORT] });
  await simulation.advance(1);
  return JSON.parse(await printed(simulation, pid)) as BatcherHealth;
}

test("the batcher counts a landing out of order and a late one, desyncs, and names a record it can't read", async () => {
  const simulation = await gameWithScripts();
  await simulation.diagnostics.gainHackingExp(2_000);
  const config: BatcherConfig = {
    target: "n00dles",
    figures: { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 },
    player: { intelligence: 0, mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 } },
    hosts: ["foodnstuff", "sigma-cosmetics"],
    hackShare: 0.05,
    spacingMs: 30_000,
  };
  const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 5_000) {
    expect(waited, "n00dles prepared within 20 virtual minutes").toBeLessThan(20 * 60_000);
    await simulation.advance(5_000);
  }
  const before = await healthOf(simulation);
  expect(before).toMatchObject({ outOfOrder: 0, late: 0, desyncs: 0, problem: null });
  // A record far in the future, then one before it: the second is out of order, and late.
  const record = (landAt: number, late: boolean) =>
    JSON.stringify({ id: "x", landAt, landedAt: landAt, result: 0, late });
  await simulation.run("home", "write-port.js", {
    args: [BATCHER_LANDING_PORT, record(Number.MAX_SAFE_INTEGER, false), record(0, true), JSON.stringify("junk")],
  });
  await simulation.advance(1_000);
  const after = await healthOf(simulation);
  expect(after).toMatchObject({ outOfOrder: 1, late: 1, desyncs: 1, state: "recovering" });
  expect(after.problem).toContain("an unreadable landing record");
});
