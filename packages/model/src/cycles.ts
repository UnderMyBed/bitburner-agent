/**
 * The cycle model (#260, the fast model's first slice, #13): BN1 stepped a minute at a time from the BitNode's start to
 * its destroy, install to install, with the brain's own choices made by core's own functions on the model's state, so
 * it can't drift from the brain:
 * - A5's work (core's `factionWorkChoice`: the most hacking value per second of work, The Red Pill first, toward
 *   donations' favour, the count; `factionReputationPerSecond` at the modelled level, `faction_rep` and favour);
 * - the joins: the hacker factions by their servers (`HACKER_FACTION_JOINS`), Tian Di Hui, the city group (core's
 *   `cityGroupValues` and `chooseCityGroup`, owner decision 54), Daedalus by its requirements (`daedalusRequirements`);
 * - A6's purchases and install (`chooseAugmentationsToBuy`, `affordableCounts`, `installRule`, the donations' terms,
 *   `daedalusCountHold` with `countablesToCome`), and A8's The Red Pill and "Daedalus donations" (`redPillTarget`), as
 *   packages/brain/src/augmentations.ts runs them;
 * - at each install, the favour (`favorAfterInstall`), the multipliers (`installGains`, SF1's bonus) and home's RAM.
 * What core can't say, the hacking level and the money over a cycle, is calibrated (./calibration.ts, ./curves.ts).
 * Not wired into the brain's choices (owner decision 46: phase B replaces a choice only where it measurably beats it).
 */
import {
  type AugmentationPurchaseState,
  affordableCounts,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationsSoldBy,
  bestWorkRate,
  chooseAugmentationsToBuy,
  chooseCityGroup,
  cityGroupValues,
  countablesToCome,
  DAEDALUS,
  daedalusCountHold,
  daedalusCountOf,
  daedalusRequirements,
  daedalusSkillsReached,
  donationsUnlocked,
  donationTermsOf,
  donationToReach,
  FACTION_NAMES,
  type FactionState,
  type FactionWorkChoice,
  factionWorkChoice,
  favorAfterInstall,
  HACKING_MULTIPLIERS,
  INSTALL_COUNTDOWN_MS,
  type InstallReason,
  installGains,
  installRule,
  isWorthInstalling,
  type JoinedFaction,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  NEURORECEPTOR_MANAGEMENT_IMPLANT,
  QUICK_INSTALL_COUNTDOWN_MS,
  redPillTarget,
  reputationToUnlockDonations,
  THE_RED_PILL,
  TIAN_DI_HUI,
  TIAN_DI_HUI_HACKING,
  TIAN_DI_HUI_MONEY,
  TRAVEL_COST,
  type WorkConditions,
  type WorkingPerson,
} from "@bitburner-agent/core";
import { CALIBRATION, type Calibration, HACKER_FACTION_JOINS } from "./calibration.ts";
import { type Clocks, Curves, homeRamAfter } from "./curves.ts";

const MINUTE_MS = 60_000;

/** The hacking multipliers (core's `HACKING_MULTIPLIERS`), each the product of what's installed and SF1's bonus. */
export type Multipliers = Record<(typeof HACKING_MULTIPLIERS)[number], number>;

/** Where a run starts: the BitNode and the Source-Files owned (run #3's BN1.2: `{ "1": 1 }`). */
export interface ModelStart {
  currentNode: number;
  ownedSF: Readonly<Record<string, number>>;
}

/** What a policy sees at each step. */
export interface PolicyView {
  atMs: number;
  /** Since the last install: the bars' clock (the model is always online). */
  onlineMs: number;
  hacking: number;
  money: number;
  installed: Readonly<Record<string, number>>;
  joined: readonly JoinedFaction[];
  multipliers: Multipliers;
}

/**
 * The choices a policy can change (#247's question; architecture §4.5's candidate policies): when to start a favour
 * grind, and when to install. Absent, each is the brain's own.
 */
export interface CyclePolicy {
  name: string;
  /** #243's hold for Daedalus's count (owner decision 56): today's brain holds; run #3's (main 7c741cc) didn't. */
  daedalusCountHold: boolean;
  /**
   * A joined faction to work for toward the favour that unlocks its donations at the next install, in place of A5's
   * choice; null for A5's. Ignored for a faction not joined, or with that favour's reputation earned.
   */
  favourGrind?: (view: PolicyView) => string | null;
  /**
   * Whether to install now, given A6's reason (null: A6 wouldn't). Never asked about The Red Pill's install, and never
   * installs with nothing to install.
   */
  install?: (view: PolicyView, brains: InstallReason | null) => boolean;
}

/** Today's brain: every rule as on main. */
export const TODAYS_POLICY: CyclePolicy = { name: "today's brain", daedalusCountHold: true };
/** Run #3's brain (main 7c741cc, 2026-11-05): before #243's hold. The validation's. */
export const RUN_3_POLICY: CyclePolicy = { name: "run #3's brain", daedalusCountHold: false };

/** Why a cycle ended: A6's reason, or the policy's own install. */
export type ModelInstallReason = InstallReason | "policy";

/** A cycle as the model ran it, from an install (or the BitNode's start) to the next. */
export interface ModelCycle {
  startMs: number;
  endMs: number;
  reason: ModelInstallReason;
  /** What the install installed: the set's augmentations, and NeuroFlux Governor's levels. */
  installed: string[];
  neuroFluxLevels: number;
  /** Daedalus's count after the install (`ownedAugs`' names, NeuroFlux Governor once). */
  countAfter: number;
  hackingAtEnd: number;
  moneyAtEnd: number;
  /** Home's RAM after the cycle. */
  homeRamGb: number;
  /** The multipliers the cycle ran at. */
  multipliers: Multipliers;
  /** By joined faction: the reputation earned, the favour after the install, the minutes worked and the best rate. */
  reputation: Record<string, number>;
  favorAfter: Record<string, number>;
  workMinutes: Record<string, number>;
  bestRatePerSecond: Record<string, number>;
  /** Minutes the work went to a donations target (#225's `workTarget`), and minutes an install was held (#243). */
  donationTargetMinutes: number;
  heldMinutes: number;
}

export type ModelEvent =
  | { atMs: number; kind: "joined"; faction: string }
  | { atMs: number; kind: "install"; reason: ModelInstallReason; count: number }
  | { atMs: number; kind: "donationsUnlocked"; faction: string }
  | { atMs: number; kind: "destroyed" };

export interface ModelRun {
  policy: string;
  cycles: ModelCycle[];
  events: ModelEvent[];
  /** The destroy (w0r1d_d43m0n's level reached with The Red Pill installed), or null within the horizon. */
  destroyedAtMs: number | null;
}

export interface ModelOptions {
  policy?: CyclePolicy;
  /** The calibration, any part overridden (the sensitivity sweeps). */
  calibration?: Partial<Calibration>;
  /** The longest the run goes, in game time: 24 hours. */
  horizonMs?: number;
  /** The step: a minute. */
  stepMs?: number;
  /** Each step's figures, for a trace. */
  onStep?: (step: { atMs: number; onlineMs: number; hacking: number; money: number; clocks: Clocks }) => void;
}

/** SF1's bonus on every hacking multiplier (`SourceFile/applySourceFile.ts:15-40`): 1.16, 1.24, 1.28. */
export function sourceFile1Bonus(level: number): number {
  let bonus = 0;
  for (let i = 0; i < level; ++i) bonus += 16 / 2 ** i;
  return 1 + bonus / 100;
}

/** The multipliers from what's installed (core's `installGains`, NeuroFlux Governor's levels each), with SF1's. */
export function multipliersOf(installed: Readonly<Record<string, number>>, sourceFile1Level: number): Multipliers {
  const names = Object.entries(installed).flatMap(([name, level]) => Array<string>(level).fill(name));
  const gains = installGains(names);
  const bonus = sourceFile1Bonus(sourceFile1Level);
  return Object.fromEntries(HACKING_MULTIPLIERS.map((key) => [key, gains[key] * bonus])) as Multipliers;
}

/** The TOR router (`Constants.ts:44`) and the port openers, cheapest first (`DarkWeb/DarkWebItems.ts:6-10`). */
const TOR_ROUTER_PRICE = 200e3;
const PORT_OPENER_PRICES = [500e3, 1.5e6, 5e6, 30e6, 250e6];
export function programsPrice(ports: number): number {
  return TOR_ROUTER_PRICE + PORT_OPENER_PRICES.slice(0, ports).reduce((sum, each) => sum + each, 0);
}

/** w0r1d_d43m0n's level: 3000 × the BitNode's `WorldDaemonDifficulty`, 1 in BN1 (`Server/ServerHelpers.ts:383-385`). */
export const WORLD_DAEMON_HACKING = 3000;
/** Home's RAM at a BitNode's start: 32 GB with SF1, else 8 (`Prestige.ts:254-260`). */
export const startHomeRamGb = (sourceFile1Level: number) => (sourceFile1Level > 0 ? 32 : 8);
/** An install puts the player in Sector-12 (`PlayerObjectGeneralMethods.ts:104`). */
const START_CITY = "Sector-12";

/** Runs the model from a BitNode's start, under `policy` (today's brain by default). */
export function runModel(start: ModelStart, options: ModelOptions = {}): ModelRun {
  const policy = options.policy ?? TODAYS_POLICY;
  const horizonMs = options.horizonMs ?? 24 * 60 * MINUTE_MS;
  const stepMs = options.stepMs ?? MINUTE_MS;
  const curves = new Curves({ ...CALIBRATION, ...options.calibration });
  const { currentNode, ownedSF } = start;
  const bitNode = augmentationBitNodeMultipliers(currentNode, ownedSF);
  const sourceFile1Level = ownedSF["1"] ?? 0;
  const installed: Record<string, number> = {};
  const favor = new Map<string, number>();
  const cycles: ModelCycle[] = [];
  const events: ModelEvent[] = [];
  let homeRamGb = startHomeRamGb(sourceFile1Level);
  let destroyedAtMs: number | null = null;
  // The cycle's state.
  let cycleStartMs = 0;
  let clocks: Clocks = { exp: 0, money: 0 };
  let joined: JoinedFaction[] = [];
  let cityGroup: string | null = null;
  let countdownEndsMs: number | null = null;
  let heldSinceOnlineMs: number | null = null;
  let held: { faction: string; augmentation: string } | null = null;
  let lastMoney = 0;
  let stats = freshStats();

  for (let now = 0; now <= horizonMs; now += stepMs) {
    const onlineMs = now - cycleStartMs;
    const multipliers = multipliersOf(installed, sourceFile1Level);
    if (onlineMs > 0) clocks = curves.advanceClocks(clocks, stepMs, multipliers, homeRamGb);
    const hacking = curves.hackingLevelAt(clocks.exp, multipliers);
    const money = curves.moneyAt(clocks.money, multipliers);
    const income = onlineMs > 0 ? (Math.max(0, money - lastMoney) / stepMs) * 1000 : null;
    lastMoney = money;
    options.onStep?.({ atMs: now, onlineMs, hacking, money, clocks });
    if (Object.hasOwn(installed, THE_RED_PILL) && hacking >= WORLD_DAEMON_HACKING) {
      destroyedAtMs = now;
      events.push({ atMs: now, kind: "destroyed" });
      break;
    }

    // The joins.
    const join = (name: string) => {
      if (joined.some((each) => each.name === name)) return;
      joined = [...joined, { name, reputation: 0, favor: favor.get(name) ?? 0 }];
      events.push({ atMs: now, kind: "joined", faction: name });
    };
    for (const { faction, hacking: level, ports } of HACKER_FACTION_JOINS) {
      if (hacking >= level && money >= programsPrice(ports)) join(faction);
    }
    // Tian Di Hui: hacking 50 and $1m held in one of its cities, a ticket away (`Faction/FactionInfo.tsx:680-692`).
    if (hacking >= TIAN_DI_HUI_HACKING && money >= TIAN_DI_HUI_MONEY + TRAVEL_COST) join(TIAN_DI_HUI);
    const state = (): FactionState => ({ joined, invitations: [], queuedAugmentations: [] });
    const count = () => daedalusCountOf({ currentNode, ownedSF, installed, joined, invitations: [] });
    const group = chooseCityGroup(
      cityGroupValues({
        state: state(),
        count: count(),
        currentNode,
        lastAugReset: cycleStartMs,
        installed,
        hackingLevel: hacking,
        money,
        city: START_CITY,
      }),
      state(),
      cityGroup,
    );
    if (group !== null) {
      cityGroup = group.group;
      if (money >= group.money) for (const faction of group.factions) join(faction);
    }
    const daedalus = daedalusRequirements(currentNode, ownedSF);
    if (count().installed >= daedalus.augmentations && hacking >= daedalus.hacking && money >= daedalus.money) {
      join(DAEDALUS);
    }

    // A5: the work.
    const person: WorkingPerson = {
      skills: { hacking, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      mults: { faction_rep: multipliers.faction_rep },
    };
    const conditions: WorkConditions = {
      sourceFile15Level: ownedSF["15"] ?? 0,
      // Faction work is focused (owner decision 37).
      focused: true,
      implant: Object.hasOwn(installed, NEURORECEPTOR_MANAGEMENT_IMPLANT),
      factionWorkRepGain: bitNode.FactionWorkRepGain,
      favorToDonateToFaction: bitNode.FavorToDonateToFaction,
      donations: true,
      shareBonus: curves.calibration.shareBonus,
    };
    const resetInfo = { currentNode, ownedAugs: installed, ownedSF: { ...ownedSF } };
    const view: PolicyView = { atMs: now, onlineMs, hacking, money, installed, joined, multipliers };
    const choice =
      grindWork(policy, view, person, conditions, bitNode.FavorToDonateToFaction) ??
      factionWorkChoice(person, state(), resetInfo, conditions, count(), held);
    if (choice !== null) work(choice);

    // A6: the purchases and the install.
    const decision = installDecision({
      installed,
      joined,
      currentNode,
      ownedSF,
      money,
      hacking,
      factionRep: multipliers.faction_rep,
      onlineMs,
    });
    let reason: ModelInstallReason | null = decision?.reason ?? null;
    if (policy.install !== undefined && decision !== null && reason !== "The Red Pill") {
      reason = policy.install(view, decision.reason) ? (decision.reason ?? "policy") : null;
    }
    // #243's hold: an install the count rule chose that would leave Daedalus's count one short.
    held = null;
    if (reason !== null && decision !== null && policy.daedalusCountHold && isCountRule(reason)) {
      const hold = countHold(decision, money, income, person, conditions, onlineMs);
      if (hold !== null) {
        heldSinceOnlineMs = hold.sinceOnlineMs;
        held = { faction: hold.next.faction, augmentation: hold.next.augmentation };
        stats.heldMinutes += stepMs / MINUTE_MS;
        reason = null;
      }
    }
    if (reason === null || decision === null || decision.names.length + decision.neuroFluxLevels === 0) {
      countdownEndsMs = null;
      continue;
    }
    // The countdown (90 s, 30 s for a quick install; none for The Red Pill), called off if the rule stops saying so.
    const countdownMs =
      reason === "The Red Pill" ? 0 : reason === "quick install" ? QUICK_INSTALL_COUNTDOWN_MS : INSTALL_COUNTDOWN_MS;
    countdownEndsMs ??= now + countdownMs;
    if (now >= countdownEndsMs) install(now, reason, decision, hacking, money, multipliers);
  }
  return { policy: policy.name, cycles, events, destroyedAtMs };

  function work(choice: FactionWorkChoice): void {
    joined = joined.map((each) =>
      each.name === choice.faction
        ? { ...each, reputation: each.reputation + (choice.reputationPerSecond * stepMs) / 1000 }
        : each,
    );
    const { workMinutes, bestRatePerSecond } = stats;
    workMinutes[choice.faction] = (workMinutes[choice.faction] ?? 0) + stepMs / MINUTE_MS;
    bestRatePerSecond[choice.faction] = Math.max(bestRatePerSecond[choice.faction] ?? 0, choice.reputationPerSecond);
    if (choice.target === "donations") stats.donationTargetMinutes += stepMs / MINUTE_MS;
  }

  /** The brain's hold (A6's `countablesToCome` and core's `daedalusCountHold`), A5 working for the held one. */
  function countHold(
    decision: InstallDecision,
    money: number,
    income: number | null,
    person: WorkingPerson,
    conditions: WorkConditions,
    onlineMs: number,
  ) {
    const state = purchaseStateOf(installed, ownedSF, bitNode);
    const working = joined.filter((faction) => FACTION_NAMES.includes(faction.name));
    const shops = new Map(working.map((each) => [each.name, augmentationsSoldBy(each.name, currentNode, null)]));
    const sold = [...new Set([...shops.values()].flat())];
    const required = daedalusRequirements(currentNode, ownedSF);
    return daedalusCountHold({
      installed,
      installing: [...decision.names, ...(decision.neuroFluxLevels > 0 ? [NEUROFLUX_GOVERNOR] : [])],
      required: required.augmentations,
      skillsReached: daedalusSkillsReached(person.skills, required),
      toCome: countablesToCome({
        sold,
        state,
        set: decision.set,
        joined: working,
        shops,
        terms: decision.terms,
        person,
        conditions,
        work: { owners: null, brainWorks: true },
        money,
        income,
      }),
      onlineMs,
      heldSinceOnlineMs,
    });
  }

  function install(
    now: number,
    reason: ModelInstallReason,
    decision: InstallDecision,
    hacking: number,
    money: number,
    multipliers: Multipliers,
  ): void {
    const reputation: Record<string, number> = {};
    const favorAfter: Record<string, number> = {};
    for (const faction of joined) {
      reputation[faction.name] = faction.reputation;
      const after = favorAfterInstall(faction.favor, faction.reputation);
      favor.set(faction.name, after);
      favorAfter[faction.name] = after;
      if (!donationsUnlocked(faction.favor, bitNode) && donationsUnlocked(after, bitNode)) {
        events.push({ atMs: now, kind: "donationsUnlocked", faction: faction.name });
      }
    }
    for (const name of decision.names) installed[name] = 1;
    if (decision.neuroFluxLevels > 0) {
      installed[NEUROFLUX_GOVERNOR] = (installed[NEUROFLUX_GOVERNOR] ?? 0) + decision.neuroFluxLevels;
    }
    const countAfter = Object.keys(installed).length;
    homeRamGb = homeRamAfter(homeRamGb, money);
    cycles.push({
      startMs: cycleStartMs,
      endMs: now,
      reason,
      installed: decision.names,
      neuroFluxLevels: decision.neuroFluxLevels,
      countAfter,
      hackingAtEnd: hacking,
      moneyAtEnd: money,
      homeRamGb,
      multipliers,
      reputation,
      favorAfter,
      ...stats,
    });
    events.push({ atMs: now, kind: "install", reason, count: countAfter });
    cycleStartMs = now;
    clocks = { exp: 0, money: 0 };
    joined = [];
    cityGroup = null;
    countdownEndsMs = null;
    heldSinceOnlineMs = null;
    held = null;
    lastMoney = 0;
    stats = freshStats();
  }
}

function freshStats() {
  return {
    workMinutes: {} as Record<string, number>,
    bestRatePerSecond: {} as Record<string, number>,
    donationTargetMinutes: 0,
    heldMinutes: 0,
  };
}

function isCountRule(reason: ModelInstallReason): boolean {
  return reason === "count reached" || reason === "quick install" || reason === "nothing left";
}

/** The brain buys at the commit, just before the install: nothing is queued through the cycle. */
function purchaseStateOf(
  installed: Readonly<Record<string, number>>,
  ownedSF: Readonly<Record<string, number>>,
  bitNode: AugmentationPurchaseState["bitNodeMultipliers"],
): AugmentationPurchaseState {
  return { installed, queued: [], sourceFile11Level: ownedSF["11"] ?? 0, bitNodeMultipliers: bitNode };
}

/** The policy's favour grind, as a work choice at the faction's best work type (core's `bestWorkRate`), or null. */
function grindWork(
  policy: CyclePolicy,
  view: PolicyView,
  person: WorkingPerson,
  conditions: WorkConditions,
  favorToDonateToFaction: number,
): FactionWorkChoice | null {
  const name = policy.favourGrind?.(view) ?? null;
  const faction = view.joined.find((each) => each.name === name);
  if (faction === undefined) return null;
  const target = reputationToUnlockDonations(faction.favor, { FavorToDonateToFaction: favorToDonateToFaction });
  if (!Number.isFinite(target) || faction.reputation >= target) return null;
  const rate = bestWorkRate(person, faction, conditions);
  if (rate === null) return null;
  return {
    faction: faction.name,
    workType: rate.workType,
    augmentation: "",
    reputation: faction.reputation,
    reputationNeeded: target,
    reputationPerSecond: rate.perSecond,
    etaSeconds: (target - faction.reputation) / rate.perSecond,
    target: "donations",
    favor: faction.favor,
  };
}

/** A6's decision: its reason (null for none), what an install would install, and the set and the donations' terms. */
export interface InstallDecision {
  reason: InstallReason | null;
  names: string[];
  neuroFluxLevels: number;
  set: ReturnType<typeof chooseAugmentationsToBuy>;
  terms: ReturnType<typeof donationTermsOf>;
}

/**
 * A6's decision (packages/brain/src/augmentations.ts, its update before the commit), from core's functions on the
 * model's state: the endgame first (#215's The Red Pill, #225's "Daedalus donations", the holds for Daedalus), then the
 * count rule on the set the money covers. Null where no install can be: The Red Pill installed, or held for it.
 */
export function installDecision({
  installed,
  joined,
  currentNode,
  ownedSF,
  money,
  hacking,
  factionRep,
  onlineMs,
}: {
  installed: Readonly<Record<string, number>>;
  joined: readonly JoinedFaction[];
  currentNode: number;
  ownedSF: Readonly<Record<string, number>>;
  money: number;
  hacking: number;
  factionRep: number;
  onlineMs: number;
}): InstallDecision | null {
  if (Object.hasOwn(installed, THE_RED_PILL)) return null;
  const multipliers = augmentationBitNodeMultipliers(currentNode, ownedSF);
  const state = purchaseStateOf(installed, ownedSF, multipliers);
  const working = joined.filter((faction) => FACTION_NAMES.includes(faction.name));
  const shops = new Map(working.map((each) => [each.name, augmentationsSoldBy(each.name, currentNode, null)]));
  const reputationOf = (faction: string) => working.find((each) => each.name === faction)?.reputation ?? 0;
  const reachedAt = (name: string) => {
    const needed = augmentationCost(name, state).reputation;
    return [...shops].some(([faction, shop]) => shop.includes(name) && reputationOf(faction) >= needed);
  };
  const owned = (name: string) => Object.hasOwn(installed, name);
  const sold = [...new Set([...shops.values()].flat())].filter((name) => name !== NEUROFLUX_GOVERNOR);
  const reached = sold.filter((name) => !owned(name) && reachedAt(name));
  const count = daedalusCountOf({ currentNode, ownedSF, installed, joined, invitations: [] });
  const terms = donationTermsOf(
    working,
    shops,
    sold.filter((name) => !owned(name) && !reachedAt(name)),
    factionRep,
    multipliers,
  );

  // The endgame (the brain's `#endgame`).
  const redPill = augmentationCost(THE_RED_PILL, state).reputation;
  const redPillSellers = working.filter((faction) => shops.get(faction.name)?.includes(THE_RED_PILL));
  const donor = redPillSellers.find((faction) => donationsUnlocked(faction.favor, multipliers));
  let redPillDonation = 0;
  let endgame: "redPill" | "daedalusDonations" | "hold" | "none" = "none";
  if (redPillSellers.some((faction) => faction.reputation >= redPill)) endgame = "redPill";
  else if (donor !== undefined) {
    redPillDonation = donationToReach(redPill - donor.reputation, factionRep, multipliers.FactionWorkRepGain);
    endgame = money >= redPillDonation ? "redPill" : "hold";
  } else if (redPillSellers.length > 0) {
    const daedalus = redPillSellers.find((faction) => faction.name === DAEDALUS);
    const target = daedalus === undefined ? null : redPillTarget(redPill, daedalus, multipliers.FavorToDonateToFaction);
    const unlocks =
      daedalus !== undefined && target?.reason === "donations" && daedalus.reputation >= target.reputation;
    endgame = unlocks ? "daedalusDonations" : "hold";
  } else {
    const required = daedalusRequirements(currentNode, ownedSF);
    // Only the money missing: held, as an install now would reset it (#215).
    if (count.installed >= required.augmentations && hacking >= required.hacking && money < required.money) {
      endgame = "hold";
    }
  }
  if (endgame === "hold") return null;
  const budget = money - redPillDonation;
  const set = chooseAugmentationsToBuy(reached, state, budget, hacking, terms, count.short);
  const names = set.purchases.map((purchase) => purchase.name);
  if (endgame === "redPill") {
    return { reason: "The Red Pill", names: [...names, THE_RED_PILL], neuroFluxLevels: 0, set, terms };
  }
  const neuroFluxReputation = Math.max(
    0,
    ...[...shops].filter(([, shop]) => shop.includes(NEUROFLUX_GOVERNOR)).map(([faction]) => reputationOf(faction)),
  );
  const counts = affordableCounts({
    state,
    installable: [],
    set,
    money: budget,
    neuroFluxReputation,
    donations: terms,
    short: count.short,
  });
  const afterSet = { installed, queued: names };
  const left = sold.filter(
    (name) =>
      isWorthInstalling(name, count.short) &&
      !owned(name) &&
      !names.includes(name) &&
      missingPrerequisites(name, afterSet).length === 0,
  );
  const rule = installRule({
    onlineMs,
    sinceResetMs: onlineMs,
    installing: names.length,
    neuroFluxLevels: counts.neuroFluxLevels,
    nothingLeft: left.length === 0,
    affordable: counts.affordable,
    affordableWithNeuroFlux: counts.affordableWithNeuroFlux,
  });
  const neuroFluxLevels = counts.neuroFluxLevels;
  if (endgame === "daedalusDonations") return { reason: "Daedalus donations", names, neuroFluxLevels, set, terms };
  return { reason: rule.install ? rule.reason : null, names, neuroFluxLevels, set, terms };
}
