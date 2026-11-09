/**
 * The brain's gang rule (#325, slice G1 of #324): who is recruited and each member's task, from the game's formulas
 * (./gang.ts). "A gang that grows", not optimal play: no ascension (G2), equipment (G3) or territory (G4) yet.
 * - **The objective:** while recruiting matters (under 12 members), respect less wanted level, a cycle, the respect
 *   taken with no wanted penalty. The penalty, respect / (respect + wanted) (`Gang.ts:357-359`), scales what the gang
 *   earns: with R its respect a cycle before the penalty and W its wanted, both stocks grow until respect × penalty +
 *   wanted ≈ respect, so the penalty settles at about 1 − W/R (about: the penalty sits inside the respect's softcap
 *   exponent, 0.83 in BN2 at 1/7 territory, `formulas.ts:27`). What the gang keeps of a member is then about its
 *   respect less its wanted. Scored with the penalty at 1, a member's choice doesn't swing with the gang's wanted level
 *   of the moment, which wanted control looks after. With 12 members: money, from the tasks whose respect covers their
 *   wanted, so the penalty doesn't grow.
 * - **Training:** a member trains (Train Hacking in a hacking gang, Train Combat in a combat one) while a minute's
 *   training, then work for the rest of `GANG_TRAINING_HORIZON_MS`, beats that time's work now. Training raises its
 *   levels by the game's exp formula (`GangMember.ts:155-210`, `:70-72`). With no ascension yet, the horizon is a fixed
 *   hour: G2's ascension replaces it with the time to the next one.
 * - **Wanted control:** the penalty's floor is respect / (respect + 1), the wanted level never falling below 1
 *   (`Gang.ts:164-166`). The share of output the penalty takes above that floor is (wanted − 1) / (respect + wanted);
 *   a member moved to a justice task costs about its own share, 1/N of N members', the bound (`gangLostShareBound`).
 *   Over the bound, members go to the justice task that lowers wanted most for each (Ethical Hacking or Vigilante
 *   Justice) until the gang's wanted level falls, its justice members' decay counted (`Gang.ts:157-167`): those on
 *   justice already first, then the weakest working, then the weakest training (all training, wanted would stay put).
 *   The run report judges the same: over the bound with the wanted level not falling. Members on justice stay there
 *   until the share is under half the bound (`GANG_JUSTICE_RELEASE`), so none flips at the bound every 10 s.
 * - **Recruits:** as many as the respect allows (`Gang.ts:325-334`), named `member-01` to `member-12`, the first
 *   names free, each set to train at once.
 */
import {
  GANG_CYCLE_MS,
  GANG_CYCLES_PER_PROCESS,
  GANG_JUSTICE_DECAY_PER_PROCESS,
  GANG_MOST_MEMBERS,
  GANG_TASK_NAMES,
  type GangFigures,
  type GangMemberFigures,
  type GangTask,
  gangMemberAfter,
  gangMoneyPerCycle,
  gangRecruitsAllowed,
  gangRespectPerCycle,
  gangTask,
  gangTasksFor,
  gangWantedPerCycle,
  TRAIN_COMBAT_TASK,
  TRAIN_HACKING_TASK,
} from "./gang.ts";

/** The horizon training must pay back within (#325): an hour, until G2's ascension gives the real one. */
export const GANG_TRAINING_HORIZON_MS = 60 * 60_000;
/** The step of training the rule weighs against working: a minute. */
export const GANG_TRAINING_STEP_MS = 60_000;
/** The share of the bound under which members on justice go back to work (#325's review): half, the hysteresis. */
export const GANG_JUSTICE_RELEASE = 0.5;

/** What the rule reads of the gang: the formulas' figures, its kind, and its members. */
export interface GangRuleInputs {
  gang: GangFigures;
  isHacking: boolean;
  members: readonly GangMemberFigures[];
  /** The BitNode's `GangSoftcap` (`gangSoftcapOf`). */
  softcap: number;
}

export type GangObjective = "respect" | "money";

/** Why a member has its task: training, working for the objective, or on justice for the wanted level. */
export type GangRole = "training" | "working" | "justice";

/** A member's choice, with the figures behind it, per cycle. */
export interface GangAssignment {
  name: string;
  task: string;
  role: GangRole;
  /**
   * The objective's figure of its best work task now, with no wanted penalty: respect less wanted, or money ($); 0 with
   * none positive.
   */
  value: number;
  /** The best work task now, whatever the member does. */
  bestTask: string;
}

/** The rule's answer: the objective, each member's task, the recruits to make, and the wanted control's figures. */
export interface GangPlan {
  objective: GangObjective;
  assignments: GangAssignment[];
  /** The names to recruit now, in order: as many as the respect allows. */
  recruit: string[];
  /** The share of output the penalty takes above its floor: (wanted − 1) / (respect + wanted). */
  lostShare: number;
  /** The bound on it: one member's share of the output, 1/N of N members (`gangLostShareBound`). */
  bound: number;
}

/** The names the rule gives recruits, in order: `member-01` to `member-12`. */
export const GANG_MEMBER_NAMES: readonly string[] = Array.from(
  { length: GANG_MOST_MEMBERS },
  (_, index) => `member-${String(index + 1).padStart(2, "0")}`,
);

/**
 * The share of output the penalty takes above its floor of respect / (respect + 1): (wanted − 1) / (respect + wanted).
 */
export function gangLostShare({ respect, wantedLevel }: Pick<GangFigures, "respect" | "wantedLevel">): number {
  return Math.max(0, wantedLevel - 1) / (respect + wantedLevel);
}

/** The bound the lost share is held under (#325): one member's share of the output, 1/N, with N at least 1. */
export function gangLostShareBound(members: number): number {
  return 1 / Math.max(1, members);
}

/** The objective: respect while recruiting matters (under 12), money with 12. */
export function gangObjectiveOf(members: number): GangObjective {
  return members < GANG_MOST_MEMBERS ? "respect" : "money";
}

/** The training task of the gang's kind. */
export function gangTrainingTask(isHacking: boolean): string {
  return isHacking ? TRAIN_HACKING_TASK : TRAIN_COMBAT_TASK;
}

/** The tasks that earn: respect or money, not justice, training or territory warfare. */
function workTasks(isHacking: boolean): GangTask[] {
  return gangTasksFor(isHacking).filter((each) => each.baseWanted >= 0 && (each.baseRespect > 0 || each.baseMoney > 0));
}

/** The tasks that lower the wanted level. */
function justiceTasks(isHacking: boolean): GangTask[] {
  return gangTasksFor(isHacking).filter((each) => each.baseWanted < 0);
}

/** Whether `taskName` lowers the wanted level: a member on it is on justice. */
export function isGangJusticeTask(taskName: string): boolean {
  return GANG_TASK_NAMES.includes(taskName) && gangTask(taskName).baseWanted < 0;
}

/**
 * The objective's figure of `task` for `member`: respect less wanted, or money where respect covers wanted. Respect
 * and money with no wanted penalty (wanted level 0 in the formulas, `formulas.ts:11-13`): see the objective above.
 */
function objectiveFigure(
  { gang, softcap }: GangRuleInputs,
  member: GangMemberFigures,
  task: GangTask,
  objective: GangObjective,
): number {
  const unpenalised = { ...gang, wantedLevel: 0 };
  const respect = gangRespectPerCycle(unpenalised, member, task, softcap);
  const wanted = gangWantedPerCycle(gang, member, task);
  if (objective === "respect") return respect - wanted;
  return respect >= wanted ? gangMoneyPerCycle(unpenalised, member, task, softcap) : 0;
}

/** The member's best work task now and its figure (0 and the first task with none positive). */
export function gangBestWork(
  inputs: GangRuleInputs,
  member: GangMemberFigures,
  objective: GangObjective,
): { task: GangTask; value: number } {
  const candidates = workTasks(inputs.isHacking);
  let best = { task: candidates[0] as GangTask, value: 0 };
  for (const each of candidates) {
    const value = objectiveFigure(inputs, member, each, objective);
    if (value > best.value) best = { task: each, value };
  }
  return best;
}

/**
 * Whether the member trains (#325): a minute's training, then work for the rest of the horizon, beats the horizon's
 * work now; or nothing earns now at all.
 */
export function gangTrains(inputs: GangRuleInputs, member: GangMemberFigures, objective: GangObjective): boolean {
  const now = gangBestWork(inputs, member, objective).value;
  if (now <= 0) return true;
  const trained = gangMemberAfter(
    member,
    gangTask(gangTrainingTask(inputs.isHacking)),
    GANG_TRAINING_STEP_MS / GANG_CYCLE_MS,
  );
  const after = gangBestWork(inputs, trained, objective).value;
  return after * (GANG_TRAINING_HORIZON_MS - GANG_TRAINING_STEP_MS) > now * GANG_TRAINING_HORIZON_MS;
}

/** The justice task that lowers the member's wanted most, and by how much a cycle (negative). */
function bestJustice(inputs: GangRuleInputs, member: GangMemberFigures): { task: GangTask; wanted: number } {
  let best: { task: GangTask; wanted: number } | null = null;
  for (const each of justiceTasks(inputs.isHacking)) {
    const wanted = gangWantedPerCycle(inputs.gang, member, each);
    if (best === null || wanted < best.wanted) best = { task: each, wanted };
  }
  if (best === null) throw new Error("no justice task for this gang");
  return best;
}

/**
 * Whether the gang's wanted level falls a cycle with these tasks (`Gang.ts:157-167`): the members' gains, justice's
 * negative, less the justice members' decay, × (1 − 0.001 × J) each 10-cycle process.
 */
export function gangWantedFalls(gang: GangFigures, members: readonly GangMemberFigures[], tasks: string[]): boolean {
  const justice = tasks.filter(isGangJusticeTask).length;
  const decay = (gang.wantedLevel * GANG_JUSTICE_DECAY_PER_PROCESS * justice) / GANG_CYCLES_PER_PROCESS;
  const gains = members.reduce((sum, member, index) => sum + gangWantedPerCycle(gang, member, gangTask(tasks[index] as string)), 0);
  return gains - decay < 0;
}

/** Each member's task, and the recruits, by the rule above. `members` in the game's order, each with its task now. */
export function planGang(inputs: GangRuleInputs): GangPlan {
  const { gang, isHacking, members } = inputs;
  const objective = gangObjectiveOf(members.length);
  const training = gangTrainingTask(isHacking);
  const assignments: GangAssignment[] = members.map((member) => {
    const best = gangBestWork(inputs, member, objective);
    const trains = gangTrains(inputs, member, objective);
    return {
      name: member.name,
      task: trains ? training : best.task.name,
      role: trains ? "training" : "working",
      value: best.value,
      bestTask: best.task.name,
    };
  });

  // Wanted control: over the bound, members to justice until the wanted level falls; under it, those on justice kept
  // there until the share is under half the bound.
  const lostShare = gangLostShare(gang);
  const bound = gangLostShareBound(members.length);
  const byName = new Map(members.map((member) => [member.name, member]));
  const toJustice = (assignment: GangAssignment) => {
    assignment.task = bestJustice(inputs, byName.get(assignment.name) as GangMemberFigures).task.name;
    assignment.role = "justice";
  };
  const onJusticeNow = (assignment: GangAssignment) => isGangJusticeTask(byName.get(assignment.name)?.task ?? "");
  if (lostShare > bound) {
    const weakestFirst = (role: GangRole) =>
      assignments.filter((each) => each.role === role && !onJusticeNow(each)).sort((a, b) => a.value - b.value);
    const candidates = [...assignments.filter(onJusticeNow), ...weakestFirst("working"), ...weakestFirst("training")];
    for (const assignment of candidates) {
      const tasks = assignments.map((each) => each.task);
      if (gangWantedFalls(gang, members, tasks)) break;
      toJustice(assignment);
    }
  } else if (lostShare > bound * GANG_JUSTICE_RELEASE) {
    for (const assignment of assignments.filter(onJusticeNow)) toJustice(assignment);
  }

  const taken = new Set(members.map((member) => member.name));
  const recruit = GANG_MEMBER_NAMES.filter((name) => !taken.has(name)).slice(
    0,
    gangRecruitsAllowed(gang.respect, members.length),
  );
  return { objective, assignments, recruit, lostShare, bound };
}
