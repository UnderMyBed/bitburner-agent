// Gangs G1 (#325): the brain from a BN2 start with SF1.3 and SF4.3, as the campaign's order enters BN2 (after BN4 ×3
// and BN5), for a bounded hour of virtual time, its rules as on Steam (all on), the simulator's own effectors taken
// away so the Agent uses its workers as in a browser. NiteSec is joined by a harness edit, as A3's backdoor on
// avmnite-02h would have it (hacking 202-220, which an hour from a fresh start doesn't reach). The gang forms through
// the gate, recruits, trains, works, keeps its wanted level down, and the run report's gang section passes. One seed:
// a thin slice, no sweep.
import type { FastSnapshotData, MediumSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { gangSnapshotOf } from "../src/gang.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const RUN_MS = 60 * 60_000;

test("1 virtual hour from BN2.1 with SF1.3 and SF4.3: the gang forms with NiteSec, recruits, trains and works; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 2, sourceFiles: { 1: 3, 4: 3 } },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.joinFactionWithReputation("NiteSec", 0);
      await withoutSimEffectors(game);
    },
  });
  // Read every 10 minutes: members, respect and the task mix, for the log and the checks below.
  const readings: { minute: number; members: number; respect: number; tasks: string[] }[] = [];
  for (let minute = 10; minute <= RUN_MS / 60_000; minute += 10) {
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
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const section = text.slice(text.indexOf("7. The gang"), text.indexOf("Verdict"));
  console.log(section);

  // Formed with NiteSec, through its worker (no Singularity worker for it), past the gate.
  const createGang = (fresh.latest<FastSnapshotData>("fast")?.intents ?? []).find(
    (each) => each.id === "createGang(NiteSec)",
  );
  expect(text).toMatch(/\n {4}createGang\(NiteSec\): done after 1 try \(ui\); /);
  expect(createGang === undefined || createGang.done).toBe(true);
  expect(section).toMatch(/\n {2}formed: with NiteSec, first seen /);
  // Measured on 2026-11-09 (seed 1): formed 1 min 25 s in; the members trained 10 to 20 min, then took Phishing; 7
  // members and 911 respect at the hour, the penalty 5.9%, at most 6.8% above its floor against a bound of 25%.
  expect(section).toMatch(/\n {4}hour 1: 0 → \d+ members; respect 1 → [\d,]+ \([\d.]+\/s\); /);
  const final = gangSnapshotOf(fresh.medium() as MediumSnapshotData);
  expect(final.kind).toBe("gang");
  if (final.kind !== "gang") return;
  expect(final.gang).toMatchObject({ faction: "NiteSec", isHacking: true });
  // Recruited past the three free members, each by the rule's names, and respect risen.
  expect(final.members.length).toBeGreaterThan(3);
  expect(final.members.map((member) => member.name)).toEqual(
    final.members.map((_, index) => `member-${String(index + 1).padStart(2, "0")}`),
  );
  expect(final.gang.respect).toBeGreaterThan(25);
  // Tasks assigned: none left Unassigned; the first trained, then worked for respect.
  expect(final.members.every((member) => member.task !== "Unassigned")).toBe(true);
  expect(readings[0]?.tasks.every((task) => task === "Train Hacking")).toBe(true);
  expect(readings.at(-1)?.tasks.some((task) => !task.startsWith("Train"))).toBe(true);
  // The wanted penalty within the rule's bound, and nothing stuck: the section's checks, and the verdict.
  expect(section).toContain("  problems the gang worker reported, as first seen:\n    none\n");
  for (const what of [
    "no gang formed with a gang faction joined for 5 min or more:\n    none",
    "a recruit the respect allows not made for 1 min or more:\n    none",
    "the wanted penalty over the rule's bound for 23 min 6 s or more:\n    none",
    "the gang unread in BN2 for 5 min or more:\n    none",
  ]) {
    expect(section).toContain(what);
  }
  // The report's other failures: none but the batcher's out of step on n00dles, BN2's grows short of its plan. The
  // brain plans BN2's hacking with BN1's multipliers (core's `bitNodeAssumptions`), and BN2's ServerGrowthRate is 0.8
  // (`BitNode/BitNode.tsx:579`): BN2's tables, G5's (#324), not the gang's.
  expect(failures.filter((failure) => !failure.startsWith("batcher out of step: "))).toEqual([]);
  expect(text).toContain("taken as BN1's");
}, 120_000);
