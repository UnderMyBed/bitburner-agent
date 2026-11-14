// #408's hindcast: the route's grown estimate from a suite's first reading against the rank the suite measured over its
// game time (B2-B6's BN6 simulator suites, and since #411 B8's BN7 two at its multipliers). The estimate's time to a
// rank under the next Black Op's is the least of its growth's tail (the path, linear between its steps) and B5's stock
// (the least expected time to it, core's `chooseBladeburnerAction` under that target, priced as the estimate prices the
// actions since #411: at the true population recovered from the Black Op's range read), as the estimate takes the next one's rank; to the
// next one done, that and its attempts. Decision 68's tolerance is ×2. #409's review: each
// suite asserts its row's side of ×2 against `GROWN_HINDCASTS` (`expectGrownHindcast`), and bladeburner-route.test.ts
// asserts their share, in one place.
// - **Two measures** (#411, the coordinator's ruling on #411): the realised (the rank the suite's seeded draws gave) and
//   the expected given the actions taken, the share's. The grown estimate is one of the mean, and an hour's realised
//   rank is one draw of a lottery where Raid's rare successes rule (B4's and BN7's B2's). The expected takes each of the
//   window's attempts (the simulator's `bladeburnerAttempts`: the chance the game drew against, at that attempt's
//   state, and its mean rank on a success and on a failure, `Bladeburner/Formulas.ts:9-44`) at its expectation in place
//   of its draw: p × gain − (1 − p) × E[min(U × loss, the rank before)], U uniform on [0.9, 1.1] (`addOffset`'s ±10%,
//   the floor at 0, `Bladeburner.ts:1271-1274`). Everything else in the window (Field Analysis's fixed rank) stands.
//   - **To a rank:** the estimate's time to the rank read plus the expected rise, against the same window.
//   - **To the next Black Op done:** the window's time per expected success of its attempts, the window over Σp (by
//     Wald's identity the attempts to a first success have Σp's mean 1). Left out, labelled: the luck of the failures'
//     rebuilds in the window (their rank's is in the expected rise of no row here).
import {
  BLACK_OPERATIONS,
  blackOpsRouteGrownEstimate,
  bladeburnerPricedInput,
  chooseBladeburnerAction,
  type MediumSnapshotData,
} from "@bitburner-agent/core";
import type { BladeburnerAttempt, Simulation } from "@bitburner-agent/sim";
import { expect } from "vitest";
import { blackOpsInstallFiguresOf } from "../../src/bladeburner-route.ts";

const HOUR = 3_600_000;

/**
 * Decision 68's share when it was set (docs/decisions/owner-decisions.md, row 68, 2026-11-12): 31 of 38 measured rows
 * of the campaign report within ×2 of the actual remaining time.
 */
export const DECISION_68_SHARE = { within: 31, of: 38 } as const;

/** Within decision 68's ×2: the estimate between half and twice the measured. */
export function withinTwice(ratio: number): boolean {
  return ratio >= 0.5 && ratio <= 2;
}

/** A hindcast's row: its seeded ratios, realised and expected (#411), each one's side of ×2, and why where out. */
export interface GrownHindcastRow {
  ratio: number;
  within: boolean;
  expected: number;
  expectedWithin: boolean;
  why?: string;
}

/**
 * Every BN6 and BN7 suite's hindcast (#408, #411), by its label: its seeded ratios and their sides of ×2. Each suite
 * asserts its own sides (`expectGrownHindcast`), so the share asserted from this table is the suites'.
 */
export const GROWN_HINDCASTS: Readonly<Record<string, GrownHindcastRow>> = {
  "B2's hour from a harness join": {
    ratio: 0.49,
    within: false,
    expected: 2.64,
    expectedWithin: false,
    why:
      "realised: no Raid success in 23 attempts at rank 0; expected out: those attempts' chances give 71.6 rank against " +
      "5.1 realised, in jumps of 55 at rank 0 where a failure loses none, so the expected rank in the window is a " +
      "lottery's mean and the estimate's first-passage time to it is long against the fixed window (#411's diagnosis)",
  },
  "B3's hour at rank 150": { ratio: 1.07, within: true, expected: 0.93, expectedWithin: true },
  "B4's hour, its chaos edited": {
    ratio: 2.38,
    within: false,
    expected: 0.95,
    expectedWithin: true,
    why: "realised: one Raid success in 12 attempts gave 54 of its 68 rank (σ 35, section 8's own line)",
  },
  "B5's Typhoon": {
    ratio: 2.02,
    within: false,
    expected: 0.98,
    expectedWithin: true,
    why: "realised: Typhoon done at its first attempt, its chance 0.48",
  },
  "B5's climb to Zero": { ratio: 1.17, within: true, expected: 1.16, expectedWithin: true },
  "B6's Daedalus": { ratio: 0.96, within: true, expected: 0.96, expectedWithin: true },
  // BN7's (#411): the same suites at BN7's multipliers.
  "B2's hour from a harness join, BN7": {
    ratio: 2.93,
    within: false,
    expected: 1.67,
    expectedWithin: true,
    why: "realised: two Raid successes in 15 attempts gave 36 of its 44 rank (σ 22, section 8's own line)",
  },
  "B6's Daedalus, BN7": { ratio: 0.95, within: true, expected: 0.95, expectedWithin: true },
};

/** A hindcast's figures: the measured game ms, the estimate's (and its two parts'), their ratios, and its line. */
export interface GrownHindcast {
  measuredMs: number;
  estimateMs: number;
  tailMs: number;
  stockMs: number | null;
  ratio: number;
  /** The expected measure's ratio (#411). */
  expected: number;
  line: string;
}

/** The game seconds the path reaches `rank` at, linear between its steps; Infinity past its end. */
function pathSecondsTo(path: readonly { rank: number; seconds: number }[], rank: number): number {
  for (let index = 1; index < path.length; index++) {
    const before = path[index - 1] as { rank: number; seconds: number };
    const after = path[index] as { rank: number; seconds: number };
    if (after.rank >= rank) {
      const share = after.rank > before.rank ? (rank - before.rank) / (after.rank - before.rank) : 1;
      return before.seconds + Math.max(0, share) * (after.seconds - before.seconds);
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * A failure's expected rank lost (#411): E[min(U × `loss`, `rank`)], U uniform on [0.9, 1.1] (`addOffset`'s ±10%),
 * the rank floored at 0 (`Bladeburner.ts:1271-1274`).
 */
export function expectedLoss(loss: number, rank: number): number {
  if (!(loss > 0) || !(rank > 0)) return 0;
  const low = 0.9 * loss;
  const high = 1.1 * loss;
  if (rank >= high) return loss;
  if (rank <= low) return rank;
  return ((rank * rank - low * low) / 2 + rank * (high - rank)) / (high - low);
}

/** An attempt's expected rank change at its state (#411): p × gain − (1 − p) × the failure's expected loss. */
export function attemptExpectedRank(attempt: BladeburnerAttempt): number {
  return attempt.chance * attempt.gain - (1 - attempt.chance) * expectedLoss(attempt.loss, attempt.rankBefore);
}

/** The window's attempts, those completed after `fromMs` and by `untilMs` (the page's clock, the suites' own). */
export async function attemptsIn(simulation: Simulation, fromMs: number, untilMs: number) {
  const attempts = await simulation.diagnostics.bladeburnerAttempts(0);
  return attempts.filter((attempt) => attempt.atMs > fromMs && attempt.atMs <= untilMs);
}

/** A window's attempts summed (#411): their realised rank, their expected, the Black Ops' chances, and the counts. */
export function attemptsSummary(attempts: readonly BladeburnerAttempt[], blackOp: string | null) {
  let realised = 0;
  let expected = 0;
  let chances = 0;
  let blackOps = 0;
  for (const attempt of attempts) {
    realised += attempt.rankAfter - attempt.rankBefore;
    expected += attemptExpectedRank(attempt);
    if (attempt.type === BLACK_OPERATIONS && attempt.name === blackOp) {
      chances += attempt.chance;
      blackOps += 1;
    }
  }
  return {
    realised,
    expected,
    chances,
    blackOps,
    successes: attempts.filter((attempt) => attempt.success).length,
  };
}

/**
 * The hindcast from `mediumData`'s reading in `bitNode` (BN6's suites; BN7's at its multipliers since #411; `label`
 * names the suite): to rank `to` (under the next Black Op's) where given, else to the next Black Op done; against
 * `measuredMs` of game time, realised, and (#411) expected given the window's `attempts`.
 */
export function grownHindcast(
  label: string,
  mediumData: MediumSnapshotData | null,
  measuredMs: number,
  to: number | "next done",
  attempts: readonly BladeburnerAttempt[],
  bitNode = 6,
): GrownHindcast & { label: string } {
  const route = blackOpsInstallFiguresOf(mediumData, bitNode)?.route;
  if (route == null) throw new Error(`${label}: no route's figures in the reading`);
  const { input, at, combat, growth } = route;
  const grown = blackOpsRouteGrownEstimate(input, at, { combat, ...growth });
  // The estimate's time to a rank: the least of the growth's tail and B5's stock.
  const toRank = (target: number) => {
    const stock =
      target <= at.rank
        ? 0
        : (chooseBladeburnerAction({ ...bladeburnerPricedInput(input, at).input, target: { rank: at.rank, target } })
            .toTarget?.seconds ?? null);
    const tail = target <= at.rank ? 0 : pathSecondsTo(grown.path, target);
    return { stock, tail, seconds: Math.min(tail, stock ?? Number.POSITIVE_INFINITY) };
  };
  const target = to === "next done" ? at.next.rank : to;
  const { stock, tail, seconds } = toRank(target);
  const attemptsSeconds = to === "next done" ? (grown.steps[0]?.attemptsSeconds ?? Number.POSITIVE_INFINITY) : 0;
  const estimate = seconds + attemptsSeconds;
  const measured = measuredMs / 1000;
  const ratio = estimate / measured;
  // The expected measure (#411): the window with each attempt at its expectation.
  const summary = attemptsSummary(attempts, to === "next done" ? at.next.name : null);
  let expected: number;
  let expectedWords: string;
  if (to === "next done") {
    const window = summary.chances > 0 ? measured / summary.chances : Number.POSITIVE_INFINITY;
    expected = estimate / window;
    expectedWords =
      `${summary.blackOps} of its attempts, their chances summing to ${summary.chances.toFixed(3)}: ` +
      `${(window / 3600).toFixed(2)} h an expected success`;
  } else {
    const rank = target - summary.realised + summary.expected;
    expected = toRank(rank).seconds / measured;
    expectedWords =
      `${attempts.length} attempts, ${summary.successes} successes, their rank ${summary.realised.toFixed(2)} ` +
      `realised and ${summary.expected.toFixed(2)} expected: to ${rank.toFixed(1)} in ` +
      `${(toRank(rank).seconds / 3600).toFixed(2)} h`;
  }
  const hours = (value: number | null) => (value === null ? "none" : `${(value / 3600).toFixed(2)} h`);
  const line =
    `#408's hindcast, ${label}: rank ${at.rank.toFixed(0)} to ${to === "next done" ? `${at.next.name} done` : target.toFixed(0)} ` +
    `measured in ${(measuredMs / HOUR).toFixed(2)} h; the grown estimate ${hours(estimate)} (its growth's tail ` +
    `${hours(tail)}, B5's stock ${hours(stock)}${to === "next done" ? `, the attempts ${hours(attemptsSeconds)}` : ""}): ` +
    `×${ratio.toFixed(2)} realised; expected given the actions (${expectedWords}): ×${expected.toFixed(2)}`;
  return {
    label,
    measuredMs,
    estimateMs: estimate * 1000,
    tailMs: tail * 1000,
    stockMs: stock === null ? null : stock * 1000,
    ratio,
    expected,
    line,
  };
}

/**
 * A suite's hindcast on its sides of ×2 as `GROWN_HINDCASTS` has them (#409's review, #411): the realised and the
 * expected, so the share's rows stay the suites'.
 */
export function expectGrownHindcast(hindcast: GrownHindcast & { label: string }): void {
  const row = GROWN_HINDCASTS[hindcast.label];
  expect(row, `${hindcast.label}: not in GROWN_HINDCASTS`).toBeDefined();
  expect(withinTwice(hindcast.ratio), hindcast.line).toBe(row?.within);
  expect(withinTwice(hindcast.expected), hindcast.line).toBe(row?.expectedWithin);
}

/** What `grownHindcastIn` reads of a suite's fresh start: the simulator and the brain's store. */
interface HindcastSource {
  simulation: Simulation;
  data: { store: { snapshots(query: { environment: "E1" }): { tier: string; receivedAtMs: number; data: unknown }[] } };
}

/**
 * The hindcast over a suite's window [`fromMs`, `untilMs`] (#411's ruling 3), from its first reading in the city the
 * window's attempts ran in: a suite's first reading can predate B4's move (Sector-12's range read, the hour in New
 * Tokyo's), and the estimate is the reading's. The window then starts at that reading; no attempt, its first reading.
 */
export async function grownHindcastIn(
  fresh: HindcastSource,
  label: string,
  { fromMs, untilMs }: { fromMs: number; untilMs: number },
  to: number | "next done",
  bitNode = 6,
): Promise<GrownHindcast & { label: string }> {
  const city = (await attemptsIn(fresh.simulation, fromMs, untilMs))[0]?.city;
  const readings = fresh.data.store
    .snapshots({ environment: "E1" })
    .filter((each) => each.tier === "medium" && each.receivedAtMs >= fromMs && each.receivedAtMs <= untilMs)
    .filter((each) => Array.isArray((each.data as { bladeburner?: { actions?: unknown } }).bladeburner?.actions));
  const inCity = readings.find(
    (each) => city !== undefined && (each.data as { bladeburner?: { city?: unknown } }).bladeburner?.city === city,
  );
  const start = inCity ?? readings[0];
  if (start === undefined) throw new Error(`${label}: no reading in the window`);
  const hindcast = grownHindcast(
    label,
    start.data as MediumSnapshotData,
    untilMs - start.receivedAtMs,
    to,
    await attemptsIn(fresh.simulation, start.receivedAtMs, untilMs),
    bitNode,
  );
  const from = `from the reading ${((start.receivedAtMs - fromMs) / 1000).toFixed(0)} s in, in ${city ?? "its city"}`;
  return { ...hindcast, line: `${hindcast.line} (${from})` };
}
