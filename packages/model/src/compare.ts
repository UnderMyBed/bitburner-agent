/**
 * The paired comparison (#263's work item 6, for #247): two policies run on the same model at each setting of a grid,
 * from a start, and compared setting by setting. The grid (`COMPARISON_GRID`) is the calibration's sensitivities and
 * the structural variants: #260's gross money and share by install index, and #294's joins at once or later and the
 * first cloud server later. A difference counts only if it has the same sign at every setting, each run's milestone
 * inside the curves' range (`ModelRun.outOfRange`): a spread that crosses zero, or a milestone out of range or never
 * reached, is no answer. A start is a known state, not an uncertainty, so each gets its own verdict over the whole
 * grid (`comparisonByStart`, #294's review); a start the curves weren't measured from (home under 32 GB) gives none.
 * #247's first rule (a difference only beyond the grid's spread) compared unpaired ranges, with one parameter varied
 * at a time, and missed errors in the model's structure (#262's review).
 */
import { augmentationsSoldBy, DAEDALUS, isWorthInstalling, TIAN_DI_HUI } from "@bitburner-agent/core";
import { CALIBRATION, calibrationSteps, HACKER_FACTION_JOINS } from "./calibration.ts";
import {
  type CyclePolicy,
  type ModelOptions,
  type ModelRun,
  type ModelStart,
  runModel,
  startHomeRamGb,
} from "./cycles.ts";

/**
 * A setting of the grid: the options both policies run at, and `countShift`, installs that many more or fewer to
 * Daedalus's count (the model's count after an install is off by up to 2 on run #3 and BN1.3, #294).
 */
export interface ComparisonSetting {
  name: string;
  options: Omit<ModelOptions, "policy" | "onStep" | "onWork">;
  countShift?: number;
}

/**
 * The least difference that counts, ms: two steps. Each milestone is a step's time, up to a step late (an install at
 * the first step past its countdown), and a join within half a step; so a difference of two steps or less is within
 * the model's resolution, a tie (#294's re-review).
 */
export const COMPARISON_MARGIN_MS = 2 * 60_000;

/** The starts compared from, each over the whole grid (#294): #263's sign flipped between a fresh BN1.1 and SF1.2. */
export const COMPARISON_STARTS: readonly { name: string; start: ModelStart }[] = [
  { name: "from a fresh BN1.1 (no Source-File, 8 GB home)", start: { currentNode: 1, ownedSF: {} } },
  { name: "from SF1.1 (run #3's BN1.2)", start: { currentNode: 1, ownedSF: { "1": 1 } } },
  { name: "from SF1.2 (BN1.3's)", start: { currentNode: 1, ownedSF: { "1": 2 } } },
];

/** How much later than modelled the grid's late variants put the joins and the first cloud server (#294): 5 min. */
export const GRID_LATER_MS = 5 * 60_000;

/**
 * The grid #247 compares on, 21 settings: the model as fitted; the structural variants (#260's gross money and share
 * by install index; #294's joins at once, as slice 2 had them); every fitted constant of the curve a step either way
 * (`calibrationSteps`, the refit's own); `firstCycleSpeed` further, 0.5 and #263's 0.8, as no run measures it; the
 * batches using half what core's plan gives (#294's share by the state, so the cloud shares more); the joins and the
 * first cloud server 5 minutes later than modelled; and Daedalus's count reached at 2 installed more or fewer, the
 * model's count's miss.
 */
export const COMPARISON_GRID: readonly ComparisonSetting[] = [
  { name: "as fitted", options: {} },
  { name: "money: the gross (#260's)", options: { money: "gross" } },
  { name: "share: by install index (#260's)", options: { share: "index" } },
  ...calibrationSteps(CALIBRATION).map(({ name, calibration }) => ({ name, options: { calibration } })),
  { name: "the batches' use ×0.5 (the cloud shares more)", options: { calibration: { batchesUseFactor: 0.5 } } },
  { name: "joins: at once (slice 2's)", options: { joinDelay: "instant" } },
  { name: "joins: 5 min later than modelled", options: { joinDelay: GRID_LATER_MS } },
  { name: "the first cloud server: 5 min later than modelled", options: { cloudDelayMs: GRID_LATER_MS } },
  { name: "firstCycleSpeed 0.5 (wide)", options: { calibration: { firstCycleSpeed: 0.5 } } },
  { name: "firstCycleSpeed 0.8 (#263's)", options: { calibration: { firstCycleSpeed: 0.8 } } },
  { name: "Daedalus's count at 2 more installed", options: {}, countShift: 2 },
  { name: "Daedalus's count at 2 fewer installed", options: {}, countShift: -2 },
];

/**
 * Whether `start` is in the curves' measured range: home's RAM at the start 32 GB or more (SF1). Every run the curves
 * are fitted on starts at 32 GB; a fresh BN1.1's 8 GB rests on `firstCycleSpeed`, which no run measures.
 */
export function startInRange(start: ModelStart): boolean {
  return startHomeRamGb(start.ownedSF["1"] ?? 0) >= 32;
}

/** The cycle (1-based) a milestone falls in, and the minutes that cycle ran past the curves (`extrapolatedMinutes`). */
export interface MilestoneCycle {
  cycle: number;
  extrapolatedMinutes: number;
}

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
  /** Whether the start is in the curves' measured range (`startInRange`): if not, every verdict is no answer. */
  startInRange: boolean;
  /**
   * By setting: each milestone's time under each policy, and `second` less `first`, ms (null for no pair); and, by
   * milestone, the cycle it falls in under each policy and the minutes that cycle ran past the curves (null: none).
   */
  settings: {
    name: string;
    first: Record<Milestone, number | null>;
    second: Record<Milestone, number | null>;
    difference: Record<Milestone, number | null>;
    cycles: Record<Milestone, { first: MilestoneCycle | null; second: MilestoneCycle | null }>;
  }[];
  /**
   * By milestone: "second sooner" or "first sooner" when every setting's difference has that sign by more than
   * `COMPARISON_MARGIN_MS`, else "no answer" (a sign that changes, a tie, or a setting with no pair); and the least and
   * the most difference, ms.
   */
  verdict: Record<Milestone, { answer: "second sooner" | "first sooner" | "no answer"; least: number; most: number }>;
}

/**
 * `first` and `second` from `start` at every setting of `grid`, paired; every verdict no answer from a start out of
 * the curves' range (`startInRange`). Daedalus's count is BN1's 30 unless `required` says otherwise.
 */
export function pairedComparison(
  start: ModelStart,
  first: CyclePolicy,
  second: CyclePolicy,
  grid: readonly ComparisonSetting[] = COMPARISON_GRID,
  required = 30,
): PairedComparison {
  const inRange = startInRange(start);
  const settings = grid.map(({ name, options, countShift = 0 }) => {
    const firstRun = runModel(start, { ...options, policy: first });
    const secondRun = runModel(start, { ...options, policy: second });
    const a = milestonesOf(firstRun, required + countShift);
    const b = milestonesOf(secondRun, required + countShift);
    const cycleOf = (run: ModelRun, atMs: number | null): MilestoneCycle | null => {
      if (atMs === null) return null;
      const index = run.cycles.findIndex((cycle) => atMs <= cycle.endMs);
      const cycle = index === -1 ? run.cycles.length + 1 : index + 1;
      return { cycle, extrapolatedMinutes: run.cycles[cycle - 1]?.extrapolatedMinutes ?? Number.NaN };
    };
    const cycles = Object.fromEntries(
      MILESTONES.map((milestone) => [
        milestone,
        { first: cycleOf(firstRun, a[milestone]), second: cycleOf(secondRun, b[milestone]) },
      ]),
    ) as PairedComparison["settings"][number]["cycles"];
    const difference = Object.fromEntries(
      MILESTONES.map((milestone) => {
        const [x, y] = [a[milestone], b[milestone]];
        return [milestone, x === null || y === null ? null : y - x];
      }),
    ) as Record<Milestone, number | null>;
    return { name, first: a, second: b, difference, cycles };
  });
  const verdict = Object.fromEntries(
    MILESTONES.map((milestone) => {
      const each = verdictOf(settings.map((setting) => setting.difference[milestone]));
      return [milestone, inRange ? each : { ...each, answer: "no answer" }];
    }),
  ) as PairedComparison["verdict"];
  return { startInRange: inRange, settings, verdict };
}

/** `pairedComparison` from each of `starts` over the whole `grid`: a verdict a start (#294's review). */
export function comparisonByStart(
  first: CyclePolicy,
  second: CyclePolicy,
  starts: readonly { name: string; start: ModelStart }[] = COMPARISON_STARTS,
  grid: readonly ComparisonSetting[] = COMPARISON_GRID,
  required = 30,
): { name: string; start: ModelStart; comparison: PairedComparison }[] {
  return starts.map(({ name, start }) => ({
    name,
    start,
    comparison: pairedComparison(start, first, second, grid, required),
  }));
}

/**
 * The verdict on one milestone from each setting's difference (the second policy's time less the first's, null for no
 * pair): a sooner policy only if every setting has a pair and every difference has its sign by more than
 * `marginMs`; else no answer.
 */
export function verdictOf(
  differences: readonly (number | null)[],
  marginMs = COMPARISON_MARGIN_MS,
): PairedComparison["verdict"][Milestone] {
  const paired = differences.filter((each): each is number => each !== null);
  const least = paired.length === 0 ? Number.NaN : Math.min(...paired);
  const most = paired.length === 0 ? Number.NaN : Math.max(...paired);
  const complete = paired.length === differences.length && paired.length > 0;
  const answer = !complete
    ? "no answer"
    : most < -marginMs
      ? "second sooner"
      : least > marginMs
        ? "first sooner"
        : "no answer";
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
