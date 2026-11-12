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
 *   resets it, `Prestige.ts:74`) at the multipliers the install gives (core's `levellingInstallMultipliers`: the
 *   level's, the experience's and the speed's, which scales the operations' times, `Hacking.ts:60-80`) at the rate now.
 * The least wins; a tie goes to waiting. With no rate measured, installing now is held, as #343's income hold is; and,
 * as #343's is, while an invitation's money is held (#228).
 * Left out, each labelled:
 * - the money for the two port openers avmnite-02h needs (`numOpenPortsRequired` 2), where they're not bought yet: left
 *   out of τ_g, optimistic for waiting;
 * - the rate now after an install, though the money and the servers rebuild after it (`Prestige.ts:98`): optimistic for
 *   installing;
 * - the re-roll of avmnite-02h's level at the install (`Prestige.ts:98`, a new roll in 202-220) taken as today's: either
 *   way;
 * - on waiting's side, the install's multipliers come a cycle later: optimistic for waiting;
 * - the 70 s of steps after the level on installing's side: optimistic for installing.
 *
 * **(2) The gang's objective at 12 members** (`GANG_MOST_MEMBERS`): respect or money, each scored by the time to The Red
 * Pill's reputation at the gang's faction (`Augmentation/Augmentations.ts:1946-1952`, `augmentationCost`'s, less the
 * faction's now). Only respect earns it: respect gained × `faction_rep` × (1 + favour / 100) / 75 (`Gang/Gang.ts:
 * 144-155`, `Gang/data/Constants.ts:10`), the gang's faction taking no work or donations (`NetscriptFunctions/
 * Singularity.ts:808-810`, `:934-935`). The rate: the members' respect a cycle under that objective's plan (core's
 * `planGang` given the objective, so with its training, ascension, justice and warfare; `Gang/formulas/formulas.ts:
 * 15-31` at the gang's penalty now), × 5 cycles a second (`GANG_CYCLE_MS`). Left out, labelled:
 * - the members' growth: either way;
 * - bonus time's faster cycles: cautious for both;
 * - what money buys toward it (gang equipment, a `faction_rep` set at an install): cautious for money.
 * The least wins; a tie goes to money, the rule's objective before #357. Under 12 it's respect (the rule's, recruiting);
 * once The Red Pill is bought, queued or installed it's money, as before, and said so.
 * Pure, so the brain's rules and the run report read the same figures.
 */
import { hackingExpOfLevel } from "./batcher.ts";
import { GANG_CYCLE_MS, GANG_MOST_MEMBERS, gangMemberAscended, gangRespectPerCycle, gangTask } from "./gang.ts";
import { type GangObjective, type GangRuleInputs, gangObjectiveOf, planGang } from "./gang-rule.ts";
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
    choice: gangFormingChoice(waitMs, installNowMs, heldForRate || heldForInvitation),
    heldForRate,
    heldForInvitation,
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
  const plan = planGang(inputs, objective);
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
