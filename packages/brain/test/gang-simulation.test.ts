// Gangs G1 (#325): the brain from a BN2 start with SF1.3 and SF4.3, as the campaign's order enters BN2 (after BN4 ×3
// and BN5), its rules as on Steam (all on), the simulator's own effectors taken away so the Agent uses its workers as
// in a browser. NiteSec is joined by a harness edit, as A3's backdoor on avmnite-02h would have it (hacking 202-220,
// which an hour from a fresh start doesn't reach). One seed each: a thin slice, no sweep.
// - A bounded hour: the gang forms through the gate, recruits, trains, works, and the run report's gang section passes.
// - Wanted control, end to end: a gang the owner left with its wanted level far over the bound (three members on DDoS
//   Attacks, which earns them no respect at their levels), then the brain for 10 minutes: every member goes to
//   justice, as fewer couldn't bring the wanted level back to the bound within the 23 min, it falls fast, and the
//   report's wanted check passes.
import type { FastSnapshotData, MediumSnapshotData } from "@bitburner-agent/core";
import { gangLostShare, gangLostShareBound } from "@bitburner-agent/core";
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
  // Measured on 2026-11-09 (seed 1): formed 1 min 25 s in; the members trained 10 to 20 min, then took Phishing; at the
  // hour 7 members and 911 respect, the penalty 5.9%, at most 6.8% above its floor (the bound 25% at 4 members then).
  expect(section).toMatch(/\n {4}hour 1: 0 → 7 members; respect 1 → (8[5-9]\d|9\d\d) \(0\.2\d\/s\); /);
  expect(section).toMatch(/; wanted penalty 50\.0% → \d\.\d%, above its floor at most \d\.\d% \(the bound then 25\.0%/);
  const final = gangSnapshotOf(fresh.medium() as MediumSnapshotData);
  expect(final.kind).toBe("gang");
  if (final.kind !== "gang") return;
  expect(final.gang).toMatchObject({ faction: "NiteSec", isHacking: true });
  expect(final.members.map((member) => member.name)).toEqual(
    final.members.map((_, index) => `member-${String(index + 1).padStart(2, "0")}`),
  );
  // Tasks assigned: none left Unassigned; the first trained, then worked for respect.
  expect(final.members.every((member) => member.task !== "Unassigned")).toBe(true);
  expect(readings[0]?.tasks.every((task) => task === "Train Hacking")).toBe(true);
  expect(readings.at(-1)?.tasks.some((task) => !task.startsWith("Train"))).toBe(true);
  // The wanted penalty within the rule's bound, and nothing stuck: the section's checks.
  expect(section).toContain("  problems the gang worker reported, as first seen:\n    none\n");
  for (const what of [
    "no gang formed with a gang faction joined for 5 min or more:\n    none",
    "a recruit the respect allows not made for 1 min or more:\n    none",
    `${WANTED_CHECK} or more:\n    none`,
    "the gang unread in BN2 for 5 min or more:\n    none",
  ]) {
    expect(section).toContain(what);
  }
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
