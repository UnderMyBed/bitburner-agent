/**
 * The cycle model (the fast model, #13: slice 1, #260; slice 2, #263; slice 3, #294): BN1 stepped a minute at a time from the
 * BitNode's start to its destroy, install to install, with the brain's own choices made by core's own functions on the
 * model's state, so it can't drift from the brain:
 * - A5's work (core's `factionWorkChoice`: the most hacking value per second of work, The Red Pill first, toward
 *   donations' favour, the count; `factionReputationPerSecond` at the modelled level, `faction_rep` and favour);
 * - the joins: the hacker factions by their servers (`HACKER_FACTION_JOINS`), Tian Di Hui, the city group (core's
 *   `cityGroupValues` and `chooseCityGroup`, owner decision 54), Daedalus by its requirements (`daedalusRequirements`);
 * - A6's decision before the commit (core's `augmentationShops`, `augmentationEndgame` with A8's The Red Pill and
 *   "Daedalus donations", and `installJudgement`), and #243's hold (`countHoldOf`: `daedalusCountHold` with
 *   `countablesToCome`), as packages/brain/src/augmentations.ts runs them;
 * - at each install, the favour (`favorAfterInstall`), the multipliers (`installGains`, SF1's bonus) and home's RAM.
 * What core can't say, the hacking level and the gross income over a cycle, is calibrated (./calibration.ts,
 * ./curves.ts). #263: the money in hand is the gross less the brain's purchases through the cycle (./money.ts); the
 * share bonus is the game's formula on the share threads, by core's `shareRound` for today's brain (#242) and a
 * fitted share of the RAM for run #3's; A6's countdown, holds and lookahead follow the brain's, tested against it on
 * the same inputs (packages/brain/test/augmentations.test.ts and desired-state.test.ts); cycles past the curves' range
 * are flagged and bounded. #294: the joins take the time the brain and the game take (./joins.ts); the brain buys one
 * purchase a medium snapshot, cloud servers on its own income measure (./money.ts); the batches' use of their hosts,
 * for the share, is core's batch maths on the state (./batches.ts); each tested against the brain's own functions
 * (packages/brain/test/backdoors.test.ts and cloud-servers.test.ts).
 * Not wired into the brain's choices (owner decision 46: phase B replaces a choice only where it measurably beats it).
 */
import {
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationEndgame,
  augmentationShops,
  bestWorkRate,
  chooseAugmentationsToBuy,
  chooseCityGroup,
  cityGroupValues,
  countablesToCome,
  countdownExtensionMs,
  DAEDALUS,
  DAEDALUS_COUNT_HOLD_MS,
  daedalusCountHold,
  daedalusCountOf,
  daedalusRequirements,
  daedalusSkillsReached,
  donationsUnlocked,
  donationTermsOf,
  type EndgameHold,
  type FactionState,
  type FactionWorkChoice,
  factionWorkChoice,
  favorAfterInstall,
  HACKING_MULTIPLIERS,
  INSTALL_COUNTDOWN_MS,
  type InstallReason,
  installGains,
  installJudgement,
  type JoinedFaction,
  NEUROFLUX_GOVERNOR,
  NEURORECEPTOR_MANAGEMENT_IMPLANT,
  passiveFactionReputationPerSecond,
  QUICK_INSTALL_COUNTDOWN_MS,
  reputationToUnlockDonations,
  SHARE_RAM_GB,
  shareBonusOfPower,
  shareRound,
  THE_RED_PILL,
  TIAN_DI_HUI,
  TIAN_DI_HUI_HACKING,
  TIAN_DI_HUI_MONEY,
  TRAVEL_COST,
  type WorkConditions,
  type WorkingPerson,
} from "@bitburner-agent/core";
import { batchesPeakGbOf } from "./batches.ts";
import { CALIBRATION, type Calibration, HACKER_FACTION_JOINS, ROOTED_WORLD_RAM_GB_BY_PORTS } from "./calibration.ts";
import { type Clocks, Curves, homeRamAfter, measuredAt } from "./curves.ts";
import { cityGroupJoinsMs, daedalusJoinMs, hackerFactionJoinMs, tianDiHuiJoinMs } from "./joins.ts";
import {
  afterPurchase,
  cloudRamOf,
  FIRST_INCOME_SAMPLE_MS,
  freshPurse,
  type Holds,
  type IncomeRate,
  IncomeWindow,
  NO_HOLDS,
  nextPurchase,
  PROGRAM_PRICES,
  PURCHASE_EVERY_MS,
  type Purse,
  portsOpen,
} from "./money.ts";

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
   * #242's share (PR #259): home's RAM shares beside the batches' hosts, less what it keeps for the Agent
   * (`shareBonusOfState`). Absent, it does: today's brain. Run #3's brain and the simulator probe's (main 412d97b) came
   * before it, and shared under one cap over every host, home included, which the batches' use filled.
   */
  homeShares?: boolean;
  /**
   * A joined faction to work for toward the favour that unlocks its donations at the next install, in place of A5's
   * choice; null for A5's. Ignored for a faction not joined, or with that favour's reputation earned.
   */
  favourGrind?: (view: PolicyView) => string | null;
  /**
   * Whether to install now, given A6's reason (null: A6 wouldn't). Never asked about The Red Pill's install, and never
   * installs with nothing to install.
   */
  install?: (view: PolicyView, brainsReason: InstallReason | null) => boolean;
}

/** Today's brain: every rule as on main. */
export const TODAYS_POLICY: CyclePolicy = { name: "today's brain", daedalusCountHold: true, homeShares: true };
/** Run #3's brain (main 7c741cc, 2026-11-05): before #243's hold and #242's share. The fit's. */
export const RUN_3_POLICY: CyclePolicy = { name: "run #3's brain", daedalusCountHold: false, homeShares: false };

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
  /** The money in hand before the commit (the gross less what the brain spent through the cycle, `money.ts`). */
  moneyAtEnd: number;
  /** The game's hacking income since the install, gross (`moneySources.hacking`). */
  grossAtEnd: number;
  /** What the commit spent: the set, NeuroFlux Governor's levels and the donations (home's RAM then has the rest). */
  commitMoney: number;
  /** Home's RAM after the cycle. */
  homeRamGb: number;
  /**
   * Minutes of the cycle past its curve's last reading (`Curves.lastMinute`, or a measured cycle's end), each clock's
   * more: extrapolated at the last slope, so less sure (#263). 0 for none.
   */
  extrapolatedMinutes: number;
  /** The share bonus while working, the cycle's average over the minutes worked (`shareBonusOfState`). */
  shareBonus: number;
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
  /**
   * The cycles (1-based) extrapolated past `EXTRAPOLATION_BOUND_MIN` (#263): out of the curves' range, so a run with
   * any isn't to be trusted, and a comparison says so. Empty for none.
   */
  outOfRange: number[];
}

/**
 * How far past its last reading a curve is trusted, minutes (#263): half the 120 min it spans. Past the last reading
 * each clock runs on at the last slope (RAM at its most, a steady income), which holds for a while; a cycle further out
 * is flagged out of range (`ModelRun.outOfRange`).
 */
export const EXTRAPOLATION_BOUND_MIN = 60;

export interface ModelOptions {
  policy?: CyclePolicy;
  /**
   * Measured cycles (`RUN_3_CYCLES`' form) to run on in place of the calibrated curves, one a cycle in order; past the
   * list, the curves. The validation runs run #3's own, so what it tests is the rules on them.
   */
  measured?: readonly { points: readonly (readonly [number, number, number])[] }[];
  /** The calibration, any part overridden (the sensitivity sweeps). */
  calibration?: Partial<Calibration>;
  /** The longest the run goes, in game time: 24 hours. */
  horizonMs?: number;
  /** The step: a minute. */
  stepMs?: number;
  /**
   * The money: "cash", the gross less what the brain spends through the cycle (`money.ts`, #263), or "gross", the
   * cycle's hacking income as slice 1 had it (#260), kept for the paired comparison's structural variant.
   */
  money?: "cash" | "gross";
  /**
   * The share bonus: "state", from the RAM the cycle's purse holds (`shareBonusOfState`, #263), or "index", run
   * #3's own by install index (`RUN_3_SHARE_BONUS`), as slice 1 had it, kept for the paired comparison's structural
   * variant.
   */
  share?: "state" | "index";
  /**
   * The joins' time after their terms are met (#294): "modelled", the brain's and the game's (./joins.ts); "instant",
   * at the step the terms are met (slice 2's); or a number, the modelled time and that many ms more (the comparison's
   * grid).
   */
  joinDelay?: "modelled" | "instant" | number;
  /**
   * How much later than the brain's rule a cycle's first cloud server may be bought, ms (#294, the comparison's grid):
   * 0, the brain's own, from the first full window of its income measure.
   */
  cloudDelayMs?: number;
  /** Each step's figures, for a trace: `money` in hand, of `gross`, and the share bonus while working. */
  onStep?: (step: {
    atMs: number;
    onlineMs: number;
    hacking: number;
    /** The money in hand at the step's medium snapshot, before its purchase (A6's, the joins'). */
    money: number;
    gross: number;
    /** The gross income a second over the brain's 10-minute window, null till it's full (A6's). */
    income: number | null;
    /** The hack loop's income as the brain's cloud purchases measure it (`IncomeWindow`), null till a full window. */
    cloudIncome: IncomeRate | null;
    shareBonus: number;
    /** #242's share's RAM, GB, and the batches' use of their hosts it's worked out with (`batchesPeakGbOf`). */
    shareRamGb: number;
    batchesUse: number;
    /** The rooted world servers' RAM, GB: the hack loop's hosts beside the cloud servers. */
    worldRamGb: number;
    /** The purse at the step's medium snapshot, before its purchase. */
    purse: Readonly<Purse>;
    clocks: Clocks;
  }) => void;
  /** Each step's work (A5's choice, or a policy's grind) and the factions joined then, for a trace. */
  onWork?: (step: { atMs: number; choice: FactionWorkChoice | null; joined: readonly JoinedFaction[] }) => void;
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

/** What the TOR router and `ports` port openers cost together (`PROGRAM_PRICES`). */
export function programsPrice(ports: number): number {
  return PROGRAM_PRICES.slice(0, ports + 1).reduce((sum, each) => sum + each, 0);
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
  const byCash = (options.money ?? "cash") === "cash";
  const byState = (options.share ?? "state") === "state";
  if (stepMs % PURCHASE_EVERY_MS !== 0)
    throw new RangeError(`the step must be a whole number of ${PURCHASE_EVERY_MS} ms`);
  const joinDelay = options.joinDelay ?? "modelled";
  const delayOf = (modelledMs: number) =>
    joinDelay === "instant" ? 0 : modelledMs + (joinDelay === "modelled" ? 0 : joinDelay);
  const cloudDelayMs = options.cloudDelayMs ?? 0;
  // The batches' peak RAM by the level and the ports, within a cycle (its multipliers fixed): core's batch maths.
  let peaks = new Map<string, number>();
  let purse = freshPurse(startHomeRamGb(sourceFile1Level));
  let destroyedAtMs: number | null = null;
  // The cycle's state.
  let cycleStartMs = 0;
  let clocks: Clocks = { exp: 0, money: 0 };
  let joined: JoinedFaction[] = [];
  let cityGroup: string | null = null;
  let countdown: Countdown | null = null;
  let heldSinceOnlineMs: number | null = null;
  let held: { faction: string; augmentation: string } | null = null;
  let holds: Holds = NO_HOLDS;
  // The game's count of income since the install, sampled each step: nothing at the install.
  let incomeSamples: { onlineMs: number; gross: number }[] = [{ onlineMs: 0, gross: 0 }];
  // The brain's measure of the hack loop's income for cloud servers (#294), and when it first had a full window.
  let cloudIncome = new IncomeWindow();
  let firstRateAtMs: number | null = null;
  // The joins under way (#294): each faction, and when the brain's slow snapshot shows it joined.
  let pendingJoins = new Map<string, number>();
  let stats = freshStats();

  for (let now = 0; now <= horizonMs; now += stepMs) {
    const onlineMs = now - cycleStartMs;
    const multipliers = multipliersOf(installed, sourceFile1Level);
    const measured = options.measured?.[cycles.length];
    const grossAt = (atMs: number) =>
      measured === undefined
        ? curves.moneyAt(clocks.money, multipliers)
        : measuredAt(measured.points, atMs / MINUTE_MS).money;
    // The medium snapshots since the last step, every 10 s (#294): the clocks on, the brain's income measure, and one
    // purchase each. The step's own is below, after A6's decision, whose holds it sees (the brain's one update).
    if (onlineMs > 0) {
      for (let tickMs = onlineMs - stepMs + PURCHASE_EVERY_MS; tickMs <= onlineMs; tickMs += PURCHASE_EVERY_MS) {
        clocks = curves.advanceClocks(clocks, PURCHASE_EVERY_MS, multipliers, purse.homeRamGb, cloudRamOf(purse) === 0);
        if (tickMs < onlineMs) purchaseAt(tickMs, grossAt(tickMs) - purse.spent);
      }
    }
    const reading = measured === undefined ? null : measuredAt(measured.points, onlineMs / MINUTE_MS);
    const hacking = reading?.hacking ?? curves.hackingLevelAt(clocks.exp, multipliers);
    const gross = reading?.money ?? curves.moneyAt(clocks.money, multipliers);
    // Past the curve's last reading, or the measured cycle's end: extrapolated (#263).
    const lastMinute = measured === undefined ? curves.lastMinute : (measured.points.at(-1)?.[0] ?? 0);
    const minutesIntoCurve = measured === undefined ? Math.max(clocks.exp, clocks.money) : onlineMs / MINUTE_MS;
    if (minutesIntoCurve > lastMinute) {
      stats.extrapolatedMinutes = Math.max(stats.extrapolatedMinutes, minutesIntoCurve - lastMinute);
    }
    // The income over the brain's window (`AUGMENTATION_INCOME_WINDOW_MS`, the cloud servers' too): from the newest
    // sample at or before the window's start, as the brain keeps them (`HackLoopIncome.add`); null till it spans it.
    incomeSamples.push({ onlineMs, gross });
    while ((incomeSamples[1]?.onlineMs ?? Number.POSITIVE_INFINITY) <= onlineMs - INCOME_WINDOW_MS) {
      incomeSamples.shift();
    }
    const oldest = incomeSamples[0] as { onlineMs: number; gross: number };
    const income =
      onlineMs - oldest.onlineMs >= INCOME_WINDOW_MS
        ? (Math.max(0, gross - oldest.gross) / (onlineMs - oldest.onlineMs)) * 1000
        : null;
    // The money in hand: the gross less what the brain has spent through the cycle (#263), at the step's medium
    // snapshot, before its purchase; with `money: "gross"`, A6 and the joins see the gross instead.
    const cash = gross - purse.spent;
    const money = byCash ? cash : gross;
    const cloudRate = onlineMs > 0 ? measureAt(onlineMs, cash) : null;
    const worldRamGb = worldRamOf(purse);
    const batchesUse = batchesUseAt(hacking, multipliers, purse);
    const shareRamGb = shareRamGbOfState(purse, batchesUse, worldRamGb);
    const shareBonus = !byState
      ? shareBonusOf(curves.calibration, cycles.length)
      : (policy.homeShares ?? true)
        ? shareBonusOfPower(1 + shareRamGb / SHARE_RAM_GB)
        : shareBonusOfState(purse, curves.calibration, false);
    options.onStep?.({
      atMs: now,
      onlineMs,
      hacking,
      money,
      gross,
      income,
      cloudIncome: cloudRate,
      shareBonus,
      shareRamGb,
      batchesUse,
      worldRamGb,
      purse,
      clocks,
    });
    if (Object.hasOwn(installed, THE_RED_PILL) && hacking >= WORLD_DAEMON_HACKING) {
      destroyedAtMs = now;
      events.push({ atMs: now, kind: "destroyed" });
      break;
    }

    // The joins: each from its terms met, as long as the brain and the game take to it (#294, ./joins.ts); joined once
    // the brain's slow snapshot shows it, at the first step at or past that (a minute late at most).
    const join = (name: string) => {
      if (joined.some((each) => each.name === name)) return;
      joined = [...joined, { name, reputation: 0, favor: favor.get(name) ?? 0 }];
      events.push({ atMs: now, kind: "joined", faction: name });
    };
    const termsMet = (name: string, modelledMs: number) => {
      if (!pendingJoins.has(name) && !joined.some((each) => each.name === name)) {
        pendingJoins.set(name, now + delayOf(modelledMs));
      }
    };
    const joinDue = () => {
      for (const [name, atMs] of pendingJoins) {
        if (atMs > now) continue;
        pendingJoins.delete(name);
        join(name);
      }
    };
    for (const { faction, hacking: level, ports } of HACKER_FACTION_JOINS) {
      // Its server's port openers bought (#263), the TOR router first.
      if (hacking >= level && portsOpen(purse) >= ports) {
        termsMet(faction, hackerFactionJoinMs(level, hacking, multipliers.hacking_speed));
      }
    }
    // Tian Di Hui: hacking 50 and $1m held in one of its cities, a ticket away (`Faction/FactionInfo.tsx:680-692`).
    if (hacking >= TIAN_DI_HUI_HACKING && money >= TIAN_DI_HUI_MONEY + TRAVEL_COST) {
      termsMet(TIAN_DI_HUI, tianDiHuiJoinMs());
    }
    joinDue();
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
      if (money >= group.money) {
        const joinsMs = cityGroupJoinsMs(group.factions.length);
        for (const [index, faction] of group.factions.entries()) termsMet(faction, joinsMs[index] as number);
      }
    }
    const daedalus = daedalusRequirements(currentNode, ownedSF);
    if (count().installed >= daedalus.augmentations && hacking >= daedalus.hacking && money >= daedalus.money) {
      termsMet(DAEDALUS, daedalusJoinMs());
    }
    joinDue();

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
      shareBonus,
    };
    const resetInfo = { currentNode, ownedAugs: installed, ownedSF: { ...ownedSF } };
    const view: PolicyView = { atMs: now, onlineMs, hacking, money, installed, joined, multipliers };
    const choice =
      grindWork(policy, view, person, conditions, bitNode.FavorToDonateToFaction) ??
      factionWorkChoice(person, state(), resetInfo, conditions, count(), held);
    options.onWork?.({ atMs: now, choice, joined });
    if (choice !== null) {
      work(choice);
      stats.shareBonusSum += shareBonus;
    }
    // Every other joined faction gains passive reputation (`processPassiveFactionRepGain`, special ones and a gang's
    // aside). In the model it tips A5's ties toward the faction joined longer: NiteSec over BitRunners in cycles 3-4.
    const passiveGain = factionPassiveRepGainOf(currentNode, bitNode.FactionWorkRepGain);
    joined = joined.map((each) =>
      each.name === choice?.faction || SPECIAL_FACTIONS.includes(each.name)
        ? each
        : {
            ...each,
            reputation:
              each.reputation +
              (passiveFactionReputationPerSecond(
                person,
                each.favor,
                conditions.sourceFile15Level,
                conditions.factionWorkRepGain,
                conditions.shareBonus,
                passiveGain,
              ) *
                stepMs) /
                1000,
          },
    );

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
      income,
    });
    let reason: ModelInstallReason | null = decision.reason;
    if (policy.install !== undefined && decision.endgameHold === null && reason !== "The Red Pill") {
      reason = policy.install(view, decision.reason) ? (decision.reason ?? "policy") : null;
    }
    // #243's hold: an install the count rule chose that would leave Daedalus's count one short.
    held = null;
    let countHeld: ReturnType<typeof countHoldOf> = null;
    if (reason !== null && policy.daedalusCountHold && isCountRule(reason)) {
      countHeld = countHoldOf({
        installed,
        joined,
        currentNode,
        ownedSF,
        decision,
        money,
        income,
        person,
        conditions,
        onlineMs,
        heldSinceOnlineMs,
      });
      if (countHeld !== null) {
        heldSinceOnlineMs = countHeld.sinceOnlineMs;
        held = { faction: countHeld.next.faction, augmentation: countHeld.next.augmentation };
        stats.heldMinutes += stepMs / MINUTE_MS;
        reason = null;
      }
    }
    const clockStep = installClock(countdown, reason, decision, now);
    countdown = clockStep.countdown;
    // What the next step's purchases leave alone (packages/brain/src/desired-state.ts `#chooseProgramOrHomeRam`,
    // `#reserveForOtherPurchase`): an endgame hold's (Daedalus's $100b, The Red Pill's donation), the countdown's or
    // #243's hold's money from everything, and the lookahead's from cloud servers.
    holds = holdsOf(decision, countdown !== null, countHeld);
    if (clockStep.install && reason !== null) install(now, reason, decision, hacking, money, cash, gross, multipliers);
    // The step's own purchase, under the holds A6 has just set; none at an install (the brain's commit).
    else if (onlineMs > 0) purchaseAt(onlineMs, cash, cloudRate);
  }
  // The cycles out of the curves' range, the one under way at the horizon or the destroy too.
  const outOfRange = [...cycles.map((each) => each.extrapolatedMinutes), stats.extrapolatedMinutes].flatMap(
    (minutes, index) => (minutes > EXTRAPOLATION_BOUND_MIN ? [index + 1] : []),
  );
  return { policy: policy.name, cycles, events, destroyedAtMs, outOfRange };

  /** The rooted world servers' RAM, GB, by the ports `held`'s programs open. */
  function worldRamOf(held: Purse): number {
    return ROOTED_WORLD_RAM_GB_BY_PORTS[Math.min(portsOpen(held), ROOTED_WORLD_RAM_GB_BY_PORTS.length - 1)] as number;
  }

  /**
   * A medium snapshot `tickMs` into the cycle in the brain's income measure (the first a medium period after the Agent
   * starts again, `FIRST_INCOME_SAMPLE_MS`), with `cash` in hand and the hack loop's hosts now; the rate after it.
   */
  function measureAt(tickMs: number, cash: number): IncomeRate | null {
    if (tickMs >= FIRST_INCOME_SAMPLE_MS) {
      cloudIncome.add({ atMs: tickMs, money: cash, hostsRam: worldRamOf(purse) + cloudRamOf(purse) });
    }
    const rate = cloudIncome.rate();
    if (rate !== null) firstRateAtMs ??= tickMs;
    return rate;
  }

  /**
   * The brain's purchase at a medium snapshot `tickMs` into the cycle, with `cash` in hand (#294): one, under A6's
   * holds, a cloud server only from the first full window of its income measure (`cloudDelayMs` later in the
   * comparison's variant).
   */
  function purchaseAt(tickMs: number, cash: number, rate = measureAt(tickMs, cash)): void {
    const cloud = firstRateAtMs !== null && tickMs >= firstRateAtMs + cloudDelayMs;
    purse = afterPurchase(purse, nextPurchase(purse, cash, rate, holds, cloud));
  }

  /**
   * The batches' use of their hosts at the step (#294's item 5, ./batches.ts): core's batch maths at the level, the
   * cycle's multipliers and the ports open, over the hosts' RAM, times `Calibration.batchesUseFactor`, at most all.
   */
  function batchesUseAt(hacking: number, multipliers: Multipliers, held: Purse): number {
    const ports = Math.min(portsOpen(held), ROOTED_WORLD_RAM_GB_BY_PORTS.length - 1);
    const key = `${hacking}|${ports}`;
    let peakGb = peaks.get(key);
    if (peakGb === undefined) {
      const { hacking_chance, hacking_speed, hacking_money, hacking_grow } = multipliers;
      peakGb = batchesPeakGbOf({
        hacking,
        mults: { hacking_chance, hacking_speed, hacking_money, hacking_grow },
        ports,
      });
      peaks.set(key, peakGb);
    }
    const hostsGb = worldRamOf(held) + cloudRamOf(held);
    return hostsGb > 0 ? Math.min(1, (peakGb * curves.calibration.batchesUseFactor) / hostsGb) : 1;
  }

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

  function install(
    now: number,
    reason: ModelInstallReason,
    decision: InstallDecision,
    hacking: number,
    money: number,
    cash: number,
    gross: number,
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
    // The commit: the donations and the set, then home's RAM with the money above the levels' (an install keeps it),
    // then the levels. From the cash in hand, whichever money A6 saw: the purse has spent through the cycle either way.
    const homeRamGb = homeRamAtCommit(purse.homeRamGb, cash, decision.money);
    const { shareBonusSum, ...cycleStats } = stats;
    const minutesWorked = Object.values(stats.workMinutes).reduce((sum, each) => sum + each, 0);
    cycles.push({
      startMs: cycleStartMs,
      endMs: now,
      reason,
      installed: decision.names,
      neuroFluxLevels: decision.neuroFluxLevels,
      countAfter,
      hackingAtEnd: hacking,
      moneyAtEnd: money,
      grossAtEnd: gross,
      commitMoney: decision.money,
      homeRamGb,
      multipliers,
      reputation,
      favorAfter,
      ...cycleStats,
      shareBonus: minutesWorked > 0 ? shareBonusSum / ((minutesWorked * MINUTE_MS) / stepMs) : 1,
    });
    events.push({ atMs: now, kind: "install", reason, count: countAfter });
    cycleStartMs = now;
    clocks = { exp: 0, money: 0 };
    joined = [];
    cityGroup = null;
    countdown = null;
    heldSinceOnlineMs = null;
    held = null;
    holds = NO_HOLDS;
    // Programs and cloud servers are lost at an install; home's RAM is kept (`Prestige.ts`).
    purse = freshPurse(homeRamGb);
    incomeSamples = [{ onlineMs: 0, gross: 0 }];
    // A new Agent after the reset: the brain measures the cloud servers' income afresh (#194); nothing is joined.
    cloudIncome = new IncomeWindow();
    firstRateAtMs = null;
    pendingJoins = new Map();
    peaks = new Map();
    stats = freshStats();
  }
}

/**
 * Home's RAM after the commit (packages/brain/src/augmentations.ts `#decide`, committed, `:1809-1823`): the donations
 * and the set first, then home's RAM with only the money above what NeuroFlux Governor's levels hold (`neuroFluxHeld`),
 * then the levels; an install keeps it. `commitMoney` is what the counted purchases cost, the donations included.
 */
export function homeRamAtCommit(homeRamGb: number, money: number, commitMoney: number): number {
  return homeRamAfter(homeRamGb, money - commitMoney);
}

function freshStats() {
  return {
    workMinutes: {} as Record<string, number>,
    bestRatePerSecond: {} as Record<string, number>,
    donationTargetMinutes: 0,
    heldMinutes: 0,
    extrapolatedMinutes: 0,
    shareBonusSum: 0,
  };
}

/** The install's countdown under way (packages/brain/src/augmentations.ts `#decide`'s `#countdown`). */
export interface Countdown {
  endsAtMs: number;
  lengthMs: number;
  extensions: number;
  /** The count with NeuroFlux Governor when last seen: a rise extends it. */
  count: number;
}

/**
 * The install's countdown, a step on (packages/brain/src/augmentations.ts `#decide`, `:1604-1690`): none for The Red
 * Pill (installed at once); started at the rule's install (90 s, 30 s for a quick install); while it runs, a rise in
 * the count with NeuroFlux Governor extends it (core's `countdownExtensionMs`, never shortened); called off when the
 * rule stops saying install (`reason` null), or with nothing to install. At a minute's step the install comes at the
 * first step at or past its end: 90 s is 2 minutes, a minute late at most.
 */
export function installClock(
  countdown: Countdown | null,
  reason: ModelInstallReason | null,
  decision: Pick<InstallDecision, "names" | "neuroFluxLevels" | "affordableWithNeuroFlux" | "barWithNeuroFlux">,
  nowMs: number,
): { countdown: Countdown | null; install: boolean } {
  if (reason === null || decision.names.length + decision.neuroFluxLevels === 0) {
    return { countdown: null, install: false };
  }
  if (reason === "The Red Pill") return { countdown: null, install: true };
  let next: Countdown;
  if (countdown === null) {
    const lengthMs = reason === "quick install" ? QUICK_INSTALL_COUNTDOWN_MS : INSTALL_COUNTDOWN_MS;
    next = { endsAtMs: nowMs + lengthMs, lengthMs, extensions: 0, count: decision.affordableWithNeuroFlux };
  } else if (decision.affordableWithNeuroFlux > countdown.count) {
    const extensions = countdown.extensions + 1;
    const endsAtMs = nowMs + countdownExtensionMs(countdown.lengthMs, extensions, decision.barWithNeuroFlux);
    next = {
      ...countdown,
      extensions,
      endsAtMs: Math.max(countdown.endsAtMs, endsAtMs),
      count: decision.affordableWithNeuroFlux,
    };
  } else next = { ...countdown, count: decision.affordableWithNeuroFlux };
  return nowMs >= next.endsAtMs ? { countdown: null, install: true } : { countdown: next, install: false };
}

/**
 * What the brain's purchases leave alone after A6's decision (packages/brain/src/desired-state.ts
 * `#chooseProgramOrHomeRam`, `:973-1017`, and `#reserveForOtherPurchase`; augmentations.ts `reserve`,
 * `countdownReserve`, `daedalusHold`, `redPillHold`): an endgame hold's money from home's RAM and cloud servers, and
 * from programs too for The Red Pill's donation only (Daedalus's $100b doesn't hold programs); in the countdown, the
 * counted purchases' money from home's RAM and cloud servers, and no program; held for Daedalus's count (#243), the
 * counted purchases' money or the set's and the last's, if more, and no program; else the lookahead's reserve from
 * cloud servers alone.
 */
export function holdsOf(
  decision: Pick<InstallDecision, "endgameHold" | "endgameHoldFor" | "money" | "set" | "lookahead">,
  countdownUnderWay: boolean,
  countHeld: { next: { money: number } } | null,
): Holds {
  if (decision.endgameHold !== null) {
    const fromPrograms = decision.endgameHoldFor === "redPill" ? decision.endgameHold : 0;
    return {
      fromHomeRam: decision.endgameHold,
      fromPrograms,
      fromCloudServers: decision.endgameHold,
      countdownUnderWay: false,
    };
  }
  if (countHeld !== null) {
    const held = Math.max(decision.money, decision.set.money + decision.set.donationMoney + countHeld.next.money);
    return { fromHomeRam: held, fromPrograms: 0, fromCloudServers: held, countdownUnderWay: true };
  }
  if (countdownUnderWay) {
    return { fromHomeRam: decision.money, fromPrograms: 0, fromCloudServers: decision.money, countdownUnderWay: true };
  }
  return { fromHomeRam: 0, fromPrograms: 0, fromCloudServers: decision.lookahead, countdownUnderWay: false };
}

/**
 * What home keeps free of share threads for the Agent's workers, GB: the brain's `SHARE_HOME_KEPT_GB`
 * (packages/brain/src/share.ts, 4 × `HOME_KEPT_FOR_THE_AGENT_GB`), checked equal by the brain's tests.
 */
export const SHARE_HOME_KEPT_GB = 32;
/**
 * Home's RAM in use beside the share, GB: what the Agent and its largest fresh-save worker take, the brain's
 * `HOME_KEPT_FOR_THE_AGENT_GB` (packages/brain/src/batcher.ts), an equal constant (the brain's tests check it). That's
 * what the brain reserves, not the game's `getServerUsedRam("home")`, which `shareRound` is given live and which
 * holds whatever else runs on home. The batches never run on home.
 */
export const HOME_USED_BY_THE_AGENT_GB = 8;

/**
 * The RAM in share threads while working, GB (#263), by #242's rule (today's brain): core's `shareRound` itself, on two
 * hosts. Home, which the batches never use, with the Agent's `HOME_USED_BY_THE_AGENT_GB` in use and
 * `SHARE_HOME_KEPT_GB` kept; and the batches' hosts as one, the rooted world servers (`worldRamGb`) and the cloud
 * servers, at `batchesUse` in use (#294: from the state, `batchesUseOf`; the cycle's index until then), which share
 * only up to core's `SHARE_MOST_USE`. The batches' reserve for their next peak (`shareReserveGb`) is left out: the
 * share is the most the RAM allows.
 */
export function shareRamGbOfState(purse: Purse, batchesUse: number, worldRamGb = 0): number {
  const use = batchesUse;
  const batchesGb = worldRamGb + cloudRamOf(purse);
  const { placed } = shareRound(
    [
      {
        host: "home",
        maxGb: purse.homeRamGb,
        usedGb: Math.min(purse.homeRamGb, HOME_USED_BY_THE_AGENT_GB),
        batches: false,
      },
      { host: "the batches' hosts", maxGb: batchesGb, usedGb: use * batchesGb },
    ],
    0,
    SHARE_HOME_KEPT_GB,
  );
  return placed.reduce((sum, each) => sum + each.threads, 0) * SHARE_RAM_GB;
}

/**
 * The share bonus while working, from the cycle's RAM (#263; core's `shareBonusOfPower`, the game's
 * `calculateShareBonus`), in share threads of `SHARE_RAM_GB` each. The RAM, not the install index (#260's), so a
 * policy that moves the installs gets its own.
 * - `homeShares` (#242, today's brain; the default, as `CyclePolicy.homeShares`'): `shareRamGbOfState`'s threads, the
 *   batches using `batchesUse` of their hosts.
 * - Else (run #3's brain, before #242): one cap over every host, which the batches' use filled for long stretches, and
 *   the share gapped between rounds (#242's table: ×1.0 in up to 69% of an hour's fast samples). Not the rule's to say:
 *   `Calibration.shareRamShare` of home's and the cloud servers' RAM, fitted on run #3.
 */
export function shareBonusOfState(
  purse: Purse,
  calibration: Calibration,
  homeShares = true,
  worldRamGb = 0,
  batchesUse = 1,
): number {
  if (!homeShares) {
    const ram = purse.homeRamGb + cloudRamOf(purse);
    return shareBonusOfPower(1 + (calibration.shareRamShare * ram) / SHARE_RAM_GB);
  }
  return shareBonusOfPower(1 + shareRamGbOfState(purse, batchesUse, worldRamGb) / SHARE_RAM_GB);
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
  /** What the counted purchases cost: the set, the levels and the donations (core's `affordableCounts`). */
  money: number;
  /** The count with NeuroFlux Governor's levels, and its bar (core's `installRule`): the countdown's extensions. */
  affordableWithNeuroFlux: number;
  barWithNeuroFlux: number;
  /** An endgame hold's money (A8: Daedalus's $100b, The Red Pill's donation), or null for none: then no install. */
  endgameHold: number | null;
  /** What the endgame holds for (core's `augmentationEndgame`'s `why`), or null for no hold. */
  endgameHoldFor: EndgameHold["why"] | null;
  /**
   * The lookahead's reserve (#213, #222), held from cloud servers before the rule says install: the counted purchases'
   * money for an install the rule would choose with `AUGMENTATION_RESERVE_LOOKAHEAD_MS` more income, else 0.
   */
  lookahead: number;
}

/** The brain's lookahead for its reserve (packages/brain/src/augmentations.ts `AUGMENTATION_RESERVE_LOOKAHEAD_MS`). */
export const AUGMENTATION_RESERVE_LOOKAHEAD_MS = 15 * 60_000;
/** The brain's income window (augmentations.ts `AUGMENTATION_INCOME_WINDOW_MS`, cloud-servers.ts's too). */
export const INCOME_WINDOW_MS = 10 * 60_000;

/**
 * A6's decision before the commit, as the brain makes it (packages/brain/src/augmentations.ts), with core's own
 * functions (#260): the shops (`augmentationShops`), A8's endgame ahead of the count rule (`augmentationEndgame`), the
 * set the money covers less The Red Pill's donation (`chooseAugmentationsToBuy`), and the counts and the rule on it
 * (`installJudgement`); with no install, the lookahead's reserve at `income` (#263). The model buys at the commit, so
 * nothing is queued or installable through a cycle, and it has no purchase reported but unshown. An endgame hold
 * installs nothing (`endgameHold`).
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
  income = null,
  sinceResetMs = onlineMs,
}: {
  installed: Readonly<Record<string, number>>;
  joined: readonly JoinedFaction[];
  currentNode: number;
  ownedSF: Readonly<Record<string, number>>;
  money: number;
  hacking: number;
  factionRep: number;
  onlineMs: number;
  income?: number | null;
  /** The game's time since the install: a quick install's limit too (the brain's); the model's is `onlineMs`. */
  sinceResetMs?: number;
}): InstallDecision {
  const multipliers = augmentationBitNodeMultipliers(currentNode, ownedSF);
  const state = purchaseStateOf(installed, ownedSF, multipliers);
  const owned = (name: string) => Object.hasOwn(installed, name);
  const shops = augmentationShops(joined, currentNode, state, owned);
  const count = daedalusCountOf({ currentNode, ownedSF, installed, joined, invitations: [] });
  const terms = donationTermsOf(
    shops.joined,
    shops.shops,
    shops.sold.filter((name) => !owned(name) && shops.sellerOf(name) === null),
    factionRep,
    multipliers,
  );
  const endgame = augmentationEndgame({
    installed,
    installable: [],
    queue: [],
    state,
    shops,
    money,
    factionRep,
    figures: { money, skills: { hacking, strength: 1, defense: 1, dexterity: 1, agility: 1 } },
    currentNode,
    ownedSF,
    // The destroy is the model's at w0r1d_d43m0n's level.
    destroyWanted: true,
  });
  const budget = money - (endgame.kind === "redPill" ? (endgame.donation?.amount ?? 0) : 0);
  const set = chooseAugmentationsToBuy(shops.reached, state, budget, hacking, terms, count.short);
  const names = set.purchases.map((purchase) => purchase.name);
  const noCounts = { neuroFluxLevels: 0, affordableWithNeuroFlux: 0, barWithNeuroFlux: 0, lookahead: 0 };
  if (endgame.kind === "hold") {
    const held = { endgameHold: endgame.reserve, endgameHoldFor: endgame.why };
    return { reason: null, names: [], set, terms, money: 0, ...held, ...noCounts };
  }
  if (endgame.kind === "redPill") {
    const redPill = { names: [...names, THE_RED_PILL], set, terms, endgameHold: null, endgameHoldFor: null };
    return { reason: "The Red Pill", ...redPill, ...noCounts, money: set.money + set.donationMoney };
  }
  const judge = (spare: number, covered: typeof set, laterMs = 0) =>
    installJudgement({
      state,
      installable: [],
      set: covered,
      money: spare,
      shops,
      owned,
      terms,
      short: count.short,
      onlineMs: onlineMs + laterMs,
      sinceResetMs: sinceResetMs + laterMs,
    });
  const { counts, rule } = judge(budget, set);
  const reason = endgame.kind === "daedalusDonations" ? "Daedalus donations" : rule.install ? rule.reason : null;
  // No install: the money the rule would install with in the lookahead, held from cloud servers (#213, #222).
  let lookahead = 0;
  if (reason === null && income !== null && income > 0) {
    const spare = budget + (income * AUGMENTATION_RESERVE_LOOKAHEAD_MS) / 1000;
    const covered = chooseAugmentationsToBuy(shops.reached, state, spare, hacking, terms, count.short);
    const ahead = judge(spare, covered, AUGMENTATION_RESERVE_LOOKAHEAD_MS);
    if (ahead.rule.install) lookahead = ahead.counts.money;
  }
  return {
    reason,
    names,
    neuroFluxLevels: counts.neuroFluxLevels,
    set,
    terms,
    money: counts.money,
    affordableWithNeuroFlux: rule.affordableWithNeuroFlux,
    barWithNeuroFlux: rule.barWithNeuroFlux,
    endgameHold: null,
    endgameHoldFor: null,
    lookahead,
  };
}

/** The share bonus in the cycle after `installs` installs: the calibration's for that cycle, past its list the last. */
export function shareBonusOf(calibration: Calibration, installs: number): number {
  const { shareBonusByCycle } = calibration;
  return shareBonusByCycle[Math.min(installs, shareBonusByCycle.length - 1)] ?? 1;
}

/**
 * The brain's hold for Daedalus's count (#243, owner decision 56) on the model's state: core's `daedalusCountHold`,
 * the countables to come by core's `countablesToCome` over core's `augmentationShops`, A5 working for the held one.
 * The work's rate leaves the share's bonus out, as the brain's does (`workConditionsOf` without it: the safe side).
 */
export function countHoldOf({
  installed,
  joined,
  currentNode,
  ownedSF,
  decision,
  money,
  income,
  person,
  conditions,
  onlineMs,
  heldSinceOnlineMs,
}: {
  installed: Readonly<Record<string, number>>;
  joined: readonly JoinedFaction[];
  currentNode: number;
  ownedSF: Readonly<Record<string, number>>;
  decision: Pick<InstallDecision, "names" | "neuroFluxLevels" | "set"> & {
    terms: InstallDecision["terms"] | undefined;
  };
  money: number;
  income: number | null;
  person: WorkingPerson;
  conditions: WorkConditions;
  onlineMs: number;
  heldSinceOnlineMs: number | null;
}) {
  const state = purchaseStateOf(installed, ownedSF, augmentationBitNodeMultipliers(currentNode, ownedSF));
  const shops = augmentationShops(joined, currentNode, state, (name) => Object.hasOwn(installed, name));
  const required = daedalusRequirements(currentNode, ownedSF);
  return daedalusCountHold({
    installed,
    installing: [...decision.names, ...(decision.neuroFluxLevels > 0 ? [NEUROFLUX_GOVERNOR] : [])],
    required: required.augmentations,
    skillsReached: daedalusSkillsReached(person.skills, required),
    toCome: countablesToCome({
      sold: shops.sold,
      state,
      set: decision.set,
      joined: shops.joined,
      shops: shops.shops,
      terms: decision.terms,
      person,
      conditions: { ...conditions, shareBonus: 1 },
      work: { owners: null, brainWorks: true },
      money,
      income,
      // The window open, the money taken as coming while there's no income (the brain's, `:1550-1551`).
      assumeMoney: heldSinceOnlineMs !== null && onlineMs < heldSinceOnlineMs + DAEDALUS_COUNT_HOLD_MS,
    }),
    onlineMs,
    heldSinceOnlineMs,
  });
}

/** The BitNode's `FactionPassiveRepGain` (`BitNode/BitNode.tsx:587`, `:967`): 0 in BN2, BN12's `dec`, else 1. */
export function factionPassiveRepGainOf(currentNode: number, factionWorkRepGain: number): number {
  if (currentNode === 2) return 0;
  // BN12's `dec` is its FactionWorkRepGain too (`BitNode/BitNode.tsx:926`, `:968`).
  return currentNode === 12 ? factionWorkRepGain : 1;
}

/** No passive reputation for these (`info.special`, `Faction/FactionInfo.tsx:714`, `:775`, `:810`). */
export const SPECIAL_FACTIONS: readonly string[] = ["Bladeburners", "Church of the Machine God", "Shadows of Anarchy"];
