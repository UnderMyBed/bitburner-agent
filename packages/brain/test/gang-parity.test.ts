// Gangs (#325, core's gang.ts) against the game's own, in the simulator: every task's parameters against
// `ns.gang.getTaskStats`, the respect, money and wanted a cycle and the penalty against `ns.formulas.gang`
// (Formulas.exe, bought through the simulator's own effectors) over gangs and members that differ in every figure the
// formulas read, training's experience against the members' own `expGain`, the recruit threshold against
// `respectForNextRecruit`, every BitNode's `GangSoftcap` against the engine's multipliers, and (#328, G2) the ascension
// result and the member after it against `getAscensionResult` and `ascendMember`; (#330, G3) every upgrade against the
// equipment getters, a purchase against `purchaseEquipment`, and an ascension keeping an augmentation; (#332, G4) the
// power an update gives the members on Territory Warfare, and the win chance against `getChanceToWinClash`; (#334, G5)
// the gang's faction's shop against `getAugmentationsFromFaction`, and the BitNode multipliers core has. In BN2
// (softcap 1), where the brain plays gangs.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  augmentationsSoldBy,
  bitNodeHackingMultipliers,
  bitNodePriceMultipliers,
  GANG_EQUIPMENT,
  GANG_STATS,
  GANG_TASKS,
  type GangMemberFigures,
  gangAscensionPointsOf,
  gangAscensionResult,
  gangClashWinChance,
  gangEquipment,
  gangEquipmentCost,
  gangEquipmentCostMultOf,
  gangEquipmentDiscount,
  gangExpPerCycle,
  gangMemberAscended,
  gangMemberEquipped,
  gangMemberPower,
  gangMoneyPerCycle,
  gangPowerGainPerUpdate,
  gangRespectPerCycle,
  gangRespectToRecruit,
  gangSoftcapOf,
  gangTask,
  gangWantedPenaltyOf,
  gangWantedPerCycle,
  knownBitNodes,
  playableBitNodes,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();

/** Gangs that differ in respect, wanted level and territory: the start's, a grown one's, and one with all territory. */
const GANGS = [
  { respect: 1, wantedLevel: 1, territory: 1 / 7 },
  { respect: 12_345, wantedLevel: 678, territory: 0.31 },
  { respect: 2e6, wantedLevel: 3, territory: 1 },
];
/**
 * Members' levels: a weak hacker, a strong one, a fighter, one with every stat moved, and one just past
 * Cyberterrorism's difficulty, whose wanted the game caps at 100 a cycle.
 */
const LEVELS = [
  { hack: 158, str: 1, def: 1, dex: 1, agi: 1, cha: 1 },
  { hack: 60, str: 1, def: 1, dex: 1, agi: 1, cha: 12 },
  { hack: 640, str: 3, def: 4, dex: 5, agi: 6, cha: 210 },
  { hack: 40, str: 500, def: 480, dex: 460, agi: 440, cha: 300 },
  { hack: 333, str: 222, def: 111, dex: 99, agi: 88, cha: 77 },
];

test("core's gang tasks, formulas, training and recruit threshold are the engine's, in BN2", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 2, sourceFiles: { 1: 3 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.setMoney(1e11);
  await sim.diagnostics.joinFactionWithReputation("NiteSec", 0);
  const { out, log } = await runScript(
    sim,
    `const effectors = globalThis.${AGENT_SIM_EFFECTORS_GLOBAL};
effectors.buyTorRouter();
effectors.buyDarkwebProgram("Formulas.exe");
ns.gang.createGang("NiteSec");
const thresholds = [ns.gang.respectForNextRecruit()];
for (const name of ["a", "b", "c"]) {
  ns.gang.recruitMember(name);
  thresholds.push(ns.gang.respectForNextRecruit());
}
out({ thresholds });
// The formulas take a task as the game has it, its description too; core's leaves that out.
const tasks = ${JSON.stringify(GANG_TASKS.map((each) => each.name))}.map((name) => ns.gang.getTaskStats(name));
out({ tasks: tasks.map(({ desc, ...stats }) => stats) });
const template = ns.gang.getMemberInformation("a");
const levels = ${JSON.stringify(LEVELS)};
// One line a gang: the script's log keeps only so many (Settings.MaxLogCapacity).
for (const gang of ${JSON.stringify(GANGS)}) {
  const figures = [];
  for (const [index, each] of levels.entries()) {
    const member = { ...template, ...each };
    for (const task of tasks) {
      figures.push({
        gang,
        index,
        task: task.name,
        respect: ns.formulas.gang.respectGain(gang, member, task),
        money: ns.formulas.gang.moneyGain(gang, member, task),
        wanted: ns.formulas.gang.wantedLevelGain(gang, member, task),
      });
    }
  }
  out({ gang, penalty: ns.formulas.gang.wantedPenalty(gang), figures });
}
// Training's experience, as the members' own: each on a training task, then read.
for (const [name, task] of [["a", "Train Hacking"], ["b", "Train Combat"], ["c", "Train Charisma"]]) {
  ns.gang.setMemberTask(name, task);
  out({ training: ns.gang.getMemberInformation(name) });
}`,
  );
  // The script ran to its end: no error, and every line out.
  expect((await sim.events()).events.filter((event) => event.type === "error")).toEqual([]);
  expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
  const thresholds = (out.find((each) => (each as { thresholds?: unknown }).thresholds) as { thresholds: number[] })
    .thresholds;
  // The 3 free members, then 5 for the fourth.
  expect(thresholds).toEqual([0, 1, 2, 3].map(gangRespectToRecruit));
  expect(thresholds).toEqual([0, 0, 0, 5]);

  const tasks = (out.find((each) => (each as { tasks?: unknown }).tasks) as { tasks: unknown[] }).tasks;
  expect(tasks).toEqual(GANG_TASKS);

  const penalties = out.filter((each) => (each as { penalty?: unknown }).penalty !== undefined) as {
    gang: (typeof GANGS)[number];
    penalty: number;
  }[];
  expect(penalties).toHaveLength(GANGS.length);
  for (const { gang, penalty } of penalties) expect(gangWantedPenaltyOf(gang)).toBe(penalty);

  const figures = (penalties as unknown as { figures: unknown[] }[]).flatMap((each) => each.figures) as {
    gang: (typeof GANGS)[number];
    index: number;
    task: string;
    respect: number;
    money: number;
    wanted: number;
  }[];
  expect(figures).toHaveLength(GANGS.length * LEVELS.length * GANG_TASKS.length);
  let earning = 0;
  for (const { gang, index, task, respect, money, wanted } of figures) {
    const member = LEVELS[index] as (typeof LEVELS)[number];
    const label = `${task}, member ${index}, gang ${JSON.stringify(gang)}`;
    expect(gangRespectPerCycle(gang, member, gangTask(task), 1), label).toBeCloseTo(respect, 12);
    expect(gangMoneyPerCycle(gang, member, gangTask(task), 1), label).toBeCloseTo(money, 9);
    expect(gangWantedPerCycle(gang, member, gangTask(task)), label).toBeCloseTo(wanted, 12);
    if (respect > 0 && money > 0 && wanted !== 0) earning++;
  }
  // Not all zeros: most members earn at most tasks.
  expect(earning).toBeGreaterThan(figures.length / 4);

  const trainings = out.filter((each) => (each as { training?: unknown }).training) as {
    training: GangMemberFigures & { expGain: Record<string, number> };
  }[];
  expect(trainings).toHaveLength(3);
  for (const { training } of trainings) {
    const ours = gangExpPerCycle(training, gangTask(training.task));
    for (const stat of GANG_STATS) {
      expect(ours[stat], `${training.task}'s ${stat}`).toBeCloseTo(training.expGain[`${stat}_exp`] as number, 15);
    }
    expect(Object.values(ours).some((gain) => gain > 0)).toBe(true);
  }
});

test("every BitNode's GangSoftcap is the engine's (BN12 at two levels)", async () => {
  const sim = await start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });
  for (const [bitNode, level] of [...Array.from({ length: 15 }, (_, index) => [index + 1, 1]), [12, 5]]) {
    const multipliers = (await sim.diagnostics.bitNodeMultipliers(bitNode as number, level as number)) as {
      GangSoftcap: number;
    };
    expect(gangSoftcapOf(bitNode as number), `BN${bitNode}.${level}`).toBe(multipliers.GangSoftcap);
  }
});

test("core's ascension result and the member after it are the engine's (G2): `getAscensionResult`, `ascendMember`", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 2, sourceFiles: {} },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.joinFactionWithReputation("NiteSec", 0);
  // Three trained 3 minutes on the three training tasks, read with the game's result; the first ascended, read again;
  // then trained 4 minutes more, with its points.
  const { out, log } = await runScript(
    sim,
    `ns.gang.createGang("NiteSec");
const tasks = [["a", "Train Hacking"], ["b", "Train Combat"], ["c", "Train Charisma"]];
for (const [name, task] of tasks) {
  ns.gang.recruitMember(name);
  ns.gang.setMemberTask(name, task);
}
await ns.sleep(180000);
for (const [name] of tasks) {
  out({ before: ns.gang.getMemberInformation(name), result: ns.gang.getAscensionResult(name) ?? null });
}
const respect = ns.gang.getGangInformation().respect;
out({ ascended: ns.gang.ascendMember("a") ?? null, after: ns.gang.getMemberInformation("a"), respect });
await ns.sleep(240000);
out({ again: ns.gang.getMemberInformation("a"), result: ns.gang.getAscensionResult("a") ?? null });`,
    430_000,
  );
  expect((await sim.events()).events.filter((event) => event.type === "error")).toEqual([]);
  expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
  type Read = GangMemberFigures & { expGain: unknown };
  const readings = out.filter((each) => (each as { before?: unknown }).before) as {
    before: Read;
    result: Record<string, number> | null;
  }[];
  expect(readings).toHaveLength(3);
  for (const { before, result } of readings) {
    const ours = gangAscensionResult(before);
    if (result === null) {
      expect(ours, before.name).toBeNull();
      continue;
    }
    expect(ours?.respect).toBe(result.respect);
    for (const stat of GANG_STATS)
      expect(ours?.[stat], `${before.name}'s ${stat}`).toBeCloseTo(result[stat] as number, 12);
  }
  // Only a could ascend: 3 minutes of Train Combat give each combat stat 945 experience (25/1,500 × 100^0.9 a cycle),
  // of Train Charisma 390, both under the 1,000 an ascension leaves out; Train Hacking 1,854.
  expect(readings.map(({ result }) => result !== null)).toEqual([true, false, false]);

  const { ascended, after } = out.find((each) => (each as { after?: unknown }).after) as {
    ascended: Record<string, number>;
    after: Read;
  };
  const before = readings[0]?.before as Read;
  expect(ascended).toMatchObject({ respect: before.earnedRespect });
  const ours = gangMemberAscended(before);
  for (const stat of GANG_STATS) {
    for (const key of [stat, `${stat}_exp`, `${stat}_mult`, `${stat}_asc_mult`, `${stat}_asc_points`] as const) {
      expect(ours[key], key).toBeCloseTo(after[key], 9);
    }
  }
  expect(gangAscensionPointsOf(after)).toBeGreaterThan(gangAscensionPointsOf(before));

  // A second ascension's result, from points already gained.
  const again = out.find((each) => (each as { again?: unknown }).again) as {
    again: Read;
    result: Record<string, number> | null;
  };
  expect(again.again.hack_asc_points).toBeGreaterThan(0);
  expect(again.result).not.toBeNull();
  for (const stat of GANG_STATS) {
    expect(gangAscensionResult(again.again)?.[stat], stat).toBeCloseTo(again.result?.[stat] as number, 12);
  }
}, 60_000);

test("core's equipment is the engine's (G3): every upgrade's type, multipliers and cost, a purchase, an ascension keeping augmentations", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 2, sourceFiles: {} },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.setMoney(1e11);
  await sim.diagnostics.joinFactionWithReputation("NiteSec", 0);
  // Two trained 3 minutes, then b a minute on Territory Warfare, for power (`Gang.ts:184-190`): the discount's second
  // term. Read with every upgrade's figures; then a equipped with a rootkit, an augmentation and a weapon, and
  // ascended.
  const { out, log } = await runScript(
    sim,
    `ns.gang.createGang("NiteSec");
for (const name of ["a", "b"]) {
  ns.gang.recruitMember(name);
  ns.gang.setMemberTask(name, "Train Hacking");
}
await ns.sleep(180000);
ns.gang.setMemberTask("b", "Territory Warfare");
await ns.sleep(60000);
const { respect, power, equipmentCostMult } = ns.gang.getGangInformation();
out({ gang: { respect, power, equipmentCostMult } });
out({
  equipment: ns.gang.getEquipmentNames().map((name) => ({
    name,
    type: ns.gang.getEquipmentType(name),
    cost: ns.gang.getEquipmentCost(name),
    mults: ns.gang.getEquipmentStats(name),
  })),
});
out({ before: ns.gang.getMemberInformation("a") });
const bought = ${JSON.stringify(["NUKE Rootkit", "BitWire", "Katana"])}.map((item) => ns.gang.purchaseEquipment("a", item));
out({ bought, again: ns.gang.purchaseEquipment("a", "BitWire"), equipped: ns.gang.getMemberInformation("a") });
ns.gang.ascendMember("a");
out({ ascended: ns.gang.getMemberInformation("a") });`,
    300_000,
  );
  expect((await sim.events()).events.filter((event) => event.type === "error")).toEqual([]);
  expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
  const find = <T>(key: string) => out.find((each) => (each as Record<string, unknown>)[key] !== undefined) as T;
  const { gang } = find<{ gang: { respect: number; power: number; equipmentCostMult: number } }>("gang");
  // Power from a minute of Territory Warfare (about 1.004): the discount over 1, its terms each in it, to 15 digits.
  expect(gang.power).toBeGreaterThan(1);
  expect(gangEquipmentDiscount(gang)).toBeGreaterThan(1 + 1e-6);
  expect(1 / gangEquipmentDiscount(gang)).toBeCloseTo(gang.equipmentCostMult, 15);
  const { equipment } = find<{ equipment: { name: string; type: string; cost: number; mults: object }[] }>("equipment");
  expect(equipment.map(({ name, type, mults }) => ({ name, type, mults }))).toEqual(
    GANG_EQUIPMENT.map(({ name, type, mults }) => ({ name, type, mults })),
  );
  for (const [index, { name, cost }] of equipment.entries()) {
    const ours = GANG_EQUIPMENT[index] as (typeof GANG_EQUIPMENT)[number];
    expect(gangEquipmentCost(ours, gangEquipmentCostMultOf(gang)), name).toBeCloseTo(cost, 6);
    // From an older Agent's reading, without the multiplier: the discount from the respect and power.
    expect(
      gangEquipmentCost(ours, gangEquipmentCostMultOf({ respect: gang.respect, power: gang.power })),
      name,
    ).toBeCloseTo(cost, 6);
  }

  type Read = GangMemberFigures & { upgrades: string[]; augmentations: string[] };
  const { before } = find<{ before: Read }>("before");
  const { bought, again, equipped } = find<{ bought: boolean[]; again: boolean; equipped: Read }>("equipped");
  expect(bought).toEqual([true, true, true]);
  // One owned is refused (`GangMember.ts:355-356`).
  expect(again).toBe(false);
  expect(equipped).toMatchObject({ upgrades: ["NUKE Rootkit", "Katana"], augmentations: ["BitWire"] });
  const ours = ["NUKE Rootkit", "BitWire", "Katana"].reduce(
    (member, item) => gangMemberEquipped(member, gangEquipment(item)),
    before as GangMemberFigures,
  );
  expect(ours).toMatchObject({ upgrades: ["NUKE Rootkit", "Katana"], augmentations: ["BitWire"] });
  for (const stat of GANG_STATS) expect(ours[`${stat}_mult`], `${stat}_mult`).toBeCloseTo(equipped[`${stat}_mult`], 12);

  // The ascension: the rootkit and the weapon lost, BitWire kept, its multiplier applied again
  // (`GangMember.ts:308-319`).
  const { ascended } = find<{ ascended: Read }>("ascended");
  expect(ascended).toMatchObject({ upgrades: [], augmentations: ["BitWire"] });
  expect(ascended.hack_mult).toBeCloseTo(1.05, 12);
  const after = gangMemberAscended(equipped);
  for (const stat of GANG_STATS) {
    for (const key of [stat, `${stat}_exp`, `${stat}_mult`, `${stat}_asc_mult`, `${stat}_asc_points`] as const) {
      expect(after[key], key).toBeCloseTo(ascended[key], 9);
    }
  }
}, 60_000);

test("core's power gain and win chance are the engine's (G4): an update's power, `getChanceToWinClash`", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 2, sourceFiles: {} },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.joinFactionWithReputation("NiteSec", 0);
  // Two of three on Territory Warfare, warfare off (no clash moves the power, `Gang.ts:281-303`): the gang's power
  // rises only by its gain, at the first territory update after the members' levels are set (`Gang.ts:99-121`).
  // Read there, with each other gang's and the game's win chance against it.
  const { out, log } = await runScript(
    sim,
    `ns.gang.createGang("NiteSec");
for (const [name, task] of [["a", "Territory Warfare"], ["b", "Territory Warfare"], ["c", "Train Hacking"]]) {
  ns.gang.recruitMember(name);
  ns.gang.setMemberTask(name, task);
}
let before = ns.gang.getGangInformation().power;
for (let update = 0; update < 30; update += 1) {
  await ns.gang.nextUpdate();
  const gang = ns.gang.getGangInformation();
  if (gang.power !== before) {
    const all = ns.gang.getAllGangInformation();
    const others = Object.keys(all).filter((name) => name !== "NiteSec");
    out({
      before,
      gang,
      members: ["a", "b", "c"].map((name) => ns.gang.getMemberInformation(name)),
      all,
      chances: Object.fromEntries(others.map((name) => [name, ns.gang.getChanceToWinClash(name)])),
    });
    break;
  }
  before = gang.power;
}`,
    60_000,
  );
  expect((await sim.events()).events.filter((event) => event.type === "error")).toEqual([]);
  expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
  const read = out[0] as {
    before: number;
    gang: { power: number; territory: number; territoryWarfareEngaged: boolean; territoryClashChance: number };
    members: GangMemberFigures[];
    all: Record<string, { power: number; territory: number }>;
    chances: Record<string, number>;
  };
  expect(read.gang).toMatchObject({ territoryWarfareEngaged: false, territoryClashChance: 0 });
  // The gain: 0.015 × max(0.002, territory) × the crew's levels over 95, `calculatePower` (`Gang.ts:362-369`).
  const crew = read.members.filter((member) => member.task === "Territory Warfare");
  expect(crew).toHaveLength(2);
  const gain = gangPowerGainPerUpdate(read.gang.territory, crew);
  expect(gain).toBeGreaterThan(0);
  expect(read.gang.power - read.before).toBeCloseTo(gain, 12);
  expect(gangMemberPower(crew[0] as GangMemberFigures)).toBeCloseTo(
    GANG_STATS.reduce((sum, stat) => sum + (crew[0] as GangMemberFigures)[stat], 0) / 95,
    12,
  );
  // The win chance, against each of the six others.
  expect(Object.keys(read.chances)).toHaveLength(6);
  for (const [faction, chance] of Object.entries(read.chances)) {
    expect(gangClashWinChance(read.gang.power, read.all[faction]?.power as number), faction).toBeCloseTo(chance, 12);
  }
}, 60_000);

test("the gang's faction's shop (#334, G5): core's augmentationsSoldBy is the engine's getAugmentationsFromFaction", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 2, sourceFiles: { 1: 3, 4: 3 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.joinFactionWithReputation("NiteSec", 0);
  await sim.diagnostics.joinFactionWithReputation("CyberSec", 0);
  // Singularity (SF4.3) reads the shop the page shows (`Singularity.ts:128-133`), before the gang and after it.
  const { out } = await runScript(
    sim,
    `const shop = (faction) => ns.singularity.getAugmentationsFromFaction(faction);
out({ before: shop("NiteSec") });
ns.gang.createGang("NiteSec");
out({ after: shop("NiteSec"), cyberSec: shop("CyberSec") });`,
  );
  const [{ before }, { after, cyberSec }] = out as [{ before: string[] }, { after: string[]; cyberSec: string[] }];
  expect(before).toEqual(augmentationsSoldBy("NiteSec", 2, null));
  // The gang's: 97 and The Red Pill, in the game's order; another faction's, its own still.
  expect(after).toEqual(augmentationsSoldBy("NiteSec", 2, "NiteSec"));
  expect(after).toHaveLength(98);
  expect(after.at(-1)).toBe("The Red Pill");
  expect(cyberSec).toEqual(augmentationsSoldBy("CyberSec", 2, "NiteSec"));
}, 60_000);

test("the BitNode multipliers core has (#321, #323, #334, #367) are the engine's, BN2's, BN6's and BN7's among them", async () => {
  const sim = await start({ seed: 1, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "new", tutorial: "skipped" } });
  expect(playableBitNodes()).toEqual([1, 2, 4, 5, 6]);
  // BN6 and BN7 known (#367); BN6 playable since B6 (#398), BN7 not until B8.
  expect(knownBitNodes()).toEqual([1, 2, 4, 5, 6, 7]);
  for (const bitNode of knownBitNodes()) {
    const engine = (await sim.diagnostics.bitNodeMultipliers(bitNode, 1)) as Record<string, number>;
    const ours = { ...bitNodeHackingMultipliers(bitNode), ...bitNodePriceMultipliers(bitNode) };
    for (const [name, value] of Object.entries(ours)) expect(value, `BN${bitNode}'s ${name}`).toBe(engine[name]);
  }
});
