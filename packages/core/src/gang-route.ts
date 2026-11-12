/**
 * BN2's route to The Red Pill (#357, planner v0, owner decision 67), slice 1: two choices the planner makes by an
 * estimated time, the rules proposing the candidates.
 *
 * **(1) Before the gang** (BN2, no gang yet, avmnite-02h's required level read): install now, or wait for the gang. Once
 * the gang forms Daedalus's count never counts (The Red Pill is the gang's faction's, `Faction/FactionHelpers.tsx:
 * 172-202`), so the rest of the route is the same either way, and each is scored by its time to the gang formed:
 * - **wait for the gang**, τ_g: the experience for avmnite-02h's level (`Server/data/servers.ts:1468-1486`, its roll)
 *   less the experience now, at the measured rate (`PersonObjects/formulas/skill.ts:7-15`, the brain's
 *   `hackingEtaSeconds` with the level multiplier read), plus `GANG_FORMING_STEPS_MS` for the backdoor, the invitation,
 *   the join and the forming (#363's seed 1);
 * - **install now**: the commit (`GANG_ROUTE_COMMIT_MS`, #343's) plus R, the level's experience from 0 (an install
 *   resets it, `Player.prestigeAugmentation()`, `Prestige.ts:69`) at the multipliers the install gives (core's `levellingInstallMultipliers`: the
 *   level's, the experience's and the speed's, which scales the operations' times, `Hacking.ts:60-80`) at the rate now.
 * The least wins; a tie goes to waiting. With no rate measured, installing now is held, as #343's income hold is; and,
 * as #343's is, while an invitation's money is held (#228); and while the gang's reading is unread in BN2 with no gang
 * known (the gang rule's "waiting": no reading yet, a worker's problem, a brain just restarted), when whether there's a
 * gang at all isn't known (#368's review).
 * Left out, each labelled:
 * - the money for the two port openers avmnite-02h needs (`numOpenPortsRequired` 2), where they're not bought yet: left
 *   out of τ_g, optimistic for waiting;
 * - the rate now after an install, though the money and the servers rebuild after it (`Prestige.ts:98`): optimistic for
 *   installing;
 * - the re-roll of avmnite-02h's level at the install (`Prestige.ts:98`, a new roll in 202-220) taken as today's: either
 *   way;
 * - on waiting's side, the install's multipliers come a cycle later: optimistic for waiting;
 * - the 70 s of steps after the level on installing's side: optimistic for installing;
 * - an install deletes home's programs (`Server/ServerHelpers.ts:227`), so the TOR router and the port openers are
 *   bought again, their money and time left out of R: optimistic for installing;
 * - the experience rate rising with the level (the operations' times fall as it rises, `Hacking.ts:66-70`), the
 *   10-minute window behind it: the rate's taken as measured, cautious for waiting.
 *
 * **(2) The gang's objective at 12 members** (`GANG_MOST_MEMBERS`): respect or money, each scored by the time to The Red
 * Pill's reputation at the gang's faction (`Augmentation/Augmentations.ts:1946-1952`, `augmentationCost`'s, less the
 * faction's now). Only respect earns it: respect gained × `faction_rep` × (1 + favour / 100) / 75 (`Gang/Gang.ts:
 * 144-155`, `Gang/data/Constants.ts:10`), the gang's faction taking no work or donations (`NetscriptFunctions/
 * Singularity.ts:808-810`, `:934-935`). The rate: the members' respect a cycle under that objective's plan (core's
 * `planGang` given the objective, so with its training, ascension, justice and warfare; `Gang/formulas/formulas.ts:
 * 15-31` at the gang's penalty now), × 5 cycles a second (`GANG_CYCLE_MS`). Left out, labelled:
 * - the members' growth: either way;
 * - the penalty's course, and each plan's training, ascension or warfare counted at once as no output (the plan's
 *   tasks now, at the penalty now): against the objective whose plan invests;
 * - bonus time's faster cycles: cautious for both;
 * - what money buys toward it (gang equipment, a `faction_rep` set at an install): cautious for money. In #357's A/B,
 *   G3 bought member-01 the eight hacking items on Money Laundering (`Gang/data/upgrades.ts:133-217`, ×2.2724 its
 *   hacking multiplier, `GangMember.ts:78-85`) within minutes: money's rate 161.8 a second at the choice, 319.6 after
 *   them; respect's still won, at 1,150.
 * The least wins; a tie goes to money, the rule's objective before #357. Under 12 it's respect (the rule's, recruiting);
 * once The Red Pill is bought, queued or installed it's money, as before, and said so. No hysteresis: a choice made on
 * one reading can flip on the next. A static probe (#368's review) flips it at respect 1,000, wanted 100 and hacking
 * 500 (respect's plan all on Ethical Hacking); dynamic probes at 2 million respect found no flapping in 24 hours, nor
 * in 2 hours from a penalty of 0.89.
 *
 * **(3) Installing with a gang** (slice 2), before The Red Pill is reached: keep the cycle, install now, or bank R* and
 * then install (`gangInstallTiming`), each scored by the time to The Red Pill's reputation at the gang's faction. An
 * install turns the faction's reputation r into favour (`Faction.ts:77-85`, `addRepToFavor`, `favor.ts:22-24`) and
 * zeroes it; the gang stays, each member's ascension points × 0.95 (`Prestige.ts:133-146`, `GangMember.ts:287-296`,
 * `Gang/data/Constants.ts:16`); the faction takes no work or donations, so favour only multiplies the rate (`Gang.ts:
 * 152-155`). With N The Red Pill's reputation, f the favour, g(x) = 1 + x/100, p the rate the members' points leave
 * (`gangInstallRateKept`) and s the set's `faction_rep` (`factionRepInstallMultiplier`), in reputation at the rate at
 * favour 0: keep (N − r) / g(f); install now (r_i − r) / g(f) + N / (g(f(r_i)) · p · s), r_i the reputation it
 * converts (r and the rate over the commit and the reading's age); bank (R* − r) / g(f) + N / (g(f(R*)) · p · s), R*
 * the least over R > r_i (`gangBankReputation`). It replaces the count rule (owner decision 51) and G5's 20-minute
 * hold in BN2 with a gang, the planner's (the brain's `bn2Route`). Its left-out terms are labelled at
 * `gangInstallTiming`.
 * Pure, so the brain's rules and the run report read the same figures.
 */
import { AUGMENTATIONS } from "./augmentation-data.ts";
import { NEUROFLUX_GOVERNOR } from "./augmentations.ts";
import { hackingExpOfLevel } from "./batcher.ts";
import { favorAfterInstall, favorToRep } from "./donations.ts";
import {
  GANG_CYCLE_MS,
  GANG_MOST_MEMBERS,
  GANG_STATS,
  type GangMemberFigures,
  gangAscensionMult,
  gangMemberAscended,
  gangRespectPerCycle,
  gangSkillLevel,
  gangTask,
} from "./gang.ts";
import { type GangObjective, type GangPlan, type GangRuleInputs, gangObjectiveOf, planGang } from "./gang-rule.ts";
import type { LevellingMultipliers } from "./levelling.ts";

/**
 * Who makes BN2's choices (#357): the planner, as main.ts has it; or (the A/B's baseline, a test's option alone) the
 * rules as before #357: #343's install timing before the gang, money at 12.
 */
export type Bn2Route = "planner" | "rules";

/** The server whose backdoor brings the gang's faction (NiteSec, `Faction/FactionInfo.tsx:464-466`) in BN2. */
export const GANG_ROUTE_SERVER = "avmnite-02h";
/**
 * The steps from avmnite-02h's level to the gang formed: the backdoor, the invitation, the join and the forming. 70 s,
 * #363's seed 1 (asked at once, backdoored 10 s later, invited 20 s, joined 10 s and formed 30 s after that). Since #357
 * the gang-start suite's seeds 1, 3 and 5 take 90, 60 and 60 s (the invitation's slow snapshot, a minute apart, the
 * spread): 70 s on average, a step's error either way.
 */
export const GANG_FORMING_STEPS_MS = 70_000;
/** An install's commit (#343's tables: about 2 minutes live): the purchases, the gate and the restart. */
export const GANG_ROUTE_COMMIT_MS = 2 * 60_000;
/** Respect to the gang's faction's reputation: 75 to 1 (`Gang/data/Constants.ts:10`, `Gang.ts:152-155`). */
export const GANG_RESPECT_PER_REPUTATION = 75;

/** What (1) reads: the experience and level now, avmnite-02h's level, the level multiplier and the measured rate. */
export interface GangFormingInputs {
  exp: number;
  level: number;
  required: number;
  /** The level multiplier (`mults.hacking` × the BitNode's `HackingLevelMultiplier`, `skill.ts:13`). */
  levelMult: number;
  /** The measured hacking experience a second, or null (not measured yet). */
  expPerSecond: number | null;
  /** What an install now would give levelling (core's `levellingInstallMultipliers` of what it installs). */
  gain: LevellingMultipliers;
  /** Whether an install now installs anything new: without, no install candidate (#343's guard). */
  installable: boolean;
  /** An overdue wait's measured error (#343's `tauScale`): each τ_g is multiplied by it; 1 for none. */
  tauScale?: number;
  /** An invitation's money held (#228's hold): installing now, which would spend it, held, as #343's is. */
  invitationHeld?: boolean;
  /** The gang's reading unread with no gang known (#368's review): whether there's a gang isn't known; held. */
  gangUnread?: boolean;
}

/** (1)'s estimates and the choice (#357). */
export interface GangFormingTiming {
  required: number;
  level: number;
  exp: number;
  levelMult: number;
  expPerSecond: number | null;
  gain: LevellingMultipliers;
  /** τ_g: the time to the gang formed waiting, ms (Infinity with no experience coming); null with no rate measured. */
  waitMs: number | null;
  /** R: the level's experience from 0 at the install's multipliers and the rate now, ms; null unmeasured. */
  rebuildMs: number | null;
  /** The commit and R, ms; null with nothing new to install, or no rate measured. */
  installNowMs: number | null;
  choice: "wait" | "install";
  /** Installing now held: no rate measured. */
  heldForRate: boolean;
  /** Installing now held: an invitation's money held (#228), as #343's. */
  heldForInvitation: boolean;
  /** Installing now held: the gang's reading unread with no gang known (#368's review). */
  heldForGangUnread: boolean;
  tauScale: number;
}

/**
 * The time, ms, from `exp` to `required` at `levelMult` and `expPerSecond` (`skill.ts:17-27`, `calculateExp`): 0 once
 * reached; Infinity with no experience coming; null unmeasured.
 */
export function gangLevelEtaMs(
  exp: number,
  required: number,
  levelMult: number,
  expPerSecond: number | null,
): number | null {
  const short = Math.max(0, hackingExpOfLevel(required, levelMult) - exp);
  if (short === 0) return 0;
  if (expPerSecond === null || !Number.isFinite(expPerSecond)) return null;
  return expPerSecond > 0 ? (short / expPerSecond) * 1000 : Number.POSITIVE_INFINITY;
}

/**
 * (1)'s choice (#357): install now only where its estimate is less than waiting's, and it isn't held (no rate measured,
 * or an invitation's money held); else wait (a tie, or either one unknown).
 */
export function gangFormingChoice(
  waitMs: number | null,
  installNowMs: number | null,
  held: boolean,
): "wait" | "install" {
  return !held && waitMs !== null && installNowMs !== null && installNowMs < waitMs ? "install" : "wait";
}

/** (1): wait for the gang, or install now (#357), by the time to the gang formed; a tie to waiting. */
export function gangFormingTiming(inputs: GangFormingInputs): GangFormingTiming {
  const { exp, level, required, levelMult, expPerSecond, gain, installable } = inputs;
  const tauScale = inputs.tauScale ?? 1;
  const toLevel = level >= required ? 0 : gangLevelEtaMs(exp, required, levelMult, expPerSecond);
  const waitMs = toLevel === null ? null : toLevel * tauScale + GANG_FORMING_STEPS_MS * tauScale;
  const rate = expPerSecond === null ? null : expPerSecond * gain.hackingExp * gain.hackingSpeed;
  const rebuildMs = gangLevelEtaMs(0, required, levelMult * gain.hacking, rate);
  const installNowMs = installable && rebuildMs !== null ? GANG_ROUTE_COMMIT_MS + rebuildMs : null;
  const heldForRate = expPerSecond === null;
  const heldForInvitation = inputs.invitationHeld === true;
  const heldForGangUnread = inputs.gangUnread === true;
  return {
    required,
    level,
    exp,
    levelMult,
    expPerSecond,
    gain,
    waitMs,
    rebuildMs,
    installNowMs,
    choice: gangFormingChoice(waitMs, installNowMs, heldForRate || heldForInvitation || heldForGangUnread),
    heldForRate,
    heldForInvitation,
    heldForGangUnread,
    tauScale,
  };
}

/** The gang's faction as (2) reads it: its reputation and favour, the player's `faction_rep`, and The Red Pill's. */
export interface GangRouteFaction {
  reputation: number;
  favor: number;
  factionRep: number;
  /** The Red Pill's reputation (`augmentationCost`'s, `Augmentations.ts:1946-1952`). */
  needed: number;
  /** The Red Pill bought, queued or installed: the objective is money, as before #357. */
  redPillOwned: boolean;
}

/** (2)'s estimate under one objective (#357). */
export interface GangObjectiveEstimate {
  objective: GangObjective;
  /** The members' respect a cycle under that objective's plan, at the gang's penalty now. */
  respectPerCycle: number;
  /** The gang's faction's reputation a second it earns: × 5 cycles a second × `faction_rep` × (1 + favour/100) / 75. */
  reputationPerSecond: number;
  /** To The Red Pill's reputation, ms: 0 once reached; Infinity with none earned. */
  etaMs: number;
}

/** (2)'s choice: the objective, why, and the two estimates where they're made. */
export interface GangObjectiveChoice {
  objective: GangObjective;
  /**
   * Under 12 members, the rule's respect (recruiting); The Red Pill bought, queued or installed, money; the gang's
   * faction unread, money (the rule's before #357), no estimates; else the estimates'.
   */
  reason: "recruiting" | "The Red Pill owned" | "unread" | "estimates";
  respect: GangObjectiveEstimate | null;
  money: GangObjectiveEstimate | null;
}

/**
 * The members' respect a cycle under `objective`'s plan (`planGang` given it): each member's task's respect
 * (`formulas.ts:15-31`) at the gang's penalty now, the plan's ascension made first (the member ascended, the gang's
 * respect less what it costs), as the plan itself is for the gang after it.
 */
export function gangRespectUnder(inputs: GangRuleInputs, objective: GangObjective): number {
  return gangRespectOfPlan(inputs, planGang(inputs, objective));
}

/** `gangRespectUnder` of a plan made already (the gang rule's, #357's (3)): its ascension first, then its tasks. */
export function gangRespectOfPlan(inputs: GangRuleInputs, plan: GangPlan): number {
  const ascend = plan.ascend;
  const gang =
    ascend === null
      ? inputs.gang
      : { ...inputs.gang, respect: Math.max(1, inputs.gang.respect - ascend.result.respect) };
  const tasks = new Map(plan.assignments.map((each) => [each.name, each.task]));
  let respect = 0;
  for (const member of inputs.members) {
    const task = tasks.get(member.name) ?? member.task;
    const figures = member.name === ascend?.name ? gangMemberAscended(member) : member;
    respect += gangRespectPerCycle(gang, figures, gangTask(task), inputs.softcap);
  }
  return respect;
}

/** The gang's faction's reputation a second from `respectPerCycle` (`Gang.ts:144-155`). */
export function gangReputationPerSecond(respectPerCycle: number, factionRep: number, favor: number): number {
  return (respectPerCycle * (1000 / GANG_CYCLE_MS) * factionRep * (1 + favor / 100)) / GANG_RESPECT_PER_REPUTATION;
}

/** (2)'s estimate under `objective`: its rate, and the time to The Red Pill's reputation from the faction's now. */
export function gangObjectiveEstimate(
  inputs: GangRuleInputs,
  objective: GangObjective,
  faction: Pick<GangRouteFaction, "reputation" | "favor" | "factionRep" | "needed">,
): GangObjectiveEstimate {
  const respectPerCycle = gangRespectUnder(inputs, objective);
  const reputationPerSecond = gangReputationPerSecond(respectPerCycle, faction.factionRep, faction.favor);
  const short = Math.max(0, faction.needed - faction.reputation);
  const etaMs =
    short === 0 ? 0 : reputationPerSecond > 0 ? (short / reputationPerSecond) * 1000 : Number.POSITIVE_INFINITY;
  return { objective, respectPerCycle, reputationPerSecond, etaMs };
}

/**
 * (2): the gang's objective (#357). Under 12 members the rule's respect; with 12, money once The Red Pill is owned, or
 * with the gang's faction unread (`faction` null); else the least time to The Red Pill's reputation, a tie to money.
 */
export function gangObjectiveChoice(inputs: GangRuleInputs, faction: GangRouteFaction | null): GangObjectiveChoice {
  if (inputs.members.length < GANG_MOST_MEMBERS) {
    return { objective: gangObjectiveOf(inputs.members.length), reason: "recruiting", respect: null, money: null };
  }
  if (faction === null) return { objective: "money", reason: "unread", respect: null, money: null };
  if (faction.redPillOwned) return { objective: "money", reason: "The Red Pill owned", respect: null, money: null };
  const respect = gangObjectiveEstimate(inputs, "respect", faction);
  const money = gangObjectiveEstimate(inputs, "money", faction);
  return { objective: respect.etaMs < money.etaMs ? "respect" : "money", reason: "estimates", respect, money };
}

/**
 * What an install keeps of each member's ascension points (`InstallAscensionPenalty`, `Gang/data/Constants.ts:16`;
 * `Prestige.ts:133-146`, `GangMember.ts:287-296`).
 */
export const GANG_INSTALL_ASCENSION_KEPT = 0.95;

/**
 * The member with its ascension points × `factor`, each stat's multiplier and level recomputed from them
 * (`GangMember.ts:70-85`, `formulas.ts:79-81`): at 0.95, the member after an install. Its experience and equipment kept.
 */
export function gangMemberAtPoints(member: GangMemberFigures, factor: number): GangMemberFigures {
  const after: GangMemberFigures = { ...member };
  for (const stat of GANG_STATS) {
    const points = member[`${stat}_asc_points`] * factor;
    const ascMult = gangAscensionMult(points);
    after[`${stat}_asc_points`] = points;
    after[`${stat}_asc_mult`] = ascMult;
    after[stat] = gangSkillLevel(member[`${stat}_exp`], member[`${stat}_mult`] * ascMult);
  }
  return after;
}

/** The members' respect a cycle on `plan`'s tasks (`formulas.ts:15-31`), at the gang's penalty now, as given. */
function gangRespectOnTasks(inputs: GangRuleInputs, plan: GangPlan, members: readonly GangMemberFigures[]): number {
  const tasks = new Map(plan.assignments.map((each) => [each.name, each.task]));
  let respect = 0;
  for (const member of members) {
    respect += gangRespectPerCycle(
      inputs.gang,
      member,
      gangTask(tasks.get(member.name) ?? member.task),
      inputs.softcap,
    );
  }
  return respect;
}

/**
 * p (#357's (3)): the rate an install leaves, the members' respect a cycle on `plan`'s tasks with every member's points
 * × 0.95 (`gangMemberAtPoints`) over it now, both from the formulas (each level recomputed from its experience and
 * points). About 0.979 at 1/7 territory for a member whose level is its ascension's: √0.95 on its level, to the
 * softcap's exponent. The plan's tasks now (its ascension left out): either way. Null with no respect earned now.
 */
export function gangInstallRateKept(inputs: GangRuleInputs, plan: GangPlan): number | null {
  const now = gangRespectOnTasks(
    inputs,
    plan,
    inputs.members.map((member) => gangMemberAtPoints(member, 1)),
  );
  if (!(now > 0)) return null;
  const after = gangRespectOnTasks(
    inputs,
    plan,
    inputs.members.map((member) => gangMemberAtPoints(member, GANG_INSTALL_ASCENSION_KEPT)),
  );
  return after / now;
}

/**
 * s (#357's (3)): the `faction_rep` an install gives, NeuroFlux Governor's `levels` and each of `augmentations` by
 * product (`applyAugmentation`, `Augmentation/AugmentationHelpers.ts:39-50`), as `levellingInstallMultipliers` does
 * levelling's. An unknown name throws.
 */
export function factionRepInstallMultiplier(levels: number, augmentations: readonly string[] = []): number {
  const multiplier = (name: string) => {
    if (!Object.hasOwn(AUGMENTATIONS, name)) throw new RangeError(`no augmentation ${JSON.stringify(name)}`);
    const { multipliers } = AUGMENTATIONS[name] as { multipliers: Readonly<Record<string, number>> };
    return multipliers.faction_rep ?? 1;
  };
  return augmentations.reduce((product, name) => product * multiplier(name), multiplier(NEUROFLUX_GOVERNOR) ** levels);
}

/** What (3) reads (#357): The Red Pill's reputation, the gang's faction's now and its favour, p, s and the rate. */
export interface GangInstallInputs {
  /** N: The Red Pill's reputation (`augmentationCost`'s, `Augmentations.ts:1946-1952`). */
  needed: number;
  /** r: the gang's faction's reputation now, which an install turns into favour (`Faction.ts:77-85`). */
  reputation: number;
  /** f: its favour now. */
  favor: number;
  /** p: the rate an install leaves (`gangInstallRateKept`), or null (no respect earned now, or the gang unread). */
  rateKept: number | null;
  /** s: the `faction_rep` the install gives (`factionRepInstallMultiplier`). */
  factionRepGain: number;
  /** The gang's faction's reputation a second now, at favour f (`gangReputationPerSecond`), or null: the minutes. */
  reputationPerSecond: number | null;
  /** Whether an install now installs anything (the queue, the set, NeuroFlux Governor's levels): else none now. */
  installable: boolean;
  /**
   * The time, ms, from r's reading to an install chosen now: the commit (`GANG_ROUTE_COMMIT_MS`) and the reading's
   * age. The gang earns through it, and the install converts that too: r_i = r + the rate × it. Absent, 0.
   */
  aheadMs?: number;
}

/** (3)'s estimates and the choice (#357): each in reputation at the rate at favour 0, and in ms at the rate. */
export interface GangInstallTiming extends GangInstallInputs {
  /** r_i: the reputation an install chosen now converts, r and what the rate earns over `aheadMs` (r unmeasured). */
  atInstall: number;
  /** f(r_i): the favour an install now gives (`addRepToFavor`, `favor.ts:22-24`). */
  favorAfter: number;
  /** R*: the reputation to bank to before installing (the least over R > r, below N), or null: none better. */
  bankAt: number | null;
  /** f(R*), or null. */
  favorAtBank: number | null;
  /** Keep the cycle: (N − r) / g(f). */
  keep: number;
  /** Install now: (r_i − r) / g(f) + N / (g(f(r_i)) · p · s); null with nothing to install, or p unknown. */
  installNow: number | null;
  /** Bank R*, then install: (R* − r) / g(f) + N / (g(f(R*)) · p · s); null with no R*, nothing to install, or p unknown. */
  bank: number | null;
  /** The same in ms at the rate (Infinity with none earned); null with the rate unmeasured, or no candidate. */
  keepMs: number | null;
  installNowMs: number | null;
  bankMs: number | null;
  /** The time to R* at the rate now, ms, or null. */
  toBankMs: number | null;
  choice: "keep" | "install" | "bank";
  /** Installing (now or banked) held: p unknown (no respect earned now, or the gang unread). */
  heldForRate: boolean;
}

/** g(x) = 1 + x / 100: the gang's reputation's favour multiplier (`Gang.ts:152-155`). */
const favorGain = (favor: number) => 1 + favor / 100;

/** `log(1.02)` as the game has it (`favor.ts:10`). */
const LOG_1_POINT_02 = 0.019802627296179712;

/**
 * R* (#357's (3)): the reputation R ≥ 0 at which to install that minimises R / g(f) + N / (g(f(R)) · ps), the time to
 * bank it and then The Red Pill's N at the favour it gives, from favour `favor`; independent of the reputation now. Its
 * derivative is 0 where (25,000 + favorToRep(f) + R) · g(f(R))² = N · g(f) / (100 · log 1.02 · ps) (`favor.ts:12-24`):
 * the left rises with R, so it's found by bisection; 0 where that's past already.
 */
export function gangBankReputation(needed: number, favor: number, rateGain: number): number {
  const base = favorToRep(favor);
  const target = (needed * favorGain(favor)) / (100 * LOG_1_POINT_02 * rateGain);
  const left = (reputation: number) =>
    (25_000 + base + reputation) * favorGain(favorAfterInstall(favor, reputation)) ** 2;
  if (!(rateGain > 0) || left(0) >= target) return 0;
  let low = 0;
  let high = Math.max(1, needed);
  while (left(high) < target && high < 1e300) high *= 2;
  for (let step = 0; step < 200 && high - low > 1e-6 * Math.max(1, high); step += 1) {
    const middle = (low + high) / 2;
    if (left(middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * (3)'s choice (#357): the least of the three; a tie to keeping (which changes nothing), then to installing now
 * (sooner than banking); an unknown candidate (null) is none.
 */
export function gangInstallChoice(
  keep: number,
  installNow: number | null,
  bank: number | null,
): "keep" | "install" | "bank" {
  if (installNow !== null && installNow < keep && (bank === null || installNow <= bank)) return "install";
  return bank !== null && bank < keep ? "bank" : "keep";
}

/** What (3) reads of the gang (#357), the gang rule's at each managed decision: p, and its plan's respect a cycle. */
export interface GangInstallFigures {
  /** p (`gangInstallRateKept`), or null with no respect earned now. */
  rateKept: number | null;
  /** The plan's respect a cycle (`gangRespectOfPlan`): the minutes' rate. */
  respectPerCycle: number;
}

/**
 * (3), installing with a gang before The Red Pill is reached (#357): keep the cycle, install now, or bank R* and then
 * install, each scored by the time to The Red Pill's reputation at the gang's faction. Every candidate is reputation
 * over the same rate (the members' respect, × `faction_rep` / 75 at favour 0), so the choice doesn't depend on it, only
 * its minutes do. The least wins; a tie goes to keeping, then to installing now (sooner than banking). Either install
 * only with something to install, and only with p known (`heldForRate`). Left out, each labelled:
 * - more than one more install: cautious for installing (the brain decides again each cycle, from its favour then);
 * - the commit's 2 minutes and the reading's age (`aheadMs`): counted, as the gang earns through them and the install
 *   converts that too (#357's A/B: banking with them left out chose at 262k, its install converting about 356k);
 * - the decisions' 10 s apart (a medium snapshot each), banking's install up to that much past R*: either way;
 * - the money the install resets, so gang equipment and the set's later buys wait for it again, and the ×0.95
 *   compounding past the next install: optimistic for installing;
 * - the plan's tasks after the install taken as now's (p's), and the members' growth: either way (the minutes only).
 */
export function gangInstallTiming(inputs: GangInstallInputs): GangInstallTiming {
  const { needed, reputation, favor, rateKept, factionRepGain, reputationPerSecond, installable } = inputs;
  const ahead = Math.max(0, inputs.aheadMs ?? 0);
  const atInstall = reputation + (reputationPerSecond === null ? 0 : (reputationPerSecond * ahead) / 1000);
  const favorAfter = favorAfterInstall(favor, atInstall);
  const keep = Math.max(0, needed - reputation) / favorGain(favor);
  const reached = reputation >= needed;
  const rateGain = rateKept === null ? null : rateKept * factionRepGain;
  const installNow =
    reached || rateGain === null || !installable
      ? null
      : (atInstall - reputation) / favorGain(favor) + needed / (favorGain(favorAfter) * rateGain);
  const optimum = reached || rateGain === null ? null : gangBankReputation(needed, favor, rateGain);
  // Banking while the reputation an install now would convert is short of R*: from there, installing now is it.
  // Only with something to install (#372's review): banking's estimate is an install's.
  const bankAt = installable && optimum !== null && optimum > atInstall && optimum < needed ? optimum : null;
  const favorAtBank = bankAt === null ? null : favorAfterInstall(favor, bankAt);
  const bank =
    bankAt === null || favorAtBank === null || rateGain === null
      ? null
      : (bankAt - reputation) / favorGain(favor) + needed / (favorGain(favorAtBank) * rateGain);
  const choice = gangInstallChoice(keep, installNow, bank);
  // At favour 0, the rate is the rate now over g(f): every candidate's reputation over it.
  const atFavorZero = reputationPerSecond === null ? null : reputationPerSecond / favorGain(favor);
  const ms = (units: number | null) =>
    units === null || atFavorZero === null
      ? null
      : units === 0
        ? 0
        : atFavorZero > 0
          ? (units / atFavorZero) * 1000
          : Number.POSITIVE_INFINITY;
  return {
    ...inputs,
    atInstall,
    favorAfter,
    bankAt,
    favorAtBank,
    keep,
    installNow,
    bank,
    keepMs: ms(keep),
    installNowMs: ms(installNow),
    bankMs: ms(bank),
    toBankMs: bankAt === null ? null : ms((bankAt - reputation) / favorGain(favor)),
    choice,
    heldForRate: rateKept === null && !reached,
  };
}
