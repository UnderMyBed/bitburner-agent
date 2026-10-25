import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import { type SimEvent, Simulation, type SimulationOptions } from "../src/simulation.ts";
import { decodeSave, diffPaths } from "./helpers/save-diff.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const scratch = mkdtempSync(path.join(tmpdir(), "sim-saves-"));
const open: Simulation[] = [];
async function start(options: SimulationOptions): Promise<Simulation> {
  const sim = await Simulation.start(options);
  open.push(sim);
  return sim;
}
const newGame = (seed: number) => start({ seed, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
const fromSave = (seed: number, bytes: Uint8Array, offlineMs = 0) =>
  start({ seed, fixture: { kind: "save", bytes, offlineMs } });
afterAll(async () => {
  await Promise.all(open.map((sim) => sim.close()));
  rmSync(scratch, { recursive: true, force: true });
});

const isDownload = (e: SimEvent): e is Extract<SimEvent, { type: "download" }> => e.type === "download";
const isConsole = (e: SimEvent): e is Extract<SimEvent, { type: "console" }> => e.type === "console";

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

/** Re-encodes a save after changing its settings, to stand in for a save the simulator didn't make. */
function withSettings(bytes: Uint8Array, settings: Record<string, unknown>): Uint8Array {
  const outer = JSON.parse(gunzipSync(bytes).toString("utf8")) as { data: Record<string, string> };
  const current = JSON.parse(outer.data.SettingsSave ?? "{}") as Record<string, unknown>;
  outer.data.SettingsSave = JSON.stringify({ ...current, ...settings });
  return new Uint8Array(gzipSync(JSON.stringify(outer)));
}

describe("saves", () => {
  test("a save the simulator made round-trips exactly: save → load → save changes nothing", async () => {
    const original = await playedGame();
    const saved = await original.save();
    const loaded = await fromSave(3, saved);
    expect(diffPaths(decodeSave(saved), decodeSave(await loaded.save()))).toEqual([]);
  });

  test("loading any other save turns autosave off, and changes nothing else", async () => {
    // The harness overrides these two settings on every load; a save the simulator made already has its values.
    const foreign = withSettings(await (await playedGame()).save(), {
      AutosaveInterval: 60,
      SuppressAutosaveDisabledWarnings: false,
    });
    const loaded = await fromSave(3, foreign);
    expect(diffPaths(decodeSave(foreign), decodeSave(await loaded.save()))).toEqual([
      "SettingsSave.AutosaveInterval",
      "SettingsSave.SuppressAutosaveDisabledWarnings",
    ]);
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
    const saved = await (await playedGame()).save();
    const gz = path.join(scratch, "played.json.gz");
    const base64 = path.join(scratch, "played.json");
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

  test("a script that compresses data (as the game's own save does) takes no virtual time", async () => {
    // The game gzips saves with CompressionStream; in Node that runs on a thread pool in real time.
    const script = `export async function main(ns) {
      const started = Date.now();
      const stream = new Blob(["x".repeat(2_000_000)]).stream().pipeThrough(new CompressionStream("gzip"));
      const bytes = await new Response(stream).arrayBuffer();
      ns.print("elapsed " + (Date.now() - started) + " size " + bytes.byteLength);
    }`;
    const sims = await Promise.all([newGame(1), newGame(1), newGame(1)]);
    const outputs = await Promise.all(
      sims.map(async (sim) => {
        await sim.writeFile("home", "compress.js", script);
        const { pid } = await sim.run("home", "compress.js");
        await sim.advance(10_000);
        return (await sim.logs(pid))[0];
      }),
    );
    expect(outputs).toEqual(Array(3).fill(expect.stringMatching(/^elapsed 0 size \d+$/)));
  });

  test("a pre-v3 save migrates cleanly, exporting a backup of the old data first", async () => {
    // A v2.8.1 save that the game's own migration tests use (public, part of the pinned game source).
    const v281 = path.join(
      import.meta.dirname,
      "../../../vendor/bitburner-src/test/jest/Migration/save-files/v2.8.1.gz",
    );
    const sim = await start({ seed: 1, fixture: { kind: "save", path: v281 } });
    const { events } = await sim.events();
    expect(events.filter(isConsole)).toEqual([]);
    const downloads = events.filter(isDownload);
    expect(downloads.map((d) => d.filename)).toEqual([expect.stringMatching(/^bitburnerSave_backup_2\.8\.1_/)]);
    expect(downloads[0]?.bytes).toBeGreaterThan(0); // the backup holds the old save
  });

  test("bad save fixtures are refused with a clear message", async () => {
    const gz = new Uint8Array(gzipSync('{"ctor":"BitburnerSaveObject","data":{}}'));
    const cases: [SimulationOptions, RegExp][] = [
      [{ seed: 1, epochMs: EPOCH, fixture: { kind: "save", bytes: gz } }, /epochMs/],
      [{ seed: 1, fixture: { kind: "new", tutorial: "skipped" } }, /epochMs is required/],
      [{ seed: 1, fixture: { kind: "save", bytes: gz, offlineMs: -1 } }, /offlineMs/],
      [{ seed: 1, fixture: { kind: "save", bytes: gz, offlineMs: 1.5 } }, /offlineMs/],
      [{ seed: 1, fixture: { kind: "save" } } as unknown as SimulationOptions, /exactly one of bytes or path/],
      [{ seed: 1, fixture: { kind: "save", bytes: gz } }, /Not a Bitburner save/],
      [{ seed: 1, fixture: { kind: "save", bytes: gz.subarray(0, 10) } }, /Not a valid \.json\.gz save/],
      [{ seed: 1, fixture: { kind: "save", bytes: new TextEncoder().encode("{}") } }, /not plain JSON/],
    ];
    for (const [options, message] of cases) await expect(Simulation.start(options)).rejects.toThrow(message);
  });
});

describe("events", () => {
  test("console errors and warnings are recorded, with the virtual time and no machine paths", async () => {
    const sim = await newGame(1);
    await sim.writeFile(
      "home",
      "noisy.js",
      'export async function main(ns) { await ns.sleep(1000); console.warn("careful"); console.error(new Error("boom")); }',
    );
    await sim.run("home", "noisy.js");
    await sim.advance(2000);
    const consoleEvents = (await sim.events()).events.filter(isConsole);
    expect(consoleEvents.map((e) => [e.level, e.at, e.message.split("\n")[0]])).toEqual([
      ["warn", EPOCH + 1000, "careful"],
      ["error", EPOCH + 1000, "Error: boom"],
    ]);
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    expect(consoleEvents.some((e) => e.message.includes(repoRoot))).toBe(false);
  });

  test("the log can be read incrementally", async () => {
    const sim = await newGame(1);
    await sim.writeFile("home", "warn.js", 'export async function main(ns) { console.warn("one"); }');
    await sim.run("home", "warn.js");
    await sim.advance(1000);
    const first = await sim.events();
    expect(first.events).toHaveLength(1);
    await sim.run("home", "warn.js");
    await sim.advance(1000);
    const second = await sim.events(first.next);
    expect(second.events.map((e) => isConsole(e) && e.message)).toEqual(["one"]);
    expect(second).toMatchObject({ next: first.next + 1, dropped: 0 });
  });
});

// Real Steam saves are personal data: they live in the gitignored fixtures-local/ and are never committed.
const LOCAL = path.join(import.meta.dirname, "..", "fixtures-local");
const steamSaves = existsSync(LOCAL) ? readdirSync(LOCAL).filter((f) => f.endsWith(".json.gz")) : [];

describe("real Steam saves in fixtures-local/", () => {
  // Reported as skipped, so a run without local saves says so.
  if (steamSaves.length === 0) test.skip("none found: local-only tests skipped (see packages/sim/README.md, Saves)");

  test.each(steamSaves)("%s loads cleanly and plays on", async (file) => {
    const sim = await start({ seed: 1, fixture: { kind: "save", path: path.join(LOCAL, file) } });
    // Loading (migration, offline progress, restarting scripts) logs no errors.
    const { events: atLoad } = await sim.events();
    expect(atLoad.filter(isConsole)).toEqual([]);
    // VersionSave is a number since v1 and a quoted string before; anything that isn't a number below 44 is pre-v3.
    const version = Number(decodeSave(readFileSync(path.join(LOCAL, file))).VersionSave);
    if (!(version >= 44)) {
      // Saves from before v3 make the game export a backup of the old data first (SaveDataMigrationUtils.ts).
      expect(atLoad.filter(isDownload).map((d) => d.filename)).toEqual([expect.stringMatching(/backup_2\.8\.1/)]);
    }
    // And the game plays on. (Not asserted: errors from the save's own scripts while playing. Scripts that read the
    // game's rendered page fail headless; see the README's known gaps.)
    const before = (await sim.summary()).playtimeMs;
    await sim.advance(10 * MINUTE);
    expect((await sim.summary()).playtimeMs).toBe(before + 10 * MINUTE);
  });
});
