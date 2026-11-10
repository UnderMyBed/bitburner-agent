// Gangs (#325, core's gang.ts) against the game's own, in the simulator: every task's parameters against
// `ns.gang.getTaskStats`, the respect, money and wanted a cycle and the penalty against `ns.formulas.gang`
// (Formulas.exe, bought through the simulator's own effectors) over gangs and members that differ in every figure the
// formulas read, training's experience against the members' own `expGain`, the recruit threshold against
// `respectForNextRecruit`, and every BitNode's `GangSoftcap` against the engine's multipliers. In BN2 (softcap 1),
// where the brain plays gangs.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  GANG_STATS,
  GANG_TASKS,
  type GangMemberFigures,
  gangExpPerCycle,
  gangMoneyPerCycle,
  gangRespectPerCycle,
  gangRespectToRecruit,
  gangSoftcapOf,
  gangTask,
  gangWantedPenaltyOf,
  gangWantedPerCycle,
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
