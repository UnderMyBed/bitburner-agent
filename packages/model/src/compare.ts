/**
 * The paired comparison (#263's work item 6, for #247): two policies run on the same model at each setting of a grid,
 * the calibration's sensitivities and the structural variants (#260's gross money, the share by install index), and
 * compared setting by setting. A difference counts only if it has the same sign at every setting, each run's milestone
 * inside the curves' range (`ModelRun.outOfRange`): a spread that crosses zero, or a milestone out of range or never
 * reached, is no answer. #247's first rule (a difference only beyond the grid's spread) compared unpaired ranges, with
 * one parameter varied at a time, and missed errors in the model's structure (#262's review).
 */
import { augmentationsSoldBy, DAEDALUS, isWorthInstalling, TIAN_DI_HUI } from "@bitburner-agent/core";
import { CALIBRATION, calibrationSteps, HACKER_FACTION_JOINS } from "./calibration.ts";
import { type CyclePolicy, type ModelOptions, type ModelRun, type ModelStart, runModel } from "./cycles.ts";

/** A setting of the grid: the options both policies run at. */
export interface ComparisonSetting {
  name: string;
  options: Omit<ModelOptions, "policy" | "onStep" | "onWork">;
}

/**
 * The grid #247 compares on, 14 settings: the model as fitted, the structural variants, every fitted constant of the
 * curve a step either way (`calibrationSteps`, the refit's own), and the cloud servers sharing a tenth under #242's
 * share (the batches at 70%, not 82%).
 */
export const COMPARISON_GRID: readonly ComparisonSetting[] = [
  { name: "as fitted", options: {} },
  { name: "money: the gross (#260's)", options: { money: "gross" } },
  { name: "share: by install index (#260's)", options: { share: "index" } },
  ...calibrationSteps(CALIBRATION).map(({ name, calibration }) => ({ name, options: { calibration } })),
  { name: "the batches' use 0.7 (the cloud shares a tenth)", options: { calibration: { batchesUseOfHosts: [0.7] } } },
];

/** #247's milestones. */
export const MILESTONES = ["donationsUnlocked", "daedalusCount", "daedalusJoined", "destroyed"] as const;
export type Milestone = (typeof MILESTONES)[number];

/**
 * Each milestone's time in `run`, ms, or null where it isn't reached or comes in or after a cycle out of the curves'
 * range: the first faction's donations unlocked, the install that reaches Daedalus's count (`required`), Daedalus
 * joined, the destroy.
 */
export function milestonesOf(run: ModelRun, required: number): Record<Milestone, number | null> {
  const firstOut = Math.min(...run.outOfRange, Number.POSITIVE_INFINITY);
  // The cycle a time falls in, 1-based: the one under way at the horizon past the last install.
  const cycleAt = (atMs: number) => {
    const index = run.cycles.findIndex((cycle) => atMs <= cycle.endMs);
    return index === -1 ? run.cycles.length + 1 : index + 1;
  };
  const inRange = (atMs: number | undefined) => (atMs === undefined || cycleAt(atMs) >= firstOut ? null : atMs);
  return {
    donationsUnlocked: inRange(run.events.find((event) => event.kind === "donationsUnlocked")?.atMs),
    daedalusCount: inRange(run.cycles.find((cycle) => cycle.countAfter >= required)?.endMs),
    daedalusJoined: inRange(run.events.find((event) => event.kind === "joined" && event.faction === DAEDALUS)?.atMs),
    destroyed: inRange(run.destroyedAtMs ?? undefined),
  };
}

export interface PairedComparison {
  /** By setting: each milestone's time under each policy, and `second` less `first`, ms (null for no pair). */
  settings: {
    name: string;
    first: Record<Milestone, number | null>;
    second: Record<Milestone, number | null>;
    difference: Record<Milestone, number | null>;
  }[];
  /**
   * By milestone: "second sooner" or "first sooner" when every setting's difference has that sign, else "no answer"
   * (a sign that changes, a tie, or a setting with no pair); and the least and the most difference, ms.
   */
  verdict: Record<Milestone, { answer: "second sooner" | "first sooner" | "no answer"; least: number; most: number }>;
}

/**
 * `first` and `second` from `start` at every setting of `grid`, paired. Daedalus's count is BN1's 30 unless `required`
 * says otherwise.
 */
export function pairedComparison(
  start: ModelStart,
  first: CyclePolicy,
  second: CyclePolicy,
  grid: readonly ComparisonSetting[] = COMPARISON_GRID,
  required = 30,
): PairedComparison {
  const settings = grid.map(({ name, options }) => {
    const a = milestonesOf(runModel(start, { ...options, policy: first }), required);
    const b = milestonesOf(runModel(start, { ...options, policy: second }), required);
    const difference = Object.fromEntries(
      MILESTONES.map((milestone) => {
        const [x, y] = [a[milestone], b[milestone]];
        return [milestone, x === null || y === null ? null : y - x];
      }),
    ) as Record<Milestone, number | null>;
    return { name, first: a, second: b, difference };
  });
  const verdict = Object.fromEntries(
    MILESTONES.map((milestone) => [milestone, verdictOf(settings.map((each) => each.difference[milestone]))]),
  ) as PairedComparison["verdict"];
  return { settings, verdict };
}

/**
 * The verdict on one milestone from each setting's difference (the second policy's time less the first's, null for no
 * pair): a sooner policy only if every setting has a pair and every difference has its sign; else no answer.
 */
export function verdictOf(differences: readonly (number | null)[]): PairedComparison["verdict"][Milestone] {
  const paired = differences.filter((each): each is number => each !== null);
  const least = paired.length === 0 ? Number.NaN : Math.min(...paired);
  const most = paired.length === 0 ? Number.NaN : Math.max(...paired);
  const complete = paired.length === differences.length && paired.length > 0;
  const answer = !complete ? "no answer" : most < 0 ? "second sooner" : least > 0 ? "first sooner" : "no answer";
  return { answer, least, most };
}

/**
 * #247's "favour first": once the faction selling the most countable augmentations not installed is joined (of the
 * hacker factions and Tian Di Hui, BN1's before Daedalus: BitRunners, 13 at first), work there toward the favour that
 * unlocks its donations, buying from it as reputation allows; the brain's own choices otherwise. Countable is core's
 * `isWorthInstalling` with nothing short.
 */
export const FAVOUR_FIRST_POLICY: CyclePolicy = {
  name: "favour first",
  daedalusCountHold: true,
  homeShares: true,
  favourGrind: (view) => {
    let best: { name: string; countable: number } | null = null;
    for (const faction of [...HACKER_FACTION_JOINS.map((each) => each.faction), TIAN_DI_HUI]) {
      const countable = augmentationsSoldBy(faction, 1, null).filter(
        (name) => isWorthInstalling(name) && !Object.hasOwn(view.installed, name),
      ).length;
      if (best === null || countable > best.countable) best = { name: faction, countable };
    }
    return view.joined.some((each) => each.name === best?.name) ? (best?.name ?? null) : null;
  },
};
