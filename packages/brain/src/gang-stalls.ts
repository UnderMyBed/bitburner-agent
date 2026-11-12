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
//   The Red Pill's route in BN2.
// The live brain (../gang.ts, `GangRule`) and the run report feed it each gang reading in order; a reading with no
// gang (none formed, unread, absent, or outside BN2) ends every stretch.
import {
  GANG_CYCLE_MS,
  GANG_CYCLES_PER_PROCESS,
  GANG_TASK_NAMES,
  type GangInformation,
  type GangMemberReading,
  type GangPlan,
  gangRespectPerCycle,
  gangTask,
  gangTrainingTask,
  MAX_GANG_MEMBER_NAME_LENGTH,
} from "@bitburner-agent/core";

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

export type GangStallKind = "problem" | "task" | "respect";

/** Each kind's bound, and how the report and the alert name it. */
export const GANG_STALL_KINDS: readonly { kind: GangStallKind; withinMs: number; what: string }[] = [
  { kind: "problem", withinMs: GANG_PROBLEM_WITHIN_MS, what: "a gang worker's problem in every reading" },
  { kind: "task", withinMs: GANG_TASK_WITHIN_MS, what: "a member off the rule's task" },
  {
    kind: "respect",
    withinMs: GANG_RESPECT_FLAT_WITHIN_MS,
    what: "the gang's respect flat with the rule's members working",
  },
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
  if (before !== null && now.atMs - before.atMs >= 2 * PROCESS_MS) {
    const perCycle = gangPlannedRespectPerCycle(before);
    const perProcess = perCycle * GANG_CYCLES_PER_PROCESS;
    const rise = now.gang.respect - before.gang.respect;
    // A fall is an ascension's or a death's (`Gang.ts:390-404`, `:291-303`), the only ways down: not judged. A
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
 * on the first that doesn't, or a reading with no gang.
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
    if (reading === null) {
      this.#closeAll();
      this.#before = null;
      return;
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
      if (open === undefined) this.#open.set(key, { kind, fromMs, toMs: reading.atMs, detail });
      else open.toMs = reading.atMs;
    }
    this.#before = reading;
  }

  /** The stretches open now, to the last reading. */
  open(): GangStallStretch[] {
    return [...this.#open.values()].map((each) => ({ ...each }));
  }

  /** The open stretches at or past their bound: the stalls. */
  stalls(): GangStallStretch[] {
    return this.open().filter((each) => each.toMs - each.fromMs >= withinMsOf(each.kind));
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
