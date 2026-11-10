// The gang's effectors in the simulator (#325): the `createGang` intent through the simulator's own effector and
// through its home worker (`create-gang.js`, the NS API alone, so the `ui` backend's in any game), each refusing what
// the game refuses; and the Agent's gang worker (`gang.js`) doing the desired state's recruits and tasks, its reading
// in the medium snapshot, what the game refused among its problems; and its ascensions (#328, G2). In BN2, NiteSec
// joined by a harness edit.
import {
  type DesiredState,
  type FastSnapshotData,
  type GangState,
  type Intent,
  intentId,
  type MediumSnapshotData,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { type FreshGame, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStart = useFreshStarts();
const HACK_LOOP_OFF: DesiredState["hackLoop"] = { enabled: false, target: null, hosts: [] };
const createGang = (faction: string): Intent => ({
  action: "createGang",
  args: { faction },
  id: intentId("createGang", { faction }),
});
const BN2 = { kind: "bitnode", n: 2, sourceFiles: { 1: 3 } } as const;
const joinNiteSec = ({ simulation }: FreshGame) => simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);

type Fresh = Awaited<ReturnType<typeof freshStart>>;
/** The latest fast snapshot's outcome of `id`. */
const outcomeOf = (fresh: Fresh, id: string) =>
  (fresh.latest<FastSnapshotData>("fast")?.intents ?? []).find((each) => each.id === id);
/** Sends `intent` alone, and runs the game until the Agent has tried it once. */
async function triedOnce(fresh: Fresh, intent: Intent) {
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [intent] });
  await fresh.game.runUntil(() => (outcomeOf(fresh, intent.id)?.tries ?? 0) > 0, 30_000);
  return outcomeOf(fresh, intent.id);
}

test("forming a gang (sim): done in BN2 with NiteSec joined; refused not joined, and in BN1, saying why", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN2, beforeAgent: joinNiteSec });
  expect(await triedOnce(fresh, createGang("Slum Snakes"))).toMatchObject({
    done: false,
    backend: "sim",
    problem: "the game formed no gang with Slum Snakes: not a member, or no gangs here (BN2, or SF2 with karma)",
  });
  expect(await triedOnce(fresh, createGang("NiteSec"))).toMatchObject({ done: true, backend: "sim", problem: null });
  // Another gang's faction once one is formed: the game allows one a BitNode.
  expect(await triedOnce(fresh, createGang("The Black Hand"))).toMatchObject({
    done: false,
    problem: "the gang is NiteSec's already: only one gang a BitNode",
  });

  const inBitNode1 = await freshStart({
    withDesiredState: false,
    beforeAgent: async (game) => {
      await joinNiteSec(game);
    },
  });
  expect(await triedOnce(inBitNode1, createGang("NiteSec"))).toMatchObject({ done: false, backend: "sim" });
});

test("forming a gang (its worker): the simulator's effectors taken away, through the NS API as the ui backend", async () => {
  const fresh = await freshStart({
    withDesiredState: false,
    fixture: { kind: "bitnode", n: 2, sourceFiles: { 1: 3, 4: 3 } },
    beforeAgent: async (game) => {
      await joinNiteSec(game);
      await withoutSimEffectors(game);
    },
  });
  expect(await triedOnce(fresh, createGang("Tetrads"))).toMatchObject({
    done: false,
    backend: "ui",
    problem: "the game formed no gang with Tetrads: not a member, or no gangs here (BN2, or SF2 with karma)",
  });
  expect(await triedOnce(fresh, createGang("NiteSec"))).toMatchObject({ done: true, backend: "ui", problem: null });
  // Another's, once one is formed: refused, never formed anew.
  expect(await triedOnce(fresh, createGang("The Black Hand"))).toMatchObject({
    done: false,
    backend: "ui",
    problem: "the gang is NiteSec's already: only one gang a BitNode",
  });
});

test("the gang worker: recruits and tasks done, read into the medium snapshot; what the game refuses, a problem", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN2, beforeAgent: joinNiteSec });
  const state = (gang: GangState): DesiredState => ({ hackLoop: HACK_LOOP_OFF, intents: [], gang });
  // No gang yet: read as none, nothing done.
  fresh.brain.channel.setDesiredState(state({ recruit: ["a"], ascend: [], tasks: { a: "Ransomware" } }));
  await fresh.game.run(12_000);
  expect(fresh.medium()?.gang).toEqual({ gang: null, members: [], problems: [] });

  expect(await triedOnce(fresh, createGang("NiteSec"))).toMatchObject({ done: true });
  // Five asked for, with the respect for the three free ones: the fourth refused, and none after it tried. A task for a
  // name not a member is skipped; one the gang's kind hasn't (Terrorism, a combat gang's) refused, the member's task
  // left as it was.
  fresh.brain.channel.setDesiredState(
    state({
      recruit: ["a", "b", "c", "d", "e"],
      ascend: [],
      tasks: { a: "Train Hacking", b: "Ransomware", c: "Terrorism", zed: "Train Hacking" },
    }),
  );
  await fresh.game.runUntil(() => (fresh.medium()?.gang?.members.length ?? 0) > 0, 30_000);
  const reading = (fresh.medium() as MediumSnapshotData).gang;
  expect(reading?.gang).toMatchObject({ faction: "NiteSec", isHacking: true, respect: 1, territory: 1 / 7 });
  expect(reading?.members.map(({ name, task }) => [name, task])).toEqual([
    ["a", "Train Hacking"],
    ["b", "Ransomware"],
    ["c", "Unassigned"],
  ]);
  expect(reading?.problems).toEqual([
    "the game didn't recruit d (respect short, the name taken, or 12 members)",
    "Terrorism isn't a task of this gang, for c",
  ]);
  // Normal time: the gang stores under 10 cycles between processes, so its bonus time is under 2 s (core's
  // `gangInBonusTime`).
  expect(reading?.gang?.bonusTimeMs).toBeLessThanOrEqual(2_000);
  // The member's figures, as the brain's rule reads them.
  expect(reading?.members[0]).toMatchObject({ hack: 1, hack_exp: 0, hack_mult: 1, hack_asc_mult: 1, earnedRespect: 0 });
  // The slow snapshot carries the gang's faction, for the reports' donors (#325's review).
  await fresh.game.runUntil(() => fresh.latest<SlowSnapshotData>("slow")?.gangFaction === "NiteSec", 70_000);
  // None wanted: nothing read, the medium snapshot's gang null.
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [] });
  await fresh.game.run(12_000);
  expect(fresh.medium()?.gang).toBeNull();
});

test("the gang worker's ascensions (G2): made while the order's points stand, once; one the game can't, a problem", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN2, beforeAgent: joinNiteSec });
  const state = (gang: GangState): DesiredState => ({ hackLoop: HACK_LOOP_OFF, intents: [], gang });
  expect(await triedOnce(fresh, createGang("NiteSec"))).toMatchObject({ done: true });
  // Three recruits: two trained 3 minutes (1,850 hacking experience, past the 1,000 an ascension leaves out), one
  // left unassigned (none).
  const tasks = { a: "Train Hacking", b: "Train Hacking", c: "Unassigned" };
  fresh.brain.channel.setDesiredState(state({ recruit: ["a", "b", "c"], ascend: [], tasks }));
  await fresh.game.run(3 * 60_000);
  const before = (fresh.medium() as MediumSnapshotData).gang?.members ?? [];
  expect(before.map((member) => [member.name, member.hack_exp > 1_000, member.hack_asc_points])).toEqual([
    ["a", true, 0],
    ["b", true, 0],
    ["c", false, 0],
  ]);
  // a's order stands (its points 0, as read); b's doesn't (as if it had ascended since the brain read it); c can't.
  const ascend = [
    { name: "a", pointsBefore: 0 },
    { name: "b", pointsBefore: 5 },
    { name: "c", pointsBefore: 0 },
  ];
  fresh.brain.channel.setDesiredState(state({ recruit: [], ascend, tasks }));
  await fresh.game.runUntil(
    () => ((fresh.medium() as MediumSnapshotData).gang?.members[0]?.hack_asc_points ?? 0) > 0,
    30_000,
  );
  const reading = (fresh.medium() as MediumSnapshotData).gang;
  const [a, b, c] = reading?.members ?? [];
  const aBefore = before[0] as NonNullable<typeof a>;
  // a: its points the experience over 1,000 (more by the seconds it trained since), its experience reset.
  expect(a?.hack_asc_points).toBeGreaterThanOrEqual(aBefore.hack_exp - 1_000);
  expect(a?.hack_exp).toBeLessThan(aBefore.hack_exp);
  expect(b?.hack_asc_points).toBe(0);
  expect(c?.hack_asc_points).toBe(0);
  expect(reading?.problems).toEqual(["the game didn't ascend c"]);
  // The worker's next runs, on the same state: a's points aren't the order's now, so it isn't ascended again.
  const points = a?.hack_asc_points;
  await fresh.game.run(25_000);
  expect((fresh.medium() as MediumSnapshotData).gang?.members[0]?.hack_asc_points).toBe(points);
});
