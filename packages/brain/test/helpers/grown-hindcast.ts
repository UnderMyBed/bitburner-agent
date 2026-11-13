// #408's hindcast: the route's grown estimate from a suite's first reading against the rank the suite measured over its
// game time (B2-B6's BN6 simulator suites). The estimate's time to a rank under the next Black Op's is the least of
// its growth's tail (the path, linear between its steps) and B5's stock (the rule's least expected time to it, core's
// `chooseBladeburnerAction` under that target), as the estimate takes the next one's rank; to the next one done, that
// and its attempts. Decision 68's tolerance is ×2.
import { blackOpsRouteGrownEstimate, chooseBladeburnerAction, type MediumSnapshotData } from "@bitburner-agent/core";
import { blackOpsInstallFiguresOf } from "../../src/bladeburner-route.ts";

const HOUR = 3_600_000;

/** A hindcast's figures: the measured game ms, the estimate's (and its two parts'), their ratio, and its line. */
export interface GrownHindcast {
  measuredMs: number;
  estimateMs: number;
  tailMs: number;
  stockMs: number | null;
  ratio: number;
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
 * The hindcast from `mediumData`'s reading in BN6 (`label` names the suite): to rank `to` (under the next Black Op's)
 * where given, else to the next Black Op done; against `measuredMs` of game time.
 */
export function grownHindcast(
  label: string,
  mediumData: MediumSnapshotData | null,
  measuredMs: number,
  to: number | "next done",
): GrownHindcast {
  const route = blackOpsInstallFiguresOf(mediumData, 6)?.route;
  if (route == null) throw new Error(`${label}: no route's figures in the reading`);
  const { input, at, combat, growth } = route;
  const grown = blackOpsRouteGrownEstimate(input, at, { combat, ...growth });
  const target = to === "next done" ? at.next.rank : to;
  const stock =
    target <= at.rank
      ? 0
      : (chooseBladeburnerAction({ ...input, target: { rank: at.rank, target } }).toTarget?.seconds ?? null);
  const tail = pathSecondsTo(grown.path, target);
  const attempts = to === "next done" ? (grown.steps[0]?.attemptsSeconds ?? Number.POSITIVE_INFINITY) : 0;
  const estimate = Math.min(tail, stock ?? Number.POSITIVE_INFINITY) + attempts;
  const ratio = estimate / (measuredMs / 1000);
  const hours = (seconds: number | null) => (seconds === null ? "none" : `${(seconds / 3600).toFixed(2)} h`);
  const line =
    `#408's hindcast, ${label}: rank ${at.rank.toFixed(0)} to ${to === "next done" ? `${at.next.name} done` : target.toFixed(0)} ` +
    `measured in ${(measuredMs / HOUR).toFixed(2)} h; the grown estimate ${hours(estimate)} (its growth's tail ` +
    `${hours(tail)}, B5's stock ${hours(stock)}${to === "next done" ? `, the attempts ${hours(attempts)}` : ""}): ` +
    `×${ratio.toFixed(2)}`;
  return {
    measuredMs,
    estimateMs: estimate * 1000,
    tailMs: tail * 1000,
    stockMs: stock === null ? null : stock * 1000,
    ratio,
    line,
  };
}
