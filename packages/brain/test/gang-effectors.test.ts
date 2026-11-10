// The gang's effectors in the simulator (#325): the `createGang` intent through the simulator's own effector and
// through its home worker (`create-gang.js`, the NS API alone, so the `ui` backend's in any game), each refusing what
// the game refuses; and the Agent's gang worker (`gang.js`) doing the desired state's recruits and tasks, its reading
// in the medium snapshot, what the game refused among its problems; its ascensions (#328, G2) and its purchases of
// equipment (#330, G3); and territory warfare (#332, G4), its flag set while the order stands. In BN2, NiteSec joined by
// a harness edit.
import {
  type DesiredState,
  type FastSnapshotData,
  type GangState,
  gangEquipmentDiscount,
  gangTerritoryPerUpdate,
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

/** A gang state, its purchases (G3) and warfare (G4) none unless given. */
type GangOrders = Omit<GangState, "buy" | "keepMoney" | "warfare"> &
  Partial<Pick<GangState, "buy" | "keepMoney" | "warfare">>;
const orders = (gang: GangOrders): GangState => ({ buy: [], keepMoney: null, warfare: null, ...gang });

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
  const state = (gang: GangOrders): DesiredState => ({ hackLoop: HACK_LOOP_OFF, intents: [], gang: orders(gang) });
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
  const state = (gang: GangOrders): DesiredState => ({ hackLoop: HACK_LOOP_OFF, intents: [], gang: orders(gang) });
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

test("the gang worker's purchases (G3): bought while the order stands, once; owned, money under keepMoney, gone or ascended, skipped", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN2, beforeAgent: joinNiteSec });
  const state = (gang: GangOrders): DesiredState => ({ hackLoop: HACK_LOOP_OFF, intents: [], gang: orders(gang) });
  expect(await triedOnce(fresh, createGang("NiteSec"))).toMatchObject({ done: true });
  const tasks = { a: "Train Hacking", b: "Train Hacking", c: "Train Hacking" };
  fresh.brain.channel.setDesiredState(state({ recruit: ["a", "b", "c"], ascend: [], tasks }));
  await fresh.game.runUntil(() => (fresh.medium()?.gang?.members.length ?? 0) === 3, 30_000);
  const before = (fresh.medium() as MediumSnapshotData).gang;
  // Read: none owned, and the gang's cost multiplier, 1 / the discount (core's).
  expect(before?.members.map(({ upgrades, augmentations }) => [upgrades, augmentations])).toEqual([
    [[], []],
    [[], []],
    [[], []],
  ]);
  const costMult = before?.gang?.equipmentCostMult as number;
  expect(costMult).toBeCloseTo(1 / gangEquipmentDiscount(before?.gang as { respect: number; power: number }), 12);
  expect(before?.keepMoney).toBeNull();
  await fresh.simulation.diagnostics.setMoney(1e9);
  // b's order first, as if b had ascended since the brain read it (its points 0, not 5): skipped, though the money
  // covers it. Then a's rootkit stands; a's BitWire ($5b) is over the money; zed isn't a member; and c's Baseball Bat
  // would take the money, after a's rootkit, under keepMoney.
  const nuke = 5e6 * costMult;
  const buy = [
    { name: "b", equipment: "NUKE Rootkit", pointsBefore: 5 },
    { name: "a", equipment: "NUKE Rootkit", pointsBefore: 0 },
    { name: "a", equipment: "BitWire", pointsBefore: 0 },
    { name: "zed", equipment: "NUKE Rootkit", pointsBefore: 0 },
    { name: "c", equipment: "Baseball Bat", pointsBefore: 0 },
  ];
  const keepMoney = 1e9 - nuke - 0.5e6;
  fresh.brain.channel.setDesiredState(state({ recruit: [], ascend: [], tasks, buy, keepMoney }));
  await fresh.game.runUntil(() => (fresh.medium()?.gang?.members[0]?.upgrades ?? []).length > 0, 30_000);
  const reading = (fresh.medium() as MediumSnapshotData).gang;
  expect(reading?.members.map(({ name, upgrades, augmentations }) => [name, upgrades, augmentations])).toEqual([
    ["a", ["NUKE Rootkit"], []],
    ["b", [], []],
    ["c", [], []],
  ]);
  expect(reading?.members[0]?.hack_mult).toBeCloseTo(1.05, 12);
  expect(reading?.problems).toEqual([]);
  expect(reading?.keepMoney).toBe(keepMoney);
  // The money: the rootkit's discounted cost, as core has it.
  expect(fresh.money()).toBeCloseTo(1e9 - nuke, 0);
  // $2b, the same state: a owns its rootkit now, so it isn't bought again (the game would refuse it, a problem);
  // c's bat is bought now, its cost above keepMoney; a's BitWire still over the money; b's order still stale.
  await fresh.simulation.diagnostics.setMoney(2e9);
  await fresh.game.run(25_000);
  const again = (fresh.medium() as MediumSnapshotData).gang;
  expect(again?.members.map(({ name, upgrades }) => [name, upgrades])).toEqual([
    ["a", ["NUKE Rootkit"]],
    ["b", []],
    ["c", ["Baseball Bat"]],
  ]);
  expect(again?.problems).toEqual([]);
  const money = fresh.money();
  expect(money).toBeCloseTo(2e9 - 1e6 * costMult, 0);
  // keepMoney null: none spent, whatever the money.
  const standing = [{ name: "b", equipment: "NUKE Rootkit", pointsBefore: 0 }];
  fresh.brain.channel.setDesiredState(state({ recruit: [], ascend: [], tasks, buy: standing, keepMoney: null }));
  await fresh.game.run(25_000);
  expect((fresh.medium() as MediumSnapshotData).gang?.members[1]?.upgrades).toEqual([]);
  expect(fresh.money()).toBe(money);
});

test("the gang worker's territory warfare (G4): engaged while the order stands; stale or off, disengaged; none, left alone", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN2, beforeAgent: joinNiteSec });
  const state = (gang: GangOrders): DesiredState => ({ hackLoop: HACK_LOOP_OFF, intents: [], gang: orders(gang) });
  expect(await triedOnce(fresh, createGang("NiteSec"))).toMatchObject({ done: true });
  const tasks = { a: "Territory Warfare", b: "Territory Warfare", c: "Train Hacking" };
  fresh.brain.channel.setDesiredState(state({ recruit: ["a", "b", "c"], ascend: [], tasks }));
  await fresh.game.runUntil(() => (fresh.medium()?.gang?.members.length ?? 0) === 3, 30_000);
  // Read: not engaged, no clash chance, the six others with the win chance against each, power over the sum.
  const first = (fresh.medium() as MediumSnapshotData).gang?.gang;
  expect(first).toMatchObject({ territoryWarfareEngaged: false, territoryClashChance: 0 });
  expect(first?.otherGangs?.map((each) => each.faction)).toEqual([
    "Slum Snakes",
    "Tetrads",
    "The Syndicate",
    "The Dark Army",
    "Speakers for the Dead",
    "The Black Hand",
  ]);
  const winChancesRead = (gang: typeof first) => {
    for (const other of gang?.otherGangs ?? []) {
      expect(other.winChance).toBeCloseTo((gang?.power as number) / ((gang?.power as number) + other.power), 12);
    }
  };
  winChancesRead(first);
  // The crew made strong by a harness edit (combat levels about 70,000), so the gang's power outgrows the others'.
  const strong = Object.fromEntries(
    ["str", "def", "dex", "agi"].flatMap((stat) => [
      [`${stat}_exp`, 1e7],
      [`${stat}_asc_points`, 1e8],
    ]),
  );
  for (const name of ["a", "b"]) await fresh.simulation.diagnostics.setGangMemberFigures(name, strong);
  const gains = () => {
    const gang = (fresh.medium() as MediumSnapshotData).gang?.gang;
    return gang === undefined || gang === null
      ? 0
      : gangTerritoryPerUpdate(gang.power, gang.territory, gang.otherGangs ?? []);
  };
  await fresh.game.runUntil(() => gains() > 1e-4, 60_000);
  // The powers apart now: the win chances read, against each, far from a half.
  const apart = (fresh.medium() as MediumSnapshotData).gang?.gang;
  winChancesRead(apart);
  expect(Math.min(...(apart?.otherGangs ?? []).map((each) => each.winChance))).toBeGreaterThan(0.9);
  // Engaged while the territory expected an update, from the powers read then, is above the break-even.
  const engaged = () => (fresh.medium() as MediumSnapshotData).gang?.gang?.territoryWarfareEngaged;
  fresh.brain.channel.setDesiredState(
    state({ recruit: [], ascend: [], tasks, warfare: { engage: true, leastTerritoryPerUpdate: 0 } }),
  );
  await fresh.game.runUntil(() => engaged() === true, 30_000);
  await fresh.game.runUntil(
    () => (fresh.medium() as MediumSnapshotData).gang?.gang?.territoryClashChance === 1,
    30_000,
  );
  // None (an older brain's): the flag left alone, still engaged.
  fresh.brain.channel.setDesiredState(state({ recruit: [], ascend: [], tasks, warfare: null }));
  await fresh.game.run(25_000);
  expect(engaged()).toBe(true);
  // Stale: the break-even above what the powers now give: disengaged, the safe side.
  fresh.brain.channel.setDesiredState(
    state({ recruit: [], ascend: [], tasks, warfare: { engage: true, leastTerritoryPerUpdate: 1 } }),
  );
  await fresh.game.runUntil(() => engaged() === false, 30_000);
  // Again, then off: disengaged, the clash chance falling 0.01 an update from 1 (`Gang.ts:210-216`).
  fresh.brain.channel.setDesiredState(
    state({ recruit: [], ascend: [], tasks, warfare: { engage: true, leastTerritoryPerUpdate: 0 } }),
  );
  await fresh.game.runUntil(() => engaged() === true, 30_000);
  fresh.brain.channel.setDesiredState(
    state({ recruit: [], ascend: [], tasks, warfare: { engage: false, leastTerritoryPerUpdate: 0 } }),
  );
  await fresh.game.runUntil(() => engaged() === false, 30_000);
  await fresh.game.run(25_000);
  const last = (fresh.medium() as MediumSnapshotData).gang;
  expect(last?.gang?.territoryClashChance).toBeLessThan(1);
  expect(last?.gang?.territoryClashChance).toBeGreaterThan(0.9);
  // The clashes it fought, stronger, won it territory; nothing the game refused.
  expect(last?.gang?.territory).toBeGreaterThan(1 / 7);
  expect(last?.problems).toEqual([]);
}, 120_000);

test("the brain gone (G4): warfare it ordered goes off, the tasks left; an older brain's flag left as it was", async () => {
  const fresh = await freshStart({ withDesiredState: false, fixture: BN2, beforeAgent: joinNiteSec });
  const state = (gang: GangOrders): DesiredState => ({ hackLoop: HACK_LOOP_OFF, intents: [], gang: orders(gang) });
  expect(await triedOnce(fresh, createGang("NiteSec"))).toMatchObject({ done: true });
  const tasks = { a: "Territory Warfare", b: "Territory Warfare", c: "Train Hacking" };
  const engage = { engage: true, leastTerritoryPerUpdate: 0 };
  fresh.brain.channel.setDesiredState(state({ recruit: ["a", "b", "c"], ascend: [], tasks }));
  await fresh.game.runUntil(() => (fresh.medium()?.gang?.members.length ?? 0) === 3, 30_000);
  const strong = Object.fromEntries(
    ["str", "def", "dex", "agi"].flatMap((stat) => [
      [`${stat}_exp`, 1e7],
      [`${stat}_asc_points`, 1e8],
    ]),
  );
  for (const name of ["a", "b"]) await fresh.simulation.diagnostics.setGangMemberFigures(name, strong);
  const engaged = () => (fresh.medium() as MediumSnapshotData).gang?.gang?.territoryWarfareEngaged;
  /** The game's flag and a's task now, read by the owner's script (the medium snapshot has no gang without a brain). */
  const inGame = async () => {
    await fresh.simulation.writeFile(
      "home",
      "flag.js",
      `export async function main(ns) {
  ns.print("flag:" + JSON.stringify([ns.gang.getGangInformation().territoryWarfareEngaged, ns.gang.getMemberInformation("a").task]));
}`,
    );
    const { pid, error } = await fresh.simulation.run("home", "flag.js");
    expect(error).toBeUndefined();
    await fresh.game.run(1_000);
    const line = (await fresh.simulation.logs(pid)).find((each) => each.startsWith("flag:"));
    return JSON.parse((line ?? "flag:null").slice(5)) as [boolean, string];
  };
  const engageAgain = async () => {
    fresh.brain.channel.setDesiredState(state({ recruit: [], ascend: [], tasks, warfare: engage }));
    await fresh.game.runUntil(() => engaged() === true, 60_000);
  };
  // Holding (a state with no gang): the warfare it ordered goes off; the crew keeps its task.
  await engageAgain();
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [] });
  await fresh.game.run(12_000);
  expect(fresh.medium()?.gang).toBeNull();
  expect(await inGame()).toEqual([false, "Territory Warfare"]);
  // An older brain's state (no order) before it goes: the flag, engaged, left as it was.
  await engageAgain();
  fresh.brain.channel.setDesiredState(state({ recruit: [], ascend: [], tasks, warfare: null }));
  await fresh.game.run(12_000);
  fresh.brain.channel.setDesiredState({ hackLoop: HACK_LOOP_OFF, intents: [] });
  await fresh.game.run(12_000);
  expect(await inGame()).toEqual([true, "Territory Warfare"]);
  // The brain gone (a disconnect, and none to reconnect to): off at once, the tasks left.
  await engageAgain();
  fresh.brain.stop();
  await fresh.game.run(5_000);
  expect(await inGame()).toEqual([false, "Territory Warfare"]);
}, 120_000);
