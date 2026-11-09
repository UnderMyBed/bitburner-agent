// The gang's effectors in the simulator (#325): the `createGang` intent through the simulator's own effector and
// through its home worker (`create-gang.js`, the NS API alone, so the `ui` backend's in any game), each refusing what
// the game refuses; and the Agent's gang worker (`gang.js`) doing the desired state's recruits and tasks, its reading
// in the medium snapshot, what the game refused among its problems. In BN2, NiteSec joined by a harness edit.
import {
  type DesiredState,
  type FastSnapshotData,
  type GangState,
  type Intent,
  intentId,
  type MediumSnapshotData,
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
  fresh.brain.channel.setDesiredState(state({ recruit: ["a"], tasks: { a: "Ransomware" } }));
  await fresh.game.run(12_000);
  expect(fresh.medium()?.gang).toEqual({ gang: null, members: [], problems: [] });

  expect(await triedOnce(fresh, createGang("NiteSec"))).toMatchObject({ done: true });
  // Five asked for, with the respect for the three free ones: the fourth refused, and none after it tried. A task for a name not a member is
  // skipped; one the gang's kind hasn't (Terrorism, a combat gang's) refused, the member's task left as it was.
  fresh.brain.channel.setDesiredState(
    state({
      recruit: ["a", "b", "c", "d", "e"],
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
  // The member's figures, as the brain's rule reads them.
  expect(reading?.members[0]).toMatchObject({ hack: 1, hack_exp: 0, hack_mult: 1, hack_asc_mult: 1, earnedRespect: 0 });
  // None wanted: nothing read, the medium snapshot's gang null.
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [] });
  await fresh.game.run(12_000);
  expect(fresh.medium()?.gang).toBeNull();
});
