// Gangs G1 (#325), G2 (#328) and G3 (#330): the brain from a BN2 start with SF1.3 and SF4.3, as the campaign enters BN2
// (after BN4 ×3 and BN5), its rules as on Steam (all on), the simulator's own effectors taken away so the Agent uses
// its workers as in a browser. NiteSec is joined by a harness edit, as A3's backdoor on avmnite-02h would have it
// (hacking 202-220, which an hour from a fresh start doesn't reach; gang-start-simulation runs that path, #353). One
// seed each: a thin slice, no sweep.
// - A bounded hour: the gang forms through the gate, recruits, trains, works, ascends (G2) and keeps growing, and the
//   run report's gang section passes, its silent stalls' checks (#354) too.
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
// - BN2's win route (G5, #334): BN2 played with its own multipliers, so the hour's batcher stays in step with no
//   allowance; and the gang's faction, its reputation set to The Red Pill's 2.5m and $10b given (harness edits, as
//   no short run earns either): A6 buys there, augmentations its own shop lacks, The Red Pill last, and installs.
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  augmentationsSoldBy,
  type FastSnapshotData,
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
  isWorthInstalling,
  type MediumSnapshotData,
  planGangEquipment,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { type GangEvent, gangSnapshotOf, gangWarfareFiguresOf } from "../src/gang.ts";
import { GANG_WANTED_OVER_BOUND_MS } from "../src/gang-report.ts";
import { formatDuration } from "../src/gap-report.ts";
import { runReport } from "../src/run-report.ts";
import { writeWorldDaemonEnabled } from "../src/world-daemon.ts";
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
    // The silent stalls (#354), on the brain's own plan at each reading against the engine's gang.
    "a gang worker's problem in every reading for 1 min or more:\n    none",
    "a member off the rule's task for 1 min or more:\n    none",
    "the gang's respect flat with the rule's members working for 1 min or more:\n    none",
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
  // Measured on 2026-11-10 (seed 1, after #335's review): power 1.0 against 3.3 to 37.9; every member on it would gain
  // 0.0301 an update, under a tenth of The Black Hand's 0.3255; the clashes now −2.75e-4 territory an update.
  expect(everyone).toBeLessThan(gangOtherPowerGainPerUpdate(fastest));
  expect(gangWarfareCrew(withWarfare, basis)).toMatchObject({ crew: [], value: 0 });
  expect(gangWarfareMeasure(withWarfare, basis, []).territoryPerUpdate).toBeLessThan(0);
  expect(failures).toEqual([]);
  // BN2 played (#334, G5): its multipliers core's, none taken as BN1's; the batcher's grows planned at its
  // ServerGrowthRate 0.8, in step, G1's allowance gone. Measured on 2026-11-10 (seed 1): 888 batches on n00dles then
  // harakiri-sushi, none short, the money full at all 845 looks after a grow; home RAM bought, BN2's price known.
  expect(text).not.toContain("taken as BN1's");
  const batcher = text.slice(text.indexOf("6. The batcher"), text.indexOf("7. The gang"));
  expect(batcher).toMatch(/\n {4}hour 1: .*; [1-9]\d* batches, \d+ hack parts landed .*, 0 short, /);
  expect(batcher).toMatch(/\n {2}money after each batch's grow \(#234\): full at all [1-9]\d* looks/);
  expect(batcher).toContain("  desyncs: none\n");
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
  expect(failures).toEqual([]);
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
  // Measured on 2026-11-10 (seed 1, after #335's review): the three, ×9.4 and 172 hacking from the owner, trained 40 minutes (G2: a minute's
  // training pays within the day to its next ascension, the cap), worked under 5 minutes, and two ascended (×1.56),
  // the respect recruiting five. No lost item pays back within a working stretch so short, nor an augmentation within
  // a day: none is bought, with $10b free, and the report's check, on the same readings, passes.
  expect(section).toMatch(/\n {4}hour 1: 3 → \d+ members; .*; [1-9]\d* ascensions? \(.*\); no equipment bought; /);
  expect(section).toContain("equipment the rule buys, with the money free, not bought for 1 min or more:\n    none");
  expect([...equipmentLines]).toEqual(["no equipment pays back within 15 minutes"]);
  expect(last.members.every((each) => (each.upgrades ?? []).length === 0)).toBe(true);
  // Why, computed on the last reading: the strongest on a respect task (earning none), and even on its best money
  // task, the best augmentation for hacking, Neuralstimulator, pays back far slower than 15 minutes (measured on
  // 2026-11-10: member-03, hacking 1,819, on Cyberterrorism; on Money Laundering it gains $2.1b a day for its $9.2b
  // at the gang's discount, paid back in 107 h 4 min).
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
  expect(failures).toEqual([]);
}, 120_000);

/**
 * The Red Pill installed (#357), a harness edit as bn2-end-simulation's: queued, then the simulator's own install. Then
 * money at 12 is the planner's own choice (#357's (2): once The Red Pill is bought, queued or installed), as these
 * suites of a gang of 12 on Money Laundering need. Before the gang's faction is joined: an install leaves it.
 */
async function redPillInstalled(game: FreshGame) {
  await game.simulation.diagnostics.queueAugmentation("The Red Pill");
  await ownerRunsOnHome(
    game,
    `export async function main(ns) { globalThis.${AGENT_SIM_EFFECTORS_GLOBAL}.installQueuedAugmentations(""); }`,
  );
}

/** The brain's objective events at 12 (#357): each its objective and why. */
const objectivesOf = (fresh: Awaited<ReturnType<typeof freshStartOf>>) =>
  fresh.data.store
    .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() })
    .filter((event) => event.kind === "gangObjectiveChosen")
    .map((event) => `${(event.detail as GangEvent).objective} (${(event.detail as GangEvent).reason})`);

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
  await redPillInstalled(game);
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
  // A6 on, as on Steam (#335's review). Measured on 2026-11-10 (seed 1): with Daedalus's count not counting (The Red
  // Pill at the gang's faction), A6 buys 12 augmentations with a hacking value at NiteSec in the window, and the rule's
  // equipment for member-01 still comes within the 3 minutes.
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: BN2,
    beforeAgent: boostedGang,
  });
  // The Red Pill installed (#357's harness edit) with the destroy wanted would hold every purchase for it (#215): the
  // World Daemon's switch off, so A6 buys as before.
  writeWorldDaemonEnabled(fresh.data.store, false);
  await fresh.game.runUntil(() => gangSnapshotOf(fresh.medium()).kind === "gang", 30_000);
  const lastAugReset = () => fresh.latest<SlowSnapshotData>("slow")?.resetInfo?.lastAugReset;
  const before = lastAugReset();
  await fresh.game.runUntil(() => {
    const reading = gangSnapshotOf(fresh.medium());
    return reading.kind === "gang" && (reading.members[0]?.augmentations ?? []).length > 0;
  }, 3 * 60_000);
  // No install before the equipment came (#335's re-review): the same cycle.
  expect(lastAugReset()).toBe(before);
  // A minute more: the report's next readings, and nothing stuck.
  await fresh.game.run(60_000);
  const last = gangSnapshotOf(fresh.medium());
  if (last.kind !== "gang") throw new Error("no gang read");
  const { section, failures } = reportOf(fresh);
  console.log(section);
  // Money at 12, the planner's own choice with The Red Pill installed (#357), from the first reading on.
  console.log(objectivesOf(fresh).join(", "));
  expect(new Set(objectivesOf(fresh))).toEqual(new Set(["money (The Red Pill owned)"]));
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
  // A6 bought at the gang's faction meanwhile, augmentations with a hacking value only, and installed none.
  const boughtByA6 = fresh.data.store
    .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() })
    .filter((event) => event.kind === "augmentationBought")
    .map((event) => event.detail as { augmentation: string; faction: string });
  console.log(`A6: ${boughtByA6.length} bought, at ${[...new Set(boughtByA6.map((each) => each.faction))].join(", ")}`);
  expect(boughtByA6.length).toBeGreaterThan(0);
  expect(boughtByA6.every((each) => each.faction === "NiteSec" && isWorthInstalling(each.augmentation, false))).toBe(
    true,
  );
  expect(lastAugReset()).toBe(before);
  expect(section).toContain("equipment the rule buys, with the money free, not bought for 1 min or more:\n    none");
  expect(section).toContain("  problems the gang worker reported, as first seen:\n    none\n");
  expect(failures).toEqual([]);
}, 120_000);

/**
 * The owner's gang, NiteSec's, of 12 (G4): the three free recruits, the respect set to 2 million (`setGangRespect`) and
 * nine more recruited, as G3's end-to-end test; then member-01 boosted as there (about 88 million hacking, so it works
 * on Money Laundering) and the other eleven made fighters (strength, dexterity and agility experience 1e7 at ascension
 * points 1e8: levels about 70,000, power about 2,200 each, `gangMemberPower`), their defence left at 1, so a clash can
 * kill them (`Gang.ts:298`, 0.005 / 1^0.6 when won, in 35% of clashes).
 */
async function fightingGang(game: FreshGame) {
  await redPillInstalled(game);
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
  // As G3's: The Red Pill installed (#357), the destroy not wanted, so A6 buys as before.
  writeWorldDaemonEnabled(fresh.data.store, false);
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
  console.log(
    fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() })
      .filter((event) => event.kind === "augmentationInstallChosen")
      .map(
        (event) =>
          `install chosen at ${formatDuration(event.atMs - EPOCH_MS)}: ${(event.detail as { reason: string }).reason}`,
      )
      .join("\n"),
  );
  // Money at 12, the planner's own choice with The Red Pill installed (#357), from the first reading on.
  console.log(objectivesOf(fresh).join(", "));
  expect(new Set(objectivesOf(fresh))).toEqual(new Set(["money (The Red Pill owned)"]));
  expect(fresh.controller().gangView().line).toContain(
    "; objective at 12: money, The Red Pill bought, queued or installed; ",
  );
  const last = gangSnapshotOf(fresh.medium());
  if (last.kind !== "gang") throw new Error("no gang read");
  // Measured on 2026-11-10 (seed 1), with PR #333's third review's model (crew slots, the others dropping out at no
  // territory). The fighters on Territory Warfare from the brain's first plan (at equal powers, not engaged yet): they
  // earn nothing, so their deaths cost little, defence 1 and all. The gang's power passes the others' at the first
  // territory update (11 × 2,200 × 0.015 × 1/7, about 52 an update, against their 1), and warfare is engaged from then
  // on: 19 min 30 s of it, territory 14.3% → 17.4% in 20 minutes, power 3,050 (2026-11-11, after #355: the gang's
  // respect earns NiteSec The Red Pill, A6 installs it, and levelling then installs the gang's shop's set for the
  // level twice, at 13 min 36 s and 16 min 1 s, sets of 9 and 3, only what adds to levelling, 40 bought there in all;
  // the level all that's left in short stretches between them, under the hopeless check's 10 minutes in all; 17.3% and 3,086 before #355, 26
  // bought, no install after The Red Pill's). One fighter died (member-06; about 0.35
  // × 0.005 a clash at defence 1, 2 clashes an update: about 2.3 deaths expected among 11 over 60 updates); its recruit
  // trains, as a slot's later deaths each cost the respect toll, and the ten others stayed. The dashboard expects
  // about 111 deaths on the ten slots in a day engaged. Expected 9.4% territory an hour at the end. Since #365's
  // review (2026-11-11): the gang's faction kept across each install's restart (no slow snapshot then), so after them
  // A8 holds for The Red Pill at NiteSec and invitations no longer travel for Daedalus's count (15, then 27 of 30); the
  // same four installs, a run a little different, and a second death, member-09's, in the last minutes: its recruit
  // trains at the 20-minute reading, nine on Territory Warfare.
  expect(readings.every((each) => each.engaged)).toBe(true);
  expect(readings.map((each) => each.crew)).toEqual([10, 10, 10, 9]);
  expect(last.gang.territory).toBeGreaterThan(1 / 7 + 0.02);
  expect(section).toMatch(
    /; territory 14\.3% → \d+\.\d%, power 1\.0 → [\d.]+; warfare engaged 19 min 30 s; 2 deaths \(member-06, member-09\)\n/,
  );
  expect(fresh.controller().gangView().line).toMatch(
    /; warfare on: .*; 9 on Territory Warfare \(about [\d.]+ deaths expected in a day engaged\); 2 deaths seen; /,
  );
  expect(section).toContain(
    "territory warfare engaged while the rule's measure says it loses for 1 min or more:\n    none",
  );
  expect(section).toContain("territory warfare off while the rule's measure says it pays for 1 min or more:\n    none");
  expect(section).toContain("  problems the gang worker reported, as first seen:\n    none\n");
  expect(failures).toEqual([]);
}, 120_000);

test("BN2's win route (G5): the gang's faction at The Red Pill's reputation, then $10b: bought there, The Red Pill last, installed", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: BN2,
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
      await withoutSimEffectors(game);
    },
  });
  await fresh.game.runUntil(() => gangSnapshotOf(fresh.medium()).kind === "gang", 5 * 60_000);
  // Formed (which zeroes the faction's reputation, `PlayerObjectGangMethods.ts:67`): then NiteSec at The Red Pill's
  // 2.5m and $10b, harness edits (an hour's gang earns its faction about 18, `Gang.ts:152-155`).
  await fresh.simulation.diagnostics.joinFactionWithReputation("NiteSec", 2.5e6);
  await fresh.simulation.diagnostics.setMoney(1e10);
  const slow = () => fresh.latest<SlowSnapshotData>("slow");
  await fresh.game.runUntil(() => Object.hasOwn(slow()?.resetInfo?.ownedAugs ?? {}, "The Red Pill"), 10 * 60_000);
  // Two minutes more: the reset game's readings, the gang still there, and nothing stuck.
  await fresh.game.run(2 * 60_000);
  const { text, failures, section } = reportOf(fresh);
  const bought = fresh.data.store
    .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() })
    .filter((event) => event.kind === "augmentationBought")
    .map((event) => event.detail as { augmentation: string; faction: string });
  console.log(bought.map((each) => `${each.augmentation} (${each.faction})`).join(", "));
  console.log(section);
  console.log(
    text.slice(text.indexOf("the path to the World Daemon"), text.indexOf("the path to the World Daemon") + 600),
  );
  // Measured on 2026-11-10 (seed 1): formed 1 min 25 s in; then 7 bought from NiteSec in under 4 minutes (ECorp
  // HVMind Implant first, ECorp's own, and DataJack, Neuregen Gene Modification, Neural-Retention Enhancement, Social
  // Negotiation Assistant (S.N.A), Neurotrainer I), The Red Pill last, and installed: its favour 233.1 after.
  // Bought from the gang's faction, some only its shop sells there (not NiteSec's own), The Red Pill last; installed.
  expect(bought.length).toBeGreaterThan(1);
  expect(bought.every((each) => each.faction === "NiteSec")).toBe(true);
  expect(bought.at(-1)?.augmentation).toBe("The Red Pill");
  const own = augmentationsSoldBy("NiteSec", 2, null);
  expect(bought.some((each) => !own.includes(each.augmentation))).toBe(true);
  for (const { augmentation } of bought)
    expect(slow()?.resetInfo?.ownedAugs, augmentation).toHaveProperty([augmentation]);
  // The gang stays through the install (`Prestige.ts:133-146`), its faction joined again.
  expect(gangSnapshotOf(fresh.medium()).kind).toBe("gang");
  expect(section).toMatch(
    /\n {2}The Red Pill's route: from NiteSec, the gang's faction, no Daedalus needed in BN2; installed\n/,
  );
  expect(section).toMatch(/; bought there in the window: \d+ \(/);
  expect(text).toContain("    The Red Pill: installed\n");
  expect(failures).toEqual([]);
}, 120_000);

/**
 * The owner's gang, NiteSec's, of 12 (#357's (2)): the three free recruits, the respect set to 2 million and nine more
 * recruited, all training, as G3's end-to-end test; then member-01 grown by a harness edit to ascension points of
 * 4.5e11 (×15,000) and 4.5e9 hacking experience, about 7.7 million hacking: its ascension converts a hundredth more,
 * so it doesn't pay, and a minute's training adds too little to pay within a day, so it works. The other eleven train.
 */
async function twelveToChoose(game: FreshGame) {
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
  await game.simulation.diagnostics.setGangMemberFigures("member-01", { hack_asc_points: 4.5e11, hack_exp: 4.5e9 });
  await withoutSimEffectors(game);
}

/** #357's (2), 20 virtual minutes an arm: NiteSec's reputation gained (its slow snapshots), and the planner's events. */
async function objectiveArm(bn2Route: "planner" | "rules") {
  // A6 off: nothing bought or installed (an install zeroes the faction's reputation, `Faction/Faction.ts:77-85`).
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: BN2,
    augmentations: false,
    bn2Route,
    beforeAgent: twelveToChoose,
  });
  await fresh.game.runUntil(() => gangSnapshotOf(fresh.medium()).kind === "gang", 30_000);
  const reputation = () =>
    fresh.latest<SlowSnapshotData>("slow")?.factions?.state?.joined.find((each) => each.name === "NiteSec")
      ?.reputation ?? Number.NaN;
  // From the first slow snapshot after the gang's first reading.
  const startSlow = fresh.latest<SlowSnapshotData>("slow");
  await fresh.game.runUntil(() => fresh.latest<SlowSnapshotData>("slow") !== startSlow, 70_000);
  const from = { atMs: fresh.game.clock.now(), reputation: reputation() };
  await fresh.game.run(20 * 60_000);
  const to = { atMs: fresh.game.clock.now(), reputation: reputation() };
  const events = fresh.data.store
    .eventsInWindow({ environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() })
    .filter((event) => event.kind === "gangObjectiveChosen")
    .map((event) => event.detail as GangEvent);
  const last = gangSnapshotOf(fresh.medium());
  const { failures, section } = reportOf(fresh);
  return { fresh, from, to, events, last, failures, section };
}

test("the objective at 12 (#357's (2)) A/B, 20 virtual minutes an arm: the planner's respect earns NiteSec more than the rules' money, at its estimate's rate", async () => {
  const planner = await objectiveArm("planner");
  const rules = await objectiveArm("rules");
  const gained = (arm: typeof planner) => arm.to.reputation - arm.from.reputation;
  const perSecond = (arm: typeof planner) => (gained(arm) / (arm.to.atMs - arm.from.atMs)) * 1000;
  const first = planner.events[0];
  console.log(
    `the planner: ${planner.events.map((each) => `${each.objective} (${each.reason})`).join(", ")}; NiteSec ` +
      `${Math.round(gained(planner)).toLocaleString("en-US")} in 20 min, ${perSecond(planner).toFixed(1)}/s against ` +
      `its estimate's ${first?.respect?.reputationPerSecond.toFixed(1)}/s; the rules (money): ` +
      `${Math.round(gained(rules)).toLocaleString("en-US")}, ${perSecond(rules).toFixed(1)}/s against money's estimate ` +
      `${first?.money?.reputationPerSecond.toFixed(1)}/s`,
  );
  console.log(planner.section);
  // The planner chose respect, by the time to The Red Pill's 2.5m (its two estimates in the event), and held it.
  expect(first).toMatchObject({ objective: "respect", reason: "estimates", members: 12, needed: 2.5e6 });
  expect(planner.events).toHaveLength(1);
  // The rules: money at 12, no event.
  expect(rules.events).toEqual([]);
  // Measured on 2026-11-11 (seed 1, about 19 s of real time an arm): the planner's respect, NiteSec 1,367,540 in the
  // 20 minutes, 1,139.6 a second against its estimate's 1,150.3 (The Red Pill in 36 min, money's 4.3 h); the rules'
  // money, 346,055, 288.4 a second against money's estimate of 161.8 (×1.78, inside ×2 too, not asserted).
  expect(gained(planner)).toBeGreaterThan(gained(rules));
  const estimate = first?.respect?.reputationPerSecond as number;
  expect(perSecond(planner)).toBeGreaterThan(estimate / 2);
  expect(perSecond(planner)).toBeLessThan(estimate * 2);
  // Member-01 on the objective's task in each arm, and both reports pass.
  if (planner.last.kind !== "gang" || rules.last.kind !== "gang") throw new Error("no gang read");
  expect(planner.last.members[0]?.task).not.toBe(rules.last.members[0]?.task);
  expect(planner.failures).toEqual([]);
  expect(planner.section).toContain(
    "  the objective at 12 differing from core's (from the snapshots) for 1 min or more:\n    none\n",
  );
}, 120_000);
