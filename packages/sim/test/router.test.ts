import { afterAll, describe, expect, test } from "vitest";
import { type SimEvent, Simulation, type SimulationOptions } from "../src/simulation.ts";
import { decodeSave } from "./helpers/save-diff.ts";
import { editSave, withBitNodeFinished, withSingularity } from "./helpers/save-edit.ts";

// The headless router (src/engine/bundle/router.ts) stands in for the one GameRoot builds when it renders. Each test
// here fails on the game's pre-mount stub, which is what headless play had before it.

const EPOCH = Date.UTC(2026, 0, 1);
const open: Simulation[] = [];
async function start(options: SimulationOptions): Promise<Simulation> {
  const sim = await Simulation.start(options);
  open.push(sim);
  return sim;
}
afterAll(async () => {
  await Promise.all(open.map((sim) => sim.close()));
});

const newGame = () => start({ seed: 5, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
const fromSave = (bytes: Uint8Array) => start({ seed: 5, fixture: { kind: "save", bytes } });
const page = async (sim: Simulation) => (await sim.diagnostics.game()).page;
const bitverseEvents = async (sim: Simulation) =>
  (await sim.events()).events.filter((e: SimEvent) => e.type === "bitverseReached").map(({ at, ...rest }) => rest);

/** A new game with Singularity available (Source-File 4.3, edited into its save). */
async function singularityGame(): Promise<Simulation> {
  return fromSave(withSingularity(await (await newGame()).save()));
}

let scripts = 0;
/** Runs a script for `ms` of virtual time. `out` is what it passed to `out(…)`; `log` is its whole log. */
async function runScript(sim: Simulation, body: string, ms = 1_000): Promise<{ out: unknown[]; log: string[] }> {
  const name = `script${++scripts}.js`;
  await sim.writeFile(
    "home",
    name,
    `export async function main(ns) {\nns.disableLog("ALL");\nconst out = (v) => ns.print("out:" + JSON.stringify(v));\n${body}\n}`,
  );
  const { pid, error } = await sim.run("home", name);
  expect(error).toBeUndefined();
  await sim.advance(ms);
  const log = await sim.logs(pid);
  const out = log.filter((line) => line.startsWith("out:")).map((line) => JSON.parse(line.slice(4)) as unknown);
  return { out, log };
}

describe("headless router", () => {
  test("a new game starts on the Terminal", async () => {
    expect(await page(await newGame())).toBe("Terminal");
  });

  test("pages change synchronously, with the real router's 10-page history", async () => {
    const sim = await newGame();
    await sim.diagnostics.toPage("City");
    expect(await page(sim)).toBe("City");
    await sim.diagnostics.toPage("Stats");
    await sim.diagnostics.back();
    expect(await page(sim)).toBe("City");
    await sim.diagnostics.back();
    expect(await page(sim)).toBe("Terminal");
    await sim.diagnostics.back(); // one page left: back does nothing
    expect(await page(sim)).toBe("Terminal");

    // History keeps 10 pages: after 10 more, the Terminal has dropped off the end.
    for (let i = 0; i < 10; i++) await sim.diagnostics.toPage(i % 2 === 0 ? "City" : "Stats");
    for (let i = 0; i < 20; i++) await sim.diagnostics.back();
    expect(await page(sim)).toBe("City");
  });

  test("messages are delivered on the Terminal (the stub hides them everywhere)", async () => {
    // Hacking level 25 brings the first message (and fl1ght.exe) at the next message check.
    const save = editSave(await (await newGame()).save(), ({ PlayerSave }) => {
      PlayerSave.data.exp.hacking = 1_000;
    });
    const sim = await fromSave(save);
    const { out } = await runScript(sim, `await ns.sleep(60_000); out(ns.ls("home"));`, 61_000);
    expect(out).toEqual([expect.arrayContaining(["j0.msg", "fl1ght.exe"])]);
  });
  test("going to the Travel page takes the player to the Travel Agency", async () => {
    // Players start at the Travel Agency; start this one somewhere else.
    const save = editSave(withSingularity(await (await newGame()).save()), ({ PlayerSave }) => {
      PlayerSave.data.location = "Alpha Enterprises";
    });
    const sim = await fromSave(save);
    const { out } = await runScript(
      sim,
      `ns.singularity.goToLocation("Travel Agency");
       out(ns.getPlayer().location);`,
    );
    expect(out).toEqual(["Travel Agency"]);
    expect(await page(sim)).toBe("Travel");
  });

  test("focused work shows the Work page; leaving it stops focusing, as the real router does", async () => {
    const sim = await singularityGame();
    await runScript(sim, `ns.singularity.commitCrime("Shoplift", true);`);
    expect(await sim.diagnostics.game()).toMatchObject({ page: "Work", focus: true });

    // setFocus(false) only navigates away; the router is what ends focus.
    const { out } = await runScript(sim, `ns.singularity.setFocus(false); out(ns.singularity.isFocused());`);
    expect(out).toEqual([false]);
    expect(await sim.diagnostics.game()).toMatchObject({ page: "Terminal", focus: false });
  });

  test("a save with work in progress starts on the Work page", async () => {
    const sim = await singularityGame();
    await runScript(sim, `ns.singularity.commitCrime("Shoplift", true);`);
    expect(await page(await fromSave(await sim.save()))).toBe("Work");
  });

  test("reaching the BitVerse kills every script, is reported, and game logic sees it", async () => {
    const sim = await singularityGame();
    await sim.writeFile("home", "idle.js", "export async function main(ns) { while (true) await ns.sleep(1000); }");
    await sim.run("home", "idle.js");
    await sim.diagnostics.toPage("BitVerse", true);

    expect(await sim.ps("home")).toEqual([]);
    expect(await bitverseEvents(sim)).toEqual([{ type: "bitverseReached", flume: true, destroyedBitNode: 1 }]);
    expect(await page(sim)).toBe("BitVerse");

    // Singularity's isBusy reads the page; so does ns.spawn, which won't start scripts from the BitVerse.
    const { out, log } = await runScript(
      sim,
      `out(ns.singularity.isBusy()); ns.enableLog("spawn"); ns.spawn("idle.js", { spawnDelay: 0 });`,
    );
    expect(out).toEqual([true]);
    expect(log).toContain("spawn: Script execution is canceled because you are in Bitverse.");
    expect(await sim.ps("home")).toEqual([]);
  });

  test("a save whose BitNode is finished starts at the BitVerse, says so, and hides messages there", async () => {
    const save = editSave(withBitNodeFinished(await (await newGame()).save()), ({ PlayerSave }) => {
      PlayerSave.data.exp.hacking = 1_000; // enough for the first message, were it delivered
    });
    const sim = await fromSave(save);
    expect(await page(sim)).toBe("BitVerse");
    expect(await bitverseEvents(sim)).toEqual([{ type: "bitverseReached", flume: false, destroyedBitNode: 1 }]);
    const { out } = await runScript(sim, `await ns.sleep(60_000); out(ns.ls("home", ".msg"));`, 61_000);
    expect(out).toEqual([[]]);
  });

  test("arriving at the BitVerse checks achievements straight away", async () => {
    // Starting at the BitVerse doesn't navigate there, so FAST_BN (finished within two days) waits for the engine's
    // next periodic check; navigating there checks at once.
    const sim = await fromSave(withBitNodeFinished(await (await newGame()).save()));
    const achievements = async () =>
      (decodeSave(await sim.save()).PlayerSave as { data: { achievements: { ID: string }[] } }).data.achievements.map(
        (a) => a.ID,
      );
    expect(await achievements()).not.toContain("FAST_BN");
    await sim.diagnostics.toPage("BitVerse");
    expect(await achievements()).toContain("FAST_BN");
  });
});
