import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import { Simulation, type SimulationOptions } from "../src/simulation.ts";
import { decodeSave, diffPaths } from "./helpers/save-diff.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const open: Simulation[] = [];
async function start(options: SimulationOptions): Promise<Simulation> {
  const sim = await Simulation.start(options);
  open.push(sim);
  return sim;
}
const newGame = (seed: number) => start({ seed, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
const fromSave = (seed: number, bytes: Uint8Array, offlineMs?: number) =>
  start({ seed, fixture: { kind: "save", bytes, ...(offlineMs === undefined ? {} : { offlineMs }) } });
afterAll(async () => {
  await Promise.all(open.map((sim) => sim.close()));
});

const HACK_LOOP = `
export async function main(ns) {
  const t = "n00dles";
  ns.nuke(t);
  while (true) {
    if (ns.getServerSecurityLevel(t) > ns.getServerMinSecurityLevel(t) + 1) await ns.weaken(t);
    else if (ns.getServerMoneyAvailable(t) < ns.getServerMaxMoney(t) * 0.75) await ns.grow(t);
    else await ns.hack(t);
  }
}`;

/** A game that has been played for an hour: a hack loop running, money and exp earned. */
async function playedGame(): Promise<Simulation> {
  const sim = await newGame(3);
  await sim.writeFile("home", "hack.js", HACK_LOOP);
  await sim.run("home", "hack.js", { threads: 2, args: ["x", 7, true] });
  await sim.advance(HOUR);
  return sim;
}

// Fields the load path legitimately changes, each with its reason (see packages/sim/README.md, "Saves").
const CHANGED_BY_LOADING: string[] = [];

describe("saves", () => {
  test("save → load → save changes nothing but the documented fields", async () => {
    const original = await playedGame();
    const saved = await original.save();
    const loaded = await fromSave(3, saved);
    expect(diffPaths(decodeSave(saved), decodeSave(await loaded.save()))).toEqual(CHANGED_BY_LOADING);
  });

  test("running scripts are restored when a save is loaded", async () => {
    const original = await playedGame();
    const loaded = await fromSave(3, await original.save());
    const shape = ({ filename, threads, args }: { filename: string; threads: number; args: unknown[] }) => ({
      filename,
      threads,
      args,
    });
    expect((await loaded.ps("home")).map(shape)).toEqual((await original.ps("home")).map(shape));
    // And they run: the hack loop keeps earning.
    const before = (await loaded.summary()).money;
    await loaded.advance(10 * MINUTE);
    expect((await loaded.summary()).money).toBeGreaterThan(before);
  });

  test("the epoch comes from the save; offline time goes through the game's own load path, deterministically", async () => {
    const original = await playedGame();
    const saved = await original.save();
    const savedSummary = await original.summary();
    const [a, b] = await Promise.all([fromSave(9, saved, HOUR), fromSave(9, saved, HOUR)]);
    expect(await a.now()).toBe(EPOCH + HOUR + HOUR); // the save's lastUpdate (one virtual hour in) + one hour offline
    const summary = await a.summary();
    expect(summary.playtimeMs).toBe(savedSummary.playtimeMs + HOUR);
    expect(summary.money).toBeGreaterThan(savedSummary.money); // offline income
    expect(await a.stateHash()).toBe(await b.stateHash());
  });

  test("saves load from a file path as well as from bytes, and as the web build's base64 text", async () => {
    const original = await playedGame();
    const saved = await original.save();
    const dir = path.join(import.meta.dirname, "..", "dist", "test-saves");
    mkdirSync(dir, { recursive: true });
    const gz = path.join(dir, "played.json.gz");
    const base64 = path.join(dir, "played.json");
    writeFileSync(gz, saved);
    writeFileSync(base64, gunzipSync(saved).toString("base64"));
    const [fromGz, fromBase64, fromBytes] = await Promise.all([
      start({ seed: 1, fixture: { kind: "save", path: gz } }),
      start({ seed: 1, fixture: { kind: "save", path: base64 } }),
      fromSave(1, saved),
    ]);
    const hash = await fromBytes.stateHash();
    expect(await fromGz.stateHash()).toBe(hash);
    expect(await fromBase64.stateHash()).toBe(hash);
  });

  test("saving along the way doesn't change how the run turns out", async () => {
    // Serialising draws from Math.random (the game builds a throwaway PlayerObject); the host must undo it.
    const [saving, plain] = await Promise.all([newGame(4), newGame(4)]);
    for (let i = 0; i < 6; i++) {
      await saving.save();
      await saving.advance(10 * MINUTE);
    }
    await plain.advance(HOUR);
    expect(await saving.stateHash()).toBe(await plain.stateHash());
  });

  test("a pre-v3 save migrates cleanly, exporting a backup of the old data first", async () => {
    // A v2.8.1 save that the game's own migration tests use (public, part of the pinned game source).
    const v281 = path.join(
      import.meta.dirname,
      "../../../vendor/bitburner-src/test/jest/Migration/save-files/v2.8.1.gz",
    );
    const sim = await start({ seed: 1, fixture: { kind: "save", path: v281 } });
    const events = await sim.events();
    expect(events.filter((e) => e.type === "console")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "download", filename: expect.stringMatching(/^bitburnerSave_backup_2\.8\.1_/) }),
    );
    const download = events.find((e) => e.type === "download");
    expect(download?.type === "download" && download.bytes).toBeGreaterThan(0); // the backup holds the old save
  });

  test("a save fixture takes its epoch from the save, so epochMs is refused", async () => {
    await expect(
      Simulation.start({ seed: 1, epochMs: EPOCH, fixture: { kind: "save", bytes: new Uint8Array() } }),
    ).rejects.toThrow(/epochMs/);
    await expect(Simulation.start({ seed: 1, fixture: { kind: "new", tutorial: "skipped" } })).rejects.toThrow(
      /epochMs/,
    );
  });
});

// Real Steam saves are personal data: they live in the gitignored fixtures-local/ and are never committed.
const LOCAL = path.join(import.meta.dirname, "..", "fixtures-local");
const steamSaves = existsSync(LOCAL) ? readdirSync(LOCAL).filter((f) => f.endsWith(".json.gz")) : [];

describe.skipIf(steamSaves.length === 0)(`real Steam saves in fixtures-local/ (${steamSaves.length} found)`, () => {
  test.each(steamSaves)("%s loads cleanly and plays on", async (file) => {
    const sim = await start({ seed: 1, fixture: { kind: "save", path: path.join(LOCAL, file) } });
    // Loading (migration, offline progress, restarting scripts) logs no errors.
    const atLoad = await sim.events();
    expect(atLoad.filter((e) => e.type === "console")).toEqual([]);
    if (Number(decodeSave(readFileSync(path.join(LOCAL, file))).VersionSave) < 44) {
      // Saves from before v3 make the game export a backup of the old data first (SaveDataMigrationUtils.ts).
      expect(atLoad.some((e) => e.type === "download" && /backup_2\.8\.1/.test(e.filename))).toBe(true);
    }
    // And the game plays on. (Not asserted: errors from the save's own scripts while playing. Scripts that read the
    // game's rendered page fail headless; see the README's known gaps.)
    const before = (await sim.summary()).playtimeMs;
    await sim.advance(10 * MINUTE);
    expect((await sim.summary()).playtimeMs).toBe(before + 10 * MINUTE);
  });
});
