// Bladeburner's effectors in the simulator (#367): the `joinBladeburnerDivision` intent through the simulator's own
// effector and through its home worker (`join-bladeburner.js`, the NS API alone, so the `ui` backend's in any game),
// each refusing what the game refuses (a combat stat under 100; no Bladeburner in BN1 without SF6 or SF7); and the
// Agent's Bladeburner worker (`bladeburner.js`) reading the rank into the medium snapshot and joining the Bladeburners
// faction at rank 25, with the medium snapshot's `inBladeburner`. The combat stats and the rank by harness edits.
import {
  type DesiredState,
  type FastSnapshotData,
  type Intent,
  type MediumSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { JOIN_BLADEBURNER_INTENT } from "../src/bladeburner.ts";
import { type FreshGame, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStart = useFreshStarts();
const HACK_LOOP_OFF: DesiredState["hackLoop"] = { enabled: false, target: null, hosts: [] };
const BN6 = { kind: "bitnode", n: 6, sourceFiles: { 1: 3 } } as const;
/** Each combat stat to 100 at ×1 (core's `skillExpFor`), by the game's own gains. */
const trained = ({ simulation }: FreshGame) => simulation.diagnostics.gainCombatExp(skillExpFor(100, 1) + 1);
const REFUSED =
  "the game didn't take the player into the Bladeburner division: a combat stat under 100, or no Bladeburner here " +
  "(BN6, BN7, or SF6 or SF7; none in BN8)";

type Fresh = Awaited<ReturnType<typeof freshStart>>;
const outcomeOf = (fresh: Fresh, id: string) =>
  (fresh.latest<FastSnapshotData>("fast")?.intents ?? []).find((each) => each.id === id);
/** Sends `intent` alone, and runs the game until the Agent has tried it once more than before. */
async function triedOnce(fresh: Fresh, intent: Intent) {
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [] });
  await fresh.game.run(4_000);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [intent] });
  await fresh.game.runUntil(() => (outcomeOf(fresh, intent.id)?.tries ?? 0) > 0, 30_000);
  return outcomeOf(fresh, intent.id);
}
const inBladeburner = (fresh: Fresh) => (fresh.medium() as MediumSnapshotData | undefined)?.inBladeburner;

test("the division's join (sim): refused under 100 in BN6, done at 100, the medium snapshot saying so; refused in BN1", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN6 });
  expect(await triedOnce(fresh, JOIN_BLADEBURNER_INTENT)).toMatchObject({
    done: false,
    backend: "sim",
    problem: REFUSED,
  });
  await fresh.game.run(12_000);
  expect(inBladeburner(fresh)).toBe(false);
  await trained(fresh);
  expect(await triedOnce(fresh, JOIN_BLADEBURNER_INTENT)).toMatchObject({ done: true, backend: "sim", problem: null });
  await fresh.game.run(12_000);
  expect(inBladeburner(fresh)).toBe(true);

  const inBitNode1 = await freshStart({ withDesiredState: false, beforeAgent: trained });
  expect(await triedOnce(inBitNode1, JOIN_BLADEBURNER_INTENT)).toMatchObject({
    done: false,
    backend: "sim",
    problem: REFUSED,
  });
});

test("the division's join (its worker): the simulator's effectors taken away, through the NS API as the ui backend", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN6, beforeAgent: withoutSimEffectors });
  expect(await triedOnce(fresh, JOIN_BLADEBURNER_INTENT)).toMatchObject({
    done: false,
    backend: "ui",
    problem: REFUSED,
  });
  await trained(fresh);
  expect(await triedOnce(fresh, JOIN_BLADEBURNER_INTENT)).toMatchObject({ done: true, backend: "ui", problem: null });
  // Again, in it: done, nothing joined anew.
  expect(await triedOnce(fresh, JOIN_BLADEBURNER_INTENT)).toMatchObject({ done: true, backend: "ui", problem: null });
});

test("the Bladeburner worker: no rank out of the division; in it, the rank read, and the faction joined at 25", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN6, beforeAgent: trained });
  const state = (joinTheFaction: boolean): DesiredState => ({
    hackLoop: HACK_LOOP_OFF,
    intents: [],
    bladeburner: { joinTheFaction },
  });
  fresh.brain.channel.setDesiredState(state(false));
  await fresh.game.run(12_000);
  expect(fresh.medium()?.bladeburner).toEqual({ rank: null, problems: [] });
  expect(await triedOnce(fresh, JOIN_BLADEBURNER_INTENT)).toMatchObject({ done: true });
  fresh.brain.channel.setDesiredState(state(false));
  await fresh.game.runUntil(() => fresh.medium()?.bladeburner?.rank === 0, 30_000);
  // Asked under 25 (a stale state): a problem, nothing joined.
  fresh.brain.channel.setDesiredState(state(true));
  await fresh.game.runUntil(() => (fresh.medium()?.bladeburner?.problems.length ?? 0) > 0, 30_000);
  expect(fresh.medium()?.bladeburner).toEqual({ rank: 0, problems: ["the faction asked for at rank 0.0, under 25"] });
  await fresh.simulation.diagnostics.setBladeburnerRank(25);
  await fresh.game.runUntil(() => {
    const factions = (fresh.medium()?.player as { factions?: string[] } | undefined)?.factions ?? [];
    return factions.includes("Bladeburners");
  }, 30_000);
  expect(fresh.medium()?.bladeburner).toEqual({ rank: 25, problems: [] });
  // Asked again with it joined: done at once, as the game has it.
  await fresh.game.run(12_000);
  expect(fresh.medium()?.bladeburner).toEqual({ rank: 25, problems: [] });
});

test("the brain gone: the Agent forgets the Bladeburner state, so its worker doesn't run on in safe mode", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN6, beforeAgent: trained });
  expect(await triedOnce(fresh, JOIN_BLADEBURNER_INTENT)).toMatchObject({ done: true });
  // Kept for safe mode (its ttl), so the Agent's rounds go on once the brain is gone.
  fresh.brain.channel.setDesiredState({
    hackLoop: HACK_LOOP_OFF,
    intents: [],
    bladeburner: { joinTheFaction: true },
    ttlMs: 600_000,
  });
  await fresh.game.runUntil(() => (fresh.medium()?.bladeburner?.problems.length ?? 0) > 0, 30_000);
  fresh.brain.stop();
  await fresh.game.run(5_000);
  // The rank there now: a worker still running on the old state would join the faction within 10 s.
  await fresh.simulation.diagnostics.setBladeburnerRank(25);
  await fresh.game.run(60_000);
  await fresh.simulation.writeFile(
    "home",
    "factions.js",
    'export async function main(ns) { ns.print("factions:" + JSON.stringify(ns.getPlayer().factions)); }',
  );
  const { pid, error } = await fresh.simulation.run("home", "factions.js");
  expect(error).toBeUndefined();
  await fresh.game.run(1_000);
  const line = (await fresh.simulation.logs(pid)).find((each) => each.startsWith("factions:"));
  expect(JSON.parse((line ?? "factions:null").slice(9))).not.toContain("Bladeburners");
}, 120_000);

test("the division's join (sim) from outside Sector-12: refused, as the NSA's button is there", async () => {
  const fresh = await freshStart({
    withDesiredState: false,
    fixture: BN6,
    beforeAgent: async (game) => {
      await trained(game);
      await game.simulation.diagnostics.setMoney(1e6);
    },
  });
  const travel = { action: "travel", args: { city: "Aevum" }, id: "travel(Aevum)" } as const;
  expect(await triedOnce(fresh, travel)).toMatchObject({ done: true });
  expect(await triedOnce(fresh, JOIN_BLADEBURNER_INTENT)).toMatchObject({
    done: false,
    backend: "sim",
    problem: "the NSA is in Sector-12, and the player is in Aevum (travel there first)",
  });
});
