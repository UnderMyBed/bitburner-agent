// Augmentations and the reset (#210, M4 phase A slice A6): the brain buys the augmentations worth installing and
// installs them, the run's reset cycle. Choices computed from the game's formulas (owner decision 46), in core's
// augmentation-plan.ts; this is the rule as the controller runs it, and what the dashboard and the run report read.
// - Not committed: each update, the set the money covers of the augmentations reached (a joined seller's reputation
//   covers them), the counts of what's affordable, and core's `installRule`, the legacy scripts' count rule (#222,
//   owner decision 51), on a clock of the game's time the brain saw online this cycle (`advanceOnlineClock`, kept in
//   the store). The rule saying install starts a countdown in the game's time (90 s, 30 s for a quick install),
//   extended as the count rises and called off if the rule stops saying so, with the counted purchases' money held
//   back from cloud servers and home RAM. At its end, the install is chosen: committed, kept in the store until the
//   game resets, so a restarted brain carries on. Each change in the counts, the bars or the countdown is an
//   `augmentationProgress` event, for the run report.
// - Committed, one intent at a time: the set's next purchase (recomputed from what's queued), then home's RAM, which
//   an install keeps (`Server/ServerHelpers.ts:224-237`), then NeuroFlux Governor a level at a time, then, once
//   every purchase the Agent reported done shows in the faction state's queue, the install (the controller's gate and
//   backup), never of nothing (#213 re-review).
//   Once the install is asked for, nothing more is bought, so the gate's count isn't restarted by a purchase.
// - The income: a 10-minute window with no gap, for one thing alone: before the rule says install, the money is held
//   back from cloud servers only for an install the rule would choose with 15 minutes more of it (A2's, #213).
// - Fail loudly: a purchase reported done that two faction state reads after it don't show queued is
//   `augmentationNotQueued` (an event, a log line, the dashboard's alert and the run report's failure); an install
//   reported done that the next slow snapshot doesn't show reset is `augmentationInstallNotReset` (likewise).
// - The Red Pill first (#215, A8): with Daedalus's count of installed augmentations reached and its other
//   requirements but the money, no install is chosen and its $100b is held back from cloud servers, until it invites
//   (A5 joins). Joined, none is chosen while The Red Pill is short of its reputation (an install resets it,
//   `Faction/Faction.ts:77-85`), or until Daedalus's reputation unlocks its donations at the next install (#225,
//   "Daedalus donations", below); reached, or queued, the install is chosen ("The Red Pill"), and it's bought last.
// - The "Augmentations" switch, on by default (owner decision 48): off, nothing is bought or installed, and a cycle
//   under way is called off (what's bought stays queued, for the owner).
// - Donations (#225, owner decision 53, under the same switch): an augmentation sold by a joined faction with donations
//   unlocked counts as within reach when the money covers its price and the donation for its missing reputation
//   (core's `chooseAugmentationsToBuy` and `affordableCounts` with `DonationTerms`), so the counts, the countdown's
//   hold and the reserve include the donations. The commit's note records each faction's donation; committed, they go
//   first, one faction at a time (the `donateToFaction` intent), each confirmed by the faction state showing the
//   reputation before anything else is bought (else `augmentationDonationFailed`: the cycle called off, alerted).
// - Daedalus's favour (#225, legacy `autopilot.js:920-931`): with Daedalus joined, its donations not unlocked (and
//   unlockable in the BitNode), its reputation this cycle enough to unlock them at the next install, and The Red Pill's
//   not reached, an install is chosen ("Daedalus donations", the normal countdown), if anything is to install. Once
//   they're unlocked, The Red Pill's way donates its reputation and buys it when the money covers the donation.
// - Short of Daedalus's count (#228, core's `daedalusCountOf`): every augmentation but NeuroFlux Governor and The Red
//   Pill is worth installing (core's `isWorthInstalling`), in the set (hacking value first, then the cheapest), the
//   counts and bars, the countdown, the lookahead's reserve and "nothing left"; the progress says so.
// - Held for Daedalus's count (#243, core's `daedalusCountHold`): an install the count rule chose that would leave the
//   count one short is held while the last can be bought within the hold's window (`DAEDALUS_COUNT_HOLD_MS`, 20 min
//   online from the cycle's first hold, kept in the store): its reputation by work at A5's rate for its seller (with
//   the share bonus measured, #345), or a donation, and the money at the income (`countablesToCome`). No countdown
//   meanwhile; the countdown's money (or the set's and the last's, if more) held back from cloud servers and home
//   RAM; the progress, the dashboard and the log say so, and when it's over.
// - The planner's levelling install (#336, ./levelling.ts): The Red Pill installed and every install held for the
//   destroy, A6 offers the NeuroFlux Governor levels the money buys (`neuroFluxOffer`) and (#355) the set's
//   augmentations that add to levelling (`installAugmentationsOffer`; in BN2 the gang's shop's, which sells no
//   NeuroFlux Governor); once the planner
//   chooses them, the install is chosen at once (`reason` "the hacking level"), the destroy's hold set aside for it,
//   with a level to buy or that set alone.
// - The planner times installs short of Daedalus's count (#343, owner decision 67; core's install-timing.ts), in place
//   of the count rule, its quick install and the hold for the count (decisions 51 and 56): install now (the set's n new
//   to the count) or wait for the next k countables (`countablesToCome`, `nextCountables`), the least estimated time to
//   the count chosen, at every update. Installing now is chosen at once (`reason` "Daedalus's count"), never with
//   nothing new to the count (a NeuroFlux-only install). Waiting holds the set's and the k's money back from cloud
//   servers and home RAM only within the lookahead's 15 minutes, and has A5 work for the first of them by work. The
//   wait is kept in the store (a restart keeps it); still short at twice its first τ and the income's window (10
//   minutes) it's `augmentationWaitOverdue` (an event, a log line, a run report failure), and from then on every fresh
//   τ is scaled by its measured error, so a stalled wait gives way, except at the last countable, where the scaled
//   wait never exceeds T; the overdue failure reports it. With no income measured (after a restart or a gap), or while
//   an invitation's money is held (#228's hold), installing now is held unless the set meets the count; held for the
//   income past two of its windows it's `augmentationIncomeHeld` (an event, a run report failure). T counts the
//   cycle's time before the brain first saw it.
// - BN2 before the gang (#357's first slice, core's gang-route.ts): with no gang read and avmnite-02h's level in the
//   static snapshot (`gangForming`), the planned branch's candidates are wait for the gang (τ_g: avmnite-02h's level at
//   the measured experience rate, `#expRate`, and 70 s for the backdoor, the join and the forming) or install now (the
//   commit and the level again from 0 at the install's multipliers), by the time to the gang formed, a tie to waiting,
//   installing now held with no rate measured (over the rate's whole 10-minute window, `HACKING_EXP_WINDOW_MS`: its first
//   minutes overstate τ_g, #378's review). Waiting is a wait as #343's: no countdown, no money held, kept in the
//   store (`route` "gang forming"), overdue at twice τ_g and 10 minutes. The A/B's baseline (`bn2Route` "rules", tests
//   alone) takes #343's candidates there, as before.
// - BN2 with the gang (#357's second slice, core's `gangInstallTiming`): The Red Pill short at the gang's faction, the
//   planner chooses (core's endgame `gang`, in place of the count rule and G5's 20-minute hold) keep the cycle, install
//   now, or bank R* and then install, by the time to The Red Pill's reputation there: p from the gang rule
//   (`gangInstall`, the members' points × 0.95), s the set's `faction_rep`, the rate the plan's respect. Keeping and
//   banking are waits as #343's (no countdown, no money held; the World Daemon's stall watches the reputation rise);
//   installing now is chosen at once (`reason` "the gang's favour"), through the controller's gate. Every install in
//   BN2 with the gang carries its cost (`gangCost`: the reputation lost, the favour gained, The Red Pill's estimate),
//   the rules' too. While the plan earns no respect (training, justice, warfare), the cycle's last p decides (kept in
//   the store, #372's review), the World Daemon's reputation stall bounding the pause by the plan's own estimate
//   (#374: twice the gang rule's time until its plan earns respect, and 10 minutes; core's `gangTimeToEarningMs`);
//   only in a cycle where p was never known do the rules decide there, as before: nothing banked is growing, and a
//   hold would only stall. The A/B's baseline
//   (`bn2Route` "rules") keeps the count rule and G5's hold.
//   Once the count is met (Daedalus inviting or joined), or never short (The Red Pill elsewhere), the count rule times
//   installs as before (amended #343: until the planner's next slice, the Daedalus/Red Pill stretch), with The Red
//   Pill's way, Daedalus donations and levelling. The count rule short of the count stays only as the A/B's baseline
//   (`installTiming` "count rule", tests alone).
import {
  type AugmentationPurchaseState,
  type AugmentationSet,
  type AugmentationShops,
  addsToLevelling,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationEndgame,
  augmentationShops,
  type Bn2Route,
  bitNodeHackingMultipliers,
  type CountableToCome,
  type CountableWithinReach,
  chooseAugmentationsToBuy,
  countAfterInstall,
  countablesToCome,
  countablesWithinReach,
  countdownExtensionMs,
  DAEDALUS,
  DAEDALUS_COUNT_HOLD_MS,
  type DaedalusCount,
  type Donation,
  daedalusCountHold,
  daedalusCountOf,
  daedalusRequirements,
  daedalusSkillsReached,
  donationTermsOf,
  donationToReach,
  type FactionState,
  factionReadingKind,
  factionReadingOf,
  factionRepInstallMultiplier,
  GANG_RED_PILL_HOLD_MS,
  GANG_ROUTE_COMMIT_MS,
  GANG_ROUTE_SERVER,
  type GangFormingTiming,
  type GangInstallFigures,
  type GangInstallTiming,
  gangFormingTiming,
  gangInstallTiming,
  gangReputationPerSecond,
  gangSellsRedPill,
  type HoldWork,
  INSTALL_COUNTDOWN_MS,
  type InstallReason,
  type InstallTiming,
  type Intent,
  installJudgement,
  installTiming,
  intentId,
  type JoinedFaction,
  LEVEL_RISE_TERM,
  type LevelRise,
  levellingInstallMultipliers,
  levelRiseOf,
  type MediumSnapshotData,
  NETBURNERS,
  NEUROFLUX_GOVERNOR,
  type NetburnersRoute,
  type NextCountable,
  neuroFluxLadder,
  nextCountables,
  purchaseSequenceCost,
  QUICK_INSTALL_COUNTDOWN_MS,
  QUICK_INSTALL_WITHIN_MS,
  type SlowSnapshotData,
  SNAPSHOT_TIER_PERIOD_MS,
  THE_RED_PILL,
  winRouteOf,
} from "@bitburner-agent/core";
import { CLOUD_SERVER_PAYBACK_LIMIT_MS } from "./cloud-servers.ts";
import { workConditionsOf, workingPersonOf } from "./factions.ts";
import { chooseHomeRamUpgrade } from "./home-ram.ts";
import { readSwitch, writeSwitch } from "./switches.ts";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";
import { HACKING_EXP_WINDOW_MS, HackingExpRate } from "./world-daemon.ts";

// What's within reach beyond a joined seller's reputation moved to core (#260); these names stay here for the brain's
// other modules and tests.
export { type CountableWithMoney, countablesToCome, donationTermsOf, type HoldWork } from "@bitburner-agent/core";

/** The dashboard's switch (#210): on unless turned off (owner decision 48). */
export const AUGMENTATIONS_ENABLED_SETTING = "augmentations.enabled";

export function readAugmentationsEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, AUGMENTATIONS_ENABLED_SETTING, true);
}

export function writeAugmentationsEnabled(store: TelemetryStore, enabled: boolean): void {
  writeSwitch(store, AUGMENTATIONS_ENABLED_SETTING, enabled);
}

/**
 * The commit, kept in the store until the game resets: the game's `lastAugReset` when the install was chosen, and
 * whether the install has been asked for (so a restarted brain buys nothing more, #213 review).
 */
export const AUGMENTATION_CYCLE_SETTING = "augmentations.cycle";

/**
 * The bars' clock (#222), kept in the store so a restarted brain carries it on: the game's time the brain saw online
 * since the last install (`advanceOnlineClock`), keyed by that install's `lastAugReset`.
 */
export const AUGMENTATION_ONLINE_SETTING = "augmentations.online";

/**
 * The hold for Daedalus's count (#243), kept in the store so a restarted brain doesn't start its window again: the
 * cycle's `lastAugReset`, and the time online at its first hold.
 */
export const AUGMENTATION_COUNT_HOLD_SETTING = "augmentations.countHold";

/** How long the income is measured over: the slow snapshots' money sources across 10 minutes. */
export const AUGMENTATION_INCOME_WINDOW_MS = 10 * 60_000;

/**
 * The share bonus A6's estimates by work take (#345's review): the mean of its samples over the income's window, one a
 * slow snapshot, so a dip for an update (a stale health, a batcher restarting, a work switch) moves it a tenth of the
 * way to 1, and it is 1 only once no share ran in the whole window; 1 with no samples.
 */
export function shareBonusMean(bonuses: readonly number[]): number {
  return bonuses.length === 0 ? 1 : bonuses.reduce((sum, bonus) => sum + bonus, 0) / bonuses.length;
}
/**
 * Slow snapshots further apart than this (3 slow intervals, 3 minutes) have a gap between them: the game closed
 * (offline earns a fraction of the online rate), or the Agent or the brain away. The time across it isn't online time
 * (the bars' clock leaves it out, #222), and what was earned across it isn't the income, so the window starts again.
 */
export const AUGMENTATION_SLOW_GAP_MS = 3 * SNAPSHOT_TIER_PERIOD_MS.slow;
/**
 * Before the rule says install, money is held back from cloud servers (A2, #194) only for an install the rule would
 * choose with this much more income: A2's payback limit (`CLOUD_SERVER_PAYBACK_LIMIT_MS`, 15 minutes, decided in
 * #213's review). A server bought now pays itself back within it, so holding money any sooner would cost the income.
 */
export const AUGMENTATION_RESERVE_LOOKAHEAD_MS = CLOUD_SERVER_PAYBACK_LIMIT_MS;
/**
 * Faction state reads after a purchase reported done that may miss it before it's `augmentationNotQueued`: 2. The first
 * may have been read before the purchase, in the same round (snapshots come before the intents).
 */
export const NOT_QUEUED_AFTER_READS = 2;

/**
 * The money sources that are earnings (`utils/MoneySourceTracker.ts`): what the income counts. The rest are spending
 * (servers, augmentations, Hacknet's and a gang's expenses, classes, hospitals), mixed (stocks, corporations, casino),
 * or "other", which holds program purchases and an install's starting money alike.
 */
export const EARNING_SOURCES = ["hacking", "work", "crime", "hacknet", "codingcontract", "infiltration"] as const;

/** The events the rule stores (#210), for the run report. */
export const AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND = "augmentationInstallChosen";
export const AUGMENTATION_BOUGHT_EVENT_KIND = "augmentationBought";
export const AUGMENTATION_NOT_QUEUED_EVENT_KIND = "augmentationNotQueued";
export const AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND = "augmentationCycleCalledOff";
/** Stored by the controller, as the install goes out (its reset note written): the brain's, or the owner's. */
export const AUGMENTATION_INSTALL_SENT_EVENT_KIND = "augmentationInstallSent";
/**
 * The install reported done, and the next slow snapshot showing no reset (#213 re-review): the game had nothing to
 * install, though the faction state's queue said otherwise. The cycle is called off; a run report failure.
 */
export const AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND = "augmentationInstallNotReset";
/**
 * The counts, a bar or the countdown changed (#222), or why the rule is held: one each time, none while steady. The
 * run report lists them, and fails a cycle overdue its install on them.
 */
export const AUGMENTATION_PROGRESS_EVENT_KIND = "augmentationProgress";
/** A change in the counts alone is recorded at most this often (#222 review); any other change at once. */
export const AUGMENTATION_PROGRESS_COUNTS_EVERY_MS = 5 * 60_000;
/**
 * A donation reported done that the faction state then showed (#225): the faction's reputation before and after. One
 * that two faction state reads after it don't show is `augmentationDonationFailed` (the cycle called off, alerted).
 */
export const AUGMENTATION_DONATED_EVENT_KIND = "augmentationDonated";
export const AUGMENTATION_DONATION_FAILED_EVENT_KIND = "augmentationDonationFailed";
/**
 * The planner's wait for Daedalus's count (#343) still short of the countables it waited for at twice its first τ and
 * `INSTALL_WAIT_OVERDUE_SLACK_MS` online: the estimate was wrong. Once a wait; a run report failure.
 */
export const AUGMENTATION_WAIT_OVERDUE_EVENT_KIND = "augmentationWaitOverdue";
/**
 * Installing now held for the income (#343: none measured, the set short of Daedalus's count) for two of the income's
 * windows online without a break (`INCOME_HELD_TOO_LONG_MS`): the income isn't being measured. Once a hold; a run
 * report failure.
 */
export const AUGMENTATION_INCOME_HELD_EVENT_KIND = "augmentationIncomeHeld";
/**
 * The overdue wait's slack beyond twice its τ (#343): the income's window, 10 minutes
 * (`AUGMENTATION_INCOME_WINDOW_MS`), which a restart or a gap takes to measure again, the money's τ never until then.
 */
export const INSTALL_WAIT_OVERDUE_SLACK_MS = AUGMENTATION_INCOME_WINDOW_MS;
/** How long installing now may be held for the income before it's a failure: two of its windows (#343). */
export const INCOME_HELD_TOO_LONG_MS = 2 * AUGMENTATION_INCOME_WINDOW_MS;

/**
 * Who times installs short of Daedalus's count (#343): the planner (the brain's), or the count rule with decision 56's
 * hold, as before #343, kept as the A/B's baseline (decision 67, point 6): a test's choice alone.
 */
export type InstallTimingPolicy = "planner" | "count rule";

/**
 * The planner's install timing as the progress, the event and the dashboard give it (#343): core's `InstallTiming`
 * (N, n, T, each candidate's τ and estimate, the choice), the next countables in turn (each one's τ, how it comes), and
 * the words.
 */
export type InstallTimingView = InstallTiming & {
  next: Pick<NextCountable, "augmentation" | "faction" | "way" | "tauMs">[];
  /** The time online this cycle, the bars' clock (#388: T, `onlineMs`, is it, `onlineBeforeMs` and `unseenMs`). */
  timeOnlineMs: number;
  /**
   * The game's time before the brain first saw the cycle, which T counts whole (#388, `cycleUnseenMs`): a cycle first
   * seen over `AUGMENTATION_SLOW_GAP_MS` past its install, its time online then not known. Absent where there's none.
   */
  unseenMs?: number;
  /** `unseenMs` is a store's from before #343 (#397's review): mostly the gaps its clock left out. */
  unseenGaps?: true;
  /**
   * τ by work along the level's rise (#401, core's level-rise.ts): the experience rate a second at the level now it
   * takes, and whence: measured now (`HackingExpRate`'s window) or the last cycle's carried over the install
   * (`AUGMENTATION_LEVEL_RISE_SETTING`), the larger. Absent with neither: at the level now.
   */
  levelRise?: {
    expPerSecond: number;
    from: "measured now" | "the last cycle's";
    /** The last cycle's: its dead time, and whether measured (a ramp) or the fallback (`LEVEL_RAMP_FALLBACK_MS`). */
    deadMs?: number;
    deadMeasured?: boolean;
  };
  /** The time online in the store's slow snapshots of the cycle before the bars' clock began (#388): T counts it. */
  onlineBeforeMs?: number;
  words: string;
  /**
   * BN2 before the gang (#357's (1)): its candidates in place of #343's, install now (k 0) and wait for the gang (k 1),
   * each by the time to the gang formed; absent, #343's.
   */
  route?: typeof GANG_FORMING_ROUTE | typeof GANG_FORMED_ROUTE;
  /** (1)'s figures (#357): τ_g, R, the level, avmnite-02h's roll, the rate and the install's multipliers. */
  gang?: GangFormingTiming;
  /**
   * (3)'s figures (#357, `route` "gang formed"): each candidate in reputation and minutes, R*, p, s and the choice. Its
   * candidates are k 0 install now, 1 bank R* then install (its τ the time to R*), 2 keep the cycle.
   */
  gangInstall?: GangInstallTiming;
};

/** The planner's route before the gang in BN2 (#357's (1)), as the timing view, the wait and the events name it. */
export const GANG_FORMING_ROUTE = "gang forming";
/** The planner's route with the gang in BN2 (#357's (3)), before The Red Pill: keep, install now, or bank R*. */
export const GANG_FORMED_ROUTE = "gang formed";

/**
 * An install's cost in BN2 with the gang (#357's (3)), on its `augmentationInstallChosen` event, the rules' too: the
 * gang's faction's reputation it turns into favour and zeroes (`Faction.ts:77-85`), as estimated at the choice (r and
 * what the rate earns over the commit and the reading's age, core's `atInstall`), the favour before and after
 * (`favor.ts:22-24`), and The Red Pill's estimate then: after this install, and keeping instead (ms; null unmeasured
 * or never, JSON having no Infinity).
 */
export interface GangInstallCost {
  faction: string;
  reputation: number;
  favor: number;
  favorAfter: number;
  needed: number;
  redPillMs: number | null;
  keepMs: number | null;
  /** p then (the gang rule's), or null: the gang earning no respect there, so the rules' install, as before #357. */
  rateKept: number | null;
}

/** The install of the queued augmentations (#164), as the rule asks for it: the owner's has the same id. */
export const AUGMENTATION_INSTALL_INTENT: Intent = {
  id: intentId("installAugmentations", {}),
  action: "installAugmentations",
  args: {},
};

/**
 * Where the count rule stands (#222), for the dashboard, the events and the report: the counts, the bars, the time
 * online this cycle and the online time until each bar falls next (null once at 1), why it would install, the
 * countdown (its end in the game's time, and how far off), and why the rule is held (The Red Pill's way), or null.
 */
export interface AugmentationProgress {
  lastAugReset: number;
  affordable: number;
  affordableWithNeuroFlux: number;
  bar: number;
  barWithNeuroFlux: number;
  onlineMs: number;
  barFallsInMs: number | null;
  barWithNeuroFluxFallsInMs: number | null;
  reason: InstallReason | null;
  countdown: { endsAtGameMs: number; endsInMs: number; quick: boolean; extensions: number } | null;
  held: string | null;
  /** How many of the counted purchases, the set's and NeuroFlux Governor's levels, need a donation (#225). */
  byDonation: number;
  /** What the set and its donations cost (#225 review): the run report's "donations unused" weighs what's left. */
  setCost: number;
  /**
   * Short of Daedalus's count (#228): installed of required, any augmentation counting; null when not. Absent in an
   * earlier brain's progress.
   */
  short?: Pick<DaedalusCount, "installed" | "required"> | null;
  /**
   * The install held for Daedalus's count (#243): the augmentation it waits for (`CountableToCome`), its money, and
   * what's left of the hold's window; null when not. Absent in an earlier brain's progress.
   */
  countHold?: CountHoldView | null;
  /** Short of Daedalus's count, the planner's install timing (#343); null or absent when it doesn't time installs. */
  timing?: InstallTimingView | null;
}

/** An install held for Daedalus's count (#243), as the progress gives it. */
export type CountHoldView = CountableToCome & { money: number; leftMs: number };

export type AugmentationEvent =
  | {
      type: typeof AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND;
      atMs: number;
      /** The set to buy, in buy order, at its prices then, and the money in all. */
      set: { augmentation: string; price: number }[];
      cost: number;
      /** Bought already, not installed. */
      queued: string[];
      /** The game's time the brain saw online this cycle, and the counts and bars then. */
      onlineMs: number;
      affordable: number;
      affordableWithNeuroFlux: number;
      bar: number;
      barWithNeuroFlux: number;
      /** The count reached, a quick install, nothing left at the joined factions, The Red Pill or Daedalus's favour. */
      reason: InstallReason;
      /** The donations the commit makes first, one a faction (#225). */
      donations: Donation[];
      /** Short of Daedalus's count (#343): installed of required. Absent when not, or in an earlier brain's event. */
      short?: Pick<DaedalusCount, "installed" | "required">;
      /** The planner's install timing that chose it (#343), short of the count. Absent otherwise. */
      timing?: InstallTimingView;
      /** In BN2 with the gang, before The Red Pill (#357's (3)): what it costs there. Absent otherwise. */
      gangCost?: GangInstallCost;
    }
  | {
      type: typeof AUGMENTATION_INCOME_HELD_EVENT_KIND;
      atMs: number;
      /** The time online this cycle now, and when the hold began. */
      onlineMs: number;
      sinceOnlineMs: number;
      timing: InstallTimingView;
    }
  | {
      type: typeof AUGMENTATION_WAIT_OVERDUE_EVENT_KIND;
      atMs: number;
      /** The time online this cycle now, and when the wait began; its first τ, and the n it waits to reach. */
      onlineMs: number;
      sinceOnlineMs: number;
      firstTauMs: number;
      untilAdding: number;
      timing: InstallTimingView;
      /** A wait for the gang (#357's (1)); absent, #343's for the count. */
      route?: typeof GANG_FORMING_ROUTE;
    }
  | {
      type: typeof AUGMENTATION_DONATED_EVENT_KIND;
      atMs: number;
      faction: string;
      amount: number;
      /** The faction's reputation the donation is for, and as the faction state showed it before and after. */
      reputation: number;
      before: number;
      after: number;
    }
  | {
      type: typeof AUGMENTATION_DONATION_FAILED_EVENT_KIND;
      atMs: number;
      faction: string;
      amount: number;
      reputation: number;
      /** The reputation the faction state showed at its last read, and when the donation was reported done. */
      shown: number | null;
      donatedAtMs: number;
    }
  | ({ type: typeof AUGMENTATION_PROGRESS_EVENT_KIND; atMs: number } & AugmentationProgress)
  | {
      type: typeof AUGMENTATION_BOUGHT_EVENT_KIND;
      atMs: number;
      augmentation: string;
      faction: string;
      level: number;
      price: number;
      /** The queue's length with it. */
      queueLength: number;
    }
  | {
      type: typeof AUGMENTATION_NOT_QUEUED_EVENT_KIND;
      atMs: number;
      augmentation: string;
      level: number;
      boughtAtMs: number;
    }
  | { type: typeof AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND; atMs: number; reason: string }
  | {
      type: typeof AUGMENTATION_INSTALL_SENT_EVENT_KIND;
      atMs: number;
      source: "brain" | "manual";
      /** The queue as last known: the faction state's, with the purchases since. */
      queued: string[];
    }
  | {
      type: typeof AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND;
      atMs: number;
      /** The queue as last known, which the game didn't install. */
      queued: string[];
    };

/** The purchase asked for, with its price then; `augmentation` null for home's RAM and a donation (`donation`'s). */
interface Asked {
  intent: Intent;
  augmentation: string | null;
  faction: string;
  level: number;
  price: number;
  /** A donation (#225): the reputation it's for, and the faction's before it. */
  donation?: { reputation: number; before: number };
}

/** A donation reported done that the faction state hasn't shown yet (#225). */
interface Donated {
  faction: string;
  amount: number;
  reputation: number;
  before: number;
  atMs: number;
  reads: number;
  shown: number | null;
}

/** A donation the faction state never showed (#225): the alert's. */
export interface DonationFailed {
  faction: string;
  amount: number;
  reputation: number;
  donatedAtMs: number;
}

/** A purchase the Agent reported done and the faction state hasn't shown queued yet. */
interface Bought {
  augmentation: string;
  level: number;
  atMs: number;
  /** Faction state reads since it was reported done, none showing it. */
  reads: number;
}

/** A purchase reported done that the faction state never showed queued (#210): the alert's. */
export interface NotQueued {
  augmentation: string;
  level: number;
  boughtAtMs: number;
}

/**
 * An install awaiting its reset (#210), the `installNotRestarted` alert's: out when the Agent disconnected, since then;
 * or (`doneNotReset`, #213 re-review) reported done with no reset in the next slow snapshot, since then.
 */
export interface InstallAwaitingRestart {
  id: string;
  sinceMs: number;
  doneNotReset?: boolean;
}

/** What the dashboard shows of augmentations (#210). */
export interface AugmentationsView {
  enabled: boolean;
  /** No medium and slow snapshots from the connected Agent yet. */
  waiting: boolean;
  /** The donations reported done that the faction state never showed (#225), until a reset. */
  donationsFailed?: DonationFailed[];
  /** The install chosen: buying for it, or installing. */
  committed: boolean;
  /** What the brain asks for now, in words, or null. */
  asking: string | null;
  /** Not committed: the set the money covers now, in buy order, and its money. */
  set: { augmentation: string; price: number }[];
  setCost: number;
  /** Not committed: where the count rule stands (#222), or null. */
  progress: AugmentationProgress | null;
  /** The donations (#225): not committed, those the counts plan; committed, the note's. */
  donations: Donation[];
  /** Why nothing is asked for, or no install chosen, or null. */
  waitingFor: string | null;
  notQueued: NotQueued[];
  /**
   * The money held back from cloud servers (A2) for augmentations: Infinity while committed; in the countdown, what
   * the counted purchases cost (#222); before it, that only for an install the rule would choose with
   * `AUGMENTATION_RESERVE_LOOKAHEAD_MS` more income, else 0; Daedalus's $100b while it holds for its invitation (#215).
   */
  reserve: number;
}

/** What the controller hands the rule each update. */
export interface AugmentationInputs {
  mediumData: MediumSnapshotData | null;
  /**
   * The game's time when the medium snapshot was taken (its `gameTimeMs`), or null: purchases reported done in a fast
   * snapshot taken after it are taken off its money (#213 re-review).
   */
  mediumGameTimeMs: number | null;
  slowData: SlowSnapshotData | null;
  /** The game's time of the latest slow snapshot (its `gameTimeMs`), or null. */
  slowGameTimeMs: number | null;
  /** The intents the connected Agent's latest fast snapshot reports done, and the game's time it was taken, or null. */
  doneIds: ReadonlySet<string>;
  fastGameTimeMs: number | null;
  /** The latest time the controller has seen (a channel event's), for the events. */
  nowMs: number | null;
  enabled: boolean;
  homeRamEnabled: boolean;
  /**
   * The BitNode's destroy wanted once The Red Pill is installed (#215 review): the World Daemon's switch on, with
   * nothing playable left in the order to gain too, where the destroy is a replay (#311, #321). Then no ordinary
   * install is chosen: it would reset the hacking level w0r1d_d43m0n needs.
   */
  destroyWanted: boolean;
  /**
   * Who works for a faction while an install is held for Daedalus's count (#243): the owner's work, and A5's switch.
   * Absent, A5 does (its switch on, no owner's work).
   */
  holdWork?: HoldWork;
  /**
   * The gang's faction (#334, G5: the gang rule's `gangShopOf`), its reputation as the slow snapshot reports it, or
   * null (absent) with no gang. `slowData` leaves it out of the joined factions; its shop joins the others here.
   */
  gangShop?: JoinedFaction | null;
  /**
   * In BN2 with no gang reading yet (#335's review, the gang rule's `gangUnread`): whether there's a gang, and its
   * shop, unknown. A commit for The Red Pill isn't called off for want of a seller meanwhile. Absent, read.
   */
  gangUnread?: boolean;
  /**
   * The planner's levelling choice is NeuroFlux Governor's levels and the set, then an install (#336, #355,
   * ./levelling.ts): with The Red Pill installed and the destroy wanted, the install is chosen at once ("the hacking
   * level") in place of the destroy's hold, if the money buys a level or the set has an augmentation that adds to
   * levelling. Absent, not.
   */
  levellingInstall?: boolean;
  /**
   * The money #228's invitation hold keeps for an invitation (the invitations rule's `hold()`, as of its last update),
   * or 0: short of Daedalus's count, the planner holds installing now meanwhile (#343). Absent, 0.
   */
  invitationHold?: number;
  /**
   * The share bonus the batcher reports running (#345, the controller's `shareBonusOf`, ./share.ts), sampled at each
   * slow snapshot: A6's estimates by work (`countablesToCome`: the planner's τ, #243's hold) take its mean over the
   * income's window (`shareBonusMean`), a rate fitted online (owner decision 67), so a dip doesn't flip a wait to an
   * install. Absent, 1: none running.
   */
  shareBonus?: number;
  /**
   * BN2 before the gang (#357's (1)): avmnite-02h's required level (its roll, the static snapshot's), given while the
   * gang rule reads no gang in BN2; then the planner's candidates there are wait for the gang or install now. Absent or
   * null, #343's.
   */
  gangForming?: { required: number; unread?: boolean } | null;
  /**
   * BN2 with the gang (#357's (3)): what the gang rule's managed decision reads (its `installFigures`: p and the plan's
   * respect a cycle), or null (no gang managed, or unread): p unknown, so no install there. Read with p null (no
   * respect earned now), the cycle's last p decides (#372's review); never known in the cycle, the rules decide there,
   * as before #357 (G5's hold, the count rule).
   */
  gangInstall?: GangInstallFigures | null;
  /**
   * Netburners before it's joined (#387, the controller's from ./hacknet.ts's `netburnersRoute`): the planner's
   * countables count its five, by A5's work there after its Hacknet setup's money and its invitation. Absent or null,
   * none of them (it's joined, invited and joined next, hacking under 80, or Hacknet servers in the BitNode).
   */
  netburners?: NetburnersRoute | null;
}

/** What the rule asks of the controller. */
export interface AugmentationAsk {
  /** A purchase (an augmentation, home's RAM, a NeuroFlux Governor level), or null. */
  intent: Intent | null;
  /** The install: the controller queues it after the owner's, through the gate. */
  install: boolean;
  /** Committed: the program purchases (lost at the install) and cloud servers stand down. */
  committed: boolean;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecordOf = (value: unknown): value is Record<string, number> =>
  typeof value === "object" && value !== null && Object.values(value).every(isFiniteNumber);
/** "BitWire", or "NeuroFlux Governor (level 3)". */
const levelled = (augmentation: string, level: number) =>
  augmentation === NEUROFLUX_GOVERNOR ? `${augmentation} (level ${level})` : augmentation;
const formatMoney = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;

/**
 * What the rule reads of the player in a medium snapshot, or null: it's the Agent's word. The person is A5's
 * (`workingPersonOf`, #203), with the money.
 */
function playerOf(mediumData: MediumSnapshotData) {
  const person = workingPersonOf(mediumData);
  const player = mediumData.player as { money?: unknown } | undefined;
  if (person === null || !isFiniteNumber(player?.money)) return null;
  return { person, money: player.money };
}

/**
 * The hacking level, experience and level multiplier (#357's (1)): `mults.hacking` × the BitNode's
 * `HackingLevelMultiplier` (`PersonObjects/formulas/skill.ts:13`, `BitNode/BitNode.tsx`), or, unread, the multiplier
 * the level and experience imply (the World Daemon's `hackingEtaSeconds`'s). No experience read: 0, so no rate either.
 */
function hackingFiguresOf(mediumData: MediumSnapshotData, currentNode: number) {
  const player = mediumData.player as
    | { skills?: { hacking?: unknown }; exp?: { hacking?: unknown }; mults?: { hacking?: unknown } }
    | undefined;
  const level = isFiniteNumber(player?.skills?.hacking) ? player.skills.hacking : 1;
  const exp = isFiniteNumber(player?.exp?.hacking) ? player.exp.hacking : 0;
  const read = player?.mults?.hacking;
  const base = 32 * Math.log(exp + 534.6) - 200;
  const levelMult = isFiniteNumber(read)
    ? read * (bitNodeHackingMultipliers(currentNode)?.HackingLevelMultiplier ?? 1)
    : base > 0
      ? level / base
      : 1;
  return { exp, level, levelMult };
}

/** The slow snapshot's reset info as the rule needs it, or null where it doesn't say. */
function resetInfoOf(slowData: SlowSnapshotData) {
  const info = slowData.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  if (
    !Number.isInteger(info?.currentNode) ||
    !isFiniteNumber(info?.lastAugReset) ||
    !isRecordOf(info?.ownedAugs) ||
    !isRecordOf(info?.ownedSF)
  ) {
    return null;
  }
  return {
    currentNode: info.currentNode as number,
    lastAugReset: info.lastAugReset,
    ownedAugs: info.ownedAugs,
    ownedSF: info.ownedSF,
  };
}

/** The money earned since the install, from the slow snapshot's money sources, or null without them. */
export function earnedOf(slowData: SlowSnapshotData): number | null {
  const sources = slowData.moneySources;
  if (typeof sources !== "object" || sources === null) return null;
  let earned = 0;
  for (const source of EARNING_SOURCES) {
    const value = sources[source] ?? 0;
    if (!isFiniteNumber(value)) return null;
    earned += value;
  }
  return earned;
}

/** The commit as stored, or null; a value the brain didn't write fails, as the reset note does. */
export interface AugmentationCycle {
  lastAugReset: number;
  installing: boolean;
  /**
   * The NeuroFlux Governor copies to have queued, those queued and the levels counted when the install was chosen
   * (#222 review): home's RAM spends only money above the rest's. Absent in an earlier brain's note: none held.
   */
  neuroFluxTarget?: number;
  /** The donations the commit makes first, one a faction (#225). Absent in an earlier brain's note: none. */
  donations?: Donation[];
  /** Why the install was chosen (#225): "Daedalus donations" installs without The Red Pill. */
  reason?: InstallReason;
  /**
   * The faction whose donation is The Red Pill's (#225): first, never passed over; the money for it gone, the cycle is
   * called off.
   */
  redPill?: string;
  /**
   * Short of Daedalus's count at the commit (#238): what counts within reach then, for "Daedalus count stuck". Absent
   * when not short, or in an earlier brain's note.
   */
  countFacts?: CountFacts;
}

/**
 * At a commit while short of Daedalus's count (#238): the money left after the set (and its donations), what
 * NeuroFlux Governor's levels and home's RAM then take; and each augmentation that would add to the count left within
 * reach beyond the set (core's `countablesWithinReach`). The World Daemon judges an install that added none to the
 * count on them: one whose money is no more than what was left, A6's set should have taken (#238 review).
 */
export interface CountFacts {
  moneyAfterSet: number;
  within: CountableWithinReach[];
}

const isCountFacts = (value: unknown): value is CountFacts => {
  const { moneyAfterSet, within } = (value ?? {}) as Partial<CountFacts>;
  return (
    isFiniteNumber(moneyAfterSet) &&
    Array.isArray(within) &&
    within.every(
      (each) =>
        typeof each?.augmentation === "string" && typeof each.faction === "string" && isFiniteNumber(each.money),
    )
  );
};

const isDonation = (value: unknown): value is Donation => {
  const { faction, reputation, amount } = (value ?? {}) as Partial<Donation>;
  return typeof faction === "string" && isFiniteNumber(reputation) && Number.isSafeInteger(amount);
};

export function readAugmentationCycle(store: TelemetryStore): AugmentationCycle | null {
  const value = store.getSetting(AUGMENTATION_CYCLE_SETTING);
  if (value === null) return null;
  type Note = {
    lastAugReset?: unknown;
    installing?: unknown;
    neuroFluxTarget?: unknown;
    donations?: unknown;
    reason?: unknown;
    redPill?: unknown;
    countFacts?: unknown;
  };
  let note: Note | null;
  try {
    note = JSON.parse(value) as Note | null;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_CYCLE_SETTING} isn't JSON`);
  }
  const installing = note?.installing ?? false;
  const target = note?.neuroFluxTarget;
  const donations = note?.donations;
  const reason = note?.reason;
  const redPill = note?.redPill;
  const countFacts = note?.countFacts;
  if (
    !isFiniteNumber(note?.lastAugReset) ||
    typeof installing !== "boolean" ||
    (target !== undefined && !(Number.isInteger(target) && (target as number) >= 0)) ||
    (donations !== undefined && !(Array.isArray(donations) && donations.every(isDonation))) ||
    (reason !== undefined && typeof reason !== "string") ||
    (redPill !== undefined && typeof redPill !== "string") ||
    (countFacts !== undefined && !isCountFacts(countFacts))
  ) {
    throw new Error(`the store's ${AUGMENTATION_CYCLE_SETTING} isn't a note the brain wrote`);
  }
  return {
    lastAugReset: note.lastAugReset,
    installing,
    ...(target === undefined ? {} : { neuroFluxTarget: target as number }),
    ...(donations === undefined ? {} : { donations: donations as Donation[] }),
    ...(reason === undefined ? {} : { reason: reason as InstallReason }),
    ...(redPill === undefined ? {} : { redPill: redPill as string }),
    ...(countFacts === undefined ? {} : { countFacts: countFacts as CountFacts }),
  };
}

function writeAugmentationCycle(store: TelemetryStore, note: AugmentationCycle | null): void {
  if (note === null) store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
  else store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify(note));
}

/** "45 s", "12 min", "3.4 h", or "never". */
export function formatEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "never";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** The store's setting with the cycle's hold for The Red Pill at the gang's faction (#335's review), as JSON. */
export const AUGMENTATION_GANG_RED_PILL_HOLD_SETTING = "augmentations.gangRedPillHold";

/** The cycle's hold at the gang's faction: the cycle (`lastAugReset`) and the online time it first started at. */
export interface GangRedPillHold {
  lastAugReset: number;
  sinceOnlineMs: number;
}

/** The hold as stored, or null for none; a value the brain didn't write fails, as the count hold's does. */
export function readGangRedPillHold(store: TelemetryStore): GangRedPillHold | null {
  const value = store.getSetting(AUGMENTATION_GANG_RED_PILL_HOLD_SETTING);
  if (value === null) return null;
  let hold: Partial<Record<keyof GangRedPillHold, unknown>> | null;
  try {
    hold = JSON.parse(value) as typeof hold;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_GANG_RED_PILL_HOLD_SETTING} isn't JSON`);
  }
  const { lastAugReset, sinceOnlineMs } = hold ?? {};
  if (!isFiniteNumber(lastAugReset) || !isFiniteNumber(sinceOnlineMs) || sinceOnlineMs < 0) {
    throw new Error(`the store's ${AUGMENTATION_GANG_RED_PILL_HOLD_SETTING} isn't a hold the brain wrote`);
  }
  return { lastAugReset, sinceOnlineMs };
}

function writeGangRedPillHold(store: TelemetryStore, hold: GangRedPillHold): void {
  store.setSetting(AUGMENTATION_GANG_RED_PILL_HOLD_SETTING, JSON.stringify(hold));
}

/** A countdown's time in seconds, rounded (#222): "90 s", "83 s". */
function countdownSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/** The counts and bars, as the progress, the events and the report give them. */
type CountFigures = Pick<AugmentationProgress, "affordable" | "affordableWithNeuroFlux" | "bar" | "barWithNeuroFlux">;

/** "5 of 8 new augmentations affordable (7 of 12 with NeuroFlux)", and (#225) "; 2 of them by donation". */
function describeCounts({
  affordable,
  affordableWithNeuroFlux,
  bar,
  barWithNeuroFlux,
  byDonation,
}: CountFigures & { byDonation?: unknown }): string {
  const donated = isFiniteNumber(byDonation) && byDonation > 0 ? `; ${byDonation} of them by donation` : "";
  return (
    `${affordable} of ${bar} new augmentations affordable (${affordableWithNeuroFlux} of ${barWithNeuroFlux} with ` +
    `NeuroFlux${donated})`
  );
}

/**
 * Where the count rule stands, in words (#222), for the log, the dashboard and the report: "5 of 8 new augmentations
 * affordable (7 of 12 with NeuroFlux), 1.2 h online this cycle; the bar falls to 7 in 48 min".
 */
export function describeProgress(progress: CountFigures & Partial<AugmentationProgress>): string {
  const { bar, barWithNeuroFlux, onlineMs, barFallsInMs, barWithNeuroFluxFallsInMs } = progress;
  const online = isFiniteNumber(onlineMs) ? `, ${formatEta(onlineMs)} online this cycle` : "";
  const falls = isFiniteNumber(barFallsInMs)
    ? `; the bar falls to ${bar - 1} in ${formatEta(barFallsInMs)}`
    : isFiniteNumber(barWithNeuroFluxFallsInMs)
      ? `; the bar is 1, and with NeuroFlux falls to ${barWithNeuroFlux - 1} in ${formatEta(barWithNeuroFluxFallsInMs)}`
      : barFallsInMs === null && barWithNeuroFluxFallsInMs === null
        ? "; both bars are 1"
        : "";
  const short = progress.short;
  const forCount =
    short === undefined || short === null
      ? ""
      : `; short of Daedalus's count (${short.installed} of ${short.required} augmentations installed): any ` +
        "augmentation counts";
  return `${describeCounts(progress)}${online}${falls}${forCount}`;
}

/** Why the install was chosen, in words, for the log and the report; another reason, as it is. */
export function describeReason(reason: InstallReason | string, figures: Partial<CountFigures>): string {
  const counted =
    isFiniteNumber(figures.affordable) &&
    isFiniteNumber(figures.affordableWithNeuroFlux) &&
    isFiniteNumber(figures.bar) &&
    isFiniteNumber(figures.barWithNeuroFlux)
      ? describeCounts(figures as CountFigures)
      : "the counts not stored";
  if (reason === "count reached") return `the count reached: ${counted}`;
  if (reason === "quick install") {
    return `a quick install, within ${formatEta(QUICK_INSTALL_WITHIN_MS)} of the last install: ${counted}`;
  }
  if (reason === "nothing left") return "nothing else worth installing at the joined factions";
  if (reason === "The Red Pill") return "The Red Pill reached: it links w0r1d_d43m0n once installed";
  if (reason === "Daedalus's count") {
    return "Daedalus's count: the planner's shortest time to it is installing now (#343)";
  }
  if (reason === "the gang's favour") {
    return (
      `the gang's favour: in BN2 with the gang, the planner's shortest time to ${THE_RED_PILL}'s reputation is ` +
      "installing now, its reputation turned into favour (#357)"
    );
  }
  if (reason === "the hacking level") {
    return (
      `the hacking level: the planner's shortest way to w0r1d_d43m0n's is augmentations, then an ` +
      `install (#336, #355; ${counted})`
    );
  }
  if (reason === "Daedalus donations") {
    return (
      `Daedalus donations: its reputation this cycle unlocks its donations at the next install, so ${THE_RED_PILL}'s ` +
      `reputation is bought, not earned (${counted})`
    );
  }
  return reason;
}

/** "$6,750,010,000 to NiteSec (for 18,750 reputation)", for the log and the report. */
export function describeDonation({ faction, amount, reputation }: Donation): string {
  return `${formatMoney(amount)} to ${faction} (for ${Math.round(reputation).toLocaleString("en-US")} reputation)`;
}

/** The bars' clock (#222): the game's time online since the install `lastAugReset`, and the last slow snapshot's. */
export interface OnlineClock {
  lastAugReset: number;
  onlineMs: number;
  lastGameTimeMs: number;
}

/**
 * The bars' clock after a slow snapshot taken at `gameTimeMs` in the cycle `lastAugReset` (#222): it adds the time
 * since the last slow snapshot of the same cycle, if no more than `AUGMENTATION_SLOW_GAP_MS` (the game closed, or
 * the Agent or the brain away, isn't online time). Another `lastAugReset` starts it at 0: a save first seen mid-cycle
 * starts when the brain first sees it, the conservative side (the bars start at 8 and 12). Never the game's time since
 * the install, which counts the time the game was closed. Also the gap, or the clock set back (`stepMs` 0 or less),
 * that it left out, or null. The rule and the run report each fold their slow snapshots through this.
 */
export function advanceOnlineClock(
  clock: OnlineClock | null,
  gameTimeMs: number,
  lastAugReset: number,
): { clock: OnlineClock; leftOutMs: number | null } {
  if (clock === null || clock.lastAugReset !== lastAugReset) {
    return { clock: { lastAugReset, onlineMs: 0, lastGameTimeMs: gameTimeMs }, leftOutMs: null };
  }
  const stepMs = gameTimeMs - clock.lastGameTimeMs;
  if (stepMs === 0) return { clock, leftOutMs: null };
  const online = stepMs > 0 && stepMs <= AUGMENTATION_SLOW_GAP_MS;
  return {
    clock: { lastAugReset, onlineMs: clock.onlineMs + (online ? stepMs : 0), lastGameTimeMs: gameTimeMs },
    leftOutMs: online ? null : stepMs,
  };
}

/** The bars' clock as stored, or null; a value the brain didn't write fails, as the commit's note does. */
export function readOnlineClock(store: TelemetryStore): OnlineClock | null {
  const value = store.getSetting(AUGMENTATION_ONLINE_SETTING);
  if (value === null) return null;
  let clock: Partial<Record<keyof OnlineClock, unknown>> | null;
  try {
    clock = JSON.parse(value) as Partial<Record<keyof OnlineClock, unknown>> | null;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_ONLINE_SETTING} isn't JSON`);
  }
  const { lastAugReset, onlineMs, lastGameTimeMs } = clock ?? {};
  if (!isFiniteNumber(lastAugReset) || !isFiniteNumber(onlineMs) || onlineMs < 0 || !isFiniteNumber(lastGameTimeMs)) {
    throw new Error(`the store's ${AUGMENTATION_ONLINE_SETTING} isn't a clock the brain wrote`);
  }
  return { lastAugReset, onlineMs, lastGameTimeMs };
}

/** The hold's window as stored (#243), or null; a value the brain didn't write fails, as the clock does. */
export function readCountHold(
  store: TelemetryStore,
): { lastAugReset: number; sinceOnlineMs: number; ended?: boolean } | null {
  const value = store.getSetting(AUGMENTATION_COUNT_HOLD_SETTING);
  if (value === null) return null;
  let hold: { lastAugReset?: unknown; sinceOnlineMs?: unknown; ended?: unknown } | null;
  try {
    hold = JSON.parse(value) as typeof hold;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_COUNT_HOLD_SETTING} isn't JSON`);
  }
  const { lastAugReset, sinceOnlineMs, ended } = hold ?? {};
  if (
    !isFiniteNumber(lastAugReset) ||
    !isFiniteNumber(sinceOnlineMs) ||
    sinceOnlineMs < 0 ||
    (ended !== undefined && typeof ended !== "boolean")
  ) {
    throw new Error(`the store's ${AUGMENTATION_COUNT_HOLD_SETTING} isn't a hold the brain wrote`);
  }
  return { lastAugReset, sinceOnlineMs, ...(ended === true ? { ended: true } : {}) };
}

/**
 * The planner's wait for Daedalus's count (#343), kept in the store so a restarted brain carries it on: its cycle
 * (`lastAugReset`), when it began (time online), its first τ, the n it waits to reach, and whether it's overdue.
 */
export const AUGMENTATION_INSTALL_WAIT_SETTING = "augmentations.installWait";

/**
 * The cycle's last p known (#357's (3), #372's review): the rate an install leaves, kept by `lastAugReset` in the store
 * so a restart keeps it. It's the last earning plan's mix (`gangInstallRateKept` on that plan's tasks), so a pause to
 * train, a stretch on justice or warfare, keeps it: (3) decides with it then, and only a cycle where it was never
 * known falls back to the rules (G5's hold, the count rule). Never with the gang unread (#372's re-review): no install
 * on a stored p alone.
 */
export const AUGMENTATION_GANG_RATE_KEPT_SETTING = "augmentations.gangRateKept";

/** The cycle's last p as stored, or null; a value the brain didn't write fails, as the wait's does. */
export function readGangRateKept(store: TelemetryStore): { lastAugReset: number; rateKept: number } | null {
  const value = store.getSetting(AUGMENTATION_GANG_RATE_KEPT_SETTING);
  if (value === null) return null;
  let kept: { lastAugReset?: unknown; rateKept?: unknown } | null;
  try {
    kept = JSON.parse(value) as typeof kept;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_GANG_RATE_KEPT_SETTING} isn't JSON`);
  }
  const { lastAugReset, rateKept } = kept ?? {};
  if (!isFiniteNumber(lastAugReset) || !isFiniteNumber(rateKept) || rateKept < 0) {
    throw new Error(`the store's ${AUGMENTATION_GANG_RATE_KEPT_SETTING} isn't a p the brain wrote`);
  }
  return { lastAugReset, rateKept };
}

export interface InstallWait {
  lastAugReset: number;
  sinceOnlineMs: number;
  firstTauMs: number;
  untilAdding: number;
  overdue: boolean;
  /** A wait for the gang (#357's (1)): it ends as the gang forms, whatever n; absent, #343's for the count. */
  route?: typeof GANG_FORMING_ROUTE;
}

/** The wait as stored, or null; a value the brain didn't write fails, as the count hold's does. */
/**
 * The level's rise carried over an install (#401): κ, the experience rate a second per (level + 50), measured as the
 * install was asked for (`HackingExpRate` over its whole window, `HACKING_EXP_WINDOW_MS`), times the install's
 * `hacking_exp` and `hacking_speed` (core's `levellingInstallMultipliers`, the queue's), for the cycles after it
 * in the BitNode (`lastNodeReset`): a cycle's own window starts again at the install and measures the hack loop's
 * ramp, not what the RAM earns (the Red Pill holds: 15 to 800 times under the hold's rate, #401). Its cycle's
 * `lastAugReset`; a restart keeps it. `deadMs` (#405's review): the ramp's dead time for the cycle after it, the
 * cycle's own ramp measured (`AUGMENTATION_LEVEL_RAMP_SETTING`), else the last measured in the BitNode (the one it
 * carried in), else null: none measured yet (an older setting's too).
 */
export const AUGMENTATION_LEVEL_RISE_SETTING = "augmentations.levelRise";

export interface CarriedLevelRise {
  lastNodeReset: number;
  lastAugReset: number;
  kappa: number;
  deadMs: number | null;
}

/**
 * A cycle's ramp after its install (#405's review), as #389 keeps its rebuild: the time online from the install until
 * the experience rate measured (`HackingExpRate`, from its first minute) first reaches, per level + 50, the κ carried
 * into the cycle; its cycle's `lastAugReset`. Measured once a cycle, kept across a restart.
 */
export const AUGMENTATION_LEVEL_RAMP_SETTING = "augmentations.levelRamp";

/**
 * The dead time where no ramp is measured yet in the BitNode (the first install, a cycle never reaching the rate
 * carried into it, an older setting): the experience rate's window, `HACKING_EXP_WINDOW_MS`, the time before the
 * cycle's own rate is measured whole at all. Labelled in the words.
 */
export const LEVEL_RAMP_FALLBACK_MS = HACKING_EXP_WINDOW_MS;

export function readLevelRamp(store: TelemetryStore): { lastAugReset: number; rampMs: number } | null {
  const value = store.getSetting(AUGMENTATION_LEVEL_RAMP_SETTING);
  if (value === null) return null;
  let ramp: { lastAugReset?: unknown; rampMs?: unknown } | null;
  try {
    ramp = JSON.parse(value) as typeof ramp;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_LEVEL_RAMP_SETTING} isn't JSON`);
  }
  const { lastAugReset, rampMs } = ramp ?? {};
  if (!isFiniteNumber(lastAugReset) || !isFiniteNumber(rampMs) || rampMs < 0) {
    throw new Error(`the store's ${AUGMENTATION_LEVEL_RAMP_SETTING} isn't a ramp the brain wrote`);
  }
  return { lastAugReset, rampMs };
}

export function readCarriedLevelRise(store: TelemetryStore): CarriedLevelRise | null {
  const value = store.getSetting(AUGMENTATION_LEVEL_RISE_SETTING);
  if (value === null) return null;
  let carried: Partial<Record<keyof CarriedLevelRise, unknown>> | null;
  try {
    carried = JSON.parse(value) as typeof carried;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_LEVEL_RISE_SETTING} isn't JSON`);
  }
  const { lastNodeReset, lastAugReset, kappa, deadMs } = carried ?? {};
  if (
    !isFiniteNumber(lastNodeReset) ||
    !isFiniteNumber(lastAugReset) ||
    !isFiniteNumber(kappa) ||
    !(kappa > 0) ||
    (deadMs !== undefined && deadMs !== null && !(isFiniteNumber(deadMs) && deadMs >= 0))
  ) {
    throw new Error(`the store's ${AUGMENTATION_LEVEL_RISE_SETTING} isn't a rate the brain wrote`);
  }
  return { lastNodeReset, lastAugReset, kappa, deadMs: (deadMs as number | null | undefined) ?? null };
}

export function readInstallWait(store: TelemetryStore): InstallWait | null {
  const value = store.getSetting(AUGMENTATION_INSTALL_WAIT_SETTING);
  if (value === null) return null;
  let wait: Partial<Record<keyof InstallWait, unknown>> | null;
  try {
    wait = JSON.parse(value) as typeof wait;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_INSTALL_WAIT_SETTING} isn't JSON`);
  }
  const { lastAugReset, sinceOnlineMs, firstTauMs, untilAdding, overdue, route } = wait ?? {};
  if (
    !isFiniteNumber(lastAugReset) ||
    !isFiniteNumber(sinceOnlineMs) ||
    !isFiniteNumber(firstTauMs) ||
    firstTauMs < 0 ||
    !Number.isInteger(untilAdding) ||
    typeof overdue !== "boolean" ||
    (route !== undefined && route !== GANG_FORMING_ROUTE)
  ) {
    throw new Error(`the store's ${AUGMENTATION_INSTALL_WAIT_SETTING} isn't a wait the brain wrote`);
  }
  return {
    lastAugReset,
    sinceOnlineMs,
    firstTauMs,
    untilAdding: untilAdding as number,
    overdue,
    ...(route === undefined ? {} : { route }),
  };
}

function writeInstallWait(store: TelemetryStore, wait: InstallWait | null): void {
  if (wait === null) store.deleteSetting(AUGMENTATION_INSTALL_WAIT_SETTING);
  else store.setSetting(AUGMENTATION_INSTALL_WAIT_SETTING, JSON.stringify(wait));
}

/**
 * The game's time the brain first saw a cycle at (#343: its clock's start), kept in the store: the planner's T counts
 * the cycle's time before it, where that's over the gap (`cycleUnseenMs`: a save first seen mid-cycle, an install made
 * while the brain was down).
 */
export const AUGMENTATION_CYCLE_SEEN_SETTING = "augmentations.cycleSeen";

/**
 * The game's time before the brain first saw the cycle that T counts (#388): none where that was within
 * `AUGMENTATION_SLOW_GAP_MS` of its install, so T is the bars' clock alone, the time online the run report's cycles
 * show (the step from the install to the first slow snapshot left out, as there); past it, all of it, since its time
 * online isn't known: cautious, leaning towards waiting (`describeInstallTiming` says so).
 */
export function cycleUnseenMs(seen: { lastAugReset: number; gameTimeMs: number }): number {
  const beforeMs = seen.gameTimeMs - seen.lastAugReset;
  return beforeMs > AUGMENTATION_SLOW_GAP_MS ? beforeMs : 0;
}

/**
 * The game's times of the store's slow snapshots of the cycle `lastAugReset`, in the order stored (#388): a cycle the
 * clock first sees past its start (a save loaded back, a store whose clock is gone, one from before #343) gets its time
 * online from them, folded through `advanceOnlineClock` as the run report folds them. Read from
 * `AUGMENTATION_SLOW_GAP_MS` before the install on, by the brain's clock (the PC's, as the game's): none is earlier.
 */
export function readCycleLooks(store: TelemetryStore, environment: Environment, lastAugReset: number): number[] {
  const looks: number[] = [];
  const after = { receivedAtMs: lastAugReset - AUGMENTATION_SLOW_GAP_MS, id: 0 };
  for (const slow of store.iterateSlowResetInfo({ environment, after })) {
    if (slow.resetInfo?.lastAugReset === lastAugReset) looks.push(slow.gameTimeMs);
  }
  return looks;
}

/** When the brain first saw a cycle (`AUGMENTATION_CYCLE_SEEN_SETTING`), and what T counts before its clock (#388). */
export interface CycleSeen {
  lastAugReset: number;
  gameTimeMs: number;
  /** The time online in the store's slow snapshots of the cycle before the clock's start: T's, never the bars'. */
  onlineBeforeMs?: number;
  /**
   * A store from before #343 with none of the cycle's slow snapshots: `gameTimeMs` is its clock's last time less its
   * time online, so T's time before it is mostly the gaps the clock left out, not time before the brain saw it.
   */
  fromClock?: true;
}

export function readCycleSeen(store: TelemetryStore): CycleSeen | null {
  const value = store.getSetting(AUGMENTATION_CYCLE_SEEN_SETTING);
  if (value === null) return null;
  let seen: Partial<Record<keyof CycleSeen, unknown>> | null;
  try {
    seen = JSON.parse(value) as typeof seen;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_CYCLE_SEEN_SETTING} isn't JSON`);
  }
  const { lastAugReset, gameTimeMs, onlineBeforeMs, fromClock } = seen ?? {};
  if (
    !isFiniteNumber(lastAugReset) ||
    !isFiniteNumber(gameTimeMs) ||
    (onlineBeforeMs !== undefined && !(isFiniteNumber(onlineBeforeMs) && onlineBeforeMs >= 0)) ||
    (fromClock !== undefined && fromClock !== true)
  ) {
    throw new Error(`the store's ${AUGMENTATION_CYCLE_SEEN_SETTING} isn't one the brain wrote`);
  }
  return {
    lastAugReset,
    gameTimeMs,
    ...(onlineBeforeMs === undefined ? {} : { onlineBeforeMs: onlineBeforeMs as number }),
    ...(fromClock === true ? { fromClock: true as const } : {}),
  };
}

/** Whether someone works for `faction` under a hold (#243 review): the owner's faction work there, or A5's. */
function worksFor(work: HoldWork, faction: string): boolean {
  if (work.owners !== null) return work.owners.kind === "faction" && work.owners.faction === faction;
  return work.brainWorks;
}

/** "Daedalus's count reachable this cycle, The Black Hand in ~17 min (by work at The Black Hand, $7,168,…; …)". */
export function describeCountHold(hold: CountHoldView, count: Pick<DaedalusCount, "required">): string {
  const route =
    hold.way === "work"
      ? `by work at ${hold.faction}`
      : hold.way === "donation"
        ? `by a donation to ${hold.faction}`
        : `at ${hold.faction}, its reputation reached`;
  return (
    `Daedalus's count reachable this cycle, ${hold.augmentation} in ~${formatEta(hold.etaMs)} (${route}, ` +
    `${formatMoney(hold.money)}; ${count.required - 1} of ${count.required} after this install; held ` +
    `${formatEta(DAEDALUS_COUNT_HOLD_MS)} at most, ${formatEta(hold.leftMs)} left)`
  );
}

/**
 * The planner's install timing in words (#343), for the log, the dashboard and the report: "25 of 30 installed, 4 new
 * at an install, 28 min this cycle (T); to Daedalus's count: install now 28 min, wait for The Black Hand (17 min, by
 * work at The Black Hand) 17 min; chosen: wait for 1". T beside the time online where they differ: "24 min this cycle
 * (T; 3 min online)".
 */
export function describeInstallTiming(
  timing: Omit<InstallTimingView, "words">,
  count: Pick<DaedalusCount, "installed" | "required">,
): string {
  const how = ({ way, faction }: { way: string; faction: string }) =>
    way === "work" ? `by work at ${faction}` : way === "donation" ? `by a donation to ${faction}` : `at ${faction}`;
  const candidates = timing.candidates.map(({ k, tauMs, estimateMs }) => {
    if (k === 0) return `install now ${formatEta(estimateMs)}`;
    const kth = timing.next[k - 1];
    const which =
      kth === undefined ? `the next ${k}` : k === 1 ? kth.augmentation : `the next ${k}, to ${kth.augmentation}`;
    return `wait for ${which} (${formatEta(tauMs)}${kth === undefined ? "" : `, ${how(kth)}`}) ${formatEta(estimateMs)}`;
  });
  const chosen =
    timing.choice === null
      ? timing.heldForIncome || timing.heldForInvitation
        ? "none"
        : "nothing new to install, and nothing to come at the rates known"
      : timing.choice === 0
        ? "install now"
        : `wait for ${timing.choice}`;
  const scaled =
    timing.tauScale > 1 ? `; each τ ×${timing.tauScale.toFixed(1)}, the overdue wait's measured error` : "";
  const held = timing.heldForIncome
    ? "; install now held: no income measured yet (10 minutes of slow snapshots), and it doesn't meet the count"
    : timing.heldForInvitation
      ? "; install now held: the money held for an invitation (#228), and it doesn't meet the count"
      : "";
  const parts = describeTParts(timing);
  const online = parts === "" ? "" : `; ${parts}`;
  const rise =
    timing.levelRise === undefined
      ? ""
      : `; τ by work along the level's rise, ${Math.round(timing.levelRise.expPerSecond).toLocaleString("en-US")} exp/s ` +
        `now (${timing.levelRise.from}` +
        (timing.levelRise.deadMs === undefined
          ? ")"
          : timing.levelRise.deadMeasured === true
            ? `, after its ramp of ${formatEta(timing.levelRise.deadMs)} measured)`
            : `, after ${formatEta(timing.levelRise.deadMs)}: no ramp measured yet, the rate's window)`);
  return (
    `${count.installed} of ${count.required} installed, ${timing.adding} new at an install, ` +
    `${formatEta(timing.onlineMs)} this cycle (T${online}); to Daedalus's count: ` +
    `${candidates.join(", ") || "no estimate"}${scaled}${rise}; chosen: ${chosen}${held}`
  );
}

/**
 * T's parts beyond the bars' clock in words (#388), or "": the stored slow snapshots' time online, and the game's time
 * counted whole. That raises installing now's estimate at least as much as any wait's (⌈(N − n) / n⌉ cycles of T
 * against ⌈(N − n − k) / (n + k)⌉), so it leans towards waiting.
 */
export function describeTParts(
  timing: Pick<InstallTimingView, "timeOnlineMs" | "unseenMs" | "unseenGaps" | "onlineBeforeMs">,
): string {
  const parts: string[] = [];
  if (timing.onlineBeforeMs !== undefined) {
    parts.push(`${formatEta(timing.onlineBeforeMs)} online before it, in its slow snapshots stored`);
  }
  if (timing.unseenMs !== undefined) {
    parts.push(
      timing.unseenGaps === true
        ? `${formatEta(timing.unseenMs)} of the game's time not known online (a store from before #343: mostly its ` +
            "clock's gaps), counted whole: cautious, leaning towards waiting"
        : `${formatEta(timing.unseenMs)} before the brain first saw the cycle, counted whole: cautious, leaning ` +
            "towards waiting",
    );
  }
  if (parts.length === 0) return "";
  const since = timing.onlineBeforeMs === undefined ? "online" : "online since the brain saw the cycle again";
  return `${formatEta(timing.timeOnlineMs)} ${since}, and ${parts.join(", and ")}`;
}

/** The gang routes' words with T's parts (#397's review), where there are any: their estimates don't use T. */
function withTParts(words: string, timing: Parameters<typeof describeTParts>[0] & { onlineMs: number }): string {
  const parts = describeTParts(timing);
  return parts === "" ? words : `${words}; T ${formatEta(timing.onlineMs)} (${parts})`;
}

/**
 * The planner's choice before the gang in words (#357's (1)), for the log, the dashboard and the report: "no gang yet:
 * wait for the gang (avmnite-02h's 218 at 214, 13 min) against install now (1.8 h: the commit and 1.7 h from 0 at 64.8
 * experience a second); chosen: wait".
 */
export function describeGangFormingTiming(gang: GangFormingTiming): string {
  // R's rate: the rate now at the install's experience and speed multipliers (#368's review), as R reads it.
  const scaledRate =
    gang.expPerSecond === null ? null : gang.expPerSecond * gang.gain.hackingExp * gang.gain.hackingSpeed;
  const rate =
    scaledRate === null || gang.expPerSecond === null
      ? "the rate not measured"
      : `${scaledRate.toFixed(1)} experience a second (${gang.expPerSecond.toFixed(1)} now, at the install's multipliers)`;
  const install =
    gang.installNowMs === null
      ? gang.heldForRate
        ? "install now (held: the experience rate not measured yet, a minute of medium snapshots)"
        : "install now (nothing new to install)"
      : `install now (${formatEta(gang.installNowMs)}: the commit and ${formatEta(gang.rebuildMs)} from 0 at ${rate})`;
  const scaled =
    (gang.tauScale > 1 ? `; τ_g ×${gang.tauScale.toFixed(1)}, the overdue wait's measured error` : "") +
    (gang.heldForInvitation ? "; install now held: the money held for an invitation (#228)" : "") +
    (gang.heldForGangUnread
      ? "; install now held: the gang's reading unread, so whether there's a gang isn't known"
      : "");
  return (
    `no gang yet: wait for the gang (${GANG_ROUTE_SERVER}'s ${gang.required} at ${gang.level}, ` +
    `${gang.waitMs === null ? "not measured yet" : formatEta(gang.waitMs)}) ` +
    `against ${install}${scaled}; chosen: ${gang.choice}`
  );
}

/** An estimate's minutes in words: "not measured yet" (null), "never" (Infinity), else `formatEta`'s. */
const etaWords = (ms: number | null) =>
  ms === null ? "not measured yet" : Number.isFinite(ms) ? formatEta(ms) : "never";
const wholeNumber = (value: number) => Math.round(value).toLocaleString("en-US");

/**
 * The planner's choice with the gang in words (#357's (3)), for the log, the dashboard and the report: "with the gang:
 * NiteSec's 100,000 of 2,500,000 reputation, favour 0.0: keep the cycle 1.6 h, install now 1.1 h (favour 0.0 → 81.3;
 * the rate ×0.979 for the members' points, ×1.000 the set's faction_rep), bank to 242,310 then install 54 min (favour
 * 119.7, in 26 min); chosen: bank".
 */
export function describeGangInstallTiming(gang: GangInstallTiming, faction: string): string {
  const rate =
    gang.rateKept === null
      ? "the rate after it not known: no respect earned now, or the gang unread"
      : `the rate ×${gang.rateKept.toFixed(3)} for the members' points, ×${gang.factionRepGain.toFixed(3)} the set's ` +
        "faction_rep";
  const install =
    gang.installNow === null
      ? gang.heldForRate
        ? `install now (held: ${rate})`
        : gang.reputation >= gang.needed
          ? "install now (The Red Pill reached)"
          : "install now (nothing new to install)"
      : `install now ${etaWords(gang.installNowMs)} (converting about ${wholeNumber(gang.atInstall)} with the commit, ` +
        `favour ${gang.favor.toFixed(1)} → ${gang.favorAfter.toFixed(1)}; ${rate})`;
  const bank =
    gang.bankAt === null || gang.bank === null || gang.favorAtBank === null
      ? ""
      : `, bank to ${wholeNumber(gang.bankAt)} then install ${etaWords(gang.bankMs)} (favour ` +
        `${gang.favorAtBank.toFixed(1)}, in ${etaWords(gang.toBankMs)})`;
  return (
    `with the gang: ${faction}'s ${wholeNumber(gang.reputation)} of ${wholeNumber(gang.needed)} reputation, favour ` +
    `${gang.favor.toFixed(1)}: keep the cycle ${etaWords(gang.keepMs)}, ${install}${bank}; chosen: ${gang.choice}`
  );
}

/** An install's cost with the gang (#357's (3)), from (3)'s figures then: JSON's null for a time never or unmeasured. */
export function gangInstallCostOf(gang: GangInstallTiming, faction: string): GangInstallCost {
  const time = (ms: number | null) => (ms !== null && Number.isFinite(ms) ? ms : null);
  // After this install, The Red Pill's N again from 0 at the favour it gives (install now's estimate), whatever chose it.
  const installNowMs =
    gang.reputationPerSecond === null || gang.rateKept === null
      ? null
      : gangInstallTiming({ ...gang, installable: true }).installNowMs;
  return {
    faction,
    reputation: gang.atInstall,
    favor: gang.favor,
    favorAfter: gang.favorAfter,
    needed: gang.needed,
    redPillMs: time(installNowMs),
    keepMs: time(gang.keepMs),
    rateKept: gang.rateKept,
  };
}

/** "NiteSec's about 242,310 reputation lost, favour 0.0 → 119.7, The Red Pill then in ~54 min (keeping's 1.6 h)". */
export function describeGangInstallCost(cost: GangInstallCost): string {
  return (
    `${cost.faction}'s about ${wholeNumber(cost.reputation)} reputation lost, favour ${cost.favor.toFixed(1)} → ` +
    `${cost.favorAfter.toFixed(1)}, The Red Pill then in ~${etaWords(cost.redPillMs)} (keeping's ` +
    `${etaWords(cost.keepMs)})`
  );
}

/** The intent buying `augmentation` from `faction` (`level` 1 but for NeuroFlux Governor). */
export function purchaseIntent(faction: string, augmentation: string, level: number): Intent {
  const args = { faction, augmentation, level };
  return { id: intentId("purchaseAugmentation", args), action: "purchaseAugmentation", args };
}

/** The Red Pill's way, before an ordinary install is chosen (#215): `AugmentationRule`'s `#endgame`. */
type HoldReason = "destroy" | "redPillNotQueued" | "redPill" | "daedalus" | "daedalusDonations";
type Endgame =
  | { kind: "redPill"; donation: Donation | null }
  | { kind: "daedalusDonations" }
  | { kind: "hold"; why: HoldReason; waitingFor: string; reserve: number }
  /** The Red Pill short at the gang's faction, the planner's turn (#357's (3)): core's `gang`. */
  | { kind: "gang"; faction: string; reputation: number; needed: number }
  | { kind: "none" };

/**
 * The note's donations with `extra` (The Red Pill's, #225) first, so the counted ones never spend its money: one a
 * faction, for the most reputation.
 */
function withDonation(donations: readonly Donation[], extra: Donation | null): Donation[] {
  if (extra === null) return [...donations];
  const same = donations.find((each) => each.faction === extra.faction);
  const first = same !== undefined && same.reputation > extra.reputation ? same : extra;
  return [first, ...donations.filter((each) => each.faction !== extra.faction)];
}

/** The augmentation rule (#210), as the controller runs it. */
export class AugmentationRule {
  readonly #store: TelemetryStore;
  readonly #log: (line: string) => void;
  readonly #emit: (event: AugmentationEvent) => void;
  /** The income's samples: the game's time, the money earned since the install, and that install. */
  #incomeSamples: { gameTimeMs: number; earned: number; lastAugReset: number }[] = [];
  /** The share bonus's samples (#345's review): the game's time, the bonus then, and the install; the income's window. */
  #shareSamples: { gameTimeMs: number; bonus: number; lastAugReset: number }[] = [];
  /**
   * The bars' clock (#222), as stored. There's no NS call for the time online since an install
   * (`getTimeSinceLastAug` went in 3.0), so it's the time the brain saw online.
   */
  #onlineClock: OnlineClock | null;
  /**
   * The countdown under way (#222), in the game's time: its cycle, its end, its length (90 s, or 30 s quick), the
   * extensions so far, and the count with NeuroFlux last seen (a rise extends it).
   */
  #countdown: {
    lastAugReset: number;
    endsAtGameMs: number;
    lengthMs: number;
    quick: boolean;
    extensions: number;
    count: number;
    /** The game's time it last saw: an earlier one is the clock set back. */
    seenAtGameMs: number;
  } | null = null;
  /** The progress last recorded: its cycle, bars, reason, countdown and hold, its counts, and when. */
  #progress: { structural: string; counts: string; atMs: number } | null = null;
  /** The slow snapshot's game time last sampled, so each is taken once. */
  #sampledGameTimeMs: number | null = null;
  /** The game's last `lastAugReset` seen: a new one is a reset, which ends a cycle's purchases. */
  #lastAugReset: number | null = null;
  /** The purchase asked for now, with its price then. */
  #asked: Asked | null = null;
  /** The queue when last worked out: the faction state's, with the purchases reported done since. */
  #queue: string[] = [];
  /** The purchases recorded as done this game, by intent id, so each is recorded once. */
  #recorded = new Set<string>();
  #bought: Bought[] = [];
  #notQueued: NotQueued[] = [];
  /** Donations reported done, not yet shown by the faction state (#225); those it never showed, for the alert. */
  #donated: Donated[] = [];
  #donationsFailed: DonationFailed[] = [];
  /** The note's donations passed over this cycle, the money short of them then (#225): bought without. */
  #donationsSkipped = new Set<string>();
  /**
   * The money of each purchase recorded done, and the game's time of the fast snapshot reporting it (#213 review and
   * re-review): until a medium snapshot taken after that, its money is taken off the medium snapshot's, read before it.
   * The Agent's round takes its snapshots before its intents, so a purchase is in every medium snapshot taken after the
   * fast one reporting it. One reported done some rounds after it was made (a page effector's) can be taken off a
   * medium snapshot that shows it already: less money, the safe side, until the next one.
   */
  #spent: { gameTimeMs: number; price: number }[] = [];
  /** The install asked for: nothing more is bought. Kept in the commit's note too. */
  #installing = false;
  /** Why no install is chosen on The Red Pill's way (#215), as last logged: logged as it starts. */
  #holding: HoldReason | null = null;
  /** The last decision held installs for The Red Pill at the gang's faction (#335's review): the World Daemon's stall. */
  #redPillHeldAtGang = false;
  /**
   * NeuroFlux Governor's levels the money buys (#336), donations included (decision 53), as the last decision held
   * every install for the destroy, or null: the planner's install candidate.
   */
  #neuroFluxOffer: number | null = null;
  /** The set's augmentations that add to levelling (#355), as the last destroy hold had it. */
  #installAugmentationsOffer: string[] = [];
  /** (d)'s ladder and set (#380), as the last destroy hold had them, or null. */
  #batchOffer: { ladder: number[]; augmentations: string[] } | null = null;
  /** The install held for Daedalus's count (#243), as last decided, or null: logged as it starts and ends. */
  #countHeld: CountHoldView | null = null;
  /** This update logged the hold's end (#243 review): `update` logs one on any other path. */
  #countHoldEndLogged = false;
  /** Who times installs short of Daedalus's count (#343): the planner, or (the A/B's baseline) the count rule. */
  readonly #timingPolicy: InstallTimingPolicy;
  /** BN2's route (#357): the planner's before the gang, or (the A/B's baseline) #343's candidates there too. */
  readonly #bn2Route: Bn2Route;
  /** The store's slow snapshots of a cycle, by its `lastAugReset` (#388), or null: none read. */
  readonly #cycleLooks: ((lastAugReset: number) => number[]) | null;
  /** The hacking experience rate (#357's τ_g and R), from the medium snapshots: a 10-minute window, a minute at least. */
  readonly #expRate = new HackingExpRate();
  /** The medium snapshot's game time last sampled for it: each is taken once (the rate restarts on a time not later). */
  #expSampledAtMs: number | null = null;
  /** The planner's choice and n as last decided (#343), or null when it isn't timing installs: logged on a change. */
  #timingLogged: string | null = null;
  /** Installing now held for the income (#343): the cycle, when it began (online), and whether it's been reported. */
  #incomeHeld: { lastAugReset: number; sinceOnlineMs: number; reported: boolean } | null = null;
  /** The countables the planner's wait waits for (#343), as last decided: A5's work target, the reserve's. */
  #waitedFor: NextCountable[] = [];
  /**
   * While the wait waits for Netburners' countables before it's joined (#387's review): the set's money and donations,
   * which τ's setup part waits behind (core's `countablesToCome`), for the Hacknet setup's hold in place of the reserve.
   */
  #setMoneyBeforeNetburners = 0;
  /** A decision made since the brain started: a hold's window open at the first is a restarted brain's hold. */
  #decidedOnce = false;
  /** Daedalus's $100b, held back for its invitation (#215), or 0: home RAM keeps it too (#215 review). */
  #daedalusHold = 0;
  /** The Red Pill's donation's money, held back (#225 review), or 0. */
  #redPillHold = 0;
  /** The install reported done, and the latest slow snapshot's game time then: the next one should show the reset. */
  #installDone: { slowGameTimeMs: number | null } | null = null;
  /**
   * An install reported done that the next slow snapshot didn't show reset (#213 re-review), until a reset: the
   * `installNotRestarted` alert's. No other install is chosen meanwhile, as the faction state's queue isn't the game's.
   */
  #installNotReset: { atMs: number; queued: string[] } | null = null;
  #view: Omit<AugmentationsView, "enabled" | "notQueued"> = {
    waiting: true,
    committed: false,
    asking: null,
    set: [],
    setCost: 0,
    progress: null,
    donations: [],
    waitingFor: null,
    reserve: 0,
  };
  #enabled = true;

  constructor({
    store,
    log = () => {},
    emit = () => {},
    installTiming: timingPolicy = "planner",
    bn2Route = "planner",
    cycleLooks = null,
  }: {
    store: TelemetryStore;
    log?: (line: string) => void;
    emit?: (event: AugmentationEvent) => void;
    /** Who times installs short of Daedalus's count (#343): the planner unless a test asks for the count rule. */
    installTiming?: InstallTimingPolicy;
    /** BN2's route (#357): the planner's unless a test asks for the rules' (#343's before the gang). */
    bn2Route?: Bn2Route;
    /** The store's slow snapshots of a cycle (#388, `readCycleLooks`); null, none read (no environment given). */
    cycleLooks?: ((lastAugReset: number) => number[]) | null;
  }) {
    this.#store = store;
    this.#log = log;
    this.#emit = emit;
    this.#timingPolicy = timingPolicy;
    this.#bn2Route = bn2Route;
    this.#cycleLooks = cycleLooks;
    readAugmentationCycle(store);
    readCountHold(store);
    readInstallWait(store);
    readCycleSeen(store);
    this.#onlineClock = readOnlineClock(store);
  }

  /** Whether the purchase asked for is among `doneIds`, not yet recorded: the controller updates at once then. */
  askedDone(doneIds: ReadonlySet<string>): boolean {
    const asked = this.#asked;
    if (asked !== null && doneIds.has(asked.intent.id) && !this.#recorded.has(asked.intent.id)) return true;
    // The install reported done (nothing to install, says the game): watched for the reset from now.
    return this.#installDone === null && doneIds.has(AUGMENTATION_INSTALL_INTENT.id) && this.installAskedFor();
  }

  /**
   * The install asked for: here, or in the commit's note (a restarted brain's, before its first decision). The World
   * Daemon's too (#238 review): an install while short with no `countFacts` is A6's, and stuck.
   */
  installAskedFor(): boolean {
    return this.#installing || readAugmentationCycle(this.#store)?.installing === true;
  }

  /**
   * The money held for Daedalus's invitation (#215): $100b while it holds for it, else 0 (each update starts at 0, so
   * the switch off is 0 too). Home RAM keeps it too.
   */
  daedalusHold(): number {
    return this.#daedalusHold;
  }

  /**
   * The money held for The Red Pill's donation (#225), while the money is short of it with a seller's donations
   * unlocked, else 0: from cloud servers (`reserve`), home RAM and programs alike.
   */
  redPillHold(): number {
    return this.#redPillHold;
  }

  /**
   * The money held in the install's countdown (#222): what the counted purchases cost, from cloud servers (`reserve`)
   * and home RAM alike, as the legacy scripts' reserve.txt holds it from every purchase (`autopilot.js:983`); while an
   * install is held for Daedalus's count (#243), the set's and the one it waits for; while the planner waits for the
   * count (#343), the set's and those it waits for, within the lookahead (else 0); else 0.
   */
  countdownReserve(): number {
    const holding = this.#countdown !== null || this.#countHeld !== null || this.#waitedFor.length > 0;
    return this.#enabled && holding ? this.#view.reserve : 0;
  }

  /**
   * The install counting down (#222), not held for Daedalus's count (#243 review): what the travel for invitations
   * stands down for (`#installUnderWay`), as the install puts the player back in Sector-12; a hold may end in none.
   */
  countdownUnderWay(): boolean {
    return this.#enabled && this.#countdown !== null;
  }

  /**
   * The faction and augmentation an install held for Daedalus's count waits on by work (#243 review), for A5 to work
   * for (the owner's work and A5's switch still win); null when none is held, or the hold waits on a donation or money.
   * The planner's wait for the count (#343) likewise: the first of the countables it waits for by work.
   */
  countHoldTarget(): { faction: string; augmentation: string } | null {
    // Not one of a faction not joined yet (Netburners', #387): A5 works for the next meanwhile.
    const held =
      this.#countHeld ?? this.#waitedFor.find((each) => each.way === "work" && each.beforeJoinMs === undefined) ?? null;
    return held?.way === "work" ? { faction: held.faction, augmentation: held.augmentation } : null;
  }

  /**
   * The money the Hacknet setup leaves to A6 (#387's review): while the wait waits for Netburners' countables, the set's
   * alone, as their τ has the setup's money come after it (core's `countablesToCome`): the reserve and the countdown's
   * hold also count the countables' own prices (`addedMoney`), Netburners' among them, which come after the setup.
   * Otherwise the most of the reserve and the countdown's hold, as cloud servers and home RAM keep them.
   */
  hacknetReserve(): number {
    if (this.netburnersWaitedFor() !== null) return this.#setMoneyBeforeNetburners;
    return Math.max(this.reserve(), this.countdownReserve());
  }

  /**
   * Whether the planner's wait (#343) waits for one of Netburners' countables before it's joined (#387): the Hacknet
   * rule's go-ahead for its setup, with their time to its invitation (τ's part). Null while installing now, or with
   * none of them among the k.
   */
  netburnersWaitedFor(): { beforeJoinMs: number } | null {
    const first = this.#waitedFor.find((each) => each.faction === NETBURNERS && each.beforeJoinMs !== undefined);
    return this.#enabled && first?.beforeJoinMs !== undefined ? { beforeJoinMs: first.beforeJoinMs } : null;
  }

  /**
   * What counts within reach at the commit, short of Daedalus's count (#238), from the commit's note until the game
   * resets; null without a commit, or one not short. The World Daemon's facts for "Daedalus count stuck".
   */
  countFacts(): CountFacts | null {
    return readAugmentationCycle(this.#store)?.countFacts ?? null;
  }

  /** The last decision held installs for The Red Pill at the gang's faction (#335's review): its stall's to watch. */
  redPillHeldAtGang(): boolean {
    return this.#redPillHeldAtGang;
  }

  /**
   * NeuroFlux Governor's levels the money would buy at an install now (#336, core's `affordableCounts`: each level's
   * price, 1.14 times the last's and 1.9 times for each purchase queued before it, and its reputation, by donation where
   * a seller takes them), while The Red Pill is installed and every install held for the destroy; null otherwise.
   */
  neuroFluxOffer(): number | null {
    return this.#neuroFluxOffer;
  }

  /**
   * The set's augmentations (core's `chooseAugmentationsToBuy`, bought before the levels) that add to levelling
   * (core's `addsToLevelling`), while every install is held for the destroy (#355): the planner's install candidate
   * counts their multipliers, whichever shop sells them. None otherwise.
   */
  installAugmentationsOffer(): string[] {
    return [...this.#installAugmentationsOffer];
  }

  /**
   * Levelling's (d) (#380), while every install is held for the destroy, or null: the set A6 would buy at any money
   * (`chooseAugmentationsToBuy`, only what adds to levelling) and the money it and each count of NeuroFlux Governor
   * levels after it cost (core's `neuroFluxLadder`: ×1.14 a level, ×1.9 a purchase, reputation by donation where a
   * seller takes them), so a commit with entry k's money buys the set and k levels.
   */
  batchOffer(): { ladder: number[]; augmentations: string[] } | null {
    return this.#batchOffer === null
      ? null
      : { ladder: [...this.#batchOffer.ladder], augmentations: [...this.#batchOffer.augmentations] };
  }

  /** An install reported done that the next slow snapshot didn't show reset, until a reset (#213 re-review). */
  installNotReset(): { atMs: number; queued: string[] } | null {
    return this.#installNotReset === null ? null : { ...this.#installNotReset };
  }

  view(): AugmentationsView {
    return {
      ...this.#view,
      enabled: this.#enabled,
      notQueued: [...this.#notQueued],
      donationsFailed: [...this.#donationsFailed],
    };
  }

  /** The money held back from cloud servers for augmentations (#210, for A2): Infinity while committed. */
  reserve(): number {
    return this.#enabled ? this.#view.reserve : 0;
  }

  /** The queue as last worked out: the faction state's, with the purchases reported done since. */
  queued(): string[] {
    return [...this.#queue];
  }

  /** The purchases reported done that never showed queued (#210): the `augmentationNotQueued` alert's. */
  notQueued(): NotQueued[] {
    return [...this.#notQueued];
  }

  /** The donations reported done that the faction state never showed (#225): the alert's, until a reset. */
  donationsFailed(): DonationFailed[] {
    return [...this.#donationsFailed];
  }

  update(inputs: AugmentationInputs): AugmentationAsk {
    // Held again only by this update's decision (#243); a hold's end is logged whatever the path (#243 review).
    const countHeldBefore = this.#countHeld;
    this.#countHeld = null;
    this.#waitedFor = [];
    this.#setMoneyBeforeNetburners = 0;
    this.#countHoldEndLogged = false;
    const ask = this.#updateOnce(inputs, countHeldBefore);
    if (countHeldBefore !== null && this.#countHeld === null && !this.#countHoldEndLogged) {
      const endReason = !inputs.enabled
        ? "the Augmentations switch turned off"
        : `waiting for ${this.#view.waitingFor ?? "the Agent's medium and slow snapshots"}`;
      this.#log(`augmentations: the hold for Daedalus's count is over: ${endReason}`);
    }
    return ask;
  }

  #updateOnce(inputs: AugmentationInputs, countHeldBefore: CountHoldView | null): AugmentationAsk {
    const { mediumData, mediumGameTimeMs, slowData, slowGameTimeMs, doneIds, fastGameTimeMs, nowMs } = inputs;
    const { enabled, homeRamEnabled, destroyWanted } = inputs;
    const holdWork = inputs.holdWork ?? { owners: null, brainWorks: true };
    this.#daedalusHold = 0;
    this.#redPillHeldAtGang = false;
    this.#neuroFluxOffer = null;
    this.#installAugmentationsOffer = [];
    this.#batchOffer = null;
    this.#redPillHold = 0;
    this.#enabled = enabled;
    const atMs = nowMs ?? 0;
    // Nothing asked for now; the last purchase asked for is kept, so its done is recorded when it's reported (after a
    // reconnect, say).
    const askNothing = (waitingFor: string | null, view: Partial<AugmentationsView> = {}): AugmentationAsk => {
      const committed = readAugmentationCycle(this.#store) !== null;
      const reserve = committed ? Number.POSITIVE_INFINITY : 0;
      this.#view = { ...this.#view, asking: null, waitingFor, committed, reserve, ...view };
      return { intent: null, install: false, committed };
    };
    if (slowData !== null) this.#sample(slowData, slowGameTimeMs, atMs, inputs.shareBonus ?? 1);
    // The hacking experience rate (#357): each medium snapshot's, on the game's clock (an install's fall restarts it).
    const hackingExp = (mediumData?.player as { exp?: { hacking?: unknown } } | undefined)?.exp?.hacking;
    if (mediumGameTimeMs !== null && mediumGameTimeMs !== this.#expSampledAtMs && isFiniteNumber(hackingExp)) {
      this.#expSampledAtMs = mediumGameTimeMs;
      this.#expRate.add(mediumGameTimeMs, hackingExp);
    }
    this.#recordDone(doneIds, fastGameTimeMs, atMs);
    this.#watchInstallDone(doneIds, slowGameTimeMs, atMs);
    // Spending a medium snapshot taken after it already shows.
    if (mediumGameTimeMs !== null) this.#spent = this.#spent.filter((each) => each.gameTimeMs > mediumGameTimeMs);
    if (!enabled) {
      if (readAugmentationCycle(this.#store) !== null) this.#callOff(atMs, "the Augmentations switch turned off");
      this.#cancelCountdown("the Augmentations switch turned off");
      return askNothing(null, {
        waiting: false,
        committed: false,
        reserve: 0,
        progress: null,
        set: [],
        setCost: 0,
        donations: [],
      });
    }
    if (mediumData === null || slowData === null) return askNothing(null, { waiting: true });
    const resetInfo = resetInfoOf(slowData);
    if (resetInfo === null) return askNothing("the reset info in the Agent's slow snapshot", { waiting: false });
    const player = playerOf(mediumData);
    if (player === null) {
      return askNothing("the player's skills, money and multipliers in the Agent's medium snapshot", {
        waiting: false,
      });
    }
    const state: FactionState | null = factionReadingOf(slowData)?.state ?? null;
    if (state === null) {
      const problem = factionReadingOf(slowData)?.problem;
      return askNothing(`the faction state in the Agent's slow snapshot${problem ? ` (unread: ${problem})` : ""}`, {
        waiting: false,
      });
    }
    // What core doesn't know (an augmentation, a BitNode: another game version) throws: nothing, saying so.
    try {
      return this.#decide({
        state,
        resetInfo,
        player,
        slowData,
        mediumData,
        slowGameTimeMs,
        // The game's latest time seen, the countdown's clock (#222): every tier's is the game's `Date.now()`.
        gameNowMs: Math.max(
          ...[slowGameTimeMs, mediumGameTimeMs, fastGameTimeMs].filter((time): time is number => time !== null),
        ),
        atMs,
        homeRamEnabled,
        destroyWanted,
        countHeldBefore,
        holdWork,
        gangShop: inputs.gangShop ?? null,
        gangUnread: inputs.gangUnread ?? false,
        levellingInstall: inputs.levellingInstall ?? false,
        invitationHold: inputs.invitationHold ?? 0,
        shareBonus: shareBonusMean(this.#shareSamples.map((sample) => sample.bonus)),
        gangForming: inputs.gangForming ?? null,
        gangInstall: inputs.gangInstall ?? null,
        netburners: inputs.netburners ?? null,
      });
    } catch (error) {
      return askNothing(`the snapshots as core knows the game (${(error as Error).message})`, { waiting: false });
    }
  }

  /**
   * When the brain first saw a cycle its clock first sees at the game's `gameTimeMs` (#388): then, within the gap of
   * its install (an install it watched, a new game). Past it, the store's slow snapshots of it before this one, if
   * any: the first of them, and their time online folded through `advanceOnlineClock` (the run report's fold), T's
   * alone (#397's review: the bars' clock starts from 0 as before, so an irreversible install never comes sooner for
   * it, and a save loaded back doesn't count the time the load threw away). With none, now (T then counts the game's
   * time before, `cycleUnseenMs`).
   */
  #cycleSeenAt(lastAugReset: number, gameTimeMs: number): CycleSeen {
    const now = { lastAugReset, gameTimeMs };
    if (this.#cycleLooks === null || cycleUnseenMs(now) === 0) return now;
    const looks = this.#cycleLooks(lastAugReset).filter((look) => look < gameTimeMs);
    const first = looks[0];
    if (first === undefined) return now;
    let clock: OnlineClock | null = null;
    for (const look of looks) clock = advanceOnlineClock(clock, look, lastAugReset).clock;
    const onlineBeforeMs = clock?.onlineMs ?? 0;
    return { lastAugReset, gameTimeMs: first, ...(onlineBeforeMs > 0 ? { onlineBeforeMs } : {}) };
  }

  /** A slow snapshot: a reset; and once per snapshot, the bars' clock, the income's sample and the faction state's read. */
  #sample(slowData: SlowSnapshotData, gameTimeMs: number | null, atMs: number, shareBonus: number): void {
    const lastAugReset = slowData.resetInfo?.lastAugReset;
    if (isFiniteNumber(lastAugReset) && this.#lastAugReset !== null && lastAugReset !== this.#lastAugReset) {
      // A new game: its purchases start afresh.
      this.#bought = [];
      this.#notQueued = [];
      this.#donated = [];
      this.#donationsFailed = [];
      this.#donationsSkipped.clear();
      this.#recorded.clear();
      this.#spent = [];
      this.#installing = false;
      this.#installNotReset = null;
    }
    if (isFiniteNumber(lastAugReset)) {
      this.#lastAugReset = lastAugReset;
      // A commit from before a reset (seen now, or while the brain was down) is over.
      const cycle = readAugmentationCycle(this.#store);
      if (cycle !== null && cycle.lastAugReset !== lastAugReset) {
        writeAugmentationCycle(this.#store, null);
        this.#installing = false;
        this.#log("augmentations: the game has reset (installed): the install cycle is over");
      }
      if (this.#countdown !== null && this.#countdown.lastAugReset !== lastAugReset) {
        this.#cancelCountdown("the game has reset");
      }
    }
    // A reset is judged on every slow snapshot; the clock, the income and the reads once per snapshot (by its time).
    if (gameTimeMs === null || gameTimeMs === this.#sampledGameTimeMs) return;
    this.#sampledGameTimeMs = gameTimeMs;
    let gap = false;
    if (isFiniteNumber(lastAugReset)) {
      // A cycle the clock hasn't seen: when the brain first saw it (#343, the planner's T), and, first seen past its
      // start, T's time online in the store's slow snapshots of it (#388: a save loaded back, a store's clock gone).
      if (this.#onlineClock?.lastAugReset !== lastAugReset) {
        const seen = this.#cycleSeenAt(lastAugReset, gameTimeMs);
        this.#store.setSetting(AUGMENTATION_CYCLE_SEEN_SETTING, JSON.stringify(seen));
      }
      const { clock, leftOutMs } = advanceOnlineClock(this.#onlineClock, gameTimeMs, lastAugReset);
      if (clock !== this.#onlineClock) {
        this.#onlineClock = clock;
        this.#store.setSetting(AUGMENTATION_ONLINE_SETTING, JSON.stringify(clock));
      }
      if (leftOutMs !== null) {
        gap = true;
        this.#log(
          `augmentations: ${leftOutMs > 0 ? `a gap of ${formatEta(leftOutMs)}` : "the game's clock set back"} between ` +
            "slow snapshots: left out of the time online this cycle, and the income is measured afresh",
        );
      }
    }
    const earned = earnedOf(slowData);
    if (earned === null || !isFiniteNumber(lastAugReset) || gap) {
      this.#incomeSamples = [];
    } else {
      this.#incomeSamples = this.#incomeSamples.filter((sample) => sample.lastAugReset === lastAugReset);
    }
    if (earned !== null && isFiniteNumber(lastAugReset)) {
      this.#incomeSamples.push({ gameTimeMs, earned, lastAugReset });
      // The newest sample a window old or older, and those after it.
      const old = this.#incomeSamples.findLastIndex(
        (sample) => gameTimeMs - sample.gameTimeMs >= AUGMENTATION_INCOME_WINDOW_MS,
      );
      if (old > 0) this.#incomeSamples = this.#incomeSamples.slice(old);
    }
    // The share bonus's samples: this cycle's, within the window (a gap starts them afresh, as the income's).
    this.#shareSamples = this.#shareSamples.filter(
      (sample) =>
        !gap && sample.lastAugReset === lastAugReset && gameTimeMs - sample.gameTimeMs < AUGMENTATION_INCOME_WINDOW_MS,
    );
    if (isFiniteNumber(lastAugReset)) this.#shareSamples.push({ gameTimeMs, bonus: shareBonus, lastAugReset });
    this.#confirmQueued(slowData, atMs);
  }

  /**
   * The planner's wait (#343), kept in the store (`AUGMENTATION_INSTALL_WAIT_SETTING`, a restart keeps it): one begins
   * at a wait chosen with none under way in the cycle, waiting for the n the set then adds plus k, its first τ the
   * k-th's; it's over at an install chosen, once n reaches that (`current` null then), or in another cycle. Still under
   * way at twice its first τ and `INSTALL_WAIT_OVERDUE_SLACK_MS` online from its start, the estimate was wrong: once,
   * `augmentationWaitOverdue` and a log line (a run report failure), and from then on its measured error scales every
   * fresh τ (the caller's `tauScale`). Nothing to install or wait for meanwhile is still the wait's.
   */
  #watchWait(
    timing: InstallTimingView,
    current: InstallWait | null,
    stored: InstallWait | null,
    lastAugReset: number,
    onlineMs: number,
    atMs: number,
  ): void {
    const { choice, adding } = timing;
    // Only #343's and the gang forming's waits are kept (#357's (3) decides afresh from the reputation each update).
    const route = timing.route === GANG_FORMING_ROUTE ? GANG_FORMING_ROUTE : undefined;
    let wait = current === null || choice === 0 ? null : { ...current };
    if (wait === null && choice !== null && choice > 0) {
      const firstTauMs = timing.candidates.find((candidate) => candidate.k === choice)?.tauMs ?? 0;
      // The wait for the gang (#357) begins only with a τ_g measured (none held for the rate, none never), its end the
      // gang formed, whatever n.
      if (route === undefined) {
        wait = { lastAugReset, sinceOnlineMs: onlineMs, firstTauMs, untilAdding: adding + choice, overdue: false };
      } else if (Number.isFinite(firstTauMs) && timing.candidates.some((candidate) => candidate.k === choice)) {
        wait = { lastAugReset, sinceOnlineMs: onlineMs, firstTauMs, untilAdding: adding, overdue: false, route };
      }
    }
    const overdue =
      wait !== null &&
      !wait.overdue &&
      onlineMs >= wait.sinceOnlineMs + 2 * wait.firstTauMs + INSTALL_WAIT_OVERDUE_SLACK_MS;
    if (wait !== null && overdue) wait.overdue = true;
    if (JSON.stringify(wait) !== JSON.stringify(stored)) writeInstallWait(this.#store, wait);
    if (wait === null || !overdue) return;
    const { sinceOnlineMs, firstTauMs, untilAdding } = wait;
    this.#emit({
      type: AUGMENTATION_WAIT_OVERDUE_EVENT_KIND,
      atMs,
      onlineMs,
      sinceOnlineMs,
      firstTauMs,
      untilAdding,
      timing,
      ...(route === undefined ? {} : { route }),
    });
    this.#log(
      route === undefined
        ? `augmentations: WAIT OVERDUE: the planner's wait for Daedalus's count, from ${formatEta(sinceOnlineMs)} ` +
            `online, expected ${untilAdding} new at an install in ~${formatEta(firstTauMs)}, still ${adding} at ` +
            `${formatEta(onlineMs)} online: the estimate was wrong; ${timing.words}`
        : `augmentations: WAIT OVERDUE: the planner's wait for the gang, from ${formatEta(sinceOnlineMs)} online, ` +
            `expected in ~${formatEta(firstTauMs)}, still none at ${formatEta(onlineMs)} online: the estimate was ` +
            `wrong; ${timing.words}`,
    );
  }

  /**
   * Installing now held for the income (#343), without a break, `INCOME_HELD_TOO_LONG_MS` online: once,
   * `augmentationIncomeHeld` and a log line (a run report failure). In memory: a restart measures the income afresh.
   */
  #watchIncomeHold(timing: InstallTimingView, lastAugReset: number, onlineMs: number, atMs: number): void {
    if (!timing.heldForIncome) {
      this.#incomeHeld = null;
      return;
    }
    const held =
      this.#incomeHeld?.lastAugReset === lastAugReset
        ? this.#incomeHeld
        : { lastAugReset, sinceOnlineMs: onlineMs, reported: false };
    this.#incomeHeld = held;
    if (held.reported || onlineMs - held.sinceOnlineMs < INCOME_HELD_TOO_LONG_MS) return;
    held.reported = true;
    this.#emit({
      type: AUGMENTATION_INCOME_HELD_EVENT_KIND,
      atMs,
      onlineMs,
      sinceOnlineMs: held.sinceOnlineMs,
      timing,
    });
    this.#log(
      `augmentations: INCOME UNMEASURED: installing now held for the income since ${formatEta(held.sinceOnlineMs)} ` +
        `online, ${formatEta(onlineMs - held.sinceOnlineMs)}; ${timing.words}`,
    );
  }

  /**
   * The money earned a second over the window, or null until the window is a window long with no gap: for the reserve's
   * lookahead alone (#222). The samples are the game's own count since the install, so they're kept across the Agent's
   * reconnects (#213 review) but for a gap: a reset (another `lastAugReset`) starts them again.
   */
  #income(): number | null {
    const first = this.#incomeSamples[0];
    const last = this.#incomeSamples.at(-1);
    if (first === undefined || last === undefined) return null;
    const spanMs = last.gameTimeMs - first.gameTimeMs;
    if (spanMs < AUGMENTATION_INCOME_WINDOW_MS) return null;
    return (Math.max(0, last.earned - first.earned) / spanMs) * 1000;
  }

  /**
   * The install reported done (#213 re-review): the game had nothing to install, or its reset is under way. A slow
   * snapshot since that shows no reset (`#sample` ends the cycle on one, first) calls the cycle off, stored and
   * alerted.
   */
  #watchInstallDone(doneIds: ReadonlySet<string>, slowGameTimeMs: number | null, atMs: number): void {
    if (!this.installAskedFor()) {
      this.#installDone = null;
      return;
    }
    if (this.#installDone === null) {
      if (!doneIds.has(AUGMENTATION_INSTALL_INTENT.id)) return;
      this.#installDone = { slowGameTimeMs };
      this.#log("augmentations: the install reported done: the next slow snapshot should show the reset");
      return;
    }
    if (slowGameTimeMs === null || slowGameTimeMs === this.#installDone.slowGameTimeMs) return;
    const queued = [...this.#queue];
    this.#installDone = null;
    this.#installNotReset = { atMs, queued };
    this.#emit({ type: AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND, atMs, queued });
    this.#log(
      `augmentations: INSTALL REPORTED DONE BUT THE GAME DIDN'T RESET: the faction state's queue ` +
        `(${queued.join(", ") || "empty"}) isn't the game's; no install is chosen again until a reset`,
    );
    this.#callOff(atMs, "the install was reported done but the game didn't reset");
  }

  /**
   * A faction state read (not skipped, not carried over): each purchase it shows queued is confirmed; one it misses on
   * its `NOT_QUEUED_AFTER_READS`th read is `augmentationNotQueued`.
   */
  #confirmQueued(slowData: SlowSnapshotData, atMs: number): void {
    const reading = factionReadingOf(slowData);
    if (reading === null || reading.state === null) return;
    const kind = factionReadingKind(reading);
    if (kind !== "read" && kind !== "readPageNotRestored") return;
    this.#confirmDonated(reading.state, atMs);
    const queue = reading.state.queuedAugmentations;
    const installed = slowData.resetInfo?.ownedAugs?.[NEUROFLUX_GOVERNOR] ?? 0;
    const shown = (bought: Bought) =>
      bought.augmentation === NEUROFLUX_GOVERNOR
        ? installed + queue.filter((name) => name === NEUROFLUX_GOVERNOR).length >= bought.level
        : queue.includes(bought.augmentation);
    const left: Bought[] = [];
    for (const bought of this.#bought) {
      if (shown(bought)) continue;
      bought.reads += 1;
      if (bought.reads < NOT_QUEUED_AFTER_READS) {
        left.push(bought);
        continue;
      }
      const notQueued = { augmentation: bought.augmentation, level: bought.level, boughtAtMs: bought.atMs };
      this.#notQueued.push(notQueued);
      this.#emit({ type: AUGMENTATION_NOT_QUEUED_EVENT_KIND, atMs, ...notQueued });
      this.#log(
        `augmentations: ${levelled(bought.augmentation, bought.level)} NOT QUEUED: the Agent reported it bought, ` +
          `and ${NOT_QUEUED_AFTER_READS} faction state reads since don't show it`,
      );
    }
    this.#bought = left;
  }

  /**
   * The donations reported done (#225), at a faction state read: each whose faction shows its reputation is an
   * `augmentationDonated` event; one the read misses on its `NOT_QUEUED_AFTER_READS`th is `augmentationDonationFailed`,
   * alerted, and the cycle called off (what it was for won't be within reach).
   */
  #confirmDonated(state: FactionState, atMs: number): void {
    const left: Donated[] = [];
    for (const donated of this.#donated) {
      const shown = state.joined.find((each) => each.name === donated.faction)?.reputation ?? null;
      if (shown !== null && shown >= donated.reputation) {
        const { faction, amount, reputation, before } = donated;
        this.#emit({ type: AUGMENTATION_DONATED_EVENT_KIND, atMs, faction, amount, reputation, before, after: shown });
        this.#log(
          `augmentations: donated ${describeDonation(donated)}: its reputation ${Math.round(before).toLocaleString("en-US")} ` +
            `→ ${Math.round(shown).toLocaleString("en-US")}`,
        );
        continue;
      }
      donated.reads += 1;
      donated.shown = shown;
      if (donated.reads < NOT_QUEUED_AFTER_READS) {
        left.push(donated);
        continue;
      }
      const failed = {
        faction: donated.faction,
        amount: donated.amount,
        reputation: donated.reputation,
        donatedAtMs: donated.atMs,
      };
      this.#donationsFailed.push(failed);
      this.#emit({ type: AUGMENTATION_DONATION_FAILED_EVENT_KIND, atMs, ...failed, shown });
      this.#log(
        `augmentations: DONATION FAILED: ${describeDonation(donated)} reported done, and ${NOT_QUEUED_AFTER_READS} ` +
          `faction state reads since show ${shown === null ? "no such faction" : Math.round(shown).toLocaleString("en-US")}`,
      );
      if (readAugmentationCycle(this.#store) !== null) {
        this.#callOff(atMs, `the donation to ${donated.faction} didn't show in its reputation`);
      }
    }
    this.#donated = left;
  }

  /** The purchase asked for, reported done: an event, a log line, and waiting for the queue to show it. */
  #recordDone(doneIds: ReadonlySet<string>, fastGameTimeMs: number | null, atMs: number): void {
    const asked = this.#asked;
    if (asked === null || !doneIds.has(asked.intent.id) || this.#recorded.has(asked.intent.id)) return;
    this.#recorded.add(asked.intent.id);
    // A done comes in a fast snapshot, which has its time (the controller's null is for no fast snapshot, so no done).
    this.#spent.push({ gameTimeMs: fastGameTimeMs ?? 0, price: asked.price });
    if (asked.donation !== undefined) {
      const { reputation, before } = asked.donation;
      this.#donated.push({
        faction: asked.faction,
        amount: asked.price,
        reputation,
        before,
        atMs,
        reads: 0,
        shown: null,
      });
      this.#log(
        `augmentations: ${describeDonation({ faction: asked.faction, amount: asked.price, reputation })} reported ` +
          "done: the faction state should show the reputation",
      );
      return;
    }
    if (asked.augmentation === null) {
      this.#log(`augmentations: ${asked.intent.id} done, before the install (home's RAM stays)`);
      return;
    }
    this.#bought.push({ augmentation: asked.augmentation, level: asked.level, atMs, reads: 0 });
    const queueLength = this.#queue.length + 1;
    this.#emit({
      type: AUGMENTATION_BOUGHT_EVENT_KIND,
      atMs,
      augmentation: asked.augmentation,
      faction: asked.faction,
      level: asked.level,
      price: asked.price,
      queueLength,
    });
    this.#log(
      `augmentations: bought ${levelled(asked.augmentation, asked.level)} from ${asked.faction} for ` +
        `${formatMoney(asked.price)} (queue ${queueLength})`,
    );
  }

  /** The cycle called off: the note gone, and why, stored and logged. */
  #callOff(atMs: number, reason: string): void {
    writeAugmentationCycle(this.#store, null);
    this.#installing = false;
    this.#donationsSkipped.clear();
    this.#emit({ type: AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND, atMs, reason });
    this.#log(`augmentations: the install cycle is called off: ${reason}`);
  }

  #decide({
    state,
    resetInfo,
    player,
    slowData,
    mediumData,
    slowGameTimeMs,
    gameNowMs,
    atMs,
    homeRamEnabled,
    destroyWanted,
    countHeldBefore,
    holdWork,
    gangShop,
    gangUnread,
    levellingInstall,
    invitationHold,
    shareBonus,
    gangForming,
    gangInstall,
    netburners,
  }: {
    state: FactionState;
    resetInfo: NonNullable<ReturnType<typeof resetInfoOf>>;
    player: NonNullable<ReturnType<typeof playerOf>>;
    slowData: SlowSnapshotData;
    mediumData: MediumSnapshotData;
    slowGameTimeMs: number | null;
    gameNowMs: number;
    atMs: number;
    homeRamEnabled: boolean;
    destroyWanted: boolean;
    countHeldBefore: CountHoldView | null;
    holdWork: HoldWork;
    gangShop: JoinedFaction | null;
    gangUnread: boolean;
    levellingInstall: boolean;
    invitationHold: number;
    shareBonus: number;
    gangForming: { required: number; unread?: boolean } | null;
    gangInstall: GangInstallFigures | null;
    netburners: NetburnersRoute | null;
  }): AugmentationAsk {
    const { currentNode, ownedAugs, ownedSF } = resetInfo;
    // What an install would install: the faction state's queue, with each purchase reported done that it doesn't show
    // yet. The queue the purchases are planned on adds each never shown (`augmentationNotQueued`, alerted): asked for
    // again, its done is already recorded, and it would be asked forever. It's never counted as installed (#213
    // re-review): a cycle whose every purchase was a false done would install nothing.
    const withUnshown = (list: string[], { augmentation, level }: { augmentation: string; level: number }) => {
      const copies = list.filter((name) => name === augmentation).length;
      const shown =
        augmentation === NEUROFLUX_GOVERNOR ? (ownedAugs[NEUROFLUX_GOVERNOR] ?? 0) + copies >= level : copies > 0;
      if (!shown) list.push(augmentation);
    };
    const installable = [...state.queuedAugmentations];
    for (const bought of this.#bought) withUnshown(installable, bought);
    const queue = [...installable];
    for (const notQueued of this.#notQueued) withUnshown(queue, notQueued);
    this.#queue = installable;
    const purchaseState: AugmentationPurchaseState = {
      installed: ownedAugs,
      queued: queue,
      sourceFile11Level: ownedSF["11"] ?? 0,
      bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
    };
    const owned = (name: string) => Object.hasOwn(ownedAugs, name) || queue.includes(name);
    // The joined factions' shops and what's reached: core's (#260), the fast model's too; the gang's faction's (#334).
    const shopsView = augmentationShops(state.joined, currentNode, purchaseState, owned, gangShop);
    const { joined, shops, sold, reached, sellerOf, reputationOf } = shopsView;
    const multipliers = augmentationBitNodeMultipliers(currentNode, ownedSF);
    const money = player.money - this.#spent.reduce((sum, each) => sum + each.price, 0);
    const hackingLevel = player.person.skills.hacking;
    // The level's rise over the work (#401): τ by work along it (core's `countablesToCome`).
    const levelRise = this.#levelRise(mediumData, slowData, resetInfo.lastAugReset, currentNode, hackingLevel);
    // Short of Daedalus's count (#228): any augmentation counts.
    // With The Red Pill at the gang's faction (#334, BN2), Daedalus isn't needed: never short of its count.
    const count = daedalusCountOf({
      currentNode,
      ownedSF,
      installed: ownedAugs,
      joined: state.joined,
      invitations: state.invitations,
      redPillElsewhere: gangSellsRedPill(gangShop?.name ?? null, currentNode),
    });
    const short = count.short;
    const cycle = readAugmentationCycle(this.#store);
    // The destroy's hold (#355's review): The Red Pill installed and the destroy wanted, every install is for the
    // level, so the set is only what adds to levelling (core's `addsToLevelling`), NeuroFlux Governor's levels after
    // it. Any other would raise each later price 1.9 times (`AugmentationHelpers.ts:29-31`) for nothing. So (#380) for
    // those bought by a donation too: the set at any money is then (d)'s, which the commit at its M buys.
    // Not on the Black Ops' route (#398, core's `winRouteOf`): the hacking level isn't the destroy's there.
    const forLevelOnly =
      destroyWanted && Object.hasOwn(ownedAugs, THE_RED_PILL) && winRouteOf(currentNode) === "redPill";
    const toBuy = forLevelOnly ? reached.filter((name) => addsToLevelling([name])) : reached;
    // Donations (#225): planned only before the commit; committed, the note's go first, and the set is what's reached.
    const terms =
      cycle === null
        ? donationTermsOf(
            joined,
            shops,
            sold.filter(
              (name) => !owned(name) && sellerOf(name) === null && (!forLevelOnly || addsToLevelling([name])),
            ),
            player.person.mults.faction_rep,
            multipliers,
          )
        : undefined;
    let set = chooseAugmentationsToBuy(toBuy, purchaseState, money, hackingLevel, terms, short);
    let setView = set.purchases.map(({ name, money: price }) => ({ augmentation: name, price }));

    // A donation asked for, its reputation shown before its done is reported (#225 review): recorded now, as the next
    // ask replaces it and its done would never be.
    this.#recordDonationShown(reputationOf, slowGameTimeMs, atMs);

    // The cycle's last p known (#372's review): this reading's, else the store's for this cycle; written on a change.
    const storedRate = readGangRateKept(this.#store);
    let cycleRateKept = storedRate?.lastAugReset === resetInfo.lastAugReset ? storedRate.rateKept : null;
    const readRateKept = gangInstall?.rateKept ?? null;
    if (readRateKept !== null && readRateKept !== cycleRateKept) {
      this.#store.setSetting(
        AUGMENTATION_GANG_RATE_KEPT_SETTING,
        JSON.stringify({ lastAugReset: resetInfo.lastAugReset, rateKept: readRateKept }),
      );
    }
    if (readRateKept !== null) cycleRateKept = readRateKept;
    if (cycle === null) {
      const endgame0 = this.#endgame({
        resetInfo,
        player,
        purchaseState,
        installable,
        queue,
        shops: shopsView,
        destroyWanted,
        // The game's time since the last install (#334): the gang's faction's rate.
        sinceResetMs: slowGameTimeMs === null ? null : Math.max(0, slowGameTimeMs - resetInfo.lastAugReset),
        onlineMs: this.#onlineClock?.lastAugReset === resetInfo.lastAugReset ? this.#onlineClock.onlineMs : 0,
        // p never known this cycle with the gang earning none (#372's review: G3's grown gang training): the rules.
        gangEarning: gangInstall === null || cycleRateKept !== null,
      });
      // The Red Pill's donation first (#225 review): the counts are budgeted without its money.
      const redPillAmount = endgame0.kind === "redPill" ? (endgame0.donation?.amount ?? 0) : 0;
      const budget = money - redPillAmount;
      if (redPillAmount > 0) {
        set = chooseAugmentationsToBuy(toBuy, purchaseState, budget, hackingLevel, terms, short);
        setView = set.purchases.map(({ name, money: price }) => ({ augmentation: name, price }));
      }
      const notCommitted = { set: setView, setCost: set.money, committed: false, donations: [] as Donation[] };
      if (this.#installNotReset !== null) {
        this.#cancelCountdown("an install was reported done but the game didn't reset");
        return this.#ask(null, {
          waitingFor:
            "a reset: an install was reported done but the game didn't reset, so no other is chosen until one (or " +
            "the brain restarts)",
          ...notCommitted,
          progress: null,
          reserve: 0,
        });
      }
      if (slowGameTimeMs === null) {
        return this.#ask(null, {
          waitingFor: "the game's time in the Agent's slow snapshot",
          ...notCommitted,
          progress: null,
          reserve: 0,
        });
      }
      const onlineMs = this.#onlineClock?.lastAugReset === resetInfo.lastAugReset ? this.#onlineClock.onlineMs : 0;
      // The game's time since the last install counts the time the game was closed: only a quick install's limit.
      const sinceResetMs = Math.max(0, slowGameTimeMs - resetInfo.lastAugReset);
      /**
       * The counts and the rule with `spare` money and the set it covers (core's `installJudgement`, #260). `laterMs`
       * on, both clocks are that much later (the lookahead's: a quick install's 20 minutes may be over by then, #222
       * review).
       */
      const judge = (spare: number, covered: AugmentationSet, laterMs = 0) =>
        installJudgement({
          state: purchaseState,
          installable,
          set: covered,
          money: spare,
          shops: shopsView,
          owned,
          terms,
          short,
          onlineMs: onlineMs + laterMs,
          sinceResetMs: sinceResetMs + laterMs,
        });
      const { counts, rule } = judge(budget, set);
      const progress = (
        held: string | null,
        reason: InstallReason | null = rule.reason,
        countHold: CountHoldView | null = null,
        timing: InstallTimingView | null = null,
      ): AugmentationProgress => ({
        lastAugReset: resetInfo.lastAugReset,
        affordable: rule.affordable,
        affordableWithNeuroFlux: rule.affordableWithNeuroFlux,
        bar: rule.bar,
        barWithNeuroFlux: rule.barWithNeuroFlux,
        onlineMs,
        barFallsInMs: rule.barFallsAtMs === null ? null : rule.barFallsAtMs - onlineMs,
        barWithNeuroFluxFallsInMs:
          rule.barWithNeuroFluxFallsAtMs === null ? null : rule.barWithNeuroFluxFallsAtMs - onlineMs,
        reason,
        countdown:
          this.#countdown === null
            ? null
            : {
                endsAtGameMs: this.#countdown.endsAtGameMs,
                endsInMs: Math.max(0, this.#countdown.endsAtGameMs - gameNowMs),
                quick: this.#countdown.quick,
                extensions: this.#countdown.extensions,
              },
        held,
        byDonation: counts.byDonation,
        setCost: set.money + set.donationMoney,
        short: short ? { installed: count.installed, required: count.required } : null,
        countHold,
        ...(timing === null ? {} : { timing }),
      });
      const notCommittedDonations = { ...notCommitted, donations: counts.donations };
      let endgame = endgame0;
      // Daedalus's favour (#225): an install only with something to install (`installRule`'s guarantee), else held.
      const anything = installable.length + set.purchases.length + counts.neuroFluxLevels > 0;
      if (endgame.kind === "daedalusDonations" && !anything) {
        endgame = {
          kind: "hold",
          why: "daedalusDonations",
          reserve: 0,
          waitingFor:
            "something affordable to install: Daedalus's reputation this cycle unlocks its donations at the next " +
            "install, but nothing is queued or affordable",
        };
      }
      // The destroy's hold (#336): what the money buys of NeuroFlux Governor, and (#355) the set's augmentations that
      // add to levelling, are the planner's install candidate; that install, once the planner
      // chooses it, goes at once in the hold's place ("the hacking level"), if the money buys a level or such a set (an
      // install of nothing new to levelling would only lose the experience).
      const destroyHold = endgame.kind === "hold" && endgame.why === "destroy";
      if (destroyHold) {
        this.#neuroFluxOffer = counts.neuroFluxLevels;
        this.#installAugmentationsOffer = set.purchases
          .map((purchase) => purchase.name)
          .filter((name) => addsToLevelling([name]));
        // (d) (#380): the set at any money (the most finite, so a donation past what can be named is left out) and
        // each count of NeuroFlux Governor levels after it, priced as the commit buys them (core's `neuroFluxLadder`).
        const whole = chooseAugmentationsToBuy(toBuy, purchaseState, Number.MAX_VALUE, hackingLevel, terms, short);
        this.#batchOffer = {
          ladder: neuroFluxLadder({
            state: purchaseState,
            set: whole,
            neuroFluxReputation: shopsView.neuroFluxReputation,
            ...(terms === undefined ? {} : { donations: terms }),
          }),
          augmentations: whole.purchases.map((purchase) => purchase.name).filter((name) => addsToLevelling([name])),
        };
      }
      const forLevel =
        destroyHold && levellingInstall && (counts.neuroFluxLevels > 0 || this.#installAugmentationsOffer.length > 0);
      const holding = endgame.kind === "hold" && !forLevel ? endgame.why : null;
      if (holding !== null && holding !== this.#holding) {
        this.#log(`augmentations: no install, waiting for ${endgame.kind === "hold" ? endgame.waitingFor : ""}`);
      }
      this.#holding = holding;
      let reason: InstallReason;
      if (endgame.kind === "hold" && !forLevel) {
        // The Red Pill's way overrides the count rule (#215).
        this.#cancelCountdown(`held for ${endgame.waitingFor}`);
        if (endgame.why === "daedalus") this.#daedalusHold = endgame.reserve;
        if (endgame.why === "redPill") this.#redPillHold = endgame.reserve;
        const held = progress(endgame.waitingFor);
        this.#recordProgress(held, endgame.why, atMs);
        return this.#ask(null, {
          ...notCommittedDonations,
          progress: held,
          reserve: endgame.reserve,
          waitingFor: endgame.waitingFor,
        });
      }
      // Daedalus's favour (#225) installs through the normal countdown, whatever the count.
      const countdownReason: InstallReason | null =
        endgame.kind === "daedalusDonations" ? "Daedalus donations" : rule.install ? rule.reason : null;
      // Daedalus's count (#243): an install the count rule chose that would leave the count one short is held while the
      // last can be bought within the hold's window, the cycle's first hold's, kept in the store; only once this cycle
      // has reached Daedalus's hacking or combat requirement (#243 review), so the count is what's missing.
      const setNames = set.purchases.map((purchase) => purchase.name);
      const installing = [...installable, ...setNames, ...(counts.neuroFluxLevels > 0 ? [NEUROFLUX_GOVERNOR] : [])];
      // BN2 with the gang, The Red Pill short there (#357's (3)): its figures, the planner's candidates (core's endgame
      // `gang`) and every install's cost there, the rules' too. N The Red Pill's reputation, r and f the faction's, p
      // the gang rule's, s the `faction_rep` of what an install now would install, the rate the plan's respect's.
      const gangFaction = shopsView.gangFaction;
      const gangFavor = gangShop?.name === gangFaction ? (gangShop?.favor ?? 0) : 0;
      const gangTiming =
        gangFaction !== null &&
        gangSellsRedPill(gangFaction, currentNode) &&
        !Object.hasOwn(ownedAugs, THE_RED_PILL) &&
        !queue.includes(THE_RED_PILL)
          ? gangInstallTiming({
              needed: augmentationCost(THE_RED_PILL, purchaseState).reputation,
              reputation: reputationOf(gangFaction),
              favor: gangFavor,
              // The cycle's last p, only with the gang read (#372's re-review): unread, p unknown, no install.
              rateKept: gangInstall === null ? null : cycleRateKept,
              factionRepGain: factionRepInstallMultiplier(
                installable.filter((name) => name === NEUROFLUX_GOVERNOR).length + counts.neuroFluxLevels,
                [...installable, ...setNames].filter((name) => name !== NEUROFLUX_GOVERNOR),
              ),
              reputationPerSecond:
                gangInstall === null
                  ? null
                  : gangReputationPerSecond(gangInstall.respectPerCycle, player.person.mults.faction_rep, gangFavor),
              installable: anything,
              // The commit, and the slow snapshot's age: the reputation the gang earns meanwhile is converted too.
              aheadMs: GANG_ROUTE_COMMIT_MS + Math.max(0, gameNowMs - (slowGameTimeMs ?? gameNowMs)),
            })
          : null;
      const gangPlanned = endgame.kind === "gang" && gangTiming !== null;
      // Short of Daedalus's count, the planner times installs (#343): install now, or wait for the next k countables,
      // the least estimated time to the count chosen, decided again at every update. With the gang, (3) (#357).
      const planned = gangPlanned || (this.#timingPolicy === "planner" && short && endgame.kind === "none");
      let timing: InstallTimingView | null = null;
      if (!planned) {
        if (readInstallWait(this.#store) !== null) writeInstallWait(this.#store, null);
        this.#timingLogged = null;
        this.#incomeHeld = null;
      } else {
        const income = this.#income();
        // T (#388): the time online this cycle, the bars' clock, gaps over 3 minutes left out, as the run report's
        // cycles show it. For a cycle first seen past its start: the time online in its slow snapshots stored before
        // the clock began (`onlineBeforeMs`, T's alone); with none stored (a save first seen mid-cycle, an install made
        // while the brain was down), the game's time before, counted whole (`cycleUnseenMs`), leaning towards waiting,
        // and labelled.
        // A store from before #343 has no record for a cycle its clock has: its first slow snapshot of the cycle stored
        // is when the clock began. Never the clock's last time less its time online, which counts the gaps it left out
        // (#388: BN4.2's first cycle chose with T 543.9 min against 240.2 online, a 5 h gap); with none stored, the
        // game's time, labelled as mostly the clock's gaps (`fromClock`).
        let seen = readCycleSeen(this.#store);
        const clock = this.#onlineClock;
        if (seen?.lastAugReset !== resetInfo.lastAugReset && clock?.lastAugReset === resetInfo.lastAugReset) {
          const first = this.#cycleLooks?.(clock.lastAugReset).find((look) => look <= clock.lastGameTimeMs);
          seen =
            first === undefined
              ? { lastAugReset: clock.lastAugReset, gameTimeMs: clock.lastGameTimeMs - clock.onlineMs, fromClock: true }
              : { lastAugReset: clock.lastAugReset, gameTimeMs: first };
          this.#store.setSetting(AUGMENTATION_CYCLE_SEEN_SETTING, JSON.stringify(seen));
        }
        const cycleSeen = seen?.lastAugReset === resetInfo.lastAugReset ? seen : null;
        const unseenMs = cycleSeen === null ? 0 : cycleUnseenMs(cycleSeen);
        const onlineBeforeMs = cycleSeen?.onlineBeforeMs ?? 0;
        const cycleMs = onlineBeforeMs + onlineMs + unseenMs;
        const unseen = {
          ...(onlineBeforeMs > 0 ? { onlineBeforeMs } : {}),
          ...(unseenMs > 0
            ? { unseenMs, ...(cycleSeen?.fromClock === true ? { unseenGaps: true as const } : {}) }
            : {}),
        };
        const needed = count.required - count.installed;
        // New to the count: NeuroFlux Governor's levels only while none is installed (one entry).
        const adding = countAfterInstall(ownedAugs, installing) - count.installed;
        const stored = readInstallWait(this.#store);
        // BN2 before the gang (#357's (1)): wait for the gang or install now, in place of #343's candidates.
        const gangRoute = this.#bn2Route === "planner" && gangForming !== null ? gangForming : null;
        let next: NextCountable[] = [];
        if (gangPlanned && gangTiming !== null && gangFaction !== null) {
          // With the gang (#357's (3)): keep, install now, or bank R*, decided again at every update from the
          // reputation, so no wait is kept (a stalled reputation is the World Daemon's stall to raise).
          if (stored !== null) writeInstallWait(this.#store, null);
          const candidate = (k: number, tauMs: number | null, estimateMs: number | null) =>
            estimateMs === null ? [] : [{ k, tauMs: tauMs ?? 0, estimateMs }];
          const figures: Omit<InstallTimingView, "words"> = {
            needed,
            adding,
            onlineMs: cycleMs,
            candidates: [
              ...candidate(0, 0, gangTiming.installNowMs),
              ...candidate(1, gangTiming.toBankMs, gangTiming.bankMs),
              ...candidate(2, gangTiming.keepMs, gangTiming.keepMs),
            ],
            choice: gangTiming.choice === "install" ? 0 : gangTiming.choice === "bank" ? 1 : 2,
            heldForIncome: false,
            heldForInvitation: false,
            tauScale: 1,
            next: [],
            timeOnlineMs: onlineMs,
            ...unseen,
            route: GANG_FORMED_ROUTE,
            gangInstall: gangTiming,
          };
          timing = { ...figures, words: withTParts(describeGangInstallTiming(gangTiming, gangFaction), figures) };
          this.#incomeHeld = null;
        } else if (gangRoute !== null) {
          // Its wait under way (the store's, a restart keeps it), and once overdue its measured error on τ_g.
          const wait =
            stored?.lastAugReset === resetInfo.lastAugReset && stored.route === GANG_FORMING_ROUTE ? stored : null;
          const tauScale = wait?.overdue === true ? Math.max(1, (onlineMs - wait.sinceOnlineMs) / wait.firstTauMs) : 1;
          // What the install would install: the queue, the set and NeuroFlux Governor's levels, each's multipliers.
          const neuroFluxLevels =
            installable.filter((name) => name === NEUROFLUX_GOVERNOR).length + counts.neuroFluxLevels;
          const others = [...installable, ...setNames].filter((name) => name !== NEUROFLUX_GOVERNOR);
          const gang = gangFormingTiming({
            ...hackingFiguresOf(mediumData, currentNode),
            required: gangRoute.required,
            // Measured only over the rate's whole window (#378's review): its first minutes, the hack loop starting
            // after the reset, overstate τ_g (gang-start's seed 5: 258 h against 26 min), and the overdue bound with it.
            expPerSecond: this.#expRate.windowFull() ? this.#expRate.perSecond() : null,
            gain: levellingInstallMultipliers(neuroFluxLevels, others),
            installable: adding > 0,
            tauScale,
            invitationHeld: invitationHold > 0,
            // The gang's reading unread, no gang known (#368's review): whether there's one isn't known yet.
            gangUnread: gangRoute.unread === true,
          });
          const figures: Omit<InstallTimingView, "words"> = {
            needed,
            adding,
            onlineMs: cycleMs,
            candidates: [
              ...(gang.installNowMs === null ? [] : [{ k: 0, tauMs: 0, estimateMs: gang.installNowMs }]),
              ...(gang.waitMs === null ? [] : [{ k: 1, tauMs: gang.waitMs, estimateMs: gang.waitMs }]),
            ],
            choice: gang.choice === "install" ? 0 : 1,
            heldForIncome: false,
            heldForInvitation: gang.heldForInvitation,
            tauScale,
            next: [],
            timeOnlineMs: onlineMs,
            ...unseen,
            route: GANG_FORMING_ROUTE,
            gang,
          };
          timing = { ...figures, words: withTParts(describeGangFormingTiming(gang), figures) };
          this.#incomeHeld = null;
          this.#watchWait(timing, wait, stored, resetInfo.lastAugReset, onlineMs, atMs);
        } else {
          const toCome = countablesToCome({
            sold,
            state: purchaseState,
            set,
            joined,
            shops,
            terms,
            person: player.person,
            conditions: workConditionsOf(resetInfo, slowData, shareBonus),
            work: holdWork,
            rise: levelRise.rise,
            money: budget,
            income,
            // Netburners' five before it's joined (#387): the Hacknet rule buys its setup once one is waited for.
            netburners,
          });
          next = nextCountables({
            toCome,
            set,
            state: purchaseState,
            money: budget,
            income,
            upTo: Math.max(0, needed - adding),
          });
          // The wait under way (kept in the store, a restart keeps it): once overdue, each fresh τ scaled by its
          // measured error, the wait so far over its first τ (decision 67's rates fitted online), so a stalled wait
          // gives way, except at the last countable, where the scaled wait never exceeds T; the overdue failure reports
          // it.
          const wait =
            stored?.lastAugReset === resetInfo.lastAugReset && stored.route === undefined && adding < stored.untilAdding
              ? stored
              : null;
          const tauScale = wait?.overdue === true ? Math.max(1, (onlineMs - wait.sinceOnlineMs) / wait.firstTauMs) : 1;
          const figures = {
            ...installTiming({
              needed,
              adding,
              onlineMs: cycleMs,
              next,
              incomeMeasured: income !== null,
              invitationHeld: invitationHold > 0,
              tauScale,
            }),
            next: next.map(({ augmentation, faction, way, tauMs }) => ({ augmentation, faction, way, tauMs })),
            timeOnlineMs: onlineMs,
            ...unseen,
            ...(levelRise.from === null
              ? {}
              : {
                  levelRise: {
                    expPerSecond: levelRise.rise.kappa * (hackingLevel + LEVEL_RISE_TERM),
                    from: levelRise.from,
                    ...levelRise.dead,
                  },
                }),
          };
          timing = { ...figures, words: describeInstallTiming(figures, count) };
          this.#watchIncomeHold(timing, resetInfo.lastAugReset, onlineMs, atMs);
          this.#watchWait(timing, wait, stored, resetInfo.lastAugReset, onlineMs, atMs);
        }
        // A wait (or nothing) logged as the choice or n changes; an install, in its own line.
        const logged = `${timing.route ?? "count"} ${timing.choice} ${timing.adding}`;
        if (logged !== this.#timingLogged && timing.choice !== 0) {
          this.#log(`augmentations: the planner's install timing: ${timing.words}`);
        }
        this.#timingLogged = logged;
        if (timing.choice !== 0) {
          // Waiting (or nothing to install or wait for): the set's and the waited-for's money held back only for a wait
          // within the lookahead's 15 minutes (A2's payback limit, as before the countdown, #213 review). The wait for
          // the gang (#357) holds none: no money is needed for it.
          this.#cancelCountdown(
            timing.route === GANG_FORMING_ROUTE
              ? "the planner waits for the gang"
              : timing.route === GANG_FORMED_ROUTE
                ? "the planner times installs with the gang"
                : "the planner times installs short of Daedalus's count",
          );
          // Keeping or banking with the gang (#357's (3)): installs held for The Red Pill there, the World Daemon's
          // stall to watch (its reputation not rising), a pause to train included (#372's re-review): while the plan
          // earns no respect, past twice the gang rule's estimate of the time until it does and 10 minutes (#374).
          if (timing.route === GANG_FORMED_ROUTE) this.#redPillHeldAtGang = true;
          const waitedFor = timing.choice === null ? [] : next.slice(0, timing.choice);
          this.#waitedFor = waitedFor;
          this.#setMoneyBeforeNetburners = set.money + set.donationMoney;
          const last = waitedFor.at(-1);
          const reserve =
            last !== undefined && last.tauMs <= AUGMENTATION_RESERVE_LOOKAHEAD_MS
              ? set.money + set.donationMoney + last.addedMoney
              : 0;
          const waiting = progress(null, null, null, timing);
          this.#recordProgress(waiting, `timing: ${timing.route ?? "count"} ${timing.choice}`, atMs);
          return this.#ask(null, {
            ...notCommittedDonations,
            progress: waiting,
            reserve,
            waitingFor:
              timing.route === GANG_FORMING_ROUTE
                ? `the planner's time to the gang formed: ${timing.words}`
                : timing.route === GANG_FORMED_ROUTE
                  ? `the planner's time to ${THE_RED_PILL}'s reputation: ${timing.words}`
                  : `the planner's time to Daedalus's count: ${timing.words}`,
          });
        }
        // Installing now: the progress it's chosen on, for the run report (the counts and donations, as a countdown's).
        this.#recordProgress(
          progress(null, timing.route === GANG_FORMED_ROUTE ? "the gang's favour" : "Daedalus's count", null, timing),
          `timing: ${timing.route ?? "count"} ${timing.choice}`,
          atMs,
        );
      }
      const stored = readCountHold(this.#store);
      const heldSinceOnlineMs = stored?.lastAugReset === resetInfo.lastAugReset ? stored.sinceOnlineMs : null;
      const windowOpen = heldSinceOnlineMs !== null && onlineMs < heldSinceOnlineMs + DAEDALUS_COUNT_HOLD_MS;
      const firstDecision = !this.#decidedOnce;
      this.#decidedOnce = true;
      const countHold =
        !planned && short && countdownReason !== null && endgame.kind !== "redPill" && !forLevel
          ? daedalusCountHold({
              installed: ownedAugs,
              installing,
              required: count.required,
              skillsReached: daedalusSkillsReached(player.person.skills, daedalusRequirements(currentNode, ownedSF)),
              toCome: countablesToCome({
                sold,
                state: purchaseState,
                set,
                joined,
                shops,
                terms,
                person: player.person,
                conditions: workConditionsOf(resetInfo, slowData, shareBonus),
                work: holdWork,
                rise: levelRise.rise,
                money: budget,
                income: this.#income(),
                // A restart or a gap loses the income for 10 minutes: the window open, its money taken as coming.
                assumeMoney: windowOpen,
              }),
              onlineMs,
              heldSinceOnlineMs,
            })
          : null;
      if (countHold !== null) {
        if (heldSinceOnlineMs === null || stored?.ended === true) {
          this.#store.setSetting(
            AUGMENTATION_COUNT_HOLD_SETTING,
            JSON.stringify({ lastAugReset: resetInfo.lastAugReset, sinceOnlineMs: countHold.sinceOnlineMs }),
          );
        }
        const view: CountHoldView = { ...countHold.next, leftMs: countHold.untilOnlineMs - onlineMs };
        const words = describeCountHold(view, count);
        if (countHeldBefore === null) this.#log(`augmentations: install held for Daedalus's count: ${words}`);
        this.#countHeld = view;
        this.#cancelCountdown(`held for Daedalus's count, ${view.augmentation} in ~${formatEta(view.etaMs)}`);
        const held = progress(words, countdownReason, view);
        this.#recordProgress(held, `daedalusCount: ${view.augmentation}`, atMs);
        return this.#ask(null, {
          ...notCommittedDonations,
          progress: held,
          // As the countdown holds (the counted purchases' money, so the rule goes on saying install), or the set's and
          // the last's if more: from cloud servers and home RAM alike (`countdownReserve`).
          reserve: Math.max(counts.money, set.money + set.donationMoney + view.money),
          waitingFor: `the install held for Daedalus's count: ${words}`,
        });
      }
      // Its end, logged: held at the last update, or (a restarted brain's first decision) its window open and its end
      // not logged before the restart (the store says).
      if (countHeldBefore !== null || (!planned && firstDecision && windowOpen && stored?.ended !== true)) {
        const countAfter = countAfterInstall(ownedAugs, installing);
        const holdLength = formatEta(DAEDALUS_COUNT_HOLD_MS);
        const endReason = !short
          ? "Daedalus's count met"
          : countdownReason === null
            ? "the rule no longer says install"
            : countAfter >= count.required
              ? "the count reached at this install"
              : count.required - countAfter > 1
                ? `this install would now leave it ${count.required - countAfter} short`
                : countHeldBefore?.way === "work" && !worksFor(holdWork, countHeldBefore.faction)
                  ? `nobody works for ${countHeldBefore.faction}`
                  : !windowOpen
                    ? `its ${holdLength} are up`
                    : `${countHeldBefore?.augmentation ?? "the last"} isn't within what's left of its ${holdLength}`;
        this.#log(`augmentations: the hold for Daedalus's count is over: ${endReason}`);
        this.#countHoldEndLogged = true;
        if (heldSinceOnlineMs !== null && stored !== null) {
          this.#store.setSetting(AUGMENTATION_COUNT_HOLD_SETTING, JSON.stringify({ ...stored, ended: true }));
        }
      }
      let redPillDonation: Donation | null = null;
      if (endgame.kind === "redPill") {
        // No countdown for The Red Pill: #215's install, at once (the legacy scripts start one, never extended, `:963-968`).
        this.#cancelCountdown("The Red Pill reached, installed at once");
        reason = "The Red Pill";
        redPillDonation = endgame.donation;
      } else if (forLevel) {
        // The planner's levelling install (#336): at once, as The Red Pill's; A6 buys the levels, then installs.
        this.#cancelCountdown("the planner's levelling install, at once");
        reason = "the hacking level";
      } else if (planned) {
        // The planner's install for Daedalus's count (#343): at once, as levelling's; never with nothing new to it. With
        // the gang (#357's (3)), for its favour, at once too.
        const forFavour = timing?.route === GANG_FORMED_ROUTE;
        this.#cancelCountdown(
          `the planner's install for ${forFavour ? "the gang's favour" : "Daedalus's count"}, at once`,
        );
        reason = forFavour ? "the gang's favour" : "Daedalus's count";
      } else if (countdownReason === null) {
        this.#cancelCountdown(`the rule no longer says install: ${describeCounts(rule)}`);
        // Held back from cloud servers only for an install the rule would choose with A2's payback limit's more income:
        // the counted purchases' money then (#213 review, #222).
        const income = this.#income();
        let reserve = 0;
        if (income !== null && income > 0) {
          const spare = money + (income * AUGMENTATION_RESERVE_LOOKAHEAD_MS) / 1000;
          const ahead = judge(
            spare,
            chooseAugmentationsToBuy(reached, purchaseState, spare, hackingLevel, terms, short),
            AUGMENTATION_RESERVE_LOOKAHEAD_MS,
          );
          if (ahead.rule.install) reserve = ahead.counts.money;
        }
        const waiting = progress(null);
        this.#recordProgress(waiting, null, atMs);
        return this.#ask(null, {
          ...notCommittedDonations,
          progress: waiting,
          reserve,
          waitingFor: `the count to reach a bar: ${describeProgress(waiting)}`,
        });
      } else {
        const ruleReason = countdownReason;
        // The game's clock set back (a save loaded, say): its end is no longer the countdown's; one starts afresh.
        if (this.#countdown !== null && gameNowMs < this.#countdown.seenAtGameMs) {
          this.#cancelCountdown("the game's clock set back");
        }
        let countdown = this.#countdown;
        if (countdown === null) {
          const quick = ruleReason === "quick install";
          const lengthMs = quick ? QUICK_INSTALL_COUNTDOWN_MS : INSTALL_COUNTDOWN_MS;
          countdown = {
            lastAugReset: resetInfo.lastAugReset,
            endsAtGameMs: gameNowMs + lengthMs,
            lengthMs,
            quick,
            extensions: 0,
            count: rule.affordableWithNeuroFlux,
            seenAtGameMs: gameNowMs,
          };
          this.#countdown = countdown;
          this.#log(
            `augmentations: install countdown started, ${countdownSeconds(lengthMs)}, ${describeReason(ruleReason, rule)}; ` +
              `${formatMoney(counts.money)} held back from cloud servers and home RAM`,
          );
        } else if (rule.affordableWithNeuroFlux > countdown.count) {
          // The count rose: the countdown runs on, a little less each time, never shortened (`autopilot.js:972-976`).
          countdown.extensions += 1;
          const endsAtGameMs =
            gameNowMs + countdownExtensionMs(countdown.lengthMs, countdown.extensions, rule.barWithNeuroFlux);
          if (endsAtGameMs > countdown.endsAtGameMs) {
            countdown.endsAtGameMs = endsAtGameMs;
            this.#log(
              `augmentations: install countdown extended, ${countdownSeconds(endsAtGameMs - gameNowMs)} from now ` +
                `(extension ${countdown.extensions}): ${describeCounts(rule)}`,
            );
          }
        }
        countdown.count = rule.affordableWithNeuroFlux;
        countdown.seenAtGameMs = gameNowMs;
        if (gameNowMs < countdown.endsAtGameMs) {
          const waiting = progress(null, ruleReason);
          this.#recordProgress(waiting, null, atMs);
          return this.#ask(null, {
            ...notCommittedDonations,
            progress: waiting,
            reserve: counts.money,
            waitingFor:
              `the install countdown: ${countdownSeconds(countdown.endsAtGameMs - gameNowMs)} left, ` +
              describeReason(ruleReason, rule),
          });
        }
        this.#countdown = null;
        this.#log(
          `augmentations: install countdown ended (${countdown.extensions} extension` +
            `${countdown.extensions === 1 ? "" : "s"})`,
        );
        reason = ruleReason;
      }
      const donations = withDonation(counts.donations, redPillDonation);
      // Its cost with the gang (#357's (3)), the rules' too; none for The Red Pill's own install, the route's end.
      const gangCost =
        gangTiming === null || gangFaction === null || reason === "The Red Pill"
          ? null
          : gangInstallCostOf(gangTiming, gangFaction);
      // Short (#238): what counts within reach beyond the set, whatever `isWorthInstalling` says, and the money left
      // after the set and its donations (#238 review: not the levels', which stop short of the next one).
      const countFacts: CountFacts | undefined = short
        ? {
            moneyAfterSet: budget - set.money - set.donationMoney,
            within: countablesWithinReach({
              reached: reached.map((augmentation) => ({ augmentation, faction: sellerOf(augmentation) as string })),
              state: { ...purchaseState, queued: [...queue, ...set.purchases.map((purchase) => purchase.name)] },
              donations: terms,
            }),
          }
        : undefined;
      writeAugmentationCycle(this.#store, {
        lastAugReset: resetInfo.lastAugReset,
        installing: false,
        neuroFluxTarget: installable.filter((name) => name === NEUROFLUX_GOVERNOR).length + counts.neuroFluxLevels,
        donations,
        reason,
        ...(redPillDonation === null ? {} : { redPill: redPillDonation.faction }),
        ...(countFacts === undefined ? {} : { countFacts }),
      });
      this.#installing = false;
      this.#progress = null;
      this.#donationsSkipped.clear();
      this.#emit({
        type: AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
        atMs,
        set: setView,
        cost: set.money,
        queued: [...installable],
        onlineMs,
        affordable: rule.affordable,
        affordableWithNeuroFlux: rule.affordableWithNeuroFlux,
        bar: rule.bar,
        barWithNeuroFlux: rule.barWithNeuroFlux,
        reason,
        donations,
        ...(short ? { short: { installed: count.installed, required: count.required } } : {}),
        ...(timing === null ? {} : { timing }),
        ...(gangCost === null ? {} : { gangCost }),
      });
      this.#log(
        `augmentations: install chosen, ${formatEta(onlineMs)} online this cycle: buying ` +
          `${setView.map((each) => each.augmentation).join(", ") || "nothing more"} (${formatMoney(set.money)}), ` +
          (donations.length === 0 ? "" : `donating ${donations.map(describeDonation).join(", ")} first, `) +
          (timing?.route === GANG_FORMING_ROUTE
            ? "BN2 before the gang: installing now is the planner's shortest time to the gang formed (#357)"
            : describeReason(reason, rule)) +
          (timing === null ? "" : `; ${timing.words}`) +
          (gangCost === null ? "" : `; its cost: ${describeGangInstallCost(gangCost)}`),
      );
    }

    // Committed: the donations (#225), the set, home's RAM, NeuroFlux Governor, then the install (already asked for, a
    // restarted brain's note says: nothing more is bought).
    if (cycle?.installing === true) this.#installing = true;
    const note = readAugmentationCycle(this.#store);
    const committedView = {
      set: setView,
      setCost: set.money,
      progress: null,
      donations: note?.donations ?? [],
      reserve: Number.POSITIVE_INFINITY,
      committed: true,
    };
    if (!this.#installing) {
      // The donations first (#225), one faction at a time, each shown by the faction state before anything is bought:
      // the set is what's reached once they are, in buy order.
      if (this.#donated.length > 0) {
        return this.#ask(null, {
          ...committedView,
          waitingFor: `the faction state to show ${this.#donated.map((each) => `${each.faction}'s`).join(", ")} reputation after the donation`,
        });
      }
      // A donation asked for and not yet reported done (#227 re-review): its money may be spent already, the medium
      // snapshot showing it before the fast one reports the done and the slow one the reputation. Asked again, and
      // nothing else judged, until its done or its reputation shows (`#recordDonationShown`); one that never goes
      // through is the Agent's `intentStuck`.
      const inFlight = this.#asked;
      if (
        inFlight?.donation !== undefined &&
        !this.#recorded.has(inFlight.intent.id) &&
        (note?.donations ?? []).some((each) => each.faction === inFlight.faction)
      ) {
        const { reputation } = inFlight.donation;
        return this.#ask(inFlight, {
          ...committedView,
          asking: `donating ${describeDonation({ faction: inFlight.faction, amount: inFlight.price, reputation })}`,
        });
      }
      // The Red Pill's donation is never passed over (#225 review): the money for it gone, the cycle is called off, and
      // `#endgame` holds the next for the money.
      const redPillDonation = note?.donations?.find((each) => each.faction === note.redPill);
      const redPillAmount =
        redPillDonation === undefined ? 0 : this.#donationNow(redPillDonation, reputationOf, player, multipliers);
      if (redPillDonation !== undefined && redPillAmount > money) {
        this.#callOff(
          atMs,
          `the money for ${THE_RED_PILL}'s donation is gone: ${describeDonation({ ...redPillDonation, amount: redPillAmount })}` +
            `, ${formatMoney(money)} now`,
        );
        return this.#ask(null, { committed: false, reserve: 0, waitingFor: null });
      }
      const donation = this.#nextDonation(note?.donations ?? [], reputationOf, player, money, multipliers);
      if (donation !== null) {
        return this.#ask(donation, {
          ...committedView,
          asking: `donating ${describeDonation({ faction: donation.faction, amount: donation.price, reputation: donation.donation?.reputation ?? 0 })}`,
        });
      }
      const [first] = set.purchases;
      if (first !== undefined) {
        const faction = sellerOf(first.name) as string;
        return this.#ask(
          {
            intent: purchaseIntent(faction, first.name, 1),
            augmentation: first.name,
            faction,
            level: 1,
            price: first.money,
          },
          { ...committedView, asking: `buying ${first.name} from ${faction} for ${formatMoney(first.money)}` },
        );
      }
      // Home's RAM (#219's order) only with the money above the NeuroFlux Governor levels counted at the choice and not
      // bought yet (#222 review): an install counted on them installs them.
      const neuroFluxLeft = Math.max(
        0,
        (readAugmentationCycle(this.#store)?.neuroFluxTarget ?? 0) -
          installable.filter((name) => name === NEUROFLUX_GOVERNOR).length,
      );
      const neuroFluxHeld =
        neuroFluxLeft === 0
          ? 0
          : purchaseSequenceCost(Array<string>(neuroFluxLeft).fill(NEUROFLUX_GOVERNOR), purchaseState).money;
      // The donations (#225) went first, each shown before this, or were passed over: home's RAM never spends their
      // money.
      const homeRam = homeRamEnabled ? chooseHomeRamUpgrade(mediumData, slowData) : null;
      if (homeRam?.next && money - (homeRam.price ?? 0) >= neuroFluxHeld) {
        const args = { fromRam: homeRam.next.fromRam, vendor: homeRam.next.vendor };
        return this.#ask(
          {
            intent: { id: intentId("upgradeHomeRam", args), action: "upgradeHomeRam", args },
            augmentation: null,
            faction: homeRam.next.vendor,
            level: 0,
            price: homeRam.price ?? 0,
          },
          { ...committedView, asking: `home RAM to ${homeRam.next.fromRam * 2} GB before the install (it stays)` },
        );
      }
      const neuroFlux = this.#neuroFlux(purchaseState, shops, reputationOf, money);
      if (neuroFlux !== null) {
        return this.#ask(neuroFlux, {
          ...committedView,
          asking:
            `buying ${NEUROFLUX_GOVERNOR} level ${neuroFlux.level} from ${neuroFlux.faction} for ` +
            formatMoney(neuroFlux.price),
        });
      }
      // The Red Pill reached at a joined seller (#215): last, as every purchase makes the next dearer and it costs $0.
      const redPillSeller = owned(THE_RED_PILL) ? null : sellerOf(THE_RED_PILL);
      if (redPillSeller !== null) {
        return this.#ask(
          {
            intent: purchaseIntent(redPillSeller, THE_RED_PILL, 1),
            augmentation: THE_RED_PILL,
            faction: redPillSeller,
            level: 1,
            price: augmentationCost(THE_RED_PILL, purchaseState).money,
          },
          { ...committedView, asking: `buying ${THE_RED_PILL} from ${redPillSeller}` },
        );
      }
      const unconfirmed = this.#bought.map((bought) => bought.augmentation);
      if (unconfirmed.length > 0) {
        return this.#ask(null, {
          ...committedView,
          waitingFor: `the faction state to show ${unconfirmed.join(", ")} queued, before the install`,
        });
      }
      // Daedalus's path chosen (a joined seller of The Red Pill, not installed): never an install without it (#215
      // review). Reported bought and never queued (`augmentationNotQueued`, alerted), the cycle is called off, and
      // `#endgame` holds the next; not bought yet (its reputation fell short), it waits. But for "Daedalus donations"
      // (#225 review): that install is for Daedalus's favour, without The Red Pill. The gang's faction (#334) holds
      // only The Red Pill's own install: `#endgame` lets an ordinary one go once the window's passed, and the gang stays.
      // Committed for The Red Pill with the gang unread (#335's review: a brain restarted in BN2): its seller unknown
      // until the gang's reading, so neither an install without it nor a call-off; it waits.
      if (
        note?.reason === "The Red Pill" &&
        gangUnread &&
        !Object.hasOwn(ownedAugs, THE_RED_PILL) &&
        !installable.includes(THE_RED_PILL)
      ) {
        return this.#ask(null, {
          ...committedView,
          waitingFor: `the gang's first reading, for ${THE_RED_PILL}'s seller, before the install`,
        });
      }
      const redPillSold = [...shops].some(
        ([faction, shop]) =>
          shop.includes(THE_RED_PILL) && (faction !== shopsView.gangFaction || note?.reason === "The Red Pill"),
      );
      const forFavour = note?.reason === "Daedalus donations";
      if (redPillSold && !forFavour && !Object.hasOwn(ownedAugs, THE_RED_PILL) && !installable.includes(THE_RED_PILL)) {
        if (queue.includes(THE_RED_PILL)) {
          this.#callOff(atMs, `${THE_RED_PILL} reported bought but never queued: no install without it`);
          return this.#ask(null, { committed: false, reserve: 0, waitingFor: null });
        }
        // Committed for it, and no seller's reputation reaches it now (#334): a stale reading's, say, as forming a gang
        // resets its faction's to 0 (`PlayerObjectGangMethods.ts:67`). Called off, so `#endgame` judges afresh, never
        // waiting on a purchase that can't come.
        if (note?.reason === "The Red Pill" && redPillSeller === null) {
          this.#callOff(atMs, `${THE_RED_PILL}'s reputation short at every seller now: no install without it`);
          return this.#ask(null, { committed: false, reserve: 0, waitingFor: null });
        }
        return this.#ask(null, {
          ...committedView,
          waitingFor: `${THE_RED_PILL} bought and shown queued, before the install`,
        });
      }
    }
    // Never an install of nothing (#213 re-review): the game would report it done, with no reset. Checked on a
    // restarted brain's way too, its install already asked for.
    if (installable.length === 0) {
      this.#callOff(atMs, "nothing queued to install (the faction state's queue is empty)");
      return this.#ask(null, { committed: false, reserve: 0, waitingFor: null });
    }
    if (!this.#installing) {
      this.#installing = true;
      this.#carryLevelRise(installable, hackingLevel, resetInfo.lastAugReset, slowData);
      writeAugmentationCycle(this.#store, {
        ...readAugmentationCycle(this.#store),
        lastAugReset: cycle?.lastAugReset ?? resetInfo.lastAugReset,
        installing: true,
      });
      this.#log(`augmentations: installing ${installable.length} queued (the gate, then a save backup first)`);
    }
    this.#asked = null;
    this.#view = {
      ...this.#view,
      ...committedView,
      asking: `installing ${installable.length} queued`,
      waitingFor: null,
      waiting: false,
    };
    return { intent: null, install: true, committed: true };
  }

  /**
   * The level's path from now (#401, core's level-rise.ts) for τ by work: the experience and the level now, and κ the
   * larger of the experience rate measured now (over `HackingExpRate`'s whole window, as #378's review has the gang's
   * τ_g: its first minutes after an install measure the hack loop's start) and the one carried over the last install
   * in the BitNode (`AUGMENTATION_LEVEL_RISE_SETTING`): the window early in a cycle is the hack loop's ramp (the Red
   * Pill holds' starts, 15 to 800 times under their rates), the carried one the RAM the last cycle ended on, under the
   * RAM bought since. The carried one rises only after its dead time (#405's review: the restart's ramp and the cloud
   * servers the install deleted), less the time online this cycle so far: the cycle before's ramp measured, else the
   * fallback (`LEVEL_RAMP_FALLBACK_MS`). Neither: flat, the level now, as before #401. Measures this cycle's ramp too:
   * the time online when the rate (from its first minute) first reaches the carried κ per level + 50, stored once.
   */
  #levelRise(
    mediumData: MediumSnapshotData,
    slowData: SlowSnapshotData,
    lastAugReset: number,
    currentNode: number,
    level: number,
  ): {
    rise: LevelRise;
    from: NonNullable<InstallTimingView["levelRise"]>["from"] | null;
    dead: { deadMs: number; deadMeasured: boolean } | Record<string, never>;
  } {
    const { exp, levelMult } = hackingFiguresOf(mediumData, currentNode);
    const measured = levelRiseOf({
      exp,
      level,
      levelMult,
      expPerSecond: this.#expRate.windowFull() ? this.#expRate.perSecond() : null,
    });
    const lastNodeReset = (slowData.resetInfo as { lastNodeReset?: unknown } | undefined)?.lastNodeReset;
    const stored = readCarriedLevelRise(this.#store);
    const carried =
      stored !== null && stored.lastNodeReset === lastNodeReset && stored.lastAugReset < lastAugReset ? stored : null;
    const sinceInstallMs = this.#onlineClock?.lastAugReset === lastAugReset ? this.#onlineClock.onlineMs : 0;
    if (carried !== null && readLevelRamp(this.#store)?.lastAugReset !== lastAugReset) {
      const perSecond = this.#expRate.perSecond();
      if (perSecond !== null && perSecond / (level + LEVEL_RISE_TERM) >= carried.kappa) {
        this.#store.setSetting(
          AUGMENTATION_LEVEL_RAMP_SETTING,
          JSON.stringify({ lastAugReset, rampMs: sinceInstallMs }),
        );
      }
    }
    if (carried !== null && carried.kappa > measured.kappa) {
      const deadMs = carried.deadMs ?? LEVEL_RAMP_FALLBACK_MS;
      return {
        rise: { ...measured, kappa: carried.kappa, delaySeconds: Math.max(0, deadMs - sinceInstallMs) / 1000 },
        from: "the last cycle's",
        dead: { deadMs, deadMeasured: carried.deadMs !== null },
      };
    }
    return { rise: measured, from: measured.kappa > 0 ? "measured now" : null, dead: {} };
  }

  /**
   * Carries the level's rise over the install asked for (#401, `AUGMENTATION_LEVEL_RISE_SETTING`): the experience rate
   * measured now over its whole window, per (level + 50), times the install's `hacking_exp` and `hacking_speed` (core's
   * `levellingInstallMultipliers` of `installing`, NeuroFlux Governor's levels each an entry). None measured, or the
   * BitNode's start unread, or an augmentation core doesn't know (logged): the one stored is kept (an earlier cycle's,
   * on less RAM: cautious for waiting).
   */
  #carryLevelRise(installing: readonly string[], level: number, lastAugReset: number, slowData: SlowSnapshotData) {
    const perSecond = this.#expRate.windowFull() ? this.#expRate.perSecond() : null;
    const lastNodeReset = (slowData.resetInfo as { lastNodeReset?: unknown } | undefined)?.lastNodeReset;
    if (perSecond === null || !(perSecond > 0) || !isFiniteNumber(lastNodeReset)) return;
    let gain: ReturnType<typeof levellingInstallMultipliers>;
    try {
      gain = levellingInstallMultipliers(
        installing.filter((name) => name === NEUROFLUX_GOVERNOR).length,
        installing.filter((name) => name !== NEUROFLUX_GOVERNOR),
      );
    } catch (error) {
      // An augmentation core doesn't know: the install goes on, the rise not carried (the last one stored kept).
      this.#log(`augmentations: the level's rise not carried over the install (${(error as Error).message})`);
      return;
    }
    const kappa = (perSecond / (level + LEVEL_RISE_TERM)) * gain.hackingExp * gain.hackingSpeed;
    // This cycle's ramp, measured; else the last measured in the BitNode, the one carried in; else none yet.
    const ramp = readLevelRamp(this.#store);
    const before = readCarriedLevelRise(this.#store);
    const deadMs =
      ramp?.lastAugReset === lastAugReset
        ? ramp.rampMs
        : before !== null && before.lastNodeReset === lastNodeReset
          ? before.deadMs
          : null;
    const carried: CarriedLevelRise = { lastNodeReset, lastAugReset, kappa, deadMs };
    this.#store.setSetting(AUGMENTATION_LEVEL_RISE_SETTING, JSON.stringify(carried));
  }

  /**
   * The Red Pill's way (#215), before an ordinary install is chosen:
   * - `redPill`: it's queued, or reached at a joined seller (Daedalus): install, for it.
   * - `hold`: no ordinary install, saying why. Joined, it's short of its reputation, which an install would reset
   *   (`Faction/Faction.ts:77-85`). Not joined, with Daedalus's count of installed augmentations reached and its skill
   *   requirement met: only money, held at the game's check, is missing, so its $100b is held back from cloud servers
   *   (an install would reset the money and the hacking level). With the skill short, ordinary installs go on: they
   *   raise the hacking multiplier.
   * - Installed, with the destroy wanted (#215 review): `hold`, as an install would reset the hacking level
   *   w0r1d_d43m0n needs (and drop its root), with `lastNodeReset` unmoved, so the destroy would wait hours.
   * - Reported bought and never queued (`augmentationNotQueued`, #215 review): `hold`, as R2 counts it owned for the
   *   plan; an install without it would install the rest and lose Daedalus's reputation.
   * - `redPill` with a donation (#225): a joined seller's donations are unlocked and the money covers the donation for
   *   its missing reputation; short of it, `hold`, that money held back (`redPillHold`).
   * - `daedalusDonations` (#225): Daedalus joined, its donations not unlocked, its reputation this cycle at what
   *   unlocks them at the next install (`redPillTarget`'s donations target: not once 90% of The Red Pill's is earned).
   * - `gang` (#357's (3)): The Red Pill short at the gang's faction, with the planner's BN2 route: its turn, no hold.
   * - `none`: installed already (the destroy not wanted), not sold in this BitNode (BN15), or Daedalus's count not
   *   reached.
   */
  #endgame({
    resetInfo,
    player,
    purchaseState,
    installable,
    queue,
    shops,
    destroyWanted,
    sinceResetMs,
    onlineMs,
    gangEarning,
  }: {
    resetInfo: NonNullable<ReturnType<typeof resetInfoOf>>;
    player: NonNullable<ReturnType<typeof playerOf>>;
    purchaseState: AugmentationPurchaseState;
    /** What an install would install, and the queue the plan counts (with each `augmentationNotQueued`). */
    installable: string[];
    queue: string[];
    shops: AugmentationShops;
    destroyWanted: boolean;
    sinceResetMs: number | null;
    /** The game's time online this cycle (the bars' clock): the hold's window at the gang's faction, from its start. */
    onlineMs: number;
    /**
     * The gang earns its faction no respect now (#357's (3): p unknown, the gang rule's `installFigures` read, its
     * plan's respect 0, members training): false; else true (earning, or the gang unread, whose reputation still rises).
     */
    gangEarning: boolean;
  }): Endgame {
    const { currentNode, ownedAugs, ownedSF, lastAugReset } = resetInfo;
    // The hold at the gang's faction (#335's review): from its first start in the cycle, at most its window, never
    // restarted, kept in the store as Daedalus's count hold is.
    const stored = readGangRedPillHold(this.#store);
    const heldSince = stored?.lastAugReset === lastAugReset ? stored.sinceOnlineMs : null;
    // The decision is core's (#260), the fast model's too; the words are the brain's.
    const endgame = augmentationEndgame({
      installed: ownedAugs,
      installable,
      queue,
      state: purchaseState,
      shops,
      money: player.money,
      factionRep: player.person.mults.faction_rep,
      figures: { money: player.money, skills: player.person.skills },
      currentNode,
      ownedSF,
      destroyWanted,
      sinceResetMs,
      gangHoldOver: heldSince !== null && onlineMs >= heldSince + GANG_RED_PILL_HOLD_MS,
      // The planner times installs there (#357's (3)), in place of G5's hold; the rules (the A/B's baseline) hold. With
      // the gang earning nothing there now (members training), the rules as before: (3) has no rate after an install,
      // and an install loses only what's banked, which isn't growing (held, the World Daemon's stall would fire).
      gangPlanned: this.#bn2Route === "planner" && gangEarning,
    });
    const atGang = endgame.kind === "hold" && "seller" in endgame && endgame.seller.faction === shops.gangFaction;
    this.#redPillHeldAtGang = atGang;
    if (atGang && heldSince === null) writeGangRedPillHold(this.#store, { lastAugReset, sinceOnlineMs: onlineMs });
    if (endgame.kind !== "hold") return endgame;
    const count = (value: number) => Math.floor(value).toLocaleString("en-US");
    const hold = (why: HoldReason, waitingFor: string): Endgame => ({
      kind: "hold",
      why,
      reserve: endgame.reserve,
      waitingFor,
    });
    switch (endgame.why) {
      case "destroy":
        return hold(
          "destroy",
          `the BitNode's destroy: ${THE_RED_PILL} is installed, and an install would reset the hacking level ` +
            "w0r1d_d43m0n needs (the destroy switched on)",
        );
      case "redPillNotQueued":
        return hold(
          "redPillNotQueued",
          `${THE_RED_PILL} reported bought but not in the faction state's queue (the augmentationNotQueued alert): ` +
            "no install without it",
        );
      case "redPill":
        return "donation" in endgame
          ? hold(
              "redPill",
              `${THE_RED_PILL}: the money for ${endgame.donation.faction}'s donation, ` +
                `${formatMoney(endgame.donation.amount)} for its reputation (${formatMoney(endgame.money)} now)`,
            )
          : hold(
              "redPill",
              `${THE_RED_PILL}: ${endgame.seller.faction}'s reputation ${count(endgame.seller.reputation)} of ` +
                `${count(endgame.seller.needed)}` +
                // The gang's faction (#334): held only while it comes within the window.
                (endgame.seller.etaMs === undefined
                  ? ""
                  : `, about ${formatEta(endgame.seller.etaMs)} more at the cycle's rate (the gang's faction; held ` +
                    `${formatEta(Math.max(0, onlineMs - (heldSince ?? onlineMs)))} of at most ` +
                    `${formatEta(GANG_RED_PILL_HOLD_MS)})`) +
                " (an install now would lose it)",
            );
      case "daedalus":
        return hold(
          "daedalus",
          `${DAEDALUS}'s invitation (${endgame.missing.join(", ") || "the game's next check"}): an install now would ` +
            "reset the money and the hacking level",
        );
    }
  }

  /**
   * The donation asked for, if the faction state shows its reputation reached though its done isn't reported yet (#225
   * review): its event, its money spent, and recorded, so the done that comes later changes nothing.
   */
  #recordDonationShown(reputationOf: (faction: string) => number, slowGameTimeMs: number | null, atMs: number): void {
    const asked = this.#asked;
    if (asked?.donation === undefined || this.#recorded.has(asked.intent.id)) return;
    const shown = reputationOf(asked.faction);
    if (shown < asked.donation.reputation) return;
    this.#recorded.add(asked.intent.id);
    this.#spent.push({ gameTimeMs: slowGameTimeMs ?? 0, price: asked.price });
    const { reputation, before } = asked.donation;
    const amount = asked.price;
    this.#emit({
      type: AUGMENTATION_DONATED_EVENT_KIND,
      atMs,
      faction: asked.faction,
      amount,
      reputation,
      before,
      after: shown,
    });
    this.#log(
      `augmentations: donated ${describeDonation({ faction: asked.faction, amount, reputation })}: its reputation ` +
        `${Math.round(before).toLocaleString("en-US")} → ${Math.round(shown).toLocaleString("en-US")} (seen before ` +
        "its done was reported)",
    );
  }

  /** The donation `donation` needs now (#225): to its reputation from the faction's now; 0 once it's there. */
  #donationNow(
    donation: Donation,
    reputationOf: (faction: string) => number,
    player: NonNullable<ReturnType<typeof playerOf>>,
    multipliers: { FactionWorkRepGain: number },
  ): number {
    return donationToReach(
      donation.reputation - reputationOf(donation.faction),
      player.person.mults.faction_rep,
      multipliers.FactionWorkRepGain,
    );
  }

  /**
   * The note's next donation to make (#225), as an ask, or null once each is made: its faction's reputation short of
   * the donation's, in the note's order. One the money doesn't cover now is passed over for the cycle, saying so: what
   * it was for isn't bought, and the rest goes on.
   */
  #nextDonation(
    donations: readonly Donation[],
    reputationOf: (faction: string) => number,
    player: NonNullable<ReturnType<typeof playerOf>>,
    money: number,
    multipliers: { FactionWorkRepGain: number },
  ): Asked | null {
    for (const donation of donations) {
      if (this.#donationsSkipped.has(donation.faction)) continue;
      const amount = this.#donationNow(donation, reputationOf, player, multipliers);
      if (amount === 0) continue;
      if (amount > money) {
        this.#donationsSkipped.add(donation.faction);
        this.#log(
          `augmentations: the donation ${describeDonation({ ...donation, amount })} passed over: ` +
            `${formatMoney(money)} now; what it was for isn't bought`,
        );
        continue;
      }
      const args = { faction: donation.faction, amount, reputation: donation.reputation };
      return {
        intent: { id: intentId("donateToFaction", args), action: "donateToFaction", args },
        augmentation: null,
        faction: donation.faction,
        level: 0,
        price: amount,
        donation: { reputation: donation.reputation, before: reputationOf(donation.faction) },
      };
    }
    return null;
  }

  /** The next NeuroFlux Governor level, if the money and a joined seller's reputation cover it, as an ask. */
  #neuroFlux(
    purchaseState: AugmentationPurchaseState,
    shops: Map<string, string[]>,
    reputationOf: (faction: string) => number,
    money: number,
  ) {
    const cost = augmentationCost(NEUROFLUX_GOVERNOR, purchaseState);
    if (cost.money > money) return null;
    let faction: string | null = null;
    for (const [name, shop] of shops) {
      if (
        shop.includes(NEUROFLUX_GOVERNOR) &&
        reputationOf(name) >= cost.reputation &&
        (faction === null || reputationOf(name) > reputationOf(faction))
      ) {
        faction = name;
      }
    }
    if (faction === null) return null;
    const level =
      (purchaseState.installed[NEUROFLUX_GOVERNOR] ?? 0) +
      purchaseState.queued.filter((name) => name === NEUROFLUX_GOVERNOR).length +
      1;
    return {
      intent: purchaseIntent(faction, NEUROFLUX_GOVERNOR, level),
      augmentation: NEUROFLUX_GOVERNOR,
      faction,
      level,
      price: cost.money,
    };
  }

  /** What's asked for now (or nothing), and the view with it. */
  #ask(asked: Asked | null, view: Partial<AugmentationsView>): AugmentationAsk {
    this.#asked = asked;
    this.#view = { ...this.#view, asking: null, waitingFor: null, waiting: false, ...view };
    const committed = readAugmentationCycle(this.#store) !== null;
    return { intent: asked?.intent ?? null, install: false, committed };
  }

  /** The countdown called off, if one is under way (#222), saying why. */
  #cancelCountdown(why: string): void {
    if (this.#countdown === null) return;
    this.#countdown = null;
    this.#log(`augmentations: install countdown called off: ${why}`);
  }

  /**
   * The progress, stored as an `augmentationProgress` event when it changed since the last: always for the cycle, a
   * bar, the reason, the countdown's end or the hold (by its kind: its words carry live figures); for the counts alone,
   * at most once every `AUGMENTATION_PROGRESS_COUNTS_EVERY_MS` (#222 review: money see-sawing across a NeuroFlux price
   * would record each crossing). A steady state records nothing.
   */
  #recordProgress(progress: AugmentationProgress, hold: string | null, atMs: number): void {
    const { lastAugReset, affordable, affordableWithNeuroFlux, bar, barWithNeuroFlux, reason, byDonation } = progress;
    const structural = JSON.stringify([
      lastAugReset,
      bar,
      barWithNeuroFlux,
      reason,
      progress.countdown?.endsAtGameMs ?? null,
      hold,
      progress.short ?? null,
    ]);
    const counts = JSON.stringify([affordable, affordableWithNeuroFlux, byDonation]);
    const last = this.#progress;
    if (last !== null && last.structural === structural) {
      if (last.counts === counts || atMs - last.atMs < AUGMENTATION_PROGRESS_COUNTS_EVERY_MS) return;
    }
    this.#progress = { structural, counts, atMs };
    this.#emit({ type: AUGMENTATION_PROGRESS_EVENT_KIND, atMs, ...progress });
  }
}
