// Bladeburner B6 (#398): BN6's win route to its end, in BN6.1 with the campaign's Source-Files (SF1.3, SF2.3, SF4.3
// and SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's own effectors taken away so the
// Agent uses its workers as in a browser (Singularity's destroy at SF4.3, beside the Agent on a 128 GB home). One seed:
// a thin slice, no sweep. Bounded by virtual time, under a minute of CI. Harness edits stand in for the days of play
// before the last Black Op (as B5's suite, bn6-black-ops-simulation.test.ts): the division joined by the owner's own
// script, home at 128 GB, CyberSec joined, the four combat stats at 10,000, and
// - **the rank at 400,000** through the game's own change (its 133,333 skill points, `Bladeburner.ts:1284-1293`), and
//   **20 Black Ops done** (`numBlackOpsComplete`): Operation Daedalus next, its rank met;
// - **the success skills the owner's script buys** with those points (Blade's Intuition and Digital Observer at 240,
//   Overclock at 90: `NetscriptFunctions/Bladeburner.ts:252-259`), so Daedalus's 80,000 is within an hour's test
//   (competence ×87 by the skills, `Bladeburner.ts:776-786`), as B7's augmentations would bring it.
// Then the brain's own: Daedalus run by B5's check, done; the World Daemon's destroy asked for with all 21 done, through
// the gate and a save backup, by Singularity's `destroyW0r1dD43m0n` (`NetscriptFunctions/Singularity.ts:1176-1183`)
// into the order's next, BN5.2 (BN6's estimate with installs past the bar, #404), SF6.1 gained; the next Agent connects; the run report
// passes, with the route's lines,
// and the campaign report counts BN6.1.
import {
  BLACK_OPERATIONS,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_READING_SECONDS,
  type MediumSnapshotData,
  nextBitNodeOf,
  type SlowSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { campaignReport } from "../src/campaign-report.ts";
import { DESTROY_ESTIMATED_EVENT_KIND, type DestroyEstimateRecord } from "../src/destroy-estimate.ts";
import { runReport } from "../src/run-report.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "../src/world-daemon.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";
import { attemptsIn, expectGrownHindcast, grownHindcast } from "./helpers/grown-hindcast.ts";

const freshStartOf = useFreshStarts();
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
const MINUTE = 60_000;
const READING_MS = BLADEBURNER_READING_SECONDS * 1000;
const DAEDALUS = BLADEBURNER_BLACK_OPS[20] as (typeof BLADEBURNER_BLACK_OPS)[number];

/** The Agent sessions the brain has seen connect. */
const agentSessions = (brain: { channelEvents: { type: string }[] }) =>
  brain.channelEvents.filter((event) => event.type === "agentConnected").length;

test("BN6.1 with 20 Black Ops done at rank 400,000: Operation Daedalus done, then the destroy by the Black Ops into the order's next, BN5.2; the reports pass", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 6, sourceFiles: SOURCE_FILES },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setHomeRam(128);
      await game.simulation.diagnostics.joinFactionWithReputation("CyberSec", 0);
      await game.simulation.diagnostics.gainCombatExp(skillExpFor(10_000, 1.28) + 1);
      await ownerRunsOnHome(
        game,
        "export async function main(ns) { if (!ns.bladeburner.joinBladeburnerDivision()) throw new Error('no join'); }",
      );
      await game.simulation.diagnostics.setBladeburnerRank(DAEDALUS.rank);
      await game.simulation.diagnostics.setBladeburnerFigures({ blackOpsDone: 20 });
      await ownerRunsOnHome(
        game,
        `export async function main(ns) {
          for (const [skill, count] of [["Blade's Intuition", 240], ["Digital Observer", 240], ["Overclock", 90]]) {
            if (!ns.bladeburner.upgradeSkill(skill, count)) throw new Error("no " + skill);
          }
        }`,
      );
      await withoutSimEffectors(game);
    },
  });
  const { game, brain, simulation } = fresh;
  const controller = fresh.controller();
  const reading = () => (fresh.medium() as MediumSnapshotData | null)?.bladeburner;
  const slow = () => fresh.latest<SlowSnapshotData>("slow");
  await game.runUntil(() => reading()?.blackOp !== undefined && slow() !== null, 2 * MINUTE);
  expect(reading()?.blackOp?.name).toBe(DAEDALUS.name);
  const nodeResetBefore = slow()?.resetInfo.lastNodeReset as number;
  // The order's next from BN6.1: BN5, BN6 (its estimate past the bar, #404), BN7 and BN3 skipped.
  expect(nextBitNodeOf({ currentNode: 6, ownedSF: SOURCE_FILES }).bitNode).toBe(5);
  // The World Daemon's path is the route's: 20 of 21 done, Daedalus next, the planner's estimates, The Red Pill's off.
  await game.run(READING_MS);
  const path = controller.worldDaemonView();
  console.log(path.lines.join("\n"));
  expect(path).toMatchObject({ destroying: false, nextBitNode: 5, path: { route: "blackOps" } });
  expect(path.path?.blackOps).toMatchObject({ done: 20, next: { name: DAEDALUS.name, rank: DAEDALUS.rank } });
  expect(path.lines[0]).toContain("20 of 21 done; next Operation Daedalus at rank 400,000");
  expect(path.lines[2]).toContain("off on this route (#398)");

  const startedAtMs = game.clock.now();
  // #408's hindcast's start: this reading, Daedalus's rank met.
  const startMedium = fresh.medium() as MediumSnapshotData | null;
  const backupsBefore = brain.saveBackupEvents.length;
  const sessionsBefore = agentSessions(brain);
  let daedalusSentAtMs: number | null = null;
  let doneAtMs: number | null = null;
  const note = (what: string) => console.log(`${((game.clock.now() - startedAtMs) / MINUTE).toFixed(1)} min: ${what}`);
  // Each reading: Daedalus sent by B5's check; then all done, the destroy asked; until the BitNode resets.
  for (let at = 0; at < 60 * MINUTE; at += READING_MS) {
    await game.run(READING_MS);
    if ((slow()?.resetInfo.lastNodeReset ?? nodeResetBefore) !== nodeResetBefore) break;
    const order = controller.bladeburnerView().actions?.order;
    if (daedalusSentAtMs === null && order?.type === BLACK_OPERATIONS && order.name === DAEDALUS.name) {
      daedalusSentAtMs = game.clock.now();
      note(
        `Daedalus sent: ${controller.bladeburnerView().line.slice(controller.bladeburnerView().line.indexOf("next Black Op"))}`,
      );
    }
    if (doneAtMs === null && reading()?.blackOp === null) {
      doneAtMs = game.clock.now();
      note(`all 21 done (rank ${reading()?.rank?.toFixed(0)}): ${controller.worldDaemonView().lines[0]}`);
    }
  }
  note(`the BitNode reset: ${JSON.stringify(slow()?.resetInfo.ownedSF)}`);
  expect(daedalusSentAtMs).not.toBeNull();
  expect(doneAtMs).not.toBeNull();
  // #408's hindcast: Daedalus done from its rank, against the grown estimate.
  const hindcast = grownHindcast(
    "B6's Daedalus",
    startMedium,
    (doneAtMs ?? Number.NaN) - startedAtMs,
    "next done",
    await attemptsIn(simulation, startedAtMs, doneAtMs ?? Number.NaN),
  );
  console.log(hindcast.line);
  expectGrownHindcast(hindcast);

  // BN5.2: SF6.1 gained beside the others; through Singularity's destroy, straight into it (no BitVerse).
  expect(slow()?.resetInfo).toMatchObject({ currentNode: 5, ownedAugs: {} });
  expect(slow()?.resetInfo.ownedSF).toEqual({ ...SOURCE_FILES, 6: 1 });
  expect(
    (await simulation.events(0)).events.filter((event) =>
      ["bitnodeDestroyed", "bitnodeFlumed", "bitverseReached"].includes(event.type),
    ),
  ).toEqual([expect.objectContaining({ type: "bitnodeDestroyed", destroyed: 6, entered: 5 })]);
  await game.runUntil(() => agentSessions(brain) > sessionsBefore, 2 * MINUTE);
  // The gate's one save backup, its own.
  expect(brain.saveBackupEvents.slice(backupsBefore)).toEqual([expect.objectContaining({ file: expect.any(String) })]);
  const stored = (kind: string) =>
    fresh.data.store
      .eventsInWindow({ environment: "E1", sinceMs: 0, untilMs: game.clock.now() })
      .filter((event) => event.kind === kind)
      .map((event) => event.detail);
  expect(stored(BITNODE_DESTROY_SENT_EVENT_KIND)).toEqual([
    {
      source: "brain",
      nextBitNode: 5,
      replay: null,
      skipped:
        "BN6 skipped: no win route yet: the Black Ops' grown estimate is past the campaign's bar even with the Bladeburners' shop installed (#408); BN7 skipped: no win route yet: the Black Ops' grown estimate at BN7's multipliers is past the campaign's bar even with the Bladeburners' shop installed (#411); BN3 skipped: no hacking multipliers or prices yet",
    },
  ]);
  expect(brain.logLines).toContainEqual(
    expect.stringMatching(/^world daemon: all 21 Black Ops done \(#398\): destroying the BitNode, into BitNode 5/),
  );
  // Within the destroy's bound of all 21 done (the stall's 5 minutes): no stall.
  await game.run(MINUTE);
  expect(controller.worldDaemonView()).toMatchObject({ destroying: false, stall: null });
  // The time to the destroy (#360, #398): BN6.1's estimates are the Black Ops' one term.
  const estimates = (stored(DESTROY_ESTIMATED_EVENT_KIND) as DestroyEstimateRecord[]).filter(
    (each) => each.bitNode === "BN6.1",
  );
  console.log(estimates.map((each) => `${each.moment}: ${JSON.stringify(each.terms)}`).join("\n"));
  expect(estimates.length).toBeGreaterThan(0);
  expect(estimates.every((each) => each.terms.length === 1 && each.terms[0]?.term === "BO")).toBe(true);
  expect(estimates.at(-1)).toMatchObject({ moment: "black op", remainingMs: 0 });

  // The run report: BN6.1 destroyed into BN5.2, no failure.
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const lines = text.split("\n");
  expect(lines.find((each) => each.startsWith("  BitNodes: "))).toMatch(
    /^ {2}BitNodes: BN6\.1 from \S+, destroyed after [^,]+, into BN5\.2; BN5\.2 from \S+, not destroyed, /,
  );
  expect(
    lines.some((each) => /^ {4}\S+ {2}destroy sent \(the brain's\), into BitNode 5 \(BN6 skipped/.test(each)),
  ).toBe(true);
  expect(failures).toEqual([]);
  // The campaign report counts BN6.1: its row, destroyed.
  const campaign = campaignReport(fresh.data.store, { environment: "E1" });
  console.log(campaign.split("\n").slice(0, 12).join("\n"));
  expect(campaign).toMatch(/BN6\.1 .*destroyed/);
}, 240_000);

test("the page's way (the simulator's stand-in for the Black Ops page's button, no Singularity worker): all 21 done, through the BitVerse into the order's next, BN4 (SF4 short)", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    // No SF4: no Singularity, so the Agent's effector is the page's (the simulator's own, as its stand-in).
    fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3, 2: 3, 5: 1 } },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setHomeRam(128);
      await game.simulation.diagnostics.gainCombatExp(skillExpFor(1_000, 1.28) + 1);
      await ownerRunsOnHome(
        game,
        "export async function main(ns) { if (!ns.bladeburner.joinBladeburnerDivision()) throw new Error('no join'); }",
      );
      await game.simulation.diagnostics.setBladeburnerRank(DAEDALUS.rank + 40_000);
      await game.simulation.diagnostics.setBladeburnerFigures({ blackOpsDone: 21 });
    },
  });
  const { game, simulation } = fresh;
  const slow = () => fresh.latest<SlowSnapshotData>("slow");
  await game.runUntil(() => slow() !== null && fresh.medium() !== null, 2 * MINUTE);
  const nodeResetBefore = slow()?.resetInfo.lastNodeReset as number;
  await game.runUntil(() => (slow()?.resetInfo.lastNodeReset ?? nodeResetBefore) !== nodeResetBefore, 10 * MINUTE);
  // With no SF4, the order's next is BN4 (#321): BN6.1 destroyed into it, SF6.1 gained.
  expect(slow()?.resetInfo).toMatchObject({ currentNode: 4, ownedSF: { 1: 3, 2: 3, 5: 1, 6: 1 } });
  // The button's way: the BitVerse reached (no flume), then its portal into BN4.
  expect(
    (await simulation.events(0)).events
      .filter((event) => ["bitnodeDestroyed", "bitnodeFlumed", "bitverseReached"].includes(event.type))
      .map((event) => event.type),
  ).toEqual(["bitverseReached", "bitnodeDestroyed"]);
  expect(fresh.brain.logLines).toContainEqual(
    expect.stringMatching(/^world daemon: all 21 Black Ops done \(#398\): destroying the BitNode, into BitNode 4/),
  );
}, 240_000);
