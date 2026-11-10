// Gangs G1 (#325), G2 (#328) and G3 (#330): the brain from a BN2 start with SF1.3 and SF4.3, as the campaign enters BN2
// (after BN4 ×3 and BN5), its rules as on Steam (all on), the simulator's own effectors taken away so the Agent uses
// its workers as in a browser. NiteSec is joined by a harness edit, as A3's backdoor on avmnite-02h would have it
// (hacking 202-220, which an hour from a fresh start doesn't reach). One seed each: a thin slice, no sweep.
// - A bounded hour: the gang forms through the gate, recruits, trains, works, ascends (G2) and keeps growing, and the
//   run report's gang section passes.
// - Wanted control, end to end: a gang the owner left with its wanted level far over the bound (three members on DDoS
//   Attacks, which earns them no respect at their levels), then the brain for 10 minutes: every member goes to
//   justice, as fewer couldn't bring the wanted level back to the bound within the 23 min, it falls fast, and the
//   report's wanted check passes.
// - Equipment (G3): in the hour, none pays by the rule's measure, so none is bought (why, computed on its last
//   reading); a gang the owner grew for 80 minutes, with $10b, then the brain for 45 minutes: still none pays (G2
//   keeps its members training, then works them minutes before an ascension), none is bought, and the report's
//   equipment check, on the same readings, passes; and (#330's review) one member boosted by a harness edit far past
//   that, in a gang of 12 (its objective money, so the plan puts it on Money Laundering): the rule orders equipment
//   for it, the worker buys it, and the report counts it, end to end.
// - Territory warfare (G4): in the hour, none on Territory Warfare and never engaged (why, computed on its last
//   reading: the others outgrow the whole gang's power); and a gang of 12 with eleven fighters made by harness edits,
//   then the brain for 20 minutes: ten on Territory Warfare, engaged throughout, territory growing, a death counted.
import type { FastSnapshotData, MediumSnapshotData } from "@bitburner-agent/core";
import {
  GANG_AUGMENTATION_HORIZON_MS,
  GANG_EQUIPMENT_PAYBACK_LIMIT_MS,
  gangBestWork,
  gangEquipment,
  gangEquipmentAppraisal,
  gangEquipmentCostMultOf,
  gangLostShare,
  gangLostShareBound,
  gangOtherPowerGainPerUpdate,
  gangPowerGainPerUpdate,
  gangWarfareBasis,
  gangWarfareCrew,
  gangWarfareMeasure,
  planGangEquipment,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { gangSnapshotOf, gangWarfareFiguresOf } from "../src/gang.ts";
import { GANG_WANTED_OVER_BOUND_MS } from "../src/gang-report.ts";
import { formatDuration } from "../src/gap-report.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { type FreshGame, ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const BN2 = { kind: "bitnode", n: 2, sourceFiles: { 1: 3, 4: 3 } } as const;
const WANTED_CHECK =
  "the wanted penalty over the rule's bound, off course, for " + formatDuration(GANG_WANTED_OVER_BOUND_MS);

/** The run report's gang section and failures, from the run's start to now. */
function reportOf(fresh: Awaited<ReturnType<typeof freshStartOf>>) {
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  return { text, failures, section: text.slice(text.indexOf("7. The gang"), text.indexOf("Verdict")) };
}

/**
 * The report's failures but one: the batcher out of step on n00dles from a grow shortfall, BN2's grows short of its
 * plan. The brain plans BN2's hacking with BN1's multipliers (core's `bitNodeAssumptions`), and BN2's ServerGrowthRate
 * is 0.8 (`BitNode/BitNode.tsx:579`): BN2's tables, G5's (#324), not the gang's.
 */
const notTheBatchersGrows = (failures: string[]) =>
  failures.filter((failure) => !/^batcher out of step: .* on n00dles, .*; its cause: a grow shortfall, /.test(failure));

test("1 virtual hour from BN2.1 with SF1.3 and SF4.3: the gang forms with NiteSec, recruits, trains and works; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: BN2,
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
      await withoutSimEffectors(game);
    },
  });
  // Read every 10 minutes: members, respect and the task mix, for the log and the checks below.
  const readings: { minute: number; members: number; respect: number; tasks: string[] }[] = [];
  for (let minute = 10; minute <= 60; minute += 10) {
    await fresh.game.run(10 * 60_000);
    const snapshot = gangSnapshotOf(fresh.medium());
    if (snapshot.kind === "gang") {
      readings.push({
        minute,
        members: snapshot.members.length,
        respect: snapshot.gang.respect,
        tasks: snapshot.members.map((member) => member.task),
      });
    }
  }
  console.log(readings.map((each) => JSON.stringify(each)).join("\n"));
  const { text, failures, section } = reportOf(fresh);
  console.log(section);

  // Formed with NiteSec, through its worker (no Singularity worker for it), past the gate.
  const createGang = (fresh.latest<FastSnapshotData>("fast")?.intents ?? []).find(
    (each) => each.id === "createGang(NiteSec)",
  );
  expect(text).toMatch(/\n {4}createGang\(NiteSec\): done after 1 try \(ui\); /);
  expect(createGang === undefined || createGang.done).toBe(true);
  expect(section).toMatch(/\n {2}formed: with NiteSec, first seen 2026-01-01T00:0[12]:/);
  // Measured on 2026-11-09 (seed 1), with G2's ascensions and #328's review (the 5,000-experience floor, the bound with
  // the plan's recruits): formed 1 min 25 s in; the first three trained 5 min, worked, and ascended at about 23 min
  // (×1.48 each, 50 respect each); 14 ascensions in the hour, ×1.39 to ×1.55. At the hour 7 members, as G1's, and
  // 1,348 respect (G1: 911). The penalty 13.9% at the hour, at most 18.7% above its floor, briefly over the bound of
  // 16.7%, and back in time.
  expect(section).toMatch(/\n {4}hour 1: 0 → 7 members; respect 1 → 1,[0-6]\d\d \(0\.[2-4]\d\/s\); /);
  expect(section).toMatch(/; wanted penalty 50\.0% → \d+\.\d%, above its floor at most \d+\.\d% \(the bound then /);
  const ascensions = /; (\d+) ascensions? \(((member-\d\d ×\d\.\d\d, [\d,]+ respect(; )?)+)\); /.exec(section);
  expect(Number(ascensions?.[1])).toBeGreaterThanOrEqual(5);
  expect(ascensions?.[2]).toMatch(/^member-01 ×1\.\d\d, \d+ respect; /);
  // None small: the floor is ×√2 at a first ascension, √(1 + 4,000 / P) after, ×1.38 or more at an hour's points.
  const gains = [...(ascensions?.[2] ?? "").matchAll(/×(\d\.\d\d)/g)].map((match) => Number(match[1]));
  expect(Math.min(...gains)).toBeGreaterThanOrEqual(1.38);
  const final = gangSnapshotOf(fresh.medium() as MediumSnapshotData);
  expect(final.kind).toBe("gang");
  if (final.kind !== "gang") return;
  expect(final.gang).toMatchObject({ faction: "NiteSec", isHacking: true });
  expect(final.members.map((member) => member.name)).toEqual(
    final.members.map((_, index) => `member-${String(index + 1).padStart(2, "0")}`),
  );
  // Tasks assigned: none left Unassigned; trained, then worked for respect.
  expect(final.members.every((member) => member.task !== "Unassigned")).toBe(true);
  expect(readings.some((each) => each.tasks.some((task) => !task.startsWith("Train")))).toBe(true);
  // Ascended (G2): the first three's multipliers up, and the gang kept growing, its members never fewer.
  for (const member of final.members.slice(0, 3)) expect(member.hack_asc_mult, member.name).toBeGreaterThan(1.4);
  const counts = readings.map((each) => each.members);
  expect(counts).toEqual([...counts].sort((a, b) => a - b));
  expect(final.gang.respect).toBeGreaterThan(Math.max(...readings.slice(0, -1).map((each) => each.respect)));
  // The wanted penalty within the rule's bound, and nothing stuck: the section's checks.
  expect(section).toContain("  problems the gang worker reported, as first seen:\n    none\n");
  for (const what of [
    "no gang formed with a gang faction joined for 5 min or more:\n    none",
    "a recruit the respect allows not made for 1 min or more:\n    none",
    `${WANTED_CHECK} or more:\n    none`,
    "the gang unread in BN2 for 5 min or more:\n    none",
    "an ascension the rule makes not made for 1 min or more:\n    none",
    "equipment the rule buys, with the money free, not bought for 1 min or more:\n    none",
  ]) {
    expect(section).toContain(what);
  }
  // Equipment (G3): none pays by the rule's measure in the hour, so none is bought, and the gang's hour is G2's
  // (1,348 respect). Why, computed on the hour's last reading, with no limit on the money: G2 works its members minutes
  // before each ascension, and trains them the rest, and training, justice and respect tasks earn no money back. Even
  // the strongest on its best money task, its cheapest hacking upgrade (NUKE Rootkit) pays back far slower than 15
  // minutes (remeasured on the money that task earns). Valued over G2's forecast of 7 h for members
  // training, rootkits were bought ($42m) and lost at ascensions within the hour, before they paid back.
  // The brain's own plan and the gang's own discount, as the brain had them at the end.
  expect(section).toMatch(/; no equipment bought; /);
  const inputs = { gang: final.gang, isHacking: true, members: final.members, softcap: 1 };
  const plan = fresh.controller().gangView().plan;
  expect(plan).not.toBeNull();
  const unlimited = planGangEquipment(inputs, plan as NonNullable<typeof plan>, {
    budget: 1e15,
    costMult: gangEquipmentCostMultOf(final.gang),
  });
  expect(unlimited.paying).toEqual([]);
  // Measured on 2026-11-09 (seed 1): member-02, hacking 263, on justice; on Fraud & Counterfeiting, its best money
  // task, NUKE Rootkit at the gang's discount gains about $1m an hour, paid back in 4 h 31 min.
  const strongest = final.members.reduce((top, each) => (each.hack > top.hack ? each : top));
  const best = gangBestWork(inputs, strongest, "money").task.name;
  const nuke = gangEquipmentAppraisal(
    inputs,
    strongest,
    gangEquipment("NUKE Rootkit"),
    GANG_AUGMENTATION_HORIZON_MS,
    gangEquipmentCostMultOf(final.gang),
    best,
  );
  console.log(
    `G3: ${strongest.name} (hacking ${strongest.hack}, ${strongest.task}): on ${best}, NUKE Rootkit gains ` +
      `$${Math.round(nuke.gain / 24)} an hour, paid back in ${formatDuration(nuke.paybackMs)}`,
  );
  expect(nuke.gain).toBeGreaterThan(0);
  expect(Number.isFinite(nuke.paybackMs)).toBe(true);
  expect(nuke.paybackMs).toBeGreaterThan(GANG_EQUIPMENT_PAYBACK_LIMIT_MS);
  // Territory warfare (G4): none on Territory Warfare in the hour and never engaged, so the gang is G3's (1,348
  // respect), and the report's two checks pass on it. Why, computed on the hour's last reading: the others grow faster
  // than the whole gang on Territory Warfare could. Its power gain an update, every member's levels over 95 × 0.015 ×
  // 1/7 (`Gang.ts:362-369`), is under the strongest other's expected one (`Gang.ts:191-204`): no crew pays over a day,
  // and the clashes now, at power 1 against the others', would lose territory.
  expect(readings.every((each) => !each.tasks.includes("Territory Warfare"))).toBe(true);
  expect(section).toMatch(/; territory 14\.3% → 14\.3%, power 1\.0 → 1\.0; warfare engaged 0 s; no deaths\n/);
  for (const what of [
    "territory warfare engaged while the rule's measure says it loses for 1 min or more:\n    none",
    "territory warfare off while the rule's measure says it pays for 1 min or more:\n    none",
  ]) {
    expect(section).toContain(what);
  }
  const warfare = gangWarfareFiguresOf(final.gang);
  if (warfare === undefined) throw new Error("no warfare read");
  const everyone = gangPowerGainPerUpdate(final.gang.territory, final.members);
  const fastest = warfare.others.reduce((top, each) =>
    gangOtherPowerGainPerUpdate(each) > gangOtherPowerGainPerUpdate(top) ? each : top,
  );
  const withWarfare = { ...inputs, warfare };
  const basis = gangWarfareBasis(withWarfare, "respect");
  console.log(
    `G4: power ${warfare.power.toFixed(2)} against ${warfare.others.map((each) => each.power.toFixed(1)).join(", ")}; ` +
      `every member on Territory Warfare gains ${everyone.toFixed(4)} an update, ${fastest.faction} ` +
      `${gangOtherPowerGainPerUpdate(fastest).toFixed(4)}; the clashes ` +
      `${gangWarfareMeasure(withWarfare, basis, []).territoryPerUpdate.toExponential(2)} territory an update`,
  );
  // Measured on 2026-11-09 (seed 1): power 1.0 against 3.6 to 35.3; every member on it would gain 0.0301 an update,
  // under a tenth of Speakers for the Dead's 0.3159; the clashes now −2.76e-4 territory an update.
  expect(everyone).toBeLessThan(gangOtherPowerGainPerUpdate(fastest));
  expect(gangWarfareCrew(withWarfare, basis)).toEqual({ crew: [], value: 0 });
  expect(gangWarfareMeasure(withWarfare, basis, []).territoryPerUpdate).toBeLessThan(0);
  expect(notTheBatchersGrows(failures)).toEqual([]);
  expect(text).toContain("taken as BN1's");
}, 120_000);

/** The owner's own gang, NiteSec's: three members trained 4 minutes, then a minute on DDoS Attacks. */
async function wantedGang(game: FreshGame) {
  await game.simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
  const names = ["member-01", "member-02", "member-03"];
  const setAll = (task: string) =>
    `for (const name of ${JSON.stringify(names)}) ns.gang.setMemberTask(name, "${task}");`;
  await ownerRunsOnHome(
    game,
    `export async function main(ns) {
  ns.gang.createGang("NiteSec");
  for (const name of ${JSON.stringify(names)}) ns.gang.recruitMember(name);
  ${setAll("Train Hacking")}
}`,
  );
  await game.game.run(4 * 60_000);
  await ownerRunsOnHome(game, `export async function main(ns) { ${setAll("DDoS Attacks")} }`);
  await game.game.run(60_000);
  await withoutSimEffectors(game);
}

test("wanted control end to end: a gang left far over the bound, then the brain: on justice at the pace the bound needs, the check passing", async () => {
  const fresh = await freshStartOf({ withDesiredState: true, fixture: BN2, beforeAgent: wantedGang });
  await fresh.game.runUntil(() => gangSnapshotOf(fresh.medium()).kind === "gang", 30_000);
  const first = gangSnapshotOf(fresh.medium());
  if (first.kind !== "gang") throw new Error("no gang read");
  // Far over the bound when the brain first reads it.
  expect(gangLostShare(first.gang)).toBeGreaterThan(2 * gangLostShareBound(first.members.length));
  await fresh.game.run(10 * 60_000);
  const last = gangSnapshotOf(fresh.medium());
  if (last.kind !== "gang") throw new Error("no gang read");
  const { section, failures } = reportOf(fresh);
  console.log(JSON.stringify({ first: first.gang, last: last.gang, tasks: last.members.map((each) => each.task) }));
  console.log(section);
  // Measured on 2026-11-09 (seed 1): read at wanted 183 and respect 3.6 (97.8% above the floor, the bound 33.3%, back
  // at wanted 3.3). All three went to Ethical Hacking and stayed (the rule's own stay over the bound, so the course back
  // only shortens), the decay × (1 − 0.003) each 2 s, e^(−0.9) in 10 minutes: 0.41 of it; 70.5 of 183, 0.385.
  expect(last.members.map((member) => member.task)).toEqual(["Ethical Hacking", "Ethical Hacking", "Ethical Hacking"]);
  expect(last.gang.wantedLevel).toBeLessThan(0.43 * first.gang.wantedLevel);
  expect(last.gang.wantedLevelGainRate).toBeLessThan(0);
  expect(section).toContain("  formed: with NiteSec, before the window");
  expect(section).toContain(`${WANTED_CHECK} or more:\n    none`);
  expect(notTheBatchersGrows(failures)).toEqual([]);
}, 120_000);

/**
 * The owner's own gang, NiteSec's, grown for 80 minutes: three trained 20 minutes a round and ascended, four rounds
 * (×9.4 each, `formulas.ts:75-81`), then $10b, the brain's to spend.
 */
async function grownGang(game: FreshGame) {
  await game.simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
  const names = JSON.stringify(["member-01", "member-02", "member-03"]);
  await ownerRunsOnHome(
    game,
    `export async function main(ns) {
  ns.gang.createGang("NiteSec");
  for (const name of ${names}) {
    ns.gang.recruitMember(name);
    ns.gang.setMemberTask(name, "Train Hacking");
  }
}`,
  );
  for (let round = 0; round < 4; round += 1) {
    await game.game.run(20 * 60_000);
    await ownerRunsOnHome(
      game,
      `export async function main(ns) { for (const name of ${names}) ns.gang.ascendMember(name); }`,
    );
  }
  await game.simulation.diagnostics.setMoney(1e10);
  await withoutSimEffectors(game);
}

test("equipment (G3): a grown gang and $10b, then the brain for 45 minutes: none pays by the rule, none bought, the check passing", async () => {
  const fresh = await freshStartOf({ withDesiredState: true, fixture: BN2, beforeAgent: grownGang });
  await fresh.game.runUntil(() => gangSnapshotOf(fresh.medium()).kind === "gang", 30_000);
  // Every 30 s: who works, and what the dashboard says of equipment.
  const working: number[] = [];
  const equipmentLines = new Set<string>();
  for (let step = 1; step <= 90; step += 1) {
    await fresh.game.run(30_000);
    const reading = gangSnapshotOf(fresh.medium());
    if (reading.kind === "gang" && reading.members.some((each) => !each.task.startsWith("Train"))) working.push(step);
    equipmentLines.add(
      fresh
        .controller()
        .gangView()
        .line.replace(/^.*; equipment: /, ""),
    );
  }
  const last = gangSnapshotOf(fresh.medium());
  if (last.kind !== "gang") throw new Error("no gang read");
  const { section, failures } = reportOf(fresh);
  console.log(`working at (30 s steps): ${working.join(", ")}`);
  console.log([...equipmentLines].join(" | "));
  console.log(section);
  // Measured on 2026-11-09 (seed 1): the three, ×9.4 and 172 hacking from the owner, trained 40 minutes (G2: a minute's
  // training pays within the day to its next ascension, the cap), worked under 5 minutes, and two ascended (×1.56),
  // the respect recruiting four. No lost item pays back within a working stretch so short, nor an augmentation within
  // a day: none is bought, with $10b free, and the report's check, on the same readings, passes.
  expect(section).toMatch(/\n {4}hour 1: 3 → \d+ members; .*; [1-9]\d* ascensions? \(.*\); no equipment bought; /);
  expect(section).toContain("equipment the rule buys, with the money free, not bought for 1 min or more:\n    none");
  expect([...equipmentLines]).toEqual(["no equipment pays back within 15 minutes"]);
  expect(last.members.every((each) => (each.upgrades ?? []).length === 0)).toBe(true);
  // Why, computed on the last reading: the strongest on a respect task (earning none), and even on its best money
  // task, the best augmentation for hacking, Neuralstimulator, pays back far slower than 15 minutes (measured on
  // 2026-11-09: member-03, hacking 1,868, on Cyberterrorism; on Money Laundering it gains $2.1b a day for its $9.2b
  // at the gang's discount, paid back in 105 h 11 min).
  const inputs = { gang: last.gang, isHacking: true, members: last.members, softcap: 1 };
  const strongest = last.members.reduce((top, each) => (each.hack > top.hack ? each : top));
  const best = gangBestWork(inputs, strongest, "money").task.name;
  const augmentation = gangEquipmentAppraisal(
    inputs,
    strongest,
    gangEquipment("Neuralstimulator"),
    GANG_AUGMENTATION_HORIZON_MS,
    gangEquipmentCostMultOf(last.gang),
    best,
  );
  console.log(
    `G3: ${strongest.name} (hacking ${strongest.hack}, ${strongest.task}): on ${best}, Neuralstimulator gains ` +
      `$${Math.round(augmentation.gain)} in a day for $${Math.round(augmentation.cost)}, paid back in ` +
      `${formatDuration(augmentation.paybackMs)}`,
  );
  expect(augmentation.gain).toBeGreaterThan(0);
  expect(Number.isFinite(augmentation.paybackMs)).toBe(true);
  expect(augmentation.paybackMs).toBeGreaterThan(GANG_EQUIPMENT_PAYBACK_LIMIT_MS);
  expect(notTheBatchersGrows(failures)).toEqual([]);
}, 120_000);

/**
 * The owner's gang, NiteSec's, of 12: the three free recruits, then the gang's respect set to 2 million by a harness
 * edit (`setGangRespect`) and nine more recruited, all training. So the brain's objective is money (12 members), and
 * its plan puts a member strong enough on Money Laundering: under 12 the plan has members on respect tasks or training,
 * which earn no money, so nothing would be bought (#330's re-review). Then member-01 boosted by `setGangMemberFigures`
 * to ascension points of 4.5e13 (×150,000) and 4.5e10 hacking experience, about 88 million hacking: its ascension
 * converts a thousandth more, so it doesn't pay, and a minute's training adds too little to pay within a day, so it
 * works. Then $100b.
 */
async function boostedGang(game: FreshGame) {
  await game.simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
  const names = Array.from({ length: 12 }, (_, index) => `member-${String(index + 1).padStart(2, "0")}`);
  const recruit = (some: string[]) =>
    ownerRunsOnHome(
      game,
      `export async function main(ns) {
  if (!ns.gang.inGang()) ns.gang.createGang("NiteSec");
  for (const name of ${JSON.stringify(some)}) {
    ns.gang.recruitMember(name);
    ns.gang.setMemberTask(name, "Train Hacking");
  }
}`,
    );
  await recruit(names.slice(0, 3));
  await game.simulation.diagnostics.setGangRespect(2e6);
  await recruit(names.slice(3));
  await game.simulation.diagnostics.setGangMemberFigures("member-01", { hack_asc_points: 4.5e13, hack_exp: 4.5e10 });
  await game.simulation.diagnostics.setMoney(1e11);
  await withoutSimEffectors(game);
}

test("equipment (G3) end to end: a member boosted far past an hour's play, on Money Laundering in a gang of 12: the rule orders, the worker buys, the report counts it", async () => {
  const fresh = await freshStartOf({ withDesiredState: true, fixture: BN2, beforeAgent: boostedGang });
  await fresh.game.runUntil(() => gangSnapshotOf(fresh.medium()).kind === "gang", 30_000);
  await fresh.game.runUntil(() => {
    const reading = gangSnapshotOf(fresh.medium());
    return reading.kind === "gang" && (reading.members[0]?.augmentations ?? []).length > 0;
  }, 3 * 60_000);
  // A minute more: the report's next readings, and nothing stuck.
  await fresh.game.run(60_000);
  const last = gangSnapshotOf(fresh.medium());
  if (last.kind !== "gang") throw new Error("no gang read");
  const { section, failures } = reportOf(fresh);
  console.log(section);
  // On the plan's money task, which earns the money back.
  expect(last.members).toHaveLength(12);
  expect(last.members[0]?.task).toBe("Money Laundering");
  const bought = [...(last.members[0]?.augmentations ?? []), ...(last.members[0]?.upgrades ?? [])];
  // What raises hacking, the rule's best payback; none for the others, training, which earn nothing.
  expect(last.members[0]?.augmentations?.length).toBeGreaterThan(0);
  for (const item of bought) expect(gangEquipment(item).mults.hack, item).toBeGreaterThan(1);
  for (const each of last.members.slice(1)) {
    expect([...(each.augmentations ?? []), ...(each.upgrades ?? [])], each.name).toEqual([]);
  }
  expect(last.members[0]?.hack_mult).toBeGreaterThan(1);
  expect(section).toMatch(/\n {4}hour 1: .*; [1-9]\d* equipment bought for \$[\d,]+ \(/);
  expect(section).toContain("equipment the rule buys, with the money free, not bought for 1 min or more:\n    none");
  expect(section).toContain("  problems the gang worker reported, as first seen:\n    none\n");
  expect(notTheBatchersGrows(failures)).toEqual([]);
}, 120_000);

/**
 * The owner's gang, NiteSec's, of 12 (G4): the three free recruits, the respect set to 2 million (`setGangRespect`) and
 * nine more recruited, as G3's end-to-end test; then member-01 boosted as there (about 88 million hacking, so it works
 * on Money Laundering) and the other eleven made fighters (strength, dexterity and agility experience 1e7 at ascension
 * points 1e8: levels about 70,000, power about 2,200 each, `gangMemberPower`), their defence left at 1, so a clash can
 * kill them (`Gang.ts:298`, 0.005 / 1^0.6 when won, in 35% of clashes).
 */
async function fightingGang(game: FreshGame) {
  await game.simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
  const names = Array.from({ length: 12 }, (_, index) => `member-${String(index + 1).padStart(2, "0")}`);
  const recruit = (some: string[]) =>
    ownerRunsOnHome(
      game,
      `export async function main(ns) {
  if (!ns.gang.inGang()) ns.gang.createGang("NiteSec");
  for (const name of ${JSON.stringify(some)}) {
    ns.gang.recruitMember(name);
    ns.gang.setMemberTask(name, "Train Hacking");
  }
}`,
    );
  await recruit(names.slice(0, 3));
  await game.simulation.diagnostics.setGangRespect(2e6);
  await recruit(names.slice(3));
  await game.simulation.diagnostics.setGangMemberFigures("member-01", { hack_asc_points: 4.5e13, hack_exp: 4.5e10 });
  const fighter = Object.fromEntries(
    ["str", "dex", "agi"].flatMap((stat) => [
      [`${stat}_exp`, 1e7],
      [`${stat}_asc_points`, 1e8],
    ]),
  );
  for (const name of names.slice(1)) await game.simulation.diagnostics.setGangMemberFigures(name, fighter);
  await withoutSimEffectors(game);
}

test("territory warfare (G4) end to end: fighters on Territory Warfare, warfare engaged, territory grows, deaths counted", async () => {
  const fresh = await freshStartOf({ withDesiredState: true, fixture: BN2, beforeAgent: fightingGang });
  await fresh.game.runUntil(() => gangSnapshotOf(fresh.medium()).kind === "gang", 30_000);
  // Every 5 minutes: territory, power, the flag and the crew.
  const readings: { minute: number; territory: number; power: number; engaged: boolean; crew: number }[] = [];
  for (let minute = 5; minute <= 20; minute += 5) {
    await fresh.game.run(5 * 60_000);
    const reading = gangSnapshotOf(fresh.medium());
    if (reading.kind !== "gang") throw new Error("no gang read");
    readings.push({
      minute,
      territory: reading.gang.territory,
      power: reading.gang.power,
      engaged: reading.gang.territoryWarfareEngaged === true,
      crew: reading.members.filter((each) => each.task === "Territory Warfare").length,
    });
  }
  console.log(readings.map((each) => JSON.stringify(each)).join("\n"));
  const { section, failures } = reportOf(fresh);
  console.log(section);
  console.log(fresh.controller().gangView().line);
  const last = gangSnapshotOf(fresh.medium());
  if (last.kind !== "gang") throw new Error("no gang read");
  // Measured on 2026-11-09, again on 2026-11-10 with the others' clash losses and the gang's own (seed 1): the same.
  // The fighters on Territory Warfare from the brain's first plan (at equal powers, not engaged yet), the gang's power
  // past the others' at the first territory update (10 × 2,200 × 0.015 × 1/7, about 47 an update, against their 1),
  // engaged from then on: 19 min 30 s of it, territory 14.3% → 17.4% in 20 minutes, power 3,181. One fighter died
  // (member-06; about 0.35 × 0.005 a clash at defence 1, 2 clashes an update: about 2.1 deaths expected among 10 over
  // 60 updates); the brain recruited a member-06 again, which trains, and the ten others stayed. Expected 9.5%
  // territory an hour at the end, the win chance 100% against each.
  expect(readings.every((each) => each.engaged)).toBe(true);
  expect(readings.every((each) => each.crew === 10)).toBe(true);
  expect(last.gang.territory).toBeGreaterThan(1 / 7 + 0.02);
  expect(section).toMatch(
    /; territory 14\.3% → \d+\.\d%, power 1\.0 → [\d.]+; warfare engaged 19 min 30 s; 1 death \(member-06\)\n/,
  );
  expect(fresh.controller().gangView().line).toMatch(/; warfare on: .*; 10 on Territory Warfare; 1 death seen; /);
  expect(section).toContain(
    "territory warfare engaged while the rule's measure says it loses for 1 min or more:\n    none",
  );
  expect(section).toContain("territory warfare off while the rule's measure says it pays for 1 min or more:\n    none");
  expect(section).toContain("  problems the gang worker reported, as first seen:\n    none\n");
  expect(notTheBatchersGrows(failures)).toEqual([]);
}, 120_000);
