// Bladeburner B5 (#392): the brain's Black Ops for an hour from a harness join, in BN6.1 with the campaign's
// Source-Files (SF1.3, SF2.3, SF4.3 and SF5.1, docs/synthesis.md §3), its rules as on Steam (all on), the simulator's
// own effectors taken away so the Agent uses its workers as in a browser. One seed: a thin slice, no sweep. Bounded by
// virtual time, under a minute of CI. Harness edits stand in for B1's half hour and the hours of rank and stats a run
// would bring, as B2's suite does (bn6-actions-simulation.test.ts): the division joined by the owner's own script, home
// at 128 GB, CyberSec joined; then
// - **the four combat stats at 1,000** (B7's augmentations' and an hour's training's), so a Black Op's chance is worth an
//   hour's test: Typhoon about 42% at the low end once B3 spends the points (core's forecast);
// - **the rank at 2,500** through the game's own change, which gives its 833 points (`Bladeburner.ts:1284-1293`):
//   Typhoon's rank met. The rule waits a reading for B3's levels (the look-ahead: the points' levels raise the chance),
//   then runs it, rebuilding the rank after each failure, until it's done;
// - **the rank at 4,900** once Typhoon is done (the hours to Zero's 5,000 at this rate), so the rule's own work brings
//   Zero's rank, and Zero is run once it comes.
// At every reading: a Black Op sent only as the next in order with its rank met (or under way, kept), the target the
// next one's rank, A5's faction work held. The whole report passing, its Black Ops' check among it.
import {
  BLACK_OPERATIONS,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_READING_SECONDS,
  type MediumSnapshotData,
  skillExpFor,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BLADEBURNER_ACTIONS_HOLD } from "../src/bladeburner.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts, withoutSimEffectors } from "./helpers/fresh-start.ts";
import { attemptsIn, expectGrownHindcast, grownHindcast } from "./helpers/grown-hindcast.ts";

const freshStartOf = useFreshStarts();
const SOURCE_FILES = { 1: 3, 2: 3, 4: 3, 5: 1 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const READING_MS = BLADEBURNER_READING_SECONDS * 1000;
const TYPHOON = BLADEBURNER_BLACK_OPS[0] as (typeof BLADEBURNER_BLACK_OPS)[number];
const ZERO = BLADEBURNER_BLACK_OPS[1] as (typeof BLADEBURNER_BLACK_OPS)[number];

test("BN6.1, an hour from a harness join at rank 2,500: Typhoon done, then Zero run once its rank comes; the report passes", async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    fixture: { kind: "bitnode", n: 6, sourceFiles: SOURCE_FILES },
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setHomeRam(128);
      await game.simulation.diagnostics.joinFactionWithReputation("CyberSec", 0);
      await game.simulation.diagnostics.gainCombatExp(skillExpFor(1000, 1.28) + 1);
      await ownerRunsOnHome(
        game,
        "export async function main(ns) { if (!ns.bladeburner.joinBladeburnerDivision()) throw new Error('no join'); }",
      );
      await game.simulation.diagnostics.setBladeburnerRank(TYPHOON.rank);
      await withoutSimEffectors(game);
    },
  });
  const reading = () => (fresh.medium() as MediumSnapshotData | null)?.bladeburner;
  await fresh.game.runUntil(() => reading()?.blackOp !== undefined, 2 * MINUTE);
  const startedAtMs = fresh.game.clock.now();
  // #408's hindcasts' starts: this reading (Typhoon's rank met), and the first at Zero's rank less 100.
  const startMedium = fresh.medium() as MediumSnapshotData | null;
  let zeroMedium: MediumSnapshotData | null = null;
  let zeroFromMs: number | null = null;
  expect(reading()?.blackOp?.name).toBe(TYPHOON.name);
  console.log(fresh.controller().bladeburnerView().line);
  const events: string[] = [];
  const note = (what: string) => {
    const line = `${((fresh.game.clock.now() - startedAtMs) / MINUTE).toFixed(1)} min: ${what}`;
    events.push(line);
    console.log(line);
  };
  let typhoonDoneAtMs: number | null = null;
  let zeroSentAtMs: number | null = null;
  let zeroRankAtMs: number | null = null;
  let sent = 0;
  let waited = 0;
  let lastNext = TYPHOON.name;
  for (let at = 0; at < HOUR; at += READING_MS) {
    await fresh.game.run(READING_MS);
    const read = reading();
    const view = fresh.controller().bladeburnerView();
    const actions = view.actions;
    const rank = read?.rank ?? 0;
    const next = read?.blackOp;
    if (next != null && next.name !== lastNext) {
      note(`${lastNext} done (rank ${rank.toFixed(1)}); the next ${next.name}`);
      if (lastNext === TYPHOON.name) {
        typhoonDoneAtMs = fresh.game.clock.now();
        // Zero's rank near, by a harness edit: the rule's own work brings it.
        await fresh.simulation.diagnostics.setBladeburnerRank(ZERO.rank - 100);
        note(`the rank set to ${ZERO.rank - 100}`);
      }
      lastNext = next.name;
    }
    if (zeroMedium === null && typhoonDoneAtMs !== null && next?.name === ZERO.name && rank >= ZERO.rank - 101) {
      zeroMedium = fresh.medium() as MediumSnapshotData | null;
      zeroFromMs = fresh.game.clock.now();
    }
    if (actions == null) continue;
    // The target: the next one's rank, under it.
    const nextOp = next == null ? null : BLADEBURNER_BLACK_OPS.find((op) => op.name === next.name);
    if (nextOp != null && rank < nextOp.rank && actions.blackOp?.order == null) {
      expect(actions.plan.toTarget?.target, `the target at ${rank}`).toBe(nextOp.rank);
    }
    if (nextOp?.name === ZERO.name && rank >= ZERO.rank && zeroRankAtMs === null) {
      zeroRankAtMs = fresh.game.clock.now();
      note(`Zero's rank met (${rank.toFixed(1)})`);
    }
    if (actions.order.type === BLACK_OPERATIONS) {
      // Only the next in order, with its rank met, the check running it at a rested stamina; or under way, kept.
      expect(actions.order.name, "only the next").toBe(next?.name);
      const blackOp = actions.blackOp;
      expect(blackOp, "its check").not.toBeNull();
      if (blackOp?.order === "run") {
        expect(blackOp.check).toMatchObject({ met: true, run: true });
        expect(rank).toBeGreaterThanOrEqual(nextOp?.rank ?? Number.POSITIVE_INFINITY);
        expect(actions.resting).toBe(false);
        sent += 1;
        if (nextOp?.name === ZERO.name && zeroSentAtMs === null) {
          zeroSentAtMs = fresh.game.clock.now();
          note(`Zero sent: ${view.line.slice(view.line.indexOf("next Black Op"))}`);
        }
      } else {
        expect(blackOp?.order).toBe("kept");
        expect(read?.current?.name).toBe(actions.order.name);
      }
      // A5's faction work held for it, as for any action.
      expect(fresh.controller().factionsView()).toMatchObject({ sent: false, waitingFor: BLADEBURNER_ACTIONS_HOLD });
      expect(fresh.controller().workView().desired).toBeNull();
    } else if (actions.blackOp?.check.met === true && actions.blackOp.check.run === false) {
      waited += 1;
      if (waited === 1) note(`waiting: ${view.line.slice(view.line.indexOf("next Black Op"))}`);
    }
  }
  console.log(`${sent} readings sending a Black Op; ${waited} at its rank waiting (the look-ahead)`);
  // #408's hindcasts: Typhoon done from its rank, and Zero's rank from 100 under it, against the grown estimate.
  const typhoonHindcast = grownHindcast(
    "B5's Typhoon",
    startMedium,
    (typhoonDoneAtMs ?? Number.NaN) - startedAtMs,
    "next done",
    await attemptsIn(fresh.simulation, startedAtMs, typhoonDoneAtMs ?? Number.NaN),
  );
  const zeroHindcast = grownHindcast(
    "B5's climb to Zero",
    zeroMedium,
    (zeroRankAtMs ?? Number.NaN) - (zeroFromMs ?? Number.NaN),
    ZERO.rank,
    await attemptsIn(fresh.simulation, zeroFromMs ?? Number.NaN, zeroRankAtMs ?? Number.NaN),
  );
  console.log(`${typhoonHindcast.line}\n${zeroHindcast.line}`);
  expectGrownHindcast(typhoonHindcast);
  expectGrownHindcast(zeroHindcast);
  // Typhoon done; Zero sent once its rank came, within the readings' cadence.
  expect(typhoonDoneAtMs).not.toBeNull();
  expect(zeroRankAtMs).not.toBeNull();
  expect(zeroSentAtMs).not.toBeNull();
  expect((zeroSentAtMs ?? 0) - (zeroRankAtMs ?? 0)).toBeLessThanOrEqual(2 * READING_MS);
  expect(fresh.game.clock.now() - startedAtMs).toBeGreaterThanOrEqual(HOUR);

  const window = { environment: "E1", sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() } as const;
  const started = Date.now();
  const { text, failures } = runReport(fresh.data.store, window, { verbose: true });
  console.log(`the report: ${Date.now() - started} ms`);
  const section = text.slice(text.indexOf("8. Bladeburner"), text.indexOf("Verdict"));
  console.log(section);
  expect(section).toContain(`  the Black Ops (#392): 0 done before the window; in it, ${TYPHOON.name} `);
  expect(section).toContain("    the ETA to ");
  // No Black Op started on a state that outlived it (one under way asks no action).
  expect(section).not.toContain("the game didn't start Operation");
  expect(section).toContain(
    "  a Black Op due (its rank met, the check running it) with work under way instead, past 22 s:\n    none",
  );
  expect(failures).toEqual([]);
}, 240_000);
