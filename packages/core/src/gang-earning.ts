/**
 * The gang rule's time until its plan earns respect (#374): what bounds a pause to train, do justice or fight, so a
 * gang stuck past its own estimate is loud (decision 45) and a normal pause isn't. The gang's respect moves only by
 * what its members earn, an ascension or a death (`Gang.ts:131-142`, `:390-404`, `:371-375`), so while the plan earns
 * none the rule's figures hold, and each member's time is the rule's own choices played forward:
 * - **training:** the least time t, to the rule's minute (`GANG_TRAINING_STEP_MS`), after which the rule stops training
 *   it: trained t (the game's experience a cycle, `GangMember.ts:155-210`, levels `:70-72`; core's `gangMemberAfter`),
 *   either a minute's training no longer pays within its next ascension (`gangTrains`, the horizon its
 *   `gangTimeToAscensionMs` then), so it works; or its ascension pays now (that horizon 0) and the rule may make it
 *   (`gangAscensionAllowed`), so it ascends (`GangMember.ts:298-320`) and trains on from its ascended self, its earned
 *   respect off the gang's (`Gang.ts:390-393`). Searched by doubling from a minute, then halving to within one; at most
 *   `GANG_ASCENSION_HORIZON_CAP_MS` (a day) in all, the longest the rule forecasts a member;
 * - **justice:** the time for the wanted level, at the plan's tasks, to fall to where the rule lets its justice members
 *   go (`GANG_JUSTICE_RELEASE`, half the bound), by the game's process (`Gang.ts:157-167`), then its training's time
 *   as above; a day in all at most, never released at the plan's tasks included;
 * - **territory warfare:** G4's own exit (#376's review): the crew empties at all the territory, where a step more is
 *   worth nothing (`gangWarfareBasis`'s step 0), so (1 − territory) / the territory the clashes gain an update (the
 *   plan's measure, `gangTerritoryPerUpdate`, `Gang.ts:184-269`) × an update's 20 s (`GANG_TERRITORY_UPDATE_MS`,
 *   `Constants.ts:12`), at most the day it's weighed over (`GANG_WARFARE_HORIZON_MS`); the day with none gained. At
 *   the measure now: the others' growth and the gang's power gain as it goes are left out, either way;
 * - **working:** 0.
 * The plan's estimate is the least of its members' and its recruits' (fresh, set to train at once), or the time two
 * members' ascensions pay at once: the rule makes one a plan (`gangAscensionToMake`) and has the other, its horizon 0,
 * work (`gangTrains`). Left out, each
 * named: bonus time, which runs the gang's cycles faster (`Gang.ts:99-110`, up to 25 a process, every engine tick), so
 * the estimate errs long, the cautious side for a bound; the experience justice and warfare give (`GangMember.ts
 * :155-210`), long too; the wanted level's fall during the training, which the ascension's penalty check
 * (`gangAscensionAllowed`) and the forecast's work at the gang's penalty (`gangWorkRespectPerCycle`) hold as now,
 * either way; one ascension a plan (10 s each), short; the rule's search's own non-monotone corners, either way.
 */
import {
  GANG_CYCLE_MS,
  GANG_CYCLES_PER_PROCESS,
  GANG_JUSTICE_DECAY_PER_PROCESS,
  type GangMemberFigures,
  gangFreshRecruit,
  gangMemberAfter,
  gangMemberAscended,
  gangTask,
  gangWantedPerCycle,
  MAX_GANG_MEMBER_NAME_LENGTH,
} from "./gang.ts";
import {
  GANG_ASCENSION_HORIZON_CAP_MS,
  GANG_JUSTICE_RELEASE,
  GANG_TERRITORY_UPDATE_MS,
  GANG_TRAINING_STEP_MS,
  GANG_WARFARE_HORIZON_MS,
  type GangObjective,
  type GangPlan,
  type GangRole,
  type GangRuleInputs,
  gangAscensionAllowed,
  gangInputsAfterAscension,
  gangTimeToAscensionMs,
  gangTrainingTask,
  gangTrains,
  isGangJusticeTask,
} from "./gang-rule.ts";

/** The margin a pause's bound adds to twice the estimate (#374): 10 minutes, as #343's waits are bounded. */
export const GANG_EARNING_MARGIN_MS = 10 * 60_000;

/** The bound on a pause the plan estimates at `estimateMs` (#374): twice it, and 10 minutes. */
export function gangEarningBoundMs(estimateMs: number): number {
  return 2 * estimateMs + GANG_EARNING_MARGIN_MS;
}

/** A member's training until the rule stops it (`gangTrainingTimeMs`). */
export interface GangTrainingTime {
  ms: number;
  /** The ascensions the rule makes on the way. */
  ascensions: number;
  /** Not done within a day (`GANG_ASCENSION_HORIZON_CAP_MS`): the day. */
  capped: boolean;
  /** The first ascension's time, ms, or null with none: where another member's at the same time earns. */
  firstAscensionMs: number | null;
}

/**
 * How long the rule trains the member before it works (#374, the module's comment): trained, its next ascension's
 * horizon recomputed, until a minute's training no longer pays (`gangTrains`); an ascension that pays and is allowed on
 * the way is made, and the training goes on from the ascended member. 0 if the rule would have it work now.
 */
export function gangTrainingTimeMs(
  given: GangRuleInputs,
  member: GangMemberFigures,
  objective: GangObjective,
): GangTrainingTime {
  const training = gangTask(gangTrainingTask(given.isHacking));
  let inputs = given;
  let current: GangMemberFigures = { ...member, task: training.name };
  let total = 0;
  let ascensions = 0;
  let firstAscensionMs: number | null = null;
  const after = (ms: number): GangMemberFigures => ({
    ...gangMemberAfter(current, training, ms / GANG_CYCLE_MS),
    task: training.name,
  });
  /** What the rule does with the member trained `ms` more: still trains (null), works, or ascends. */
  const exit = (ms: number): "works" | "ascends" | null => {
    const trained = after(ms);
    const horizonMs = gangTimeToAscensionMs(inputs, trained, objective);
    if (horizonMs === 0 && gangAscensionAllowed(inputs, trained)) return "ascends";
    return gangTrains(inputs, trained, objective, horizonMs) ? null : "works";
  };
  // An ascension leaves no experience to convert, so the next takes a minute or more; the count's bound is a guard.
  while (total < GANG_ASCENSION_HORIZON_CAP_MS && ascensions <= GANG_ASCENSION_HORIZON_CAP_MS / GANG_TRAINING_STEP_MS) {
    const left = GANG_ASCENSION_HORIZON_CAP_MS - total;
    let found = exit(0);
    let high = 0;
    if (found === null) {
      let low = 0;
      high = Math.min(GANG_TRAINING_STEP_MS, left);
      found = exit(high);
      while (found === null && high < left) {
        low = high;
        high = Math.min(2 * high, left);
        found = exit(high);
      }
      if (found === null) break;
      while (high - low > GANG_TRAINING_STEP_MS) {
        const middle = (low + high) / 2;
        const there = exit(middle);
        if (there === null) low = middle;
        else {
          high = middle;
          found = there;
        }
      }
    }
    total += high;
    if (found === "works") return { ms: total, ascensions, capped: false, firstAscensionMs };
    firstAscensionMs ??= total;
    // Ascended (G2): its earned respect off the gang's, its levels from 1 at its new multipliers; trains on.
    const trained = after(high);
    inputs = gangInputsAfterAscension(
      {
        ...inputs,
        members: inputs.members.map((each) => (each.name === trained.name ? trained : each)),
      },
      {
        name: trained.name,
        result: { respect: trained.earnedRespect, hack: 1, str: 1, def: 1, dex: 1, agi: 1, cha: 1 },
      },
    );
    current = { ...gangMemberAscended(trained), task: training.name };
    ascensions += 1;
  }
  return { ms: GANG_ASCENSION_HORIZON_CAP_MS, ascensions, capped: true, firstAscensionMs };
}

/**
 * The time, ms, for the wanted level to fall to where the rule releases its justice members (#374): the lost share
 * (`gangLostShare`) at half the plan's bound (`GANG_JUSTICE_RELEASE`), W_r = (b·R + 1) / (1 − b) with b that half and R
 * the respect, which the plan, earning none, holds. With the plan's tasks, the game's process (`Gang.ts:157-167`): every
 * 10 cycles (2 s), W ← (W + 10g)(1 − d), g the members' wanted a cycle (justice's negative, `formulas.ts:33-54`) and d
 * 0.001 × those on justice; so W_n − W* = (W − W*)(1 − d)^n, W* = 10g(1 − d)/d, and the processes are the least n with
 * W_n ≤ W_r. 0 at or under it; Infinity if the plan never gets there (none on justice, or W* above W_r).
 */
export function gangJusticeReleaseMs(inputs: GangRuleInputs, plan: Pick<GangPlan, "assignments" | "bound">): number {
  const { gang, members } = inputs;
  const share = plan.bound * GANG_JUSTICE_RELEASE;
  const released = (share * gang.respect + 1) / (1 - share);
  if (gang.wantedLevel <= released) return 0;
  const tasks = new Map(plan.assignments.map((each) => [each.name, each.task]));
  let gain = 0;
  let justice = 0;
  for (const member of members) {
    const task = tasks.get(member.name) ?? member.task;
    if (isGangJusticeTask(task)) justice += 1;
    gain += gangWantedPerCycle(gang, member, gangTask(task));
  }
  const decay = GANG_JUSTICE_DECAY_PER_PROCESS * justice;
  if (decay === 0) return Number.POSITIVE_INFINITY;
  const settles = (GANG_CYCLES_PER_PROCESS * gain * (1 - decay)) / decay;
  if (settles >= released) return Number.POSITIVE_INFINITY;
  const processes = Math.ceil(Math.log((gang.wantedLevel - settles) / (released - settles)) / -Math.log1p(-decay));
  return processes * GANG_CYCLES_PER_PROCESS * GANG_CYCLE_MS;
}

/**
 * The time until the plan's crew leaves Territory Warfare (G4's exit, #376's review, the module's comment): the
 * territory left at the territory its measure gains an update, an update every 20 s; at most a day, the day with none.
 */
export function gangWarfareExitMs(
  inputs: Pick<GangRuleInputs, "gang">,
  plan: { warfare: { measure: { territoryPerUpdate: number } } | null },
): number {
  const perUpdate = plan.warfare?.measure.territoryPerUpdate ?? 0;
  if (!(perUpdate > 0)) return GANG_WARFARE_HORIZON_MS;
  const updates = Math.max(0, 1 - inputs.gang.territory) / perUpdate;
  return Math.min(GANG_WARFARE_HORIZON_MS, updates * GANG_TERRITORY_UPDATE_MS);
}

/** A member's time until it earns respect under the plan (#374). */
export interface GangMemberEarning {
  name: string;
  /** Its role in the plan; a recruit's "training". */
  role: GangRole;
  ms: number;
  /** On justice: the time to its release, before its training. */
  releaseMs?: number;
  /** Training: the ascensions on the way, whether it hit the day, and the first ascension's time from now. */
  ascensions?: number;
  capped?: boolean;
  firstAscensionMs?: number | null;
}

/** The plan's time until it earns respect (#374), and each member's. */
export interface GangEarningEstimate {
  /** The least of the members': the first to earn. */
  ms: number;
  /** Who, or null with none. */
  first: string | null;
  members: GangMemberEarning[];
  /** The bound on the pause: `gangEarningBoundMs`. */
  boundMs: number;
}

/**
 * The plan's time until it earns respect (#374, the module's comment), on the inputs `planGang` had (its ascension
 * applied here, as it does): each member's by its role, and the recruits', the least. A member the protocol can't name
 * (an owner's) is the owner's, left out. Infinity with nobody (no member, no recruit).
 */
export function gangTimeToEarningMs(given: GangRuleInputs, plan: GangPlan): GangEarningEstimate {
  const inputs = gangInputsAfterAscension(given, plan.ascend);
  const byName = new Map(inputs.members.map((member) => [member.name, member]));
  const members: GangMemberEarning[] = [];
  const release = plan.assignments.some((each) => each.role === "justice") ? gangJusticeReleaseMs(inputs, plan) : 0;
  // At most a day in all: a justice member never released at the plan's tasks (Infinity) too, so a bound always holds.
  const trained = (training: GangTrainingTime, fromMs: number) => ({
    ms: Math.min(GANG_ASCENSION_HORIZON_CAP_MS, fromMs + training.ms),
    ascensions: training.ascensions,
    capped: training.capped || fromMs + training.ms >= GANG_ASCENSION_HORIZON_CAP_MS,
    firstAscensionMs: training.firstAscensionMs === null ? null : fromMs + training.firstAscensionMs,
  });
  for (const { name, role } of plan.assignments) {
    const member = byName.get(name);
    if (member === undefined || name === "" || name.length > MAX_GANG_MEMBER_NAME_LENGTH) continue;
    if (role === "working") members.push({ name, role, ms: 0 });
    else if (role === "territory") members.push({ name, role, ms: gangWarfareExitMs(inputs, plan) });
    else {
      const training = gangTrainingTimeMs(inputs, member, plan.objective);
      const releaseMs = role === "justice" ? release : 0;
      members.push({ name, role, ...(role === "justice" ? { releaseMs } : {}), ...trained(training, releaseMs) });
    }
  }
  for (const name of plan.recruit) {
    members.push({
      name,
      role: "training",
      ...trained(gangTrainingTimeMs(inputs, gangFreshRecruit(name), plan.objective), 0),
    });
  }
  let first: { name: string; ms: number } | null = null;
  for (const each of members) if (first === null || each.ms < first.ms) first = each;
  // One ascension a plan (`gangAscensionToMake`): of two whose ascensions pay at once, the one not ascended works.
  const ascending = new Map<number, string[]>();
  for (const each of members) {
    if (each.firstAscensionMs === undefined || each.firstAscensionMs === null) continue;
    ascending.set(each.firstAscensionMs, [...(ascending.get(each.firstAscensionMs) ?? []), each.name]);
  }
  for (const [atMs, names] of ascending) {
    if (names.length >= 2 && (first === null || atMs < first.ms)) first = { name: names[1] as string, ms: atMs };
  }
  const ms = first?.ms ?? Number.POSITIVE_INFINITY;
  return { ms, first: first?.name ?? null, members, boundMs: gangEarningBoundMs(ms) };
}
