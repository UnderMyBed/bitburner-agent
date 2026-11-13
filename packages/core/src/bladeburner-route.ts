/**
 * Bladeburner (#359), slice B6 (#398): BN6's win route, the 21 Black Ops to the destroy, and the planner's estimates of
 * both routes (decision 67: the rules propose, the planner chooses). Paths are `vendor/bitburner-src/src/`'s (v3.0.1).
 * - **The destroy:** with all 21 done, Singularity's `destroyW0r1dD43m0n` needs no hacking level, root, Red Pill or
 *   Daedalus (`NetscriptFunctions/Singularity.ts:1176-1183`), nor does the Black Ops page's button
 *   (`Bladeburner/ui/BlackOpPage.tsx:39-52`). Core's `worldDaemonProblem` takes the count (./bitnodes.ts).
 * - **The Black Ops' route's time** (`blackOpsRouteSeconds`), the expected game seconds from the rank now to the last
 *   Black Op done, summed over those left in order. Each Black Op k at rank Rₖ, chance pₖ, attempt seconds Tₖ, a
 *   success's rank Gₖ and a failure's Lₖ (core's B5 formulas, ./bladeburner-black-ops.ts):
 *   - the time to its rank: the next one's is B5's least expected time to it (#386's stock phase and #392's tail, the
 *     rule's `toTarget`); each later one's, from the rank its predecessor left (max(rank, Rₖ₋₁) + Gₖ₋₁, a success's
 *     mean), the tail alone: (Rₖ − that) over the sustainable rate ρ (Wald's identity: a far target's expected
 *     first-passage time is its distance over the drift, as #392's decision has it);
 *   - its attempts: (Tₖ + (1 − pₖ) · Lₖ/ρ) / pₖ, B5's expected time to it done (`blackOpSecondsToDone`: the attempts
 *     geometric, each failure's loss rebuilt at ρ).
 * - **Its chances:** the next one's the estimate's low end read (B5's, the stamina's penalty out), the later ones' the
 *   game's formula at the competence now (`blackOpSuccessChance`, rested: no penalty) times the next one's low end over
 *   its formula (the city's population estimate's share, common to every Black Op, `Actions/BlackOperation.ts:55-61`).
 * - **Left out, and labelled:** the competence's rise over the route (the skill points a rank of 3 brings, the stats and
 *   the augmentations: B7's, the planner's), so later chances and ρ err low and the time long, cautious; at a chance of 0
 *   now the time is never, "never at the competence now". The stock's counts after the next one (their regrowth is in ρ,
 *   their stock now isn't): cautious. The rank over each requirement at a failure (the rebuild errs long). The ±10% on
 *   each rank (its mean). The stamina a Black Op costs and its rests, and HP (B2's, the planner's). The bonus time's ×5
 *   (game seconds, so cautious in real time). The destroy's own minute or two through the gate.
 * - **The Red Pill's route** in BN6 (`redPillLevelSeconds`): its hacking level alone, by the formulas, is a lower bound:
 *   w0r1d_d43m0n's 3,000 × `WorldDaemonDifficulty` (6,000 in BN6) at the level multiplier the level and experience imply
 *   now (`PersonObjects/formulas/skill.ts:7-27`, with BN6's 0.35 in it), the experience still needed over the measured
 *   rate. Daedalus's 35 augmentations and The Red Pill's reputation are left out: at least.
 * - **The planner's choice** (`chooseWinRoute`): the route with the least estimate, the Red Pill's only where it isn't
 *   hopeless, decision 67's point 8's bar (the run report's for levelling): past the BitNode's time so far, the whole
 *   path to here, a last step longer than all of it is hopeless (#359: about 10^22 times BN4.1's experience at a
 *   multiplier of 5). Without both figures the rules' offer stands, the Black Ops (#359).
 */
import { hackingExpForLevel } from "./augmentation-plan.ts";
import type { WinRoute } from "./bitnodes.ts";
import {
  type BladeburnerActionInput,
  bladeburnerTailRate,
  chooseBladeburnerAction,
  staminaPenalty,
} from "./bladeburner-actions.ts";
import {
  BLADEBURNER_BLACK_OPS,
  type BladeburnerBlackOp,
  blackOpChanceLow,
  blackOpRankGain,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpSuccessChance,
} from "./bladeburner-black-ops.ts";
import { bladeburnerSkillMultsOf } from "./bladeburner-skills.ts";

/** A Black Op as the route's time takes it: its rank, chance, attempt seconds, and a success's and failure's rank. */
export interface BlackOpsRouteOp {
  name: string;
  rank: number;
  chance: number;
  seconds: number;
  gain: number;
  loss: number;
}

/** One Black Op's part of the route's time: the time to its rank, a failure's rebuild, and its attempts' time. */
export interface BlackOpsRouteStep extends BlackOpsRouteOp {
  toRankSeconds: number;
  rebuildSeconds: number;
  attemptsSeconds: number;
}

/** The route's time (#398): each Black Op's part, their sum in game seconds (Infinity: never), and the rate ρ. */
export interface BlackOpsRouteTime {
  steps: BlackOpsRouteStep[];
  seconds: number;
  rate: number;
}

/**
 * The expected time to a Black Op done at its chance, its failures rebuilt at `rebuild` seconds each: B5's (T + (1 −
 * p) · rebuild) / p (`blackOpSecondsToDone`), T alone at a chance of 1, Infinity at 0.
 */
function attemptsSecondsOf(chance: number, seconds: number, rebuild: number): number {
  if (!(chance > 0)) return Number.POSITIVE_INFINITY;
  if (chance >= 1) return seconds;
  return (seconds + (1 - chance) * rebuild) / chance;
}

/**
 * The route's time (#398, see above): from `rank`, the Black Ops `ops` in order, the first's time to its rank
 * `firstToRankSeconds` (B5's stock and tail; null: the tail's too), each later one's (its rank less the rank its
 * predecessor left) over `rate`, plus each one's attempts, every failure's loss rebuilt at `rate`. Pure arithmetic, so
 * a seeded walk checks it (`bladeburner-route.test.ts`).
 */
export function blackOpsRouteSeconds({
  rank,
  rate,
  firstToRankSeconds,
  ops,
}: {
  rank: number;
  rate: number;
  firstToRankSeconds: number | null;
  ops: readonly BlackOpsRouteOp[];
}): BlackOpsRouteTime {
  const tail = (distance: number) => (distance <= 0 ? 0 : rate > 0 ? distance / rate : Number.POSITIVE_INFINITY);
  let at = rank;
  let seconds = 0;
  const steps = ops.map((op, index): BlackOpsRouteStep => {
    const toRankSeconds =
      at >= op.rank ? 0 : index === 0 && firstToRankSeconds !== null ? firstToRankSeconds : tail(op.rank - at);
    const rebuildSeconds = tail(op.loss);
    const attemptsSeconds = attemptsSecondsOf(op.chance, op.seconds, rebuildSeconds);
    seconds += toRankSeconds + attemptsSeconds;
    // A success's mean from its rank (a failure's loss is rebuilt to it first).
    at = Math.max(at, op.rank) + op.gain;
    return { ...op, toRankSeconds, rebuildSeconds, attemptsSeconds };
  });
  return { steps, seconds, rate };
}

/**
 * The Black Ops' route from a reading (#398): the next Black Op `next` and those after it, at `input`'s competence
 * (the forecast's, its skills read), the next one's chance its low end as `chanceRead` gives it. `firstToRankSeconds`:
 * the rule's time to the next one's rank where it has it (its plan's `toTarget`), else solved here.
 */
export function blackOpsRouteEstimate(
  input: Omit<BladeburnerActionInput, "target">,
  {
    rank,
    next,
    chanceRead,
    firstToRankSeconds,
  }: {
    rank: number;
    next: BladeburnerBlackOp;
    chanceRead: readonly [number, number];
    firstToRankSeconds?: number | null;
  },
): BlackOpsRouteTime {
  const mults = bladeburnerSkillMultsOf(input.skills?.read ?? {});
  const penalty = input.maxStamina > 0 ? staminaPenalty(input.stamina, input.maxStamina) : 0;
  const nextLow = blackOpChanceLow(chanceRead, penalty);
  const formula = (op: BladeburnerBlackOp) => blackOpSuccessChance(op, input.person, { penalty: 1, skills: mults });
  const nextFormula = formula(next);
  // The low end's share of the formula's (pop/popEst at the low end): common to every Black Op; 1 where unknown.
  const share = nextLow !== null && nextFormula > 0 && nextFormula < 1 ? Math.min(1, nextLow / nextFormula) : 1;
  const left = BLADEBURNER_BLACK_OPS.slice(BLADEBURNER_BLACK_OPS.findIndex((op) => op.name === next.name));
  const ops = left.map((op) => ({
    name: op.name,
    rank: op.rank,
    chance: op.name === next.name ? (nextLow ?? nextFormula) : Math.min(1, share * formula(op)),
    seconds: blackOpSeconds(op, input.person, mults),
    gain: blackOpRankGain(op, input.rankMultiplier),
    loss: blackOpRankLoss(op),
  }));
  const toRank =
    firstToRankSeconds ??
    (rank >= next.rank
      ? 0
      : (chooseBladeburnerAction({ ...input, target: { rank, target: next.rank } }).toTarget?.seconds ?? null));
  return blackOpsRouteSeconds({ rank, rate: bladeburnerTailRate(input), firstToRankSeconds: toRank, ops });
}

/**
 * The Red Pill's route's hacking level by the formulas (#398): the game seconds from `exp` at `level` to
 * `requiredLevel`'s experience at the multiplier the two imply (`PersonObjects/formulas/skill.ts:7-27`), at
 * `expPerSecond`; 0 once reached, Infinity past the experience a double holds; null unmeasured.
 */
export function redPillLevelSeconds({
  level,
  exp,
  requiredLevel,
  expPerSecond,
}: {
  level: number;
  exp: number;
  requiredLevel: number;
  expPerSecond: number | null;
}): number | null {
  if (level >= requiredLevel) return 0;
  const base = 32 * Math.log(exp + 534.6) - 200;
  if (expPerSecond === null || !(expPerSecond > 0) || !(base > 0) || !(level > 0)) return null;
  return Math.max(0, hackingExpForLevel(requiredLevel, level / base) - exp) / expPerSecond;
}

/** The planner's choice of route (#398): the route, and whether The Red Pill's estimate is hopeless, with why. */
export interface WinRouteChoice {
  route: WinRoute;
  /** The Red Pill's estimate past the bar (or never); null where it isn't measured. */
  redPillHopeless: boolean | null;
  why: string;
}

/**
 * The planner's choice between the routes (#398, decision 67): the least estimate, The Red Pill's only where it's
 * measured and not hopeless (past `soFarSeconds`, the BitNode's time so far: decision 67's point 8's bar). Without both
 * estimates the rules' offer stands, the Black Ops (#359). Seconds each; null unmeasured, Infinity never.
 */
export function chooseWinRoute({
  blackOpsSeconds,
  redPillSeconds,
  soFarSeconds,
}: {
  blackOpsSeconds: number | null;
  redPillSeconds: number | null;
  soFarSeconds: number | null;
}): WinRouteChoice {
  if (redPillSeconds === null) {
    return { route: "blackOps", redPillHopeless: null, why: "The Red Pill's not measured: the rules' offer stands" };
  }
  if (!Number.isFinite(redPillSeconds) || (soFarSeconds !== null && redPillSeconds > soFarSeconds)) {
    return {
      route: "blackOps",
      redPillHopeless: true,
      why: "The Red Pill's hopeless by the formulas, past the BitNode's time so far (decision 67's point 8, #359)",
    };
  }
  if (blackOpsSeconds !== null && !(redPillSeconds < blackOpsSeconds)) {
    return { route: "blackOps", redPillHopeless: false, why: "the Black Ops' the shorter" };
  }
  return {
    route: "redPill",
    redPillHopeless: false,
    why:
      blackOpsSeconds === null
        ? "The Red Pill's not hopeless, the Black Ops' not estimated"
        : "The Red Pill's the shorter",
  };
}
