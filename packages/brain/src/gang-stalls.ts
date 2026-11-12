// The gang's silent stalls (#354, from #352's findings): three ways the gang stops progressing that nothing else
// judges, each a run report failure (./gang-report.ts) and a dashboard alert (`gangStalled`, ./dashboard/alerts.ts),
// from the same medium snapshots' gang readings and the rule's plan at each (core's `planGang`):
// - **a worker problem that persists:** the same problem (the game didn't set a task, recruit, ascend or buy;
//   ../../ingame/src/workers/gang-management.ts) in every reading for `GANG_PROBLEM_WITHIN_MS`;
// - **a member off the rule's task:** its task neither the one the plan at the reading before gave it (what the worker
//   had to do since) nor the one this reading's plan gives, for `GANG_TASK_WITHIN_MS`. Both, so a plan that moves a
//   member back and forth each reading, the worker a reading behind, isn't one;
// - **respect flat while the plan has members working:** the respect risen by less than the plan's tasks earn in one of
//   the game's processes, from the gang formulas, between readings that span two processes or more, for
//   `GANG_RESPECT_FLAT_WITHIN_MS`. Respect is the gang's faction's only reputation (`Gang.ts:144-155`), so this stalls
//   The Red Pill's route in BN2;
// - **the plan earning no respect past its own estimate (#374):** every member training, on justice or on Territory
//   Warfare, for longer than twice the rule's own time until its plan earns respect (core's `gangTimeToEarningMs`, at
//   the stretch's first reading) and 10 minutes (`gangEarningBoundMs`, as #343's waits are bounded). The respect stall
//   above can't see it, the plan expecting none. A normal pause ends within its estimate; one past twice it is stuck.
// The live brain (../gang.ts, `GangRule`) and the run report feed it each gang reading in order; a reading with no
// gang (none formed, unread, absent, or outside BN2) ends every stretch, and so does a gap: readings further apart than
// the medium snapshots' cadence allows (`MEDIUM_SNAPSHOT_GAP_MS`, a thinned store's minute or a degraded medium tier),
// where one reading would already be a stretch of the gap's length (#364's review).
import {
  GANG_CYCLE_MS,
  GANG_CYCLES_PER_PROCESS,
  GANG_EARNING_MARGIN_MS,
  GANG_TASK_NAMES,
  type GangEarningEstimate,
  type GangInformation,
  type GangMemberReading,
  type GangPlan,
  gangRespectPerCycle,
  gangTask,
  gangTimeToEarningMs,
  gangTrainingTask,
  MAX_GANG_MEMBER_NAME_LENGTH,
} from "@bitburner-agent/core";
import { MEDIUM_SNAPSHOT_GAP_MS } from "./backdoors.ts";
import { formatDuration } from "./gap-report.ts";

/**
 * How long one problem of the worker's may be in every reading: 1 minute. The Agent runs the worker when the brain's
 * gang state changes and every 10 s (`GANG_ROUNDS_BETWEEN`, ../../ingame/src/agent/gang.ts), each run trying afresh,
 * and the medium snapshot (10 s) carries the last run's problems: a passing one is gone a reading later; one in every
 * reading for a minute is six runs, and the brain's six plans, refused alike.
 */
export const GANG_PROBLEM_WITHIN_MS = 60_000;
/**
 * How long a member may be off the rule's task: 1 minute. The brain plans on each medium snapshot (10 s), the worker
 * runs at once on the changed state and sets every member's task each run (gang-management.ts), and the next medium
 * snapshot shows it: under 20 s, three times over.
 */
export const GANG_TASK_WITHIN_MS = 60_000;
/**
 * How long the respect may stay flat while the plan has members working: 1 minute, the time a plan's tasks take to be
 * set (`GANG_TASK_WITHIN_MS`). "Flat" is computed from the plan: the gang processes every 2 s of cycles, adding each
 * member's respect gain a cycle × the cycles (`Gang.ts:99-104`, `:131-142`; `Gang/data/Constants.ts:29`), the gain
 * the formulas' (`Gang/formulas/formulas.ts:15-31`, core's `gangRespectPerCycle`, checked in the parity suite). A
 * reading 10 s on spans five processes; respect risen by less than one process's worth of the plan's tasks is flat.
 */
export const GANG_RESPECT_FLAT_WITHIN_MS = 60_000;

/** The game's process (`Gang/data/Constants.ts:29`): 10 cycles, 2 s. The least it adds at a time. */
const PROCESS_MS = GANG_CYCLES_PER_PROCESS * GANG_CYCLE_MS;

/** Whether the protocol takes `name` as a member's (core's `parseGangState`): an owner's longer name is skipped. */
export const isGangProtocolName = (name: string) => name !== "" && name.length <= MAX_GANG_MEMBER_NAME_LENGTH;

export type GangStallKind = "problem" | "task" | "respect" | "earning";

/** How the report and the alert name the plan earning no respect past its bound (#374). */
export const GANG_EARNING_STALL_WHAT = "the rule's plan earning no respect past its estimate";

/**
 * Each kind's bound, and how the report and the alert name it. The plan earning no respect (#374): each stretch's own,
 * twice its estimate and 10 minutes (`GangStallStretch.withinMs`); the 10 minutes is the least.
 */
export const GANG_STALL_KINDS: readonly { kind: GangStallKind; withinMs: number; what: string }[] = [
  { kind: "problem", withinMs: GANG_PROBLEM_WITHIN_MS, what: "a gang worker's problem in every reading" },
  { kind: "task", withinMs: GANG_TASK_WITHIN_MS, what: "a member off the rule's task" },
  {
    kind: "respect",
    withinMs: GANG_RESPECT_FLAT_WITHIN_MS,
    what: "the gang's respect flat with the rule's members working",
  },
  { kind: "earning", withinMs: GANG_EARNING_MARGIN_MS, what: GANG_EARNING_STALL_WHAT },
];

/** A gang reading and the rule's plan on it. */
export interface GangStallReading {
  atMs: number;
  gang: GangInformation;
  members: readonly GangMemberReading[];
  problems: readonly string[];
  plan: GangPlan;
  /** The BitNode's `GangSoftcap` (core's `gangSoftcapOf`). */
  softcap: number;
}

/** A stall holding at a reading: since `fromMs` (where it started, a reading earlier for the task and respect). */
export interface GangStallCondition {
  key: string;
  kind: GangStallKind;
  fromMs: number;
  detail: string;
}

/** A stretch a stall held, from its start to the last reading showing it. */
export interface GangStallStretch {
  kind: GangStallKind;
  fromMs: number;
  toMs: number;
  detail: string;
  /**
   * The plan earning no respect (#374): the rule's estimate at the stretch's first reading (`gangTimeToEarningMs`), and
   * the stretch's bound, twice it and 10 minutes (`gangEarningBoundMs`); absent for the other kinds (`withinMsOf`).
   */
  estimateMs?: number;
  withinMs?: number;
}

/** Each member's task by the plan: its assignments, and its recruits, set to train at once (../gang.ts). */
function tasksOf(plan: GangPlan, isHacking: boolean): Map<string, string> {
  const tasks = new Map(plan.assignments.map(({ name, task }) => [name, task]));
  for (const name of plan.recruit) tasks.set(name, gangTrainingTask(isHacking));
  return tasks;
}

/**
 * The respect a cycle the plan's tasks earn, by the formulas at the reading's figures (the wanted penalty with them):
 * the rule's members only, as the brain sends their tasks (an owner's longer name is left as it is, ../gang.ts).
 */
export function gangPlannedRespectPerCycle(reading: Omit<GangStallReading, "atMs" | "problems">): number {
  const { gang, members, plan, softcap } = reading;
  const planned = tasksOf(plan, gang.isHacking);
  return members.reduce((sum, member) => {
    const task = planned.get(member.name);
    return task === undefined || !isGangProtocolName(member.name) || !GANG_TASK_NAMES.includes(task)
      ? sum
      : sum + gangRespectPerCycle(gang, member, gangTask(task), softcap);
  }, 0);
}

/**
 * Whether the plan has nobody working (#374): each of the rule's members training, on justice or on Territory Warfare,
 * and its recruits training; false with nobody of the rule's at all. A member working on a task that earns no respect
 * (under the money objective, one whose respect and wanted are both 0) is left to the respect stall, which expects none
 * of it either: a corner the rule's money tasks don't reach while respect covers wanted.
 */
export function gangPlanEarnsNone(plan: Pick<GangPlan, "assignments" | "recruit">): boolean {
  const rules = plan.assignments.filter((each) => isGangProtocolName(each.name));
  return rules.length + plan.recruit.length > 0 && rules.every((each) => each.role !== "working");
}

/** The rule's time until the reading's plan earns respect (#374, core's `gangTimeToEarningMs`), on what it read. */
export function gangEarningEstimateOf(reading: Omit<GangStallReading, "atMs" | "problems">): GangEarningEstimate {
  const { gang, members, plan, softcap } = reading;
  const figures = { respect: gang.respect, wantedLevel: gang.wantedLevel, territory: gang.territory };
  return gangTimeToEarningMs({ gang: figures, isHacking: gang.isHacking, members, softcap }, plan);
}

/** The roles of the rule's members in the plan, counted: "3 training, 1 on justice". */
function describeRoles(plan: Pick<GangPlan, "assignments" | "recruit">): string {
  const counts = new Map<string, number>();
  for (const { name, role } of plan.assignments) {
    if (!isGangProtocolName(name)) continue;
    const label = role === "justice" ? "on justice" : role === "territory" ? "on Territory Warfare" : role;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (plan.recruit.length > 0) counts.set("recruited", plan.recruit.length);
  return [...counts].map(([label, count]) => `${count} ${label}`).join(", ");
}

/** The stalls holding at `now`, with `before` the gang reading before it (null: none, or a reading with no gang). */
export function gangStallsAt(before: GangStallReading | null, now: GangStallReading): GangStallCondition[] {
  const conditions: GangStallCondition[] = [];
  for (const problem of new Set(now.problems)) {
    conditions.push({ key: `problem:${problem}`, kind: "problem", fromMs: now.atMs, detail: problem });
  }
  const planned = tasksOf(now.plan, now.gang.isHacking);
  const ordered = before === null ? null : tasksOf(before.plan, before.gang.isHacking);
  for (const { name, task } of now.members) {
    if (!isGangProtocolName(name)) continue;
    const wanted = planned.get(name);
    if (wanted === undefined || task === wanted) continue;
    const given = ordered?.get(name);
    // The order the worker had since the reading before; a member new since (an owner's) has had none of it yet.
    if (ordered !== null && (given === undefined || task === given)) continue;
    conditions.push({
      key: `task:${name}`,
      kind: "task",
      fromMs: before?.atMs ?? now.atMs,
      detail: `${name} on ${task}, the rule's ${wanted}`,
    });
  }
  if (gangPlanEarnsNone(now.plan)) {
    // The bound and the detail are the watch's, from the estimate at the stretch's first reading (#374).
    conditions.push({ key: "earning", kind: "earning", fromMs: now.atMs, detail: "" });
  }
  if (before !== null && now.atMs - before.atMs >= 2 * PROCESS_MS) {
    const perCycle = gangPlannedRespectPerCycle(before);
    const perProcess = perCycle * GANG_CYCLES_PER_PROCESS;
    const rise = now.gang.respect - before.gang.respect;
    // A fall is an ascension's or a death's (`Gang.ts:390-404`, `:371-375`), the only ways down: not judged. A
    // process's worth too small for a double to show on the respect isn't expected to show.
    const shows = perProcess > Math.abs(before.gang.respect) * Number.EPSILON;
    if (rise >= 0 && shows && rise < perProcess) {
      const working = before.plan.assignments.filter((each) => each.role === "working").length;
      conditions.push({
        key: "respect",
        kind: "respect",
        fromMs: before.atMs,
        detail:
          `respect ${Math.round(before.gang.respect).toLocaleString("en-US")}, the rule's tasks expected to earn ` +
          `${((perCycle * 1000) / GANG_CYCLE_MS).toPrecision(3)}/s (${working} working)`,
      });
    }
  }
  return conditions;
}

/**
 * The stalls over a run of readings: each holding stretch, open while each reading shows it, closed (to `onClosed`)
 * on the first that doesn't, a reading with no gang, or a gap (`MEDIUM_SNAPSHOT_GAP_MS`): the reading after it is judged
 * as a first.
 */
export class GangStallWatch {
  readonly #open = new Map<string, GangStallStretch>();
  #before: GangStallReading | null = null;
  readonly #onClosed: (stretch: GangStallStretch) => void;

  constructor(onClosed: (stretch: GangStallStretch) => void = () => {}) {
    this.#onClosed = onClosed;
  }

  /** A gang reading, in order; null for one with no gang. */
  add(reading: GangStallReading | null): void {
    if (reading === null || (this.#before !== null && reading.atMs - this.#before.atMs > MEDIUM_SNAPSHOT_GAP_MS)) {
      this.#closeAll();
      this.#before = null;
      if (reading === null) return;
    }
    const conditions = gangStallsAt(this.#before, reading);
    const holding = new Set(conditions.map((each) => each.key));
    for (const [key, stretch] of this.#open) {
      if (holding.has(key)) continue;
      this.#open.delete(key);
      this.#onClosed(stretch);
    }
    for (const { key, kind, fromMs, detail } of conditions) {
      const open = this.#open.get(key);
      if (open !== undefined) open.toMs = reading.atMs;
      else if (kind !== "earning") this.#open.set(key, { kind, fromMs, toMs: reading.atMs, detail });
      else {
        // The plan's own estimate at its first reading (#374), its bound twice it and 10 minutes, kept for the stretch.
        const estimate = gangEarningEstimateOf(reading);
        this.#open.set(key, {
          kind,
          fromMs,
          toMs: reading.atMs,
          detail:
            `${describeRoles(reading.plan)}; the rule's estimate ${formatDuration(estimate.ms)} ` +
            `(${estimate.first ?? "nobody"} first), its bound ${formatDuration(estimate.boundMs)}`,
          estimateMs: estimate.ms,
          withinMs: estimate.boundMs,
        });
      }
    }
    this.#before = reading;
  }

  /** The stretches open now, to the last reading. */
  open(): GangStallStretch[] {
    return [...this.#open.values()].map((each) => ({ ...each }));
  }

  /** The open stretches at or past their bound: the stalls. */
  stalls(): GangStallStretch[] {
    return this.open().filter((each) => each.toMs - each.fromMs >= stretchWithinMs(each));
  }

  /**
   * The plan earning no respect at the last reading (#374): its stretch, from its first reading, with the rule's
   * estimate and bound; null while it earns (or with no gang read).
   */
  earningPause(): GangStallStretch | null {
    const open = this.#open.get("earning");
    return open === undefined ? null : { ...open };
  }

  #closeAll(): void {
    for (const stretch of this.#open.values()) this.#onClosed(stretch);
    this.#open.clear();
  }
}

/** The bound of `kind`. */
export function withinMsOf(kind: GangStallKind): number {
  return (GANG_STALL_KINDS.find((each) => each.kind === kind) as (typeof GANG_STALL_KINDS)[number]).withinMs;
}

/** A stretch's bound: its own (the plan earning no respect, #374), else its kind's. */
export function stretchWithinMs(stretch: Pick<GangStallStretch, "kind" | "withinMs">): number {
  return stretch.withinMs ?? withinMsOf(stretch.kind);
}
