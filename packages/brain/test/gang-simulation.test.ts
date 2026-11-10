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
//   that, then the brain for 3 minutes: the rule orders an augmentation for it, the worker buys it, and the report
//   counts it, end to end.
import type { FastSnapshotData, MediumSnapshotData } from "@bitburner-agent/core";
import {
  GANG_AUGMENTATION_HORIZON_MS,
  gangEquipment,
  gangEquipmentAppraisal,
  gangEquipmentCostMultOf,
  gangLostShare,
  gangLostShareBound,
  gangTimeToAscensionMs,
  planGangEquipment,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { gangSnapshotOf } from "../src/gang.ts";
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
  // before each ascension, and trains them the rest (which earns nothing before the ascension loses a lost item); and
  // no augmentation pays back within a day at these levels. The strongest's NUKE Rootkit, worked an hour, pays back in
  // about 47 min (measured on 2026-11-09: member-02, hacking 263, on justice). Valued over G2's forecast of 7 h for such
  // members, rootkits were bought ($42m) and lost at ascensions within the hour, before they paid back.
  // The brain's own plan and the gang's own discount, as the brain had them at the end.
  expect(section).toMatch(/; no equipment bought\n/);
  const inputs = { gang: final.gang, isHacking: true, members: final.members, softcap: 1 };
  const plan = fresh.controller().gangView().plan;
  expect(plan).not.toBeNull();
  const unlimited = planGangEquipment(inputs, plan as NonNullable<typeof plan>, {
    budget: 1e15,
    costMult: gangEquipmentCostMultOf(final.gang),
  });
  expect(unlimited.paying).toEqual([]);
  const strongest = final.members.reduce((top, each) => (each.hack > top.hack ? each : top));
  const hourMs = 3_600_000;
  const nuke = gangEquipmentAppraisal(inputs, strongest, gangEquipment("NUKE Rootkit"), hourMs, 1);
  console.log(
    `G3: ${strongest.name} (hacking ${strongest.hack}, ${strongest.task}): NUKE Rootkit pays back in ` +
      `${formatDuration((nuke.cost / nuke.gain) * hourMs)} of an hour's work; G2's forecast of its next ascension, ` +
      `${formatDuration(gangTimeToAscensionMs(inputs, strongest, "respect"))}`,
  );
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
  expect(section).toMatch(/\n {4}hour 1: 3 → \d+ members; .*; [1-9]\d* ascensions? \(.*\); no equipment bought\n/);
  expect(section).toContain("equipment the rule buys, with the money free, not bought for 1 min or more:\n    none");
  expect([...equipmentLines]).toEqual(["no equipment pays back within its horizon"]);
  expect(last.members.every((each) => (each.upgrades ?? []).length === 0)).toBe(true);
  // Why, computed on the last reading: the strongest's best augmentation for hacking, Neuralstimulator, over a day.
  const inputs = { gang: last.gang, isHacking: true, members: last.members, softcap: 1 };
  const strongest = last.members.reduce((top, each) => (each.hack > top.hack ? each : top));
  const augmentation = gangEquipmentAppraisal(
    inputs,
    strongest,
    gangEquipment("Neuralstimulator"),
    GANG_AUGMENTATION_HORIZON_MS,
    1,
  );
  console.log(
    `G3: ${strongest.name} (hacking ${strongest.hack}): Neuralstimulator gains $${Math.round(augmentation.gain)} in a ` +
      `day for $${augmentation.cost}`,
  );
  expect(augmentation.gain).toBeLessThan(augmentation.cost);
  expect(notTheBatchersGrows(failures)).toEqual([]);
}, 120_000);

/**
 * The owner's gang, NiteSec's: three recruits training, member-01 boosted by a harness edit (`setGangMemberFigures`)
 * to ascension points of 8e13 (×200,000) and a million hacking experience, about 48 million hacking, far past any
 * hour's play; then $100b.
 */
async function boostedGang(game: FreshGame) {
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
  await game.simulation.diagnostics.setGangMemberFigures("member-01", { hack_asc_points: 8e13, hack_exp: 1e6 });
  await game.simulation.diagnostics.setMoney(1e11);
  await withoutSimEffectors(game);
}

test("equipment (G3) end to end: a member boosted far past an hour's play, then the brain: the rule orders an augmentation, the worker buys it, the report counts it", async () => {
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
  const bought = last.members[0]?.augmentations ?? [];
  // An augmentation that raises hacking, the rule's best payback; none for the others, which can't pay one back.
  expect(bought.length).toBeGreaterThan(0);
  for (const item of bought) expect(gangEquipment(item).mults.hack, item).toBeGreaterThan(1);
  expect(last.members.slice(1).every((each) => (each.augmentations ?? []).length === 0)).toBe(true);
  expect(last.members[0]?.hack_mult).toBeGreaterThan(1);
  expect(section).toMatch(/\n {4}hour 1: .*; [1-9]\d* equipment bought for \$[\d,]+ \(/);
  expect(section).toContain("equipment the rule buys, with the money free, not bought for 1 min or more:\n    none");
  expect(section).toContain("  problems the gang worker reported, as first seen:\n    none\n");
  expect(notTheBatchersGrows(failures)).toEqual([]);
}, 120_000);
