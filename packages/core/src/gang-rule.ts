/**
 * The brain's gang rule (#325, slice G1 of #324): who is recruited and each member's task, from the game's formulas
 * (./gang.ts). "A gang that grows", not optimal play: no ascension (G2), equipment (G3) or territory (G4) yet.
 * - **The objective:** while recruiting matters (under 12 members), respect less wanted level, a cycle. Respect and
 *   wanted both grow, and the penalty respect / (respect + wanted) (`Gang.ts:357-359`) multiplies the respect earned,
 *   so in the long run it settles where respect × penalty + wanted = respect: penalty = 1 − wanted / respect. What the
 *   gang keeps of a member's respect is its respect less its wanted. With 12 members: money, from the tasks whose
 *   respect covers their wanted, so the penalty doesn't grow.
 * - **Training:** a member trains (Train Hacking in a hacking gang, Train Combat in a combat one) while a minute's
 *   training, then work for the rest of `GANG_TRAINING_HORIZON_MS`, beats that time's work now. Training raises its
 *   levels by the game's exp formula (`GangMember.ts:155-210`, `:70-72`). With no ascension yet, the horizon is a fixed
 *   hour: G2's ascension replaces it with the time to the next one.
 * - **Wanted control:** the penalty's floor is respect / (respect + 1), the wanted level never falling below 1
 *   (`Gang.ts:164-166`). The share of output the penalty takes above that floor is (wanted − 1) / (respect + wanted);
 *   a member moved to a justice task costs about its own share, 1/N of N members'. So the k-th weakest working member
 *   goes to the justice task that lowers wanted most for it (Ethical Hacking or Vigilante Justice) while that share is
 *   over k/N and the gang's wanted is still rising, its justice members' decay counted (`Gang.ts:157-167`).
 * - **Recruits:** as many as the respect allows (`Gang.ts:325-334`), named `member-01` to `member-12`, the first
 *   names free, each set to train at once.
 */
import {
  GANG_CYCLE_MS,
  GANG_CYCLES_PER_PROCESS,
  GANG_JUSTICE_DECAY_PER_PROCESS,
  GANG_MOST_MEMBERS,
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
  /** The objective's figure of its best work task now: respect less wanted, or money ($); 0 with none positive. */
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
  /** The bound on it for one member on justice: 1/N of N members (`gangLostShareBound`). */
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

/** The objective's figure of `task` for `member`: respect less wanted, or money where respect covers wanted. */
function objectiveFigure(
  { gang, softcap }: GangRuleInputs,
  member: GangMemberFigures,
  task: GangTask,
  objective: GangObjective,
): number {
  const respect = gangRespectPerCycle(gang, member, task, softcap);
  const wanted = gangWantedPerCycle(gang, member, task);
  if (objective === "respect") return respect - wanted;
  return respect >= wanted ? gangMoneyPerCycle(gang, member, task, softcap) : 0;
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

/** Each member's task, and the recruits, by the rule above. `members` in the game's order. */
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

  // Wanted control: the weakest working members first, each while the lost share is over its cumulative cost and the
  // wanted level would still rise.
  const lostShare = gangLostShare(gang);
  const bound = gangLostShareBound(members.length);
  const byName = new Map(members.map((member) => [member.name, member]));
  const wantedOf = (assignment: GangAssignment) =>
    gangWantedPerCycle(gang, byName.get(assignment.name) as GangMemberFigures, gangTask(assignment.task));
  const rising = () => {
    const justice = assignments.filter((each) => each.role === "justice").length;
    const decay = (gang.wantedLevel * GANG_JUSTICE_DECAY_PER_PROCESS * justice) / GANG_CYCLES_PER_PROCESS;
    return assignments.reduce((sum, each) => sum + wantedOf(each), 0) - decay > 0;
  };
  const weakestFirst = assignments.filter((each) => each.role === "working").sort((a, b) => a.value - b.value);
  for (const [index, assignment] of weakestFirst.entries()) {
    if (!(lostShare > (index + 1) * bound) || !rising()) break;
    assignment.task = bestJustice(inputs, byName.get(assignment.name) as GangMemberFigures).task.name;
    assignment.role = "justice";
  }

  const taken = new Set(members.map((member) => member.name));
  const recruit = GANG_MEMBER_NAMES.filter((name) => !taken.has(name)).slice(
    0,
    gangRecruitsAllowed(gang.respect, members.length),
  );
  return { objective, assignments, recruit, lostShare, bound };
}
