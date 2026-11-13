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
// - **The rank's stall bound** (decision 45): the rank's high not passed for longer than twice the longest the rule's
//   own cycle holds it flat, a rest from ½ max stamina to the max at the natural regain alone (the slowest rest), the
//   next Black Op's attempt, and its failure's loss rebuilt at the sustainable rate; and `BLADEBURNER_REST_SLACK_MS`, as
//   B2's stuck resting is bounded. The rate 0, the rebuild is left out of it: the bound stays finite, so a dead route is
//   loud.
import {
  BLACK_OPS_COUNT,
  BLADEBURNER_BLACK_OPS,
  type BlackOpsRouteTime,
  type BladeburnerActionInput,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpsRouteEstimate,
  bladeburnerBlackOp,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  bladeburnerSkillMultsOf,
  chooseWinRoute,
  type MediumSnapshotData,
  redPillLevelSeconds,
  staminaGainPerSecond,
  type WinRouteChoice,
  worldDaemonRequiredLevel,
} from "@bitburner-agent/core";
import { bladeburnerSnapshotOf, bladeburnerSpeedOf } from "./bladeburner.ts";
import { BLADEBURNER_REST_SLACK_MS } from "./bladeburner-actions-report.ts";

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
  /** How long the rank's high may stand before it's a stall, ms; null unread. */
  rankStallMs: number | null;
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
 * Bladeburner rule's time to the next one's rank where it has it (its plan's `toTarget`), else core solves it.
 */
export function blackOpsRouteOf({
  mediumData,
  bitNode,
  ownedSF,
  rankPerSecond,
  expPerSecond,
  soFarMs,
  firstToRankSeconds = null,
}: {
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
  if (input !== null && op !== null && actions !== null) {
    const mults = bladeburnerSkillMultsOf(input.skills?.read ?? {});
    const regain = staminaGainPerSecond(input.person, actions.maxStamina, mults);
    const rest = regain > 0 ? actions.maxStamina / 2 / regain : 0;
    const rate = estimate?.rate ?? 0;
    const rebuild = rate > 0 ? blackOpRankLoss(op) / rate : 0;
    rankStallMs = 2 * (rest + blackOpSeconds(op, input.person, mults) + rebuild) * 1000 + BLADEBURNER_REST_SLACK_MS;
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
  };
}
