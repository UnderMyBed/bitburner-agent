// BN6's win route (#398, Bladeburner's B6 of #359): the Black Ops to the destroy, as the World Daemon's path shows it
// (./world-daemon.ts), from the medium snapshot's Bladeburner reading. Core has the formulas
// (../../core/src/bladeburner-route.ts); paths are `vendor/bitburner-src/src/`'s.
// - **Where it stands:** the rank against Operation Daedalus's 400,000, the last (`data/BlackOperations.ts:704-735`),
//   the Black Ops done (the next one's place in the 21; none next once all are, `NetscriptFunctions/Bladeburner.ts:
//   88-96`), the next one's rank and its chance's low end read (B5's, the stamina's penalty out), and the ETA to
//   400,000 at the rank a second measured over the readings.
// - **The planner's estimates** (decision 67): the Black Ops' (core's `blackOpsRouteEstimate`: the next one's rank by
//   B5's stock and tail, the Bladeburner rule's own time where it has it; each later one's at the sustainable rate; each
//   one's attempts) and The Red Pill's (core's `redPillLevelSeconds`: w0r1d_d43m0n's hacking level alone at the
//   measured experience rate, at least), and the choice between them (core's `chooseWinRoute`, The Red Pill's hopeless
//   past the BitNode's time so far).
// - **The stall bounds** (decision 45, #400's review), keyed by where the rank is:
//   - **The climb** (under the next Black Op's rank: none attempted, contracts' failures in B2's own bound): the rank
//     must rise by `climbRise` within `climbWindowMs`. The window is `rankStallMs`, twice the longest the rule's
//     cycle holds the rank flat (a rest from ½ max stamina at the natural regain alone, the slowest rest; the next
//     Black Op's attempt; its failure's loss rebuilt at the sustainable rate) and `BLADEBURNER_REST_SLACK_MS`, as B2's
//     stuck resting is bounded. The rise is a lower bound at a false failure's chance α `BLADEBURNER_RANK_ALPHA` (0.001,
//     B2's): the sustainable rate's rise over the window, less Bernstein's margin for the plan's attempts there (core's
//     `climbRiseLowerBound`: each attempt at most its mean and a failure's loss at 110% under its mean, B2's, with its
//     variance; Freedman's inequality for the attempts as they come, as B2's and B5's `stockInClosedForm`), floored at
//     0. Where it's 0 at `rankStallMs` (a plan too lumpy for that window), the window is the smallest longer one where
//     it's positive (core's `climbWindowSeconds`), said in the stall. So a flat rank and a crawl are loud, and a run at
//     the rate with its ordinary failures isn't, but at chance α a window: over K windows the false failures add up to
//     about K·α (a union bound; a time-uniform bound would hold α over all of them), stated, not bounded. The mean is
//     min(ρ, the plan's own rate); a plan resting alone (the counts spent) has no attempts to bound, so its readings
//     aren't judged. The plan is the Bladeburner rule's (its view's), else
//     its forecast's best. The rate 0, the rebuild is left out and any rise counts: a dead route is loud. Judged from the
//     faction's 25 (under it the plan can be #386's lottery: B2's bound judges the rank there).
//   - **The attempts** (the next one's rank met): the Black Ops done must rise within `attemptsStallMs`, N attempts
//     each with a failure's rebuild at the sustainable rate and its own stamina regained (min(cost, max) at the natural
//     regain), a rest to the max, and the slack: N = ⌈ln α / ln(1 − p)⌉,
//     the attempts by which a success is all but sure at the low end's chance p, α `BLADEBURNER_RANK_ALPHA` (0.001, a
//     false failure's chance, B2's). So a Black Op stuck failing (each rebuild a rise) is loud. None at a chance of 0
//     (#360's estimate is never then, a failure of its own).
import {
  actionRankLoss,
  BLACK_OPS_COUNT,
  BLADEBURNER_BLACK_OPS,
  type BlackOpsRouteAt,
  type BlackOpsRouteTime,
  type BladeburnerActionInput,
  type BladeburnerActionPlan,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpStaminaCost,
  blackOpsRouteEstimate,
  bladeburnerBlackOp,
  bladeburnerLevelledAction,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  bladeburnerSkillMultsOf,
  type ClimbAttempts,
  type CombatPerson,
  chooseBladeburnerAction,
  chooseWinRoute,
  climbRiseLowerBound,
  climbWindowSeconds,
  combatPersonOf,
  type MediumSnapshotData,
  redPillLevelSeconds,
  staminaGainPerSecond,
  type WinRouteChoice,
  winRouteOf,
  worldDaemonRequiredLevel,
} from "@bitburner-agent/core";
import { bladeburnerSnapshotOf, bladeburnerSpeedOf } from "./bladeburner.ts";
import { BLADEBURNER_RANK_ALPHA, BLADEBURNER_REST_SLACK_MS } from "./bladeburner-actions-report.ts";

/** The last Black Op's rank: Operation Daedalus's 400,000 (`data/BlackOperations.ts:704-735`). */
export const BLACK_OPS_LAST_RANK = (BLADEBURNER_BLACK_OPS.at(-1) as { rank: number }).rank;

/** The Black Ops' route as the path shows it (#398): each part null where the reading doesn't say. */
export interface BlackOpsRouteView {
  /** The rank read, or null (no reading in the division yet). */
  rank: number | null;
  /** The Black Ops done, or null unread (no reading with the next one). */
  done: number | null;
  /** The next one, its rank and its chance's low end read (null at stamina 0); null with all done or unread. */
  next: { name: string; rank: number; chance: number | null } | null;
  /** The rank measured a second over the readings, and the ETA to the last one's rank at it; null unmeasured. */
  rankPerSecond: number | null;
  etaSeconds: number | null;
  /** The planner's estimate of the Black Ops' route, game seconds (core's); null unread. */
  estimate: BlackOpsRouteTime | null;
  /** The Red Pill's hacking level by the formulas, at least, game seconds; Infinity never; null unmeasured. */
  redPillSeconds: number | null;
  /** The planner's choice between them (core's `chooseWinRoute`). */
  choice: WinRouteChoice;
  /** The climb's base window (#400's review): twice a rest, an attempt and a rebuild, and the slack, ms; null unread. */
  rankStallMs: number | null;
  /** The climb's window: `rankStallMs`, or the smallest longer one where `climbRise` is positive; ms. */
  climbWindowMs: number | null;
  /** The climb's least rise within `climbWindowMs` at α 0.001 (Bernstein's lower bound; 0: any rise). */
  climbRise: number | null;
  /** The attempts' bound (#400's review): how long the Black Ops done may stand at the next one's rank, ms; null none. */
  attemptsStallMs: number | null;
}

/** The Black Ops done from a reading's next one: 21 with none next, its place in the 21 otherwise, null unread. */
export function blackOpsDoneOf(next: { name: string } | null | undefined): number | null {
  if (next === undefined) return null;
  if (next === null) return BLACK_OPS_COUNT;
  const index = BLADEBURNER_BLACK_OPS.findIndex((op) => op.name === next.name);
  return index < 0 ? null : index;
}

/** The Black Ops done, from a medium snapshot's Bladeburner reading (the gate's, #398); null unread. */
export function blackOpsDoneIn(mediumData: unknown): number | null {
  const { reading } = bladeburnerSnapshotOf(mediumData);
  return reading.kind === "read" ? blackOpsDoneOf(reading.actions?.blackOp) : null;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The route from the medium snapshot (#398): `rankPerSecond` the rank measured, `expPerSecond` the hacking experience
 * measured (The Red Pill's), `soFarMs` the BitNode's game time so far (the hopeless bar), `firstToRankSeconds` the
 * Bladeburner rule's time to the next one's rank where it has it (its plan's `toTarget`), null the tail alone (the
 * controller's while the rule's target is another, the faction's 25), absent core solves it (the run report's).
 */
export function blackOpsRouteOf({
  mediumData,
  bitNode,
  ownedSF,
  rankPerSecond,
  expPerSecond,
  soFarMs,
  firstToRankSeconds,
  plan,
}: {
  /** The Bladeburner rule's plan (its view's), for the climb's bound; absent, the forecast's best by rank a second. */
  plan?: BladeburnerActionPlan | null;
  mediumData: MediumSnapshotData | null;
  bitNode: number;
  ownedSF: Readonly<Record<string, number>>;
  rankPerSecond: number | null;
  expPerSecond: number | null;
  soFarMs: number | null;
  firstToRankSeconds?: number | null;
}): BlackOpsRouteView {
  const player = mediumData?.player as { skills?: { hacking?: unknown }; exp?: { hacking?: unknown } } | undefined;
  const level = player?.skills?.hacking;
  const exp = player?.exp?.hacking;
  const redPillSeconds =
    isFiniteNumber(level) && isFiniteNumber(exp)
      ? redPillLevelSeconds({ level, exp, requiredLevel: worldDaemonRequiredLevel(bitNode, ownedSF), expPerSecond })
      : null;
  const { reading } = bladeburnerSnapshotOf(mediumData);
  const read = reading.kind === "read" ? reading : null;
  const rank = read?.rank ?? null;
  const actions = read?.actions ?? null;
  const done = blackOpsDoneOf(actions?.blackOp);
  const nextRead = actions?.blackOp ?? null;
  const op = nextRead === null ? null : bladeburnerBlackOp(nextRead.name);
  const person = mediumData === null ? null : bladeburnerPersonOf(mediumData.player);
  const rankMultiplier = bladeburnerRankMultiplierOf(bitNode);
  const input: Omit<BladeburnerActionInput, "target"> | null =
    actions === null || person === null || rankMultiplier === null
      ? null
      : {
          readings: actions.actions,
          person,
          stamina: actions.stamina,
          maxStamina: actions.maxStamina,
          rankMultiplier,
          speed: bladeburnerSpeedOf(actions.bonusSeconds),
          skills: { read: actions.skills?.levels ?? {} },
        };
  const estimate: BlackOpsRouteTime | null =
    done === BLACK_OPS_COUNT
      ? { steps: [], seconds: 0, rate: 0 }
      : input === null || op === null || nextRead === null || rank === null
        ? null
        : blackOpsRouteEstimate(input, { rank, next: op, chanceRead: nextRead.chance, firstToRankSeconds });
  const first = estimate?.steps[0];
  let rankStallMs: number | null = null;
  let climbRise: number | null = null;
  let climbWindowMs: number | null = null;
  let attemptsStallMs: number | null = null;
  if (input !== null && op !== null && actions !== null) {
    const mults = bladeburnerSkillMultsOf(input.skills?.read ?? {});
    const regain = staminaGainPerSecond(input.person, actions.maxStamina, mults);
    const rest = regain > 0 ? actions.maxStamina / 2 / regain : 0;
    const rate = estimate?.rate ?? 0;
    const rebuild = rate > 0 ? blackOpRankLoss(op) / rate : 0;
    const attempt = blackOpSeconds(op, input.person, mults);
    rankStallMs = 2 * (rest + attempt + rebuild) * 1000 + BLADEBURNER_REST_SLACK_MS;
    const climbing = plan ?? chooseBladeburnerAction(input);
    const work = climbing.work;
    // The climb's mean (#400's round 2): the plan's own rate where under ρ (the LP's mix can outrun the one plan run).
    const climbRate = Math.min(rate, climbing.rankPerSecond);
    const action = work === null ? null : bladeburnerLevelledAction(work.type, work.name);
    const attempts: ClimbAttempts =
      work === null || action === null
        ? { perSecond: 0, variance: 0, below: 0 }
        : {
            perSecond: climbing.duty / work.seconds,
            variance: work.rankVariance,
            below: work.rankMean + 1.1 * actionRankLoss(action, work.level),
          };
    if (work === null && rate > 0) {
      // Resting alone (the counts spent, #400's round 2): its rank has no attempts' spread to bound, so the reading isn't
      // judged (null); a rest with no rate at all is the dead route's below.
      climbWindowMs = null;
      climbRise = null;
    } else if (climbRate > 0) {
      const window = climbWindowSeconds(climbRate, rankStallMs / 1000, attempts, BLADEBURNER_RANK_ALPHA);
      climbWindowMs = window * 1000;
      climbRise = Number.isFinite(window)
        ? climbRiseLowerBound(climbRate, window, attempts, BLADEBURNER_RANK_ALPHA)
        : 0;
    } else {
      climbWindowMs = rankStallMs;
      climbRise = 0;
    }
    const chance = first?.chance ?? 0;
    if (chance > 0) {
      const attempts = chance >= 1 ? 1 : Math.ceil(Math.log(BLADEBURNER_RANK_ALPHA) / Math.log(1 - chance));
      // Each attempt's own stamina regained too (#400's round 2): min(its cost, the max) at the natural regain.
      const stamina = regain > 0 ? Math.min(blackOpStaminaCost(op), actions.maxStamina) / regain : 0;
      attemptsStallMs = (attempts * (attempt + rebuild + stamina) + rest) * 1000 + BLADEBURNER_REST_SLACK_MS;
    }
  }
  const soFarSeconds = soFarMs === null ? null : soFarMs / 1000;
  return {
    rank,
    done,
    next: op === null ? null : { name: op.name, rank: op.rank, chance: first?.chance ?? null },
    rankPerSecond,
    etaSeconds:
      rank === null || rankPerSecond === null || !(rankPerSecond > 0)
        ? null
        : Math.max(0, BLACK_OPS_LAST_RANK - rank) / rankPerSecond,
    estimate,
    redPillSeconds,
    choice: chooseWinRoute({ blackOpsSeconds: estimate?.seconds ?? null, redPillSeconds, soFarSeconds }),
    rankStallMs,
    climbWindowMs,
    climbRise,
    attemptsStallMs,
  };
}

/**
 * What A6's install timing on the route reads (#404): B6's estimate's inputs from the medium snapshot (the actions read,
 * the person, the stamina, the skills), the next Black Op and its chance read, and the combat figures (each stat's
 * level, experience and multipliers) for the rebuild. `route` null where the reading doesn't give them: unread, no
 * Black Op next (all 21 done: the destroy, no install), or the player's figures not in the snapshot.
 */
export interface BlackOpsInstallFigures {
  route: {
    input: Omit<BladeburnerActionInput, "target">;
    at: BlackOpsRouteAt;
    combat: CombatPerson;
  } | null;
}

/**
 * A6's figures on the Black Ops' route (#404), in the division only (`inBladeburner`): null outside it (before the join
 * an install loses the training to join, B1's, as before #404), or off the route (core's `winRouteOf`).
 */
export function blackOpsInstallFiguresOf(
  mediumData: MediumSnapshotData | null,
  bitNode: number,
): BlackOpsInstallFigures | null {
  const rankMultiplier = bladeburnerRankMultiplierOf(bitNode);
  if (winRouteOf(bitNode) !== "blackOps" || rankMultiplier === null) return null;
  const { joined, reading } = bladeburnerSnapshotOf(mediumData);
  if (joined !== true) return null;
  const actions = reading.kind === "read" ? reading.actions : null;
  const rank = reading.kind === "read" ? reading.rank : null;
  const nextRead = actions?.blackOp ?? null;
  const next = nextRead === null ? null : bladeburnerBlackOp(nextRead.name);
  const person = mediumData === null ? null : bladeburnerPersonOf(mediumData.player);
  const combat = mediumData === null ? null : combatPersonOf(mediumData.player);
  if (actions === null || rank === null || nextRead === null || next === null || person === null || combat === null) {
    return { route: null };
  }
  return {
    route: {
      input: {
        readings: actions.actions,
        person,
        stamina: actions.stamina,
        maxStamina: actions.maxStamina,
        rankMultiplier,
        speed: bladeburnerSpeedOf(actions.bonusSeconds),
        skills: { read: actions.skills?.levels ?? {} },
      },
      at: { rank, next, chanceRead: nextRead.chance },
      combat,
    },
  };
}
