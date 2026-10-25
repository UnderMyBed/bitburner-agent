import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SimEvent, Simulation, SimulationOptions } from "../src/simulation.ts";
import { editSave } from "./helpers/save-edit.ts";
import { useSimulations } from "./helpers/sim.ts";

// runUntil: advancing until a condition holds, checked after every timer; and BitNode entries as events.

const EPOCH = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const start = useSimulations();
const newGame = (seed = 6) => start({ seed, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });

const HACK_LOOP = readFileSync(path.join(import.meta.dirname, "../scenarios/scripts/hack.js"), "utf8");

async function hacking(seed = 6): Promise<Simulation> {
  const sim = await newGame(seed);
  await sim.writeFile("home", "hack.js", HACK_LOOP);
  await sim.run("home", "hack.js", { threads: 3 });
  return sim;
}

/**
 * BN1 with SF4.3, able to destroy w0r1d_d43m0n at once. That takes The Red Pill, whose install links w0r1d_d43m0n to
 * The-Cave (Prestige.ts), root on it, and its hacking level, lowered here to what a new player has.
 */
async function readyToDestroy(sourceFiles: Record<number, number> = { 4: 3 }): Promise<Simulation> {
  const fixture = await start({ seed: 6, epochMs: EPOCH, fixture: { kind: "bitnode", n: 1, sourceFiles } });
  const save = editSave(await fixture.save(), ({ PlayerSave, AllServersSave }) => {
    PlayerSave.data.augmentations.push({ name: "The Red Pill", level: 1 });
    AllServersSave.home.data.maxRam = 1024;
    const daemon = AllServersSave.w0r1d_d43m0n.data;
    daemon.hasAdminRights = true;
    daemon.requiredHackingSkill = 1;
    daemon.serversOnNetwork.push("The-Cave");
    AllServersSave["The-Cave"].data.serversOnNetwork.push("w0r1d_d43m0n");
  });
  return start({ seed: 6, fixture: { kind: "save", bytes: save } } satisfies SimulationOptions);
}

const entries = async (sim: Simulation) =>
  (await sim.events()).events
    .filter((e: SimEvent) => e.type === "bitnodeDestroyed" || e.type === "bitnodeFlumed")
    .map(({ at, ...e }) => e);

describe("runUntil", () => {
  test("without a stop condition it is advance: the same state, however it is cut up", async () => {
    const [byAdvance, byRunUntil, inPieces] = await Promise.all([hacking(), hacking(), hacking()]);
    await byAdvance.advance(2 * HOUR);
    expect(await byRunUntil.runUntil(2 * HOUR)).toEqual({ now: EPOCH + 2 * HOUR, stoppedBy: null });
    for (let i = 0; i < 7; i++) await inPieces.runUntil((2 * HOUR) / 8);
    await inPieces.runUntil((2 * HOUR) / 8);
    const hash = await byAdvance.stateHash();
    expect(await byRunUntil.stateHash()).toBe(hash);
    expect(await inPieces.stateHash()).toBe(hash);
  });

  test("stops right after the timer at which a summary condition first holds, however the run is cut up", async () => {
    const stopWhen = [{ summary: { field: "money" as const, op: ">=" as const, value: 100_000 } }];
    const [whole, inPieces] = await Promise.all([hacking(), hacking()]);
    const result = await whole.runUntil(10 * HOUR, { stopWhen });
    expect(result.stoppedBy).toBe(0);
    expect((await whole.summary()).money).toBeGreaterThanOrEqual(100_000);
    let pieces = await inPieces.runUntil(HOUR, { stopWhen });
    while (pieces.stoppedBy === null) pieces = await inPieces.runUntil(HOUR, { stopWhen });
    expect(pieces).toEqual(result);
    expect(await inPieces.stateHash()).toBe(await whole.stateHash());
  });

  test("0 ms sleeps behave as under advance, and a loop of them doesn't stall", async () => {
    const zeros = `const t0 = Date.now(); for (let i = 0; i < 100; i++) await ns.sleep(0); ns.print("out:" + (Date.now() - t0));`;
    const [byAdvance, byRunUntil] = await Promise.all([newGame(), newGame()]);
    for (const sim of [byAdvance, byRunUntil])
      await sim.writeFile("home", "zeros.js", `export async function main(ns) { ${zeros} }`);
    const a = await byAdvance.run("home", "zeros.js");
    const b = await byRunUntil.run("home", "zeros.js");
    await byAdvance.advance(5000);
    await byRunUntil.runUntil(5000);
    const out = async (sim: Simulation, pid: number) => (await sim.logs(pid)).find((l) => l.startsWith("out:"));
    // 99: the first sleep starts outside a tick, so it fires in the same ms; each later one 1 ms after the last.
    expect(await out(byAdvance, a.pid)).toBe("out:99");
    expect(await out(byRunUntil, b.pid)).toBe("out:99");

    await byRunUntil.writeFile("home", "spin.js", "export async function main(ns) { while (true) await ns.sleep(0); }");
    await byRunUntil.run("home", "spin.js");
    const from = await byRunUntil.now();
    expect(await byRunUntil.runUntil(1000)).toEqual({ now: from + 1000, stoppedBy: null });
  });

  test("stops when a script exits", async () => {
    const sim = await newGame();
    await sim.writeFile("home", "nap.js", "export async function main(ns) { await ns.sleep(5000); }");
    await sim.run("home", "nap.js");
    const { now, stoppedBy } = await sim.runUntil(HOUR, { stopWhen: [{ scriptExited: "nap.js" }] });
    expect(stoppedBy).toBe(0);
    expect(now - EPOCH).toBeGreaterThanOrEqual(5000);
    expect(now - EPOCH).toBeLessThan(6000);
  });

  test("a script that hasn't started yet hasn't exited", async () => {
    const sim = await hacking();
    expect((await sim.runUntil(1000, { stopWhen: [{ scriptExited: "later.js" }] })).stoppedBy).toBe(null);
  });

  test("runs the full time when nothing holds, and says which condition stopped it", async () => {
    const sim = await newGame();
    await sim.writeFile("home", "nap.js", "export async function main(ns) { await ns.sleep(5000); }");
    await sim.run("home", "nap.js");
    const stopWhen = [{ event: "bitnodeDestroyed" as const }, { scriptExited: "nap.js" }];
    expect((await sim.runUntil(1000, { stopWhen })).stoppedBy).toBe(null);
    expect((await sim.runUntil(HOUR, { stopWhen })).stoppedBy).toBe(1);
    // It ends exactly at the end, between the game's 200 ms ticks too.
    const from = await sim.now();
    expect(await sim.runUntil(1234)).toEqual({ now: from + 1234, stoppedBy: null });
  });

  test.each([
    [{ ms: -1 }, /non-negative integer/],
    [{ ms: 1, stopWhen: [{ event: "nope" }] }, /stop on event/],
    [{ ms: 1, stopWhen: [{ summary: { field: "nope", op: ">", value: 1 } }] }, /summary field/],
    [{ ms: 1, stopWhen: [{ summary: { field: "money", op: "!=", value: 1 } }] }, /summary op/],
    [{ ms: 1, stopWhen: [{ scriptExited: "a.js", event: "bitverseReached" }] }, /exactly one/],
    [{ ms: 1, onBitVerse: { enter: 16 } }, /onBitVerse/],
    [{ ms: 1, stopWhen: [{ summary: { field: "virtualMs", op: ">", value: 1 } }] }, /summary field/],
    [{ ms: 1, eventsFrom: -1 }, /eventsFrom/],
    [{ ms: 1, stalledLoopMs: 0 }, /stalledLoopMs/],
  ])("refuses %o", async (params, message) => {
    const sim = await newGame();
    const { ms, ...rest } = params as { ms: number };
    expect(() => sim.runUntil(ms, rest as never)).toThrow(message);
  });
});

describe("BitNode entries", () => {
  test("destroying w0r1d_d43m0n through Singularity is a bitnodeDestroyed event, and can stop a run", async () => {
    const sim = await readyToDestroy();
    await sim.writeFile("home", "end.js", "export async function main(ns) { ns.singularity.destroyW0r1dD43m0n(2); }");
    await sim.run("home", "end.js");
    const result = await sim.runUntil(HOUR, { stopWhen: [{ event: "bitnodeDestroyed" }] });
    expect(result.stoppedBy).toBe(0);
    expect(await entries(sim)).toEqual([{ type: "bitnodeDestroyed", destroyed: 1, entered: 2 }]);
    expect(await sim.summary()).toMatchObject({ bitNodeN: 2, sourceFiles: { 1: 1, 4: 3 } });
  });

  test("leaving by b1tflum3 is a bitnodeFlumed event, timed at the timer it happened in", async () => {
    const sim = await readyToDestroy();
    const t0 = await sim.now();
    const flume = "export async function main(ns) { await ns.sleep(5000); ns.singularity.b1tflum3(3); }";
    await sim.writeFile("home", "flume.js", flume);
    await sim.run("home", "flume.js");
    await sim.advance(60_000);
    expect(await entries(sim)).toEqual([{ type: "bitnodeFlumed", left: 1, entered: 3 }]);
    const [event] = (await sim.events()).events.filter((e) => e.type === "bitnodeFlumed");
    expect((event?.at ?? 0) - t0).toBe(5000); // the timer it happened in, not the end of the advance
    expect(await sim.summary()).toMatchObject({ bitNodeN: 3, sourceFiles: { 4: 3 } });
  });

  test("an entry exactly at the end of a run still stops it", async () => {
    const sim = await readyToDestroy();
    const t0 = await sim.now();
    const flume = "export async function main(ns) { await ns.sleep(5000); ns.singularity.b1tflum3(3); }";
    await sim.writeFile("home", "flume.js", flume);
    await sim.run("home", "flume.js");
    const stopWhen = [{ event: "bitnodeFlumed" as const }];
    expect(await sim.runUntil(5000, { stopWhen })).toEqual({ now: t0 + 5000, stoppedBy: 0 });
    // By default a run counts only its own events: the next one doesn't stop on that flume again.
    expect(await sim.runUntil(1000, { stopWhen })).toEqual({ now: t0 + 6000, stoppedBy: null });
    expect(await sim.runUntil(1000, { stopWhen, eventsFrom: 0 })).toEqual({ now: t0 + 6000, stoppedBy: 0 });
  });

  test("destroying the BitNode you're in: bitnodeDestroyed from BN1 to BN1", async () => {
    const sim = await readyToDestroy();
    await sim.writeFile("home", "again.js", "export async function main(ns) { ns.singularity.destroyW0r1dD43m0n(1); }");
    await sim.run("home", "again.js");
    await sim.advance(1000);
    expect(await entries(sim)).toEqual([{ type: "bitnodeDestroyed", destroyed: 1, entered: 1 }]);
    expect(await sim.summary()).toMatchObject({ bitNodeN: 1, sourceFiles: { 1: 1, 4: 3 } });
  });

  test("destroying a BitNode whose Source-File is maxed is still a destroy (w0r1d_d43m0n was backdoored)", async () => {
    const sim = await readyToDestroy({ 1: 3, 4: 3 });
    await sim.writeFile("home", "end.js", "export async function main(ns) { ns.singularity.destroyW0r1dD43m0n(2); }");
    await sim.run("home", "end.js");
    await sim.advance(1000);
    expect(await entries(sim)).toEqual([{ type: "bitnodeDestroyed", destroyed: 1, entered: 2 }]);
    expect((await sim.summary()).sourceFiles).toEqual({ 1: 3, 4: 3 });
  });

  test("destroying into the same BitNode in the same ms as the last entry is still seen", async () => {
    const sim = await start({ seed: 6, epochMs: EPOCH, fixture: { kind: "bitnode", n: 1, sourceFiles: {} } });
    await sim.diagnostics.destroyBitNode(1); // at the fixture's own entry time: only the Source-Files tell
    expect(await entries(sim)).toEqual([{ type: "bitnodeDestroyed", destroyed: 1, entered: 1 }]);
  });

  test("an entry a request makes is recorded at once (the portal diagnostic)", async () => {
    const sim = await start({ seed: 6, epochMs: EPOCH, fixture: { kind: "bitnode", n: 1, sourceFiles: {} } });
    await sim.advance(1000);
    await sim.diagnostics.destroyBitNode(2);
    const [event] = (await sim.events()).events.filter((e) => e.type === "bitnodeDestroyed");
    expect(event).toEqual({ type: "bitnodeDestroyed", destroyed: 1, entered: 2, at: EPOCH + 1000 });
  });

  // Backdooring w0r1d_d43m0n only takes the game to the BitVerse; a player then picks the next BitNode there.
  const BACKDOOR = `
    const path = ["w0r1d_d43m0n"];
    const parent = { home: null };
    const queue = ["home"];
    while (queue.length) {
      const host = queue.shift();
      for (const next of ns.scan(host)) if (!(next in parent)) { parent[next] = host; queue.push(next); }
    }
    if (!("w0r1d_d43m0n" in parent)) throw new Error("w0r1d_d43m0n is not on the network");
    while (parent[path[0]] !== "home") path.unshift(parent[path[0]]);
    for (const host of path) ns.singularity.connect(host);
    await ns.singularity.installBackdoor();`;

  test("backdooring w0r1d_d43m0n reaches the BitVerse; onBitVerse: stop ends the run there", async () => {
    const sim = await readyToDestroy();
    await sim.writeFile("home", "door.js", `export async function main(ns) {${BACKDOOR}}`);
    await sim.run("home", "door.js");
    const t0 = await sim.now();
    const result = await sim.runUntil(HOUR, { onBitVerse: "stop" });
    expect(result.stoppedBy).toBe("bitverse");
    expect(result.now - t0).toBeLessThan(HOUR); // stopped on arrival, not at the end
    expect(await sim.diagnostics.game()).toMatchObject({ page: "BitVerse" });
    expect(await entries(sim)).toEqual([]);
  });

  test("flumeing from the BitVerse after a backdoor is a flume: no Source-File is granted", async () => {
    const sim = await readyToDestroy();
    await sim.writeFile("home", "door.js", `export async function main(ns) {${BACKDOOR}}`);
    await sim.run("home", "door.js");
    await sim.runUntil(HOUR, { onBitVerse: "stop" });
    await sim.writeFile("home", "flume.js", "export async function main(ns) { ns.singularity.b1tflum3(3); }");
    await sim.run("home", "flume.js");
    await sim.advance(1000);
    expect(await entries(sim)).toEqual([{ type: "bitnodeFlumed", left: 1, entered: 3 }]);
    expect((await sim.summary()).sourceFiles).toEqual({ 4: 3 });
  });

  test("onBitVerse: { enter } picks the next BitNode as the portal does: a bitnodeDestroyed event", async () => {
    const sim = await readyToDestroy();
    await sim.writeFile("home", "door.js", `export async function main(ns) {${BACKDOOR}}`);
    await sim.run("home", "door.js");
    const result = await sim.runUntil(HOUR, {
      onBitVerse: { enter: 6 },
      stopWhen: [{ event: "bitnodeDestroyed" }],
    });
    expect(result.stoppedBy).toBe(0);
    expect(await entries(sim)).toEqual([{ type: "bitnodeDestroyed", destroyed: 1, entered: 6 }]);
    const [event] = (await sim.events()).events.filter((e) => e.type === "bitnodeDestroyed");
    expect(event?.at).toBe(result.now); // recorded at the moment of entry, not a timer later
    // BitNode 6's cinematic is left as Continue does.
    expect(await sim.diagnostics.game()).toMatchObject({ page: "Terminal" });
    expect(await sim.summary()).toMatchObject({ bitNodeN: 6, sourceFiles: { 1: 1, 4: 3 } });
  });

  test("a BitNode fixture's own entry isn't an event", async () => {
    const sim = await start({ seed: 6, epochMs: EPOCH, fixture: { kind: "bitnode", n: 2, sourceFiles: { 1: 1 } } });
    await sim.advance(1000);
    expect(await entries(sim)).toEqual([]);
  });
});
