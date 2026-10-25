import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { enginePaths } from "../src/engine/paths.ts";
import type { SimEvent, Simulation } from "../src/simulation.ts";
import { decodeSave } from "./helpers/save-diff.ts";
import { editSave, withBitNodeFinished, withSingularity } from "./helpers/save-edit.ts";
import { runScript, useSimulations } from "./helpers/sim.ts";

// The headless router (src/engine/bundle/router.ts) stands in for the one GameRoot builds when it renders. Each test
// here fails on the game's pre-mount stub, which is what headless play had before it.

const EPOCH = Date.UTC(2026, 0, 1);
const start = useSimulations();

const newGame = () => start({ seed: 5, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
const fromSave = (bytes: Uint8Array) => start({ seed: 5, fixture: { kind: "save", bytes } });
const page = async (sim: Simulation) => (await sim.diagnostics.game()).page;
const bitverseEvents = async (sim: Simulation) =>
  (await sim.events()).events.filter((e: SimEvent) => e.type === "bitverseReached");

/** A new game with Singularity available (Source-File 4.3, edited into its save). */
async function singularityGame(): Promise<Simulation> {
  return fromSave(withSingularity(await (await newGame()).save()));
}

/** Enough hacking exp for the first message (j0.msg, at hacking level 25), delivered at the next message check. */
const withHackingExp = (bytes: Uint8Array) =>
  editSave(bytes, ({ PlayerSave }) => {
    PlayerSave.data.exp.hacking = 1_000;
  });

/** The messages on home after a minute: message checks run every 30 s or so. */
async function messagesAfterAMinute(sim: Simulation): Promise<unknown> {
  const { out } = await runScript(sim, `await ns.sleep(60_000); out(ns.ls("home", ".msg"));`, 61_000);
  return out[0];
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

  test("the copied router constants still match the game's GameRoot.tsx", () => {
    // router.ts copies these from GameRoot; a game version that changes them must fail here, not silently differ.
    const ours = readFileSync(path.resolve(import.meta.dirname, "../src/engine/bundle/router.ts"), "utf8");
    const game = readFileSync(path.join(enginePaths.gameRoot, "src/ui/GameRoot.tsx"), "utf8");
    const historySize = (source: string) => source.match(/const MAX_PAGES_IN_HISTORY = (\d+);/)?.[1];
    const hidden = (source: string) =>
      source
        .match(/const hiddenPages = new Set(?:<Page>)?\(\[([^\]]*)\]/)?.[1]
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    expect(historySize(game)).toBeDefined();
    expect(historySize(ours)).toBe(historySize(game));
    expect(hidden(game)).toHaveLength(5);
    expect(hidden(ours)).toEqual(hidden(game));
  });

  test("messages are delivered on the Terminal (the stub hides them everywhere)", async () => {
    const sim = await fromSave(withHackingExp(await (await newGame()).save()));
    expect(await messagesAfterAMinute(sim)).toEqual(["j0.msg"]);
    const { out } = await runScript(sim, `out(ns.ls("home", "fl1ght.exe"));`); // the first message's gift
    expect(out).toEqual([["fl1ght.exe"]]);
  });

  test.each(["BitVerse", "Infiltration", "Bladeburner Cinematic", "Recovery"])(
    "messages are hidden on the %s page",
    async (hiddenPage) => {
      const sim = await fromSave(withHackingExp(await (await newGame()).save()));
      await sim.diagnostics.toPage(hiddenPage);
      expect(await messagesAfterAMinute(sim)).toEqual([]);
    },
  );

  test("going to the Travel page takes the player to the Travel Agency", async () => {
    // Players start at the Travel Agency; start this one somewhere else.
    const save = editSave(withSingularity(await (await newGame()).save()), ({ PlayerSave }) => {
      PlayerSave.data.location = "Alpha Enterprises";
    });
    const sim = await fromSave(save);
    const { out } = await runScript(sim, `ns.singularity.goToLocation("Travel Agency"); out(ns.getPlayer().location);`);
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

  test("the Work page goes back to the Terminal once the work ends, as its component does", async () => {
    const sim = await singularityGame();
    await runScript(sim, `ns.singularity.commitCrime("Shoplift", true); ns.singularity.stopAction();`, 0);
    expect(await page(sim)).toBe("Work"); // until the page next renders: after the next game cycle
    await sim.advance(1_000);
    expect(await page(sim)).toBe("Terminal");
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
    await sim.advance(5_000);
    await sim.diagnostics.toPage("BitVerse", true);

    expect(await sim.ps("home")).toEqual([]);
    expect(await bitverseEvents(sim)).toEqual([
      { type: "bitverseReached", at: await sim.now(), flume: true, destroyedBitNode: 1 },
    ]);
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

  test("a save whose BitNode is finished starts at the BitVerse, and says so", async () => {
    const save = editSave(withBitNodeFinished(await (await newGame()).save()), ({ PlayerSave }) => {
      PlayerSave.data.bitNodeN = 2;
    });
    const sim = await fromSave(save);
    expect(await page(sim)).toBe("BitVerse");
    expect(await bitverseEvents(sim)).toEqual([
      { type: "bitverseReached", at: await sim.now(), flume: false, destroyedBitNode: 2 },
    ]);
  });

  test("a finished BitNode outranks work in progress; focus survives leaving a page that isn't Work", async () => {
    const working = await singularityGame();
    await runScript(working, `ns.singularity.commitCrime("Shoplift", true);`);
    const sim = await fromSave(withBitNodeFinished(await working.save()));
    expect(await sim.diagnostics.game()).toMatchObject({ page: "BitVerse", focus: true });
    await sim.diagnostics.toPage("Terminal");
    expect(await sim.diagnostics.game()).toMatchObject({ page: "Terminal", focus: true });
  });

  test("a save the game can't make sense of starts on the Recovery page", async () => {
    // Without w0r1d_d43m0n, isBitNodeFinished throws, and the game starts in recovery mode.
    const save = editSave(await (await newGame()).save(), ({ AllServersSave }) => {
      delete AllServersSave.w0r1d_d43m0n;
    });
    expect(await page(await fromSave(save))).toBe("Recovery");
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

  test.each([
    [1, "Terminal"],
    [6, "Bladeburner Cinematic"],
  ])("entering BitNode %i lands on the %s page, and stays there", async (bitNode, landing) => {
    // enterBitNode navigates (RedPill.tsx). Only the cinematic's Continue button leaves it, so headless (like a
    // player who never clicks) the game stays there, with messages hidden, until something navigates.
    const sim = await singularityGame();
    await sim.writeFile("home", "flume.js", `export async function main(ns) { ns.singularity.b1tflum3(${bitNode}); }`);
    await sim.run("home", "flume.js"); // its log goes with the BitNode, so it isn't read
    await sim.advance(600_000);
    expect(await page(sim)).toBe(landing);
    expect((await sim.summary()).bitNodeN).toBe(bitNode);
  });

  test("the page is part of the state hash: it decides what happens next", async () => {
    const save = await (await newGame()).save();
    const a = await fromSave(save);
    const b = await fromSave(save);
    expect(await a.stateHash()).toBe(await b.stateHash());
    await b.diagnostics.toPage("Infiltration");
    expect(await a.stateHash()).not.toBe(await b.stateHash());
  });
});
