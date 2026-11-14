// Bladeburner B8 (#411): B6's end of the route (bn6-destroy-simulation.test.ts, #398) in BN7.1, so BN7's multipliers run
// end to end: Operation Daedalus's rank gained ×0.6 (`BladeburnerRank`, `BitNode/BitNode.tsx:756`;
// `Bladeburner/Formulas.ts:25`), the skill points' costs ×2 (`:757`; `Bladeburner/Skill.ts:76-80`). The campaign's
// Source-Files (SF1.3, SF2.3, SF4.3 and SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's
// own effectors taken away (Singularity's destroy at SF4.3, beside the Agent on a 128 GB home). One seed: a thin slice,
// no sweep. Bounded by virtual time, under a minute of CI. BN6's harness edits stand in for the days of play before the
// last Black Op: the division joined by the owner's own script, home at 128 GB, CyberSec joined, and
// - **the rank at 400,000** through the game's own change (its 133,333 skill points, `Bladeburner.ts:1284-1293`, as in
//   BN6: the points are the rank's, not scaled), and **20 Black Ops done**: Operation Daedalus next, its rank met;
// - **the success skills the owner's script buys** with those points at BN7's costs, ×2: Blade's Intuition and Digital
//   Observer at 169 and Overclock at 90 (132,690 points; BN6's 240 each would cost 255,066), a competence ×47 by the
//   skills against BN6's ×87 (`Bladeburner.ts:776-786`);
// - **the four combat stats at 15,000** (BN6's 10,000), so Daedalus's chance is BN6's suite's, 1 by the formula (core's
//   `blackOpSuccessChance`: 0.75 at 10,000, 0.98 at 14,000), the skills' lower competence made up by the stats, as
//   B7's augmentations would bring it.
// Then the brain's own: Daedalus run by B5's check, done; the destroy asked for with all 21 done, through the gate and a
// save backup, by Singularity's `destroyW0r1dD43m0n` (`NetscriptFunctions/Singularity.ts:1176-1183`) into the order's
// next, BN5.2 (BN6 and BN7 skipped, each one's estimate past the bar), SF7.1 gained; the next Agent connects; the run
// report passes, with the route's lines at BN7's multipliers, and the campaign report counts BN7.1.
import {
  BLACK_OPERATIONS,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_READING_SECONDS,
  bladeburnerSkill,
  bladeburnerSkillCost,
  type MediumSnapshotData,
  nextBitNodeOf,
  type SlowSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { blackOpsInstallFiguresOf } from "../src/bladeburner-route.ts";
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
/** BN7's `BladeburnerRank` and `BladeburnerSkillCost` (`BitNode/BitNode.tsx:756-757`). */
const RANK_MULTIPLIER = 0.6;
const COST_MULTIPLIER = 2;
/** The skills the owner's script buys (see above), and their points at BN7's costs. */
const BOUGHT = [
  ["Blade's Intuition", 169],
  ["Digital Observer", 169],
  ["Overclock", 90],
] as const;
const COMBAT = 15_000;

/** The Agent sessions the brain has seen connect. */
const agentSessions = (brain: { channelEvents: { type: string }[] }) =>
  brain.channelEvents.filter((event) => event.type === "agentConnected").length;

test("BN7.1 with 20 Black Ops done at rank 400,000, its skills at ×2: Operation Daedalus done at ×0.6, then the destroy into BN5.2; the reports pass", async () => {
  // The skills fit the points at BN7's costs, as the owner's script buys them (one point for each 3 of the rank).
  const points = BOUGHT.reduce(
    (sum, [name, count]) =>
      sum +
      bladeburnerSkillCost(
        bladeburnerSkill(name) as NonNullable<ReturnType<typeof bladeburnerSkill>>,
        0,
        count,
        COST_MULTIPLIER,
      ),
    0,
  );
  expect(points).toBe(132_690);
  expect(points).toBeLessThanOrEqual(Math.floor(DAEDALUS.rank / 3));
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 7, sourceFiles: SOURCE_FILES },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setHomeRam(128);
      await game.simulation.diagnostics.joinFactionWithReputation("CyberSec", 0);
      await game.simulation.diagnostics.gainCombatExp(skillExpFor(COMBAT, 1.28) + 1);
      await ownerRunsOnHome(
        game,
        "export async function main(ns) { if (!ns.bladeburner.joinBladeburnerDivision()) throw new Error('no join'); }",
      );
      await game.simulation.diagnostics.setBladeburnerRank(DAEDALUS.rank);
      await game.simulation.diagnostics.setBladeburnerFigures({ blackOpsDone: 20 });
      await ownerRunsOnHome(
        game,
        `export async function main(ns) {
          const points = ns.bladeburner.getSkillPoints();
          for (const [skill, count] of ${JSON.stringify(BOUGHT)}) {
            if (!ns.bladeburner.upgradeSkill(skill, count)) throw new Error("no " + skill);
          }
          if (points - ns.bladeburner.getSkillPoints() !== ${points}) throw new Error("not BN7's costs");
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
  // The order's next from BN7.1: BN5, BN6 and BN7 (their estimates past the bar, #408, #411) and BN3 skipped.
  expect(nextBitNodeOf({ currentNode: 7, ownedSF: SOURCE_FILES }).bitNode).toBe(5);
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
  // The route's figures at BN7's multipliers, as the planner and B7 read them: the rank ×0.6, the skills ×2.
  const route = blackOpsInstallFiguresOf(startMedium, 7)?.route;
  expect(route?.input.rankMultiplier).toBe(RANK_MULTIPLIER);
  expect(route?.growth.costMultiplier).toBe(COST_MULTIPLIER);
  // #408's hindcast at BN7's multipliers: Daedalus done from its rank, against the grown estimate.
  const hindcast = grownHindcast(
    "B6's Daedalus, BN7",
    startMedium,
    (doneAtMs ?? Number.NaN) - startedAtMs,
    "next done",
    await attemptsIn(simulation, startedAtMs, doneAtMs ?? Number.NaN),
    7,
  );
  console.log(hindcast.line);
  expectGrownHindcast(hindcast);

  // BN5.2: SF7.1 gained beside the others; through Singularity's destroy, straight into it (no BitVerse).
  expect(slow()?.resetInfo).toMatchObject({ currentNode: 5, ownedAugs: {} });
  expect(slow()?.resetInfo.ownedSF).toEqual({ ...SOURCE_FILES, 7: 1 });
  expect(
    (await simulation.events(0)).events.filter((event) =>
      ["bitnodeDestroyed", "bitnodeFlumed", "bitverseReached"].includes(event.type),
    ),
  ).toEqual([expect.objectContaining({ type: "bitnodeDestroyed", destroyed: 7, entered: 5 })]);
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
  // The time to the destroy (#360, #398): BN7.1's estimates are the Black Ops' one term.
  const estimates = (stored(DESTROY_ESTIMATED_EVENT_KIND) as DestroyEstimateRecord[]).filter(
    (each) => each.bitNode === "BN7.1",
  );
  console.log(estimates.map((each) => `${each.moment}: ${JSON.stringify(each.terms)}`).join("\n"));
  expect(estimates.length).toBeGreaterThan(0);
  expect(estimates.every((each) => each.terms.length === 1 && each.terms[0]?.term === "BO")).toBe(true);
  expect(estimates.at(-1)).toMatchObject({ moment: "black op", remainingMs: 0 });

  // The run report: BN7.1 destroyed into BN5.2, no failure.
  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() } as const;
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  const lines = text.split("\n");
  expect(lines.find((each) => each.startsWith("  BitNodes: "))).toMatch(
    /^ {2}BitNodes: BN7\.1 from \S+, destroyed after [^,]+, into BN5\.2; BN5\.2 from \S+, not destroyed, /,
  );
  expect(
    lines.some((each) => /^ {4}\S+ {2}destroy sent \(the brain's\), into BitNode 5 \(BN6 skipped/.test(each)),
  ).toBe(true);
  expect(failures).toEqual([]);
  // The campaign report counts BN7.1: its row, destroyed.
  const campaign = campaignReport(fresh.data.store, { environment: "E1" });
  console.log(campaign.split("\n").slice(0, 12).join("\n"));
  expect(campaign).toMatch(/BN7\.1 .*destroyed/);
}, 240_000);
