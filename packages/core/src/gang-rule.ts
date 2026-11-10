/**
 * The brain's gang rule (#325, slice G1 of #324): who is recruited and each member's task, from the game's formulas
 * (./gang.ts), when a member ascends (#328, G2), and what equipment it's bought (#330, G3). "A gang that grows", not
 * optimal play: no territory (G4) yet.
 * - **The objective:** while recruiting matters (under 12 members), respect less wanted level, a cycle, the respect
 *   taken with no wanted penalty. The penalty, respect / (respect + wanted) (`Gang.ts:357-359`), scales what the gang
 *   earns: with R its respect a cycle before the penalty and W its wanted, both stocks grow until respect × penalty +
 *   wanted ≈ respect, so the penalty settles at about 1 − W/R (about: the penalty sits inside the respect's softcap
 *   exponent, 0.83 in BN2 at 1/7 territory, `formulas.ts:27`). What the gang keeps of a member is then about its
 *   respect less its wanted. Scored with the penalty at 1, a member's choice doesn't swing with the gang's wanted level
 *   of the moment, which wanted control looks after. With 12 members: money, from the tasks whose respect covers their
 *   wanted, so the penalty doesn't grow.
 * - **Training:** a member trains (Train Hacking in a hacking gang, Train Combat in a combat one) while a minute's
 *   training, then work until its next ascension (`gangTimeToAscensionMs`, G2), beats that time's work now. Training
 *   raises its levels by the game's exp formula (`GangMember.ts:155-210`, `:70-72`); an ascension resets them.
 * - **Ascension (G2):** a member ascends when, over a horizon, its ascended self (bigger multipliers: faster training,
 *   higher levels, `GangMember.ts:262-320`, `formulas.ts:75-81`) out-earns it as it is by more than the cost: the
 *   respect lost (`Gang.ts:390-404`) and its toll on the others' output through the penalty
 *   (`gangAscensionAppraisal`, `gangAscensionCost`). The horizon is its cycle so far, the next taken as long
 *   (`gangCycleSoFarMs`). One a plan, none over the wanted bound, and none that leaves fewer recruits allowed
 *   (`gangAscensionToMake`).
 * - **Wanted control:** the penalty's floor is respect / (respect + 1), the wanted level never falling below 1
 *   (`Gang.ts:164-166`). The share of output the penalty takes above that floor is (wanted − 1) / (respect + wanted);
 *   a member moved to a justice task costs about its own share, 1/N of N members', the bound (`gangLostShareBound`).
 *   Over the bound, members go to the justice task that lowers wanted most for each (Ethical Hacking or Vigilante
 *   Justice) until the wanted level, at that pace, reaches the bound within `GANG_WANTED_RECOVERY_MS` (one justice
 *   member's time to halve it; `gangWantedRecovers`, the game's gains and justice decay, `Gang.ts:157-167`), or every
 *   member is on justice: those the rule put on justice stay (so the course only shortens), then those training
 *   (their output is none either way), then the weakest working. In bonus time the decay is 2.5 times slower a cycle
 *   (`GANG_BONUS_CYCLES_PER_PROCESS`). The run report judges the same, and the outcome too. Members the rule put on
 *   justice stay there until the share is under half the bound (`GANG_JUSTICE_RELEASE`), so none flips at the bound
 *   every 10 s; one the owner put there is the rule's to move.
 * - **Recruits:** as many as the respect allows (`Gang.ts:325-334`), named `member-01` to `member-12`, the first
 *   names free, each set to train at once.
 * - **Equipment (G3):** an upgrade is bought for a member when its gain to the member's output over a horizon beats its
 *   discounted cost (`Gang.ts:407-434`): both in dollars, the output the member's money figure, the cautious side
 *   under 12 members (`gangEquipmentAppraisal`). Lost on ascension (weapons, armour, vehicles, rootkits,
 *   `GangMember.ts:308-319`): while it works, over the time to its next ascension (G2's). Augmentations, kept:
 *   over a day (`GANG_AUGMENTATION_HORIZON_MS`). One a member a plan, the best payback first, within the money the
 *   brain leaves free (`planGangEquipment`).
 */
import {
  GANG_ASCENSION_EXP_LEFT_OUT,
  GANG_BONUS_CYCLES_PER_PROCESS,
  GANG_CYCLE_MS,
  GANG_CYCLES_PER_PROCESS,
  GANG_EQUIPMENT,
  GANG_JUSTICE_DECAY_PER_PROCESS,
  GANG_MOST_MEMBERS,
  GANG_STATS,
  GANG_TASK_NAMES,
  type GangAscensionResult,
  type GangEquipment,
  type GangFigures,
  type GangMemberFigures,
  type GangTask,
  gangAscensionResult,
  gangEquipmentCost,
  gangEquipmentKept,
  gangExpPerCycle,
  gangMemberAfter,
  gangMemberAscended,
  gangMemberEquipped,
  gangMemberOwns,
  gangMoneyPerCycle,
  gangRecruitsAllowed,
  gangRespectPerCycle,
  gangTask,
  gangTasksFor,
  gangWantedPenaltyOf,
  gangWantedPerCycle,
  MAX_GANG_MEMBER_NAME_LENGTH,
  TRAIN_COMBAT_TASK,
  TRAIN_HACKING_TASK,
} from "./gang.ts";

/**
 * The longest time to a member's next ascension the rule looks to (G2), training's horizon when its ascension doesn't
 * pay within it (`gangTimeToAscensionMs`): a day.
 */
export const GANG_ASCENSION_HORIZON_CAP_MS = 24 * 60 * 60_000;
/** The shares of a horizon a member's training is tried for, the rest worked (`gangOutputOver`): sixteenths. */
export const GANG_HORIZON_SPLITS = 16;
/**
 * The most of what an ascension converts that the 1,000 experience it leaves out may be (#328's review): a fifth. So a
 * training stat's experience of 5,000 or more: at the first ascension ×√2 or more (√(4,000 / 2,000)), after it
 * √(1 + 4,000 / P) or more with P points already (`formulas.ts:75-81`). A floor under the rule's own measure, so a
 * later change to the objective or the horizon can't let small ascensions through.
 */
export const GANG_ASCENSION_MOST_LEFT_OUT = 0.2;
/** The step of training the rule weighs against working: a minute. */
export const GANG_TRAINING_STEP_MS = 60_000;
/** The share of the bound under which members on justice go back to work (#325's review): half, the hysteresis. */
export const GANG_JUSTICE_RELEASE = 0.5;
/**
 * The time the rule gives the wanted level to come back to the bound (#325's re-review), and the run report its check:
 * one member on a justice task's time to halve it by the game's decay alone, × (1 − 0.001) each 2 s process
 * (`Gang.ts:161`): 1,385 s, about 23 min.
 */
export const GANG_WANTED_RECOVERY_MS =
  (GANG_CYCLES_PER_PROCESS * GANG_CYCLE_MS * Math.LN2) / -Math.log1p(-GANG_JUSTICE_DECAY_PER_PROCESS);

/** What the rule reads of the gang: the formulas' figures, its kind, and its members. */
export interface GangRuleInputs {
  gang: GangFigures;
  isHacking: boolean;
  members: readonly GangMemberFigures[];
  /** The BitNode's `GangSoftcap` (`gangSoftcapOf`). */
  softcap: number;
  /**
   * The members the rule put on justice in its last plan: those of them still on a justice task are kept there, the
   * hysteresis. None given (a brain just started, the run report): none kept.
   */
  placedOnJustice?: readonly string[];
  /** The gang in bonus time (`gangInBonusTime`): its decay is slower a cycle. */
  bonusTime?: boolean;
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
  /** The time to its next ascension, its training's horizon (`gangTimeToAscensionMs`), ms: 0 when it pays now. */
  nextAscensionMs: number;
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
  /** The member to ascend now (G2, `gangAscensionToMake`), before the tasks are set, or null. */
  ascend: GangAscensionAppraisal | null;
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
 * work now; or nothing earns now at all. The horizon (G2): the time to the member's next ascension
 * (`gangTimeToAscensionMs`), which resets its levels; never under the minute's step.
 */
export function gangTrains(
  inputs: GangRuleInputs,
  member: GangMemberFigures,
  objective: GangObjective,
  horizonMs: number,
): boolean {
  const now = gangBestWork(inputs, member, objective).value;
  if (now <= 0) return true;
  const horizon = Math.max(horizonMs, GANG_TRAINING_STEP_MS);
  const trained = gangMemberAfter(
    member,
    gangTask(gangTrainingTask(inputs.isHacking)),
    GANG_TRAINING_STEP_MS / GANG_CYCLE_MS,
  );
  const after = gangBestWork(inputs, trained, objective).value;
  return after * (horizon - GANG_TRAINING_STEP_MS) > now * horizon;
}

/**
 * The best a member earns over `cycles` (G2), in the objective's units (`gangBestWork`'s figure × cycles): training
 * for a share of them, then working the rest, the best of `GANG_HORIZON_SPLITS` shares (0, 1/16, … 15/16). The
 * experience work gives is left out: a work task's difficulty^0.9 is a tenth of training's or less (`GangMember.ts
 * :155-210`, Phishing 3.5 against Train Hacking's 45).
 */
export function gangOutputOver(
  inputs: GangRuleInputs,
  member: GangMemberFigures,
  objective: GangObjective,
  cycles: number,
): number {
  const training = gangTask(gangTrainingTask(inputs.isHacking));
  let best = 0;
  for (let split = 0; split < GANG_HORIZON_SPLITS; split += 1) {
    const trainingCycles = (cycles * split) / GANG_HORIZON_SPLITS;
    const trained = split === 0 ? member : gangMemberAfter(member, training, trainingCycles);
    best = Math.max(best, gangBestWork(inputs, trained, objective).value * (cycles - trainingCycles));
  }
  return best;
}

/**
 * How long the member's cycle has run, since its recruit or last ascension (G2), read from what the game keeps of it
 * (the reading has no clock): its training time, the training stats' experience over training's pace now
 * (`gangExpPerCycle`), and its working time, its earned respect (reset by an ascension, `GangMember.ts:315-316`) over
 * its best work's respect a cycle at the gang's penalty now. Approximate, not a bound either way: work's own
 * experience counts as training time, and time on justice and the penalty's swings are left out.
 */
export function gangCycleSoFarMs(inputs: GangRuleInputs, member: GangMemberFigures): number {
  const training = gangTask(gangTrainingTask(inputs.isHacking));
  const pace = gangExpPerCycle(member, training);
  let exp = 0;
  let rate = 0;
  for (const stat of GANG_STATS) {
    if (training[`${stat}Weight`] === 0) continue;
    exp += member[`${stat}_exp`];
    rate += pace[stat];
  }
  const trainingCycles = rate > 0 ? exp / rate : 0;
  const respect = gangWorkRespectPerCycle(inputs, member);
  const workingCycles = respect > 0 ? member.earnedRespect / respect : 0;
  return (trainingCycles + workingCycles) * GANG_CYCLE_MS;
}

/** The respect a cycle of the member's best work for respect earns, at the gang's penalty now (`formulas.ts:15-31`). */
export function gangWorkRespectPerCycle(inputs: GangRuleInputs, member: GangMemberFigures): number {
  const work = gangBestWork(inputs, member, "respect").task;
  return gangRespectPerCycle(inputs.gang, member, work, inputs.softcap);
}

/** What an ascension of a member would give and cost over the horizon (G2), in the objective's units. */
export interface GangAscensionAppraisal {
  name: string;
  /** The game's ascension result: the respect lost and each stat's multiplier after over before. */
  result: GangAscensionResult;
  /** The horizon, ms: the member's cycle so far (`gangCycleSoFarMs`), the next one taken as long. */
  horizonMs: number;
  /** The ascended member's best output over the horizon less the member's as it is (`gangOutputOver`). */
  gain: number;
  /** The respect lost (under the respect objective) and the penalty's toll on the others (`gangAscensionCost`). */
  cost: number;
  /** Whether it converts enough: a training stat's experience 5,000 or more (`gangAscensionConvertsEnough`). */
  convertsEnough: boolean;
  /** It converts enough, and the gain beats the cost. */
  pays: boolean;
}

/**
 * The cost of the member's ascension over `cycles` (G2), in the objective's units:
 * - **the respect lost**, its earned respect (`Gang.ts:390-393`): under the respect objective, respect itself, the
 *   stock that buys recruits (`Gang.ts:316-323`); with 12 members, no more;
 * - **the penalty's toll**: the gang's respect falls to max(1, respect − earned), so the penalty respect / (respect +
 *   wanted) does (`formulas.ts:11-13`), and every other member's output with it (respect and money both,
 *   `formulas.ts:28`, `:72`), until the others earn the respect back at their pace then, at most the horizon: charged
 *   in full until then, an overestimate.
 */
export function gangAscensionCost(
  inputs: GangRuleInputs,
  member: GangMemberFigures,
  objective: GangObjective,
  cycles: number,
): number {
  const { gang, softcap } = inputs;
  const after = { ...gang, respect: Math.max(1, gang.respect - member.earnedRespect) };
  const others = inputs.members.filter((each) => each.name !== member.name);
  const outputAt = (figures: GangFigures) =>
    others.reduce((sum, each) => {
      if (!GANG_TASK_NAMES.includes(each.task)) return sum;
      const task = gangTask(each.task);
      return (
        sum +
        (objective === "respect"
          ? gangRespectPerCycle(figures, each, task, softcap)
          : gangMoneyPerCycle(figures, each, task, softcap))
      );
    }, 0);
  const regrowth = others.reduce(
    (sum, each) =>
      GANG_TASK_NAMES.includes(each.task) ? sum + gangRespectPerCycle(after, each, gangTask(each.task), softcap) : sum,
    0,
  );
  const lost = gang.respect - after.respect;
  const tollCycles = regrowth > 0 ? Math.min(cycles, lost / regrowth) : cycles;
  const toll = (outputAt(gang) - outputAt(after)) * tollCycles;
  return (objective === "respect" ? member.earnedRespect : 0) + toll;
}

/**
 * Whether the 1,000 experience an ascension leaves out is at most a fifth of what it converts (#328's review,
 * `GANG_ASCENSION_MOST_LEFT_OUT`): a stat the gang's training task trains has 5,000 experience or more.
 */
export function gangAscensionConvertsEnough(member: GangMemberFigures, isHacking: boolean): boolean {
  const training = gangTask(gangTrainingTask(isHacking));
  return GANG_STATS.some(
    (stat) =>
      training[`${stat}Weight`] > 0 &&
      member[`${stat}_exp`] >= GANG_ASCENSION_EXP_LEFT_OUT / GANG_ASCENSION_MOST_LEFT_OUT,
  );
}

/**
 * Whether ascending the member pays (G2): over the horizon, its ascended self's best output (`gangMemberAscended`,
 * with its bigger multipliers it trains faster, `GangMember.ts:155-210`, and its levels go higher for the same
 * experience, `:70-79`) less its own as it is, beats the cost (`gangAscensionCost`); the retraining's time is in the
 * gain, as the ascended member starts from level 1. Null when the game wouldn't ascend it. The horizon: the member's
 * cycle so far, the next taken as long (`gangCycleSoFarMs`); its next would be longer, as its multipliers grow. The
 * ascended member's own output is valued at the gang's respect after the ascension (#328's review): scored with no
 * wanted penalty, as G1 scores work, the respect doesn't move it today. And it pays only if it converts enough
 * (`gangAscensionConvertsEnough`), so the time to the next ascension waits for that too.
 */
export function gangAscensionAppraisal(
  inputs: GangRuleInputs,
  member: GangMemberFigures,
  objective: GangObjective,
  horizonMs = gangCycleSoFarMs(inputs, member),
): GangAscensionAppraisal | null {
  const result = gangAscensionResult(member);
  if (result === null) return null;
  const cycles = horizonMs / GANG_CYCLE_MS;
  const after = { ...inputs, gang: { ...inputs.gang, respect: Math.max(1, inputs.gang.respect - result.respect) } };
  const gain =
    gangOutputOver(after, gangMemberAscended(member), objective, cycles) -
    gangOutputOver(inputs, member, objective, cycles);
  const cost = gangAscensionCost(inputs, member, objective, cycles);
  const convertsEnough = gangAscensionConvertsEnough(member, inputs.isHacking);
  return {
    name: member.name,
    result,
    horizonMs,
    gain,
    cost,
    convertsEnough,
    pays: convertsEnough && gain > cost && gain > 0,
  };
}

/**
 * The time to the member's next ascension (G2), the horizon its training pays back within (`gangTrains`): working from
 * now, the time until its ascension pays (`gangAscensionAppraisal`), its cycle and its earned respect growing at its
 * best work's pace (`gangWorkRespectPerCycle`), its levels as they are (work's experience left out, as in
 * `gangOutputOver`). Working, as training asks whether to stop now and work until then. Searched by doubling from a
 * minute, then halving to within a minute; `GANG_ASCENSION_HORIZON_CAP_MS` if it doesn't pay within that; 0 if now.
 */
export function gangTimeToAscensionMs(
  inputs: GangRuleInputs,
  member: GangMemberFigures,
  objective: GangObjective,
): number {
  const cycleMs = gangCycleSoFarMs(inputs, member);
  const respect = gangWorkRespectPerCycle(inputs, member);
  const paysAfter = (ms: number) => {
    const worked = { ...member, earnedRespect: member.earnedRespect + (respect * ms) / GANG_CYCLE_MS };
    return gangAscensionAppraisal(inputs, worked, objective, cycleMs + ms)?.pays === true;
  };
  if (paysAfter(0)) return 0;
  let low = 0;
  let high = GANG_TRAINING_STEP_MS;
  while (!paysAfter(high)) {
    if (high >= GANG_ASCENSION_HORIZON_CAP_MS) return GANG_ASCENSION_HORIZON_CAP_MS;
    low = high;
    high = Math.min(2 * high, GANG_ASCENSION_HORIZON_CAP_MS);
  }
  while (high - low > GANG_TRAINING_STEP_MS) {
    const middle = (low + high) / 2;
    if (paysAfter(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/**
 * The member to ascend now, if any (G2): of those whose ascension pays (`gangAscensionAppraisal`), the one that gains
 * the most over its cost; one at a time, so each is judged on the gang's respect as the last left it. None that would
 * leave the penalty's share above its floor (`gangLostShare`) over the bound with the recruits the plan makes too,
 * 1/(N + recruits) (#328's review: the plan recruits them before the worker ascends), so none while it's over
 * already, when wanted control puts members on justice (the respect lost only raises it); no member on justice (its
 * justice would start again from level 1); none that would leave fewer recruits allowed than now
 * (`gangRecruitsAllowed`): the respect a recruit due needs; and none whose name the protocol can't carry (over 64
 * characters, an owner's), which the brain could never order, so it would hold back every other.
 */
export function gangAscensionToMake(inputs: GangRuleInputs, objective: GangObjective): GangAscensionAppraisal | null {
  const { gang, members } = inputs;
  const recruitsNow = gangRecruitsAllowed(gang.respect, members.length);
  const bound = gangLostShareBound(members.length + recruitsNow);
  let best: GangAscensionAppraisal | null = null;
  for (const member of members) {
    if (member.name === "" || member.name.length > MAX_GANG_MEMBER_NAME_LENGTH) continue;
    if (isGangJusticeTask(member.task)) continue;
    const respect = Math.max(1, gang.respect - member.earnedRespect);
    if (gangLostShare({ respect, wantedLevel: gang.wantedLevel }) > bound) continue;
    if (gangRecruitsAllowed(respect, members.length) < recruitsNow) continue;
    const appraisal = gangAscensionAppraisal(inputs, member, objective);
    if (appraisal === null || !appraisal.pays) continue;
    if (best === null || appraisal.gain - appraisal.cost > best.gain - best.cost) best = appraisal;
  }
  return best;
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
 * The wanted level after `cycles` with these tasks (`Gang.ts:157-167`): the members' gains g a cycle (justice's
 * negative), and the justice members' decay, × (1 − 0.001 × J) each process, 10 cycles, k = 0.0001 × J a cycle; in
 * bonus time 25 (`Gang.ts:100-104`), k = 0.00004 × J. So W' = g − kW: W(t) = g/k + (W − g/k)e^(−kt), or W + gt with
 * none on justice; never below the floor of 1.
 */
export function gangWantedAfter(
  gang: GangFigures,
  members: readonly GangMemberFigures[],
  tasks: readonly string[],
  cycles: number,
  bonusTime = false,
): number {
  const justice = tasks.filter(isGangJusticeTask).length;
  const cyclesPerProcess = bonusTime ? GANG_BONUS_CYCLES_PER_PROCESS : GANG_CYCLES_PER_PROCESS;
  const k = (GANG_JUSTICE_DECAY_PER_PROCESS * justice) / cyclesPerProcess;
  const gains = members.reduce(
    (sum, member, index) => sum + gangWantedPerCycle(gang, member, gangTask(tasks[index] as string)),
    0,
  );
  const after =
    k === 0 ? gang.wantedLevel + gains * cycles : gains / k + (gang.wantedLevel - gains / k) * Math.exp(-k * cycles);
  return Math.max(1, after);
}

/** The wanted level at which the lost share is the bound: (wanted − 1)/(respect + wanted) = 1/N. */
export function gangWantedAtBound(gang: Pick<GangFigures, "respect">, members: number): number {
  const bound = gangLostShareBound(members);
  return bound >= 1 ? Number.POSITIVE_INFINITY : (bound * gang.respect + 1) / (1 - bound);
}

/** Whether, with these tasks, the wanted level reaches the bound within `GANG_WANTED_RECOVERY_MS`'s cycles. */
export function gangWantedRecovers(
  gang: GangFigures,
  members: readonly GangMemberFigures[],
  tasks: readonly string[],
  bonusTime = false,
): boolean {
  const cycles = GANG_WANTED_RECOVERY_MS / GANG_CYCLE_MS;
  return gangWantedAfter(gang, members, tasks, cycles, bonusTime) <= gangWantedAtBound(gang, members.length);
}

/** Each member's task, and the recruits, by the rule above. `members` in the game's order, each with its task now. */
export function planGang(given: GangRuleInputs): GangPlan {
  const objective = gangObjectiveOf(given.members.length);
  // The ascension first (G2): the rest of the plan is for the gang after it, the member ascended and the respect less.
  const ascend = gangAscensionToMake(given, objective);
  const inputs: GangRuleInputs =
    ascend === null
      ? given
      : {
          ...given,
          gang: { ...given.gang, respect: Math.max(1, given.gang.respect - ascend.result.respect) },
          members: given.members.map((member) =>
            member.name === ascend.name ? { ...gangMemberAscended(member), task: member.task } : member,
          ),
        };
  const { gang, isHacking, members } = inputs;
  const training = gangTrainingTask(isHacking);
  const assignments: GangAssignment[] = members.map((member) => {
    const best = gangBestWork(inputs, member, objective);
    const nextAscensionMs = gangTimeToAscensionMs(inputs, member, objective);
    const trains = gangTrains(inputs, member, objective, nextAscensionMs);
    return {
      name: member.name,
      task: trains ? training : best.task.name,
      role: trains ? "training" : "working",
      value: best.value,
      bestTask: best.task.name,
      nextAscensionMs,
    };
  });

  // Wanted control: over the bound, members to justice until the wanted level is on course back to it; under it,
  // those the rule put on justice kept there until the share is under half the bound.
  const lostShare = gangLostShare(gang);
  const bound = gangLostShareBound(members.length);
  const byName = new Map(members.map((member) => [member.name, member]));
  const toJustice = (assignment: GangAssignment) => {
    assignment.task = bestJustice(inputs, byName.get(assignment.name) as GangMemberFigures).task.name;
    assignment.role = "justice";
  };
  const placed = new Set(inputs.placedOnJustice ?? []);
  const onJusticeNow = (assignment: GangAssignment) =>
    placed.has(assignment.name) && isGangJusticeTask(byName.get(assignment.name)?.task ?? "");
  if (lostShare > bound) {
    // The rule's own stay: released as the wanted level falls, the course back would lengthen each round.
    for (const assignment of assignments.filter(onJusticeNow)) toJustice(assignment);
    const weakestFirst = (role: GangRole) =>
      assignments.filter((each) => each.role === role && !onJusticeNow(each)).sort((a, b) => a.value - b.value);
    for (const assignment of [...weakestFirst("training"), ...weakestFirst("working")]) {
      const tasks = assignments.map((each) => each.task);
      if (gangWantedRecovers(gang, members, tasks, inputs.bonusTime === true)) break;
      toJustice(assignment);
    }
  } else if (lostShare > bound * GANG_JUSTICE_RELEASE) {
    for (const assignment of assignments.filter(onJusticeNow)) toJustice(assignment);
  }

  const taken = new Set(members.map((member) => member.name));
  const recruit = GANG_MEMBER_NAMES.filter((name) => !taken.has(name)).slice(
    0,
    gangRecruitsAllowed(given.gang.respect, members.length),
  );
  return { objective, assignments, recruit, lostShare, bound, ascend };
}

/**
 * The horizon an augmentation's gain is counted over (G3, #330): a day, `GANG_ASCENSION_HORIZON_CAP_MS`, the longest
 * the rule forecasts a member, and so at least any lost item's (the time to the next ascension). Augmentations are kept
 * through ascensions (`GangMember.ts:308-319`) and installs (`Prestige.ts:133-147` cuts only the ascension points), so
 * they pay for longer; the gain past a day isn't counted, nor the later ascensions that make the member stronger in it
 * (`gangOutputOver` forecasts it unascended): both undercount, the cautious side.
 */
export const GANG_AUGMENTATION_HORIZON_MS = GANG_ASCENSION_HORIZON_CAP_MS;

/** What an upgrade would give a member over its horizon (G3), and what it costs, in dollars. */
export interface GangEquipmentAppraisal {
  /** The member's name. */
  name: string;
  equipment: string;
  /** An augmentation, kept on ascension; else lost at the member's next. */
  kept: boolean;
  /** Its cost now, with the gang's discount (`gangEquipmentCost`). */
  cost: number;
  /** The time its gain is counted over: the time to the member's next ascension, or a day for an augmentation. */
  horizonMs: number;
  /** The member's best money output over the horizon with it less without it, at the gang's wanted penalty now. */
  gain: number;
  /** The gain beats the cost. */
  pays: boolean;
}

/** The stats the gang's work and training tasks weigh: an upgrade on none of them gains nothing. */
function weighedStats(isHacking: boolean): Set<string> {
  const tasks = [...workTasks(isHacking), gangTask(gangTrainingTask(isHacking))];
  return new Set(GANG_STATS.filter((stat) => tasks.some((each) => each[`${stat}Weight`] > 0)));
}

/** The member's best money output over `horizonMs` (`gangOutputOver`), at the gang's wanted penalty now. */
function moneyOver(inputs: GangRuleInputs, member: GangMemberFigures, horizonMs: number): number {
  const cycles = horizonMs / GANG_CYCLE_MS;
  return cycles > 0 ? gangWantedPenaltyOf(inputs.gang) * gangOutputOver(inputs, member, "money", cycles) : 0;
}

/**
 * Whether the upgrade pays the member back within `horizonMs` (G3): over it, the member's best output with the upgrade
 * (`gangMemberEquipped`: higher levels, faster training, `GangMember.ts:141-210`, `:343-350`) less its best output
 * without, beats its cost now (`costMult`, the gang's `equipmentCostMult`, `Gang.ts:407-434`). The output is G2's
 * `gangOutputOver` (training a share of the horizon, then working) with G1's **money** figure, the member's best money
 * task whose respect covers its wanted, at the gang's wanted penalty now (`formulas.ts:72`; the penalty sits inside the
 * softcap's exponent, so this undercounts). Dollars against dollars: respect has no market price. Under 12 members the
 * rule prefers respect to that money, so it values the member's time at least as high, and a money payback undervalues
 * the gain then; with 12 members it's the objective itself.
 */
export function gangEquipmentAppraisal(
  inputs: GangRuleInputs,
  member: GangMemberFigures,
  item: GangEquipment,
  horizonMs: number,
  costMult: number,
  without = moneyOver(inputs, member, horizonMs),
): GangEquipmentAppraisal {
  const gain = moneyOver(inputs, gangMemberEquipped(member, item), horizonMs) - without;
  const cost = gangEquipmentCost(item, costMult);
  return {
    name: member.name,
    equipment: item.name,
    kept: gangEquipmentKept(item),
    cost,
    horizonMs,
    gain,
    pays: gain > cost && gain > 0,
  };
}

/** The equipment to buy now (G3), and what pays whatever the money. */
export interface GangEquipmentPlan {
  /** The money the purchases may spend: what the brain leaves free. */
  budget: number;
  /** Each member's upgrade that pays back soonest for its cost (the most gain a dollar), best first; one a member. */
  paying: GangEquipmentAppraisal[];
  /** Those of them the budget covers, best first, in order: the purchases to make now. */
  buy: GangEquipmentAppraisal[];
}

/**
 * The equipment to buy now (G3, #330), by `plan` (`planGang`'s, on the same inputs), within `budget` dollars, at the
 * gang's `costMult`:
 * - **lost on ascension** (weapons, armour, vehicles, rootkits, `GangMember.ts:308-319`): only for a member the plan
 *   has working, over the time to its next ascension, G2's forecast working from now (`gangTimeToAscensionMs`, the
 *   plan's `nextAscensionMs`, at most a day): what it earns until the item is lost. And only once its ascension
 *   converts enough (`gangAscensionConvertsEnough`, a training stat's 5,000 experience, under which G2 never ascends
 *   it): before that the forecast leaves out the training that soon brings it. A member training earns nothing, and
 *   G2's forecast for it, working from now, isn't when it ascends: in the BN2 hour's run, valued over it, rootkits
 *   were bought for members it gave 7 h, which ascended within the hour, and the gang ended with less respect (#330).
 *   G2 has it work before it ascends (it trains while a minute's training pays within that time, `gangTrains`), when
 *   it's bought. One on justice earns nothing either. None for the member the plan ascends, nor one whose ascension is
 *   due (0, held); a member whose ascension is close gets none, as nothing pays back in so short a time.
 * - **augmentations:** over `GANG_AUGMENTATION_HORIZON_MS`, a day, whatever the member's task: G2's own measure of
 *   what training then working gives over a horizon (`gangOutputOver`).
 * - A member `plan` has no assignment for (the run report's, which reads the tasks): working unless on the training or
 *   a justice task, its forecast worked out here, only for one with a lost item that pays over a day (the most any
 *   forecast gives it, the gain growing with the time).
 * - Of each member's upgrades not owned that pay (`gangEquipmentAppraisal`), the one with the most gain for its cost; one
 *   a member a plan, so the next plan (10 s on) values the next upgrade on the member with this one. Then, best first,
 *   those the budget covers. None for a name the protocol can't carry (an owner's, over 64 characters).
 */
export function planGangEquipment(
  inputs: GangRuleInputs,
  plan: Pick<GangPlan, "assignments" | "ascend">,
  { budget, costMult }: { budget: number; costMult: number },
): GangEquipmentPlan {
  const weighed = weighedStats(inputs.isHacking);
  const relevant = GANG_EQUIPMENT.filter((item) => Object.keys(item.mults).some((stat) => weighed.has(stat)));
  const objective = gangObjectiveOf(inputs.members.length);
  const training = gangTrainingTask(inputs.isHacking);
  const paying: GangEquipmentAppraisal[] = [];
  for (const member of inputs.members) {
    if (member.name === "" || member.name.length > MAX_GANG_MEMBER_NAME_LENGTH) continue;
    if (member.name === plan.ascend?.name) continue;
    const assignment = plan.assignments.find((each) => each.name === member.name);
    const withoutOver = new Map<number, number>();
    const appraise = (item: GangEquipment, horizonMs: number) => {
      if (!withoutOver.has(horizonMs)) withoutOver.set(horizonMs, moneyOver(inputs, member, horizonMs));
      return gangEquipmentAppraisal(inputs, member, item, horizonMs, costMult, withoutOver.get(horizonMs) as number);
    };
    const working =
      assignment === undefined
        ? member.task !== training && !isGangJusticeTask(member.task)
        : assignment.role === "working";
    const forecast = working && gangAscensionConvertsEnough(member, inputs.isHacking);
    let lostHorizonMs: number | null = null;
    const lostHorizon = () => {
      lostHorizonMs ??= Math.max(0, assignment?.nextAscensionMs ?? gangTimeToAscensionMs(inputs, member, objective));
      return lostHorizonMs;
    };
    let best: GangEquipmentAppraisal | null = null;
    for (const item of relevant) {
      if (gangMemberOwns(member, item.name)) continue;
      let appraisal: GangEquipmentAppraisal;
      if (gangEquipmentKept(item)) appraisal = appraise(item, GANG_AUGMENTATION_HORIZON_MS);
      else {
        if (!forecast || !appraise(item, GANG_ASCENSION_HORIZON_CAP_MS).pays || lostHorizon() === 0) continue;
        appraisal = appraise(item, lostHorizon());
      }
      if (!appraisal.pays) continue;
      if (best === null || appraisal.gain / appraisal.cost > best.gain / best.cost) best = appraisal;
    }
    if (best !== null) paying.push(best);
  }
  paying.sort((a, b) => b.gain / b.cost - a.gain / a.cost);
  const buy: GangEquipmentAppraisal[] = [];
  let left = budget;
  for (const each of paying) {
    if (each.cost > left) continue;
    buy.push(each);
    left -= each.cost;
  }
  return { budget, paying, buy };
}
