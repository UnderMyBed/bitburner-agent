// What the brain wants running in the game (architecture D2), kept in step with the dashboard's switches and the
// connected Agent's snapshots, and handed to the control channel to send: the hack loop (#134) and the intents (#141):
// the next purchase of the hacking programs (#136), home's RAM (#138) or a cloud server (#194), the next backdoor for
// the hacker factions (#195, ./backdoors.ts), the next faction to join and the brain's faction work (#203,
// ./factions.ts), the travel for invitations (#228, ./invitations.ts), the augmentations' purchases and install (#210,
// ./augmentations.ts), the gang in BN2 (#325, ./gang.ts), Bladeburner in BN6 and BN7 (#367, ./bladeburner.ts), and the
// owner's manual queue and work. Irreversible
// intents wait for their guard and a save backup first (#147). Each state carries how long the Agent keeps it with the
// brain gone (`ttlMs`, safe mode, #160).
// An install of augmentations (#164) or a destroy of the BitNode (#175) holds back what's queued after it, and leaves
// the queue once a slow snapshot shows the game reset.
import type { ControlChannel } from "@bitburner-agent/bridge";
import {
  BATCHER_RAM_BUDGET_GB,
  type BatcherHealth,
  type BitNodeHackingMultipliers,
  BLADEBURNER_SKILL_WORKER_RAM_GB,
  BLADEBURNER_WORKER_RAM_GB,
  type BladeburnerState,
  type Bn2Route,
  bitNodeAssumptions,
  type DesiredState,
  EFFECTOR_BACKENDS,
  FACTION_ENEMIES,
  type FactionWorkType,
  type FastSnapshotData,
  factionReadingOf,
  GANG_ROUTE_SERVER,
  type GangState,
  gangSellsRedPill,
  type Intent,
  type IntentOutcome,
  intentId,
  isBitNodeNumber,
  isHackLoopFile,
  isIrreversibleIntent,
  type JoinedFaction,
  LEVEL_GROW_SCRIPT_NAME,
  LEVEL_LOOP_SCRIPT_NAME,
  MAX_INTENTS,
  type MediumSnapshotData,
  PORT_OPENER_PROGRAMS,
  parseIntentRequest,
  resetsTheGame,
  type SlowSnapshotData,
  type StaticSnapshotData,
  THE_RED_PILL,
  TOR_ROUTER,
} from "@bitburner-agent/core";
import {
  AUGMENTATION_INSTALL_INTENT,
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  type AugmentationEvent,
  AugmentationRule,
  type AugmentationsView,
  type InstallAwaitingRestart,
  type InstallTimingPolicy,
  type NotQueued,
  readAugmentationsEnabled,
  writeAugmentationsEnabled,
} from "./augmentations.ts";
import { type BackdoorDue, BackdoorRule } from "./backdoors.ts";
import {
  BATCHER_ENABLED_SETTING,
  type BatcherView,
  batcherHostsOf,
  batcherNotRunning,
  batcherViewOf,
  bitNodeHackingOf,
  chooseBatcher,
  HACKING_MULTIPLIERS_UNREAD,
  planBatcher,
  readBatcherEnabled,
  readBatcherOnHome,
} from "./batcher.ts";
import {
  type BitNodeEndEvent,
  BitNodeEndWatch,
  bitNodeReadingOf,
  CLOSE_GAME_INTENT,
  CLOSE_GAME_MOST_TRIES,
  closeGameTriedEnough,
  GAME_CLOSE_CALLED_OFF_EVENT_KIND,
  GAME_CLOSE_SENT_EVENT_KIND,
  GAME_CLOSE_TRIED_EVENT_KIND,
  readStopAtBitNodeEnd,
  type StopAtBitNodeEnd,
  writeStopAtBitNodeEnd,
} from "./bitnode-end.ts";
import {
  BLADEBURNER_ACTIONS_HOLD,
  type BladeburnerEvent,
  BladeburnerRule,
  type BladeburnerView,
} from "./bladeburner.ts";
import {
  CLOUD_SERVER_RESERVE_HORIZON_MS,
  CLOUD_SERVERS_ENABLED_SETTING,
  type CloudServer,
  type CloudServerPurchase,
  type CloudServersPlan,
  chooseCloudServerPurchase,
  HackLoopIncome,
  type MoneyReserve,
  readCloudServersEnabled,
} from "./cloud-servers.ts";
import { type DestroyEstimateEvent, DestroyEstimateRule, readDestroySeed } from "./destroy-estimate.ts";
import {
  countOf,
  FactionRule,
  type FactionsView,
  type FactionWorkEvent,
  type FactionWorkStall,
  readFactionWorkEnabled,
  resetInfoOf,
  writeFactionWorkEnabled,
} from "./factions.ts";
import {
  bitNodeOfSlow,
  GANG_BITNODE,
  type GangEvent,
  type GangMoneyHold,
  GangRule,
  type GangView,
  gangMoneyHoldOf,
  gangPurchasesSpokenFor,
  gangShopOf,
  withoutGangFaction,
} from "./gang.ts";
import type { GangStallStretch } from "./gang-stalls.ts";
import { HACK_LOOP_ENABLED_SETTING, type LastHackTarget, planHackLoop, readHackLoopEnabled } from "./hack-loop.ts";
import { chooseHomeRamUpgrade, HOME_RAM_ENABLED_SETTING, type HomeRamPlan, readHomeRamEnabled } from "./home-ram.ts";
import { type InvitationEvent, type InvitationInputs, InvitationRule, type InvitationView } from "./invitations.ts";
import { type BackupsBeforeIrreversibleIntents, IrreversibleIntentGates } from "./irreversible-gate.ts";
import { type LevellingEvent, type LevellingPlan, LevellingRule, type LevellingView } from "./levelling.ts";
import {
  type ResetSentNote,
  readManualIntents,
  readResetSentNote,
  writeManualIntents,
  writeResetSentNote,
} from "./manual-intents.ts";
import { chooseNextPurchase, PROGRAMS_ENABLED_SETTING, type ProgramsPlan, readProgramsEnabled } from "./programs.ts";
import {
  factionWorkGoingOn,
  homeBatchesWhileSharing,
  homeKeptGbOf,
  readShareEnabled,
  type ShareView,
  shareBonusOf,
  sharingConfigOf,
  sharingOf,
  singularityRamMultiplierOf,
  writeShareEnabled,
} from "./share.ts";
import { writeSwitch } from "./switches.ts";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";
import {
  type OwnersWork,
  parseOwnersWork,
  readOwnersWork,
  reportedWorkOutcome,
  type WorkView,
  workFocus,
  writeOwnersWork,
} from "./work.ts";
import {
  BITNODE_DESTROY_SENT_EVENT_KIND,
  readWorldDaemonEnabled,
  replayOf,
  skippedOf,
  type WorldDaemonEvent,
  WorldDaemonRule,
  type WorldDaemonStall,
  type WorldDaemonView,
  worldDaemonDestroyInto,
  writeWorldDaemonEnabled,
} from "./world-daemon.ts";

/**
 * Safe mode (#160, architecture §5.4): how long the Agent keeps converging on the last state, minus its intents, after
 * it was last connected to this brain. Nothing in a state turns harmful with time alone (a reset, which does, drops it
 * at once), and the loops and the work carry on after it anyway: it bounds how long a stopped brain's choices outlive
 * it. 12 hours covers a night or a working day with the brain stopped or crashed for good.
 */
export const SAFE_MODE_TTL_MS = 12 * 60 * 60_000;

/**
 * The owner's manual queue's limit: the protocol's 100, less room for the purchase (a program, home RAM or a cloud
 * server, #194, one at a time), the backdoor (#195), the join (#203), the augmentation purchase or install (#210; never
 * both) and the World Daemon's destroy (#215).
 */
export const MANUAL_QUEUE_LIMIT = MAX_INTENTS - 5;

/** What the dashboard shows of the hack loop. */
export interface HackLoopView {
  enabled: boolean;
  /** On, but the brain hasn't yet had the connected Agent's static and medium snapshots, so it has sent nothing new. */
  waiting: boolean;
  /** The target it earns on, and its hosts. */
  target: string | null;
  hosts: string[];
  /**
   * At most how many of their threads hack at once (#187): the brain's count for each host added up (a host's loop may
   * have fewer threads), or null when it gives none, so all hack.
   */
  hackThreads: number | null;
  /** The next target, being prepared on these hosts while the others earn (#184), or null, with its hack threads. */
  preparing: { target: string; hosts: string[]; hackThreads: number | null } | null;
  /**
   * Levelling mode (#336): the hosts weaken `target` for the hacking experience, not money, so no income is expected;
   * absent, the hack loop (or the batcher).
   */
  levelling?: boolean;
}

/**
 * The hosts' hack threads added up, for the dashboard (#187), or null when a host hacks with all its threads: the state
 * gives no counts, or none for that host (which the brain's plan never leaves out, but the protocol allows).
 */
export function hackThreadsAddedUp(
  hackThreads: Record<string, number> | null | undefined,
  hosts: string[],
): number | null {
  if (!hackThreads) return null;
  let total = 0;
  for (const host of hosts) {
    const count = hackThreads[host];
    if (count === undefined) return null;
    total += count;
  }
  return total;
}

/** What the dashboard shows of the hacking programs. */
export interface ProgramsView {
  enabled: boolean;
  /** As for the hack loop: no medium snapshot from the connected Agent yet. */
  waiting: boolean;
  /** The TOR router and the port openers owned, in buying order. */
  owned: string[];
  /** The item being bought now, or null. */
  buying: string | null;
  /** Why nothing is bought now, or null. */
  waitingFor: string | null;
}

/** What the dashboard shows of home's RAM. */
export interface HomeRamView {
  enabled: boolean;
  /** As for the hack loop: no medium snapshot from the connected Agent yet. */
  waiting: boolean;
  /** Home's RAM (GB), or null if it isn't known. */
  ram: number | null;
  /** The RAM the upgrade being bought now brings home to, or null. */
  upgradingTo: number | null;
  /** Why nothing is bought now, or null. */
  waitingFor: string | null;
}

/** What the dashboard shows of cloud servers (#194). */
export interface CloudServersView {
  enabled: boolean;
  /** As for the hack loop: no static and medium snapshots from the connected Agent yet. */
  waiting: boolean;
  /** The player's cloud servers, by name, with their RAM. */
  servers: CloudServer[];
  /** The purchase being sent now: a new server, or more RAM for one, or null. */
  buying: Pick<CloudServerPurchase, "action" | "hostname" | "ram" | "price" | "paybackMs"> | null;
  /** Why nothing is bought now, or null. */
  waitingFor: string | null;
  /**
   * A cloud purchase the connected Agent reported done with a problem (bought under another name), as "<id>:
   * <problem>", or null: the `cloudServerProblem` alert. The rule buys nothing more until the switch is turned off and
   * on.
   */
  problem: string | null;
}

/** The rules' events, for the store (#203, #210, #215, #228), and the stop at the BitNode's end (#303). */
export type RuleEvent =
  | FactionWorkEvent
  | AugmentationEvent
  | WorldDaemonEvent
  | InvitationEvent
  | BitNodeEndEvent
  | LevellingEvent
  | DestroyEstimateEvent
  | GangEvent
  | BladeburnerEvent;

/** What the dashboard shows of the stop at the BitNode's end (#303). */
export interface StopAtBitNodeEndView {
  setting: StopAtBitNodeEnd;
}

/** What the dashboard shows of each intent sent: where it came from, and how it went in the game. */
export interface IntentView {
  id: string;
  /**
   * The owner's manual queue, the brain's purchase rules, its backdoors (#195), its joins (#203), its travel for an
   * invitation (#228: Tian Di Hui's or its city group's), or its augmentations' purchases and install (#210), or its
   * destroy (#215), or its gang's forming (#325), or its Bladeburner division's join (#367).
   */
  source:
    | "manual"
    | "purchase"
    | "backdoor"
    | "join"
    | "travel"
    | "augmentation"
    | "worldDaemon"
    | "bitNodeEnd"
    | "gang"
    | "bladeburner";
  /** From the connected Agent's latest fast snapshot, or null before it reports this intent. */
  outcome: IntentOutcome | null;
  /**
   * Why an irreversible intent (#147), or one queued after an install (#164) or a destroy (#175), isn't sent yet, to
   * follow "not sent: ", or null once it's sent, or for any other.
   */
  waitingFor: string | null;
}

/** A manual intent added, or why it wasn't. */
export type AddedIntent = { ok: true; intent: Intent } | { ok: false; reason: string };

/**
 * Keeps the channel's desired state in step with the switches and the connected Agent's snapshots.
 * - Every activity goes in one state, whole each time. With no snapshots from the connected Agent yet (it sends them
 *   in its first round), only the hack loop off goes out, with the owner's manual queue (each intent checks the game
 *   first, so a stale one does nothing). If the hack loop is on, nothing goes out until then. So a stale target or the last brain's view is never sent: a brain that
 *   restarts sends the running Agent the same state, which changes nothing, and an Agent after a reset is never given
 *   a target its game can't hack.
 * - The channel sends each connection a state once, then again on a change.
 * - One purchase at a time, cheapest first: of the next program and the next RAM upgrade, both affordable, the cheaper
 *   goes and the other waits for it. Money covers the cheaper one first, so nothing is bought ahead of it. With home
 *   RAM on, no program goes before the slow snapshot, which says the BitNode and so the upgrade's price.
 * - Then a cloud server (#194, ./cloud-servers.ts), only while neither of those is being bought, and with the hack loop
 *   on (they only run it). While the cheaper of the two waits for money, its price is held back from cloud servers if
 *   the hack loop's income would cover it within `CLOUD_SERVER_RESERVE_HORIZON_MS`.
 * - Gang equipment last (#330, G3, ./gang.ts): only from money above every hold cloud servers and home RAM keep, this
 *   round's purchase and the cloud server waiting for money (`#gangEquipmentHold`), sent as the gang's `keepMoney`.
 * - Intents go in order: the owner's manual queue first, as added, then the brain's install of augmentations (#210,
 *   ./augmentations.ts) behind it, then the purchase, then the augmentation purchase (#210), then the backdoor (#195),
 *   asked for until the connected Agent reports it done, then the join (#203). A manual intent leaves the queue once
 *   the connected Agent reports it done: the game's state can change again (a travel there and back), so a snapshot
 *   can't say it was done. Never more than the protocol's 100: a queue stored under an older limit leaves the rules'
 *   intents out, logged.
 * - Augmentations (#210): once an install is chosen, the programs and cloud servers stand down (an install loses
 *   them), and home's RAM is the augmentation rule's. In the install's countdown before it (#222), the counted
 *   purchases' money is held from cloud servers and home RAM, and no program is bought. Before that, cloud servers
 *   leave alone the rule's reserve too: that money, for an install the count rule would choose with A2's payback
 *   limit's more income.
 * - An irreversible intent (R8, #147) goes out only past its gate (./irreversible-gate.ts): its guard on two
 *   consecutive medium snapshots from the connected Agent, then a save backup. Until then it's left out, and the
 *   intents after it go on without it: a held join doesn't hold up a travel queued later.
 * - An intent that resets the game (core's `resetsTheGame`: an install of augmentations, #164, or a destroy of the
 *   BitNode, #175) is the exception: what's queued after it waits until it's done, since it was queued for the game
 *   after the reset. Its own guard is that nothing queued before it is undone (and, for a destroy, w0r1d_d43m0n's
 *   preconditions).
 * - Its done check: the connected Agent's reset time (the slow snapshot's `lastAugReset` for an install,
 *   `lastNodeReset` for a destroy, which an install doesn't move) is noted when it's sent, and another one shows the
 *   game reset: it leaves the queue at once, not gated and backed up again for the new game. Another, not a later one:
 *   the game sets them from the clock (`PersonObjects/Player/PlayerObjectGeneralMethods.ts:122-126`, `:173`), which
 *   can be set back (#167: E2's page clock is). They move only with a reset or another save loaded; either way the
 *   intent is dropped, the safe direction for an irreversible one.
 * - It goes out only once a slow snapshot has said the reset time (#175 review), so the note is always written.
 * - The note is kept in the store (#175): it outlives a disconnect (the reset kills the Agent) and a restart of the
 *   brain. A destroy can't be seen done in the game (another can follow): a brain that forgot it sent one would gate
 *   it again in the next BitNode, and destroy that too once its requirements were met.
 */
export class DesiredStateController {
  readonly #channel: ControlChannel;
  readonly #store: TelemetryStore;
  /** The connected Agent's latest snapshots: forgotten when it disconnects, or another connects. */
  #staticData: StaticSnapshotData | null = null;
  #mediumData: MediumSnapshotData | null = null;
  /**
   * The slow snapshot the rules decide on: the connected Agent's (`#slowSnapshot`) with the gang's faction left out of
   * the factions joined (#325, `withoutGangFaction`).
   */
  #slowData: SlowSnapshotData | null = null;
  /** The gang's faction as A6, A5, the World Daemon and the invitations see it (#334, `gangShopOf`), or null. */
  #gangShop: JoinedFaction | null = null;
  /** The connected Agent's latest slow snapshot, as it came. */
  #slowSnapshot: SlowSnapshotData | null = null;
  #fastData: FastSnapshotData | null = null;
  #desired: DesiredState | null = null;
  /**
   * The hack loop's target last set, whether it earns, and the hosts preparing the next one, or null (#184). Kept across
   * the Agent's connections while the game hasn't reset: a reconnect mid-prepare judged afresh could find the target
   * between a hack and its weaken, not ready, and move every host to the next one, the Steam stall again. None after the
   * switch off or a brain restart: the rule then starts from the targets that are ready, or being worked.
   */
  #lastSetHackTarget: LastHackTarget | null = null;
  /** The game's `lastAugReset` (the slow snapshot's) when it was set, or null if no slow snapshot had said. */
  #lastSetHackTargetResetAt: number | null = null;
  /** Why no batcher is sent while its switch is on (#205), or null. */
  #batcherWhy: string | null = null;
  /** Home left out of the batcher's hosts to share instead, this update (#340's review, `homeBatchesWhileSharing`). */
  #homeSharesInstead = false;
  /** The mode, the batcher's target and next as last logged (#206), or null before any. */
  #batcherMode: string | null = null;
  /** Why the batcher sent isn't running, as the last fast snapshot said, or null (#211). */
  #batcherNotRunning: string | null = null;
  /** Why the batcher isn't asked to share while sharing's switch is on (#224), or null when it is. */
  #shareWhy: string | null = null;
  /** The purchase the brain's rules ask for now, or null. */
  #purchase: Intent | null = null;
  /** From the connected Agent's latest medium snapshot, or null. */
  #programsPlan: ProgramsPlan | null = null;
  /** From its latest medium and slow snapshots, or null. */
  #homeRamPlan: HomeRamPlan | null = null;
  /** From its latest static, medium and slow snapshots, or null (#194). */
  #cloudServersPlan: CloudServersPlan | null = null;
  /** The hack loop's income, from its medium snapshots (#194). */
  readonly #income = new HackLoopIncome();
  /** The cloud purchase last sent, kept while still to do so its id holds (#194), or null. */
  #lastCloudPurchase: CloudServerPurchase | null = null;
  /** A cloud purchase reported done with a problem, until the switch is turned off (#194), or null. */
  #cloudServerProblem: { id: string; text: string } | null = null;
  /** The ids of the problems the switch turned off has seen, so a fast snapshot still showing one isn't noted again. */
  readonly #seenCloudServerProblems = new Set<string>();
  /** Why each activity's purchase isn't asked for now, or null: its plan's reason, or the cheaper purchase first. */
  #waitingFor: { programs: string | null; homeRam: string | null; cloudServers: string | null } = {
    programs: null,
    homeRam: null,
    cloudServers: null,
  };
  /** Each irreversible intent queued and not yet done (none goes out with a brain that takes no save backups). */
  readonly #gates: IrreversibleIntentGates;
  /** The reset time when the first intent that resets the game was sent, while it's queued, or null (#164, #175). */
  #resetSent: ResetSentNote | null;
  /** The backdoors for the hacker factions (#195): the rule, and the one it asks for now, or null. */
  readonly #backdoors: BackdoorRule;
  /** The gang (#325): its forming intent, and the desired state's gang. */
  readonly #gang: GangRule;
  #gangIntent: Intent | null = null;
  #gangState: GangState | null = null;
  /**
   * Bladeburner (#367): the rule, its join, the worker's state, the training it sends as the brain's work, and (#379)
   * the skills it buys.
   */
  readonly #bladeburner: BladeburnerRule;
  #bladeburnerIntent: Intent | null = null;
  #bladeburnerSkillIntents: Intent[] = [];
  #bladeburnerState: BladeburnerState | null = null;
  #bladeburnerWork: OwnersWork | null = null;
  #backdoor: Intent | null = null;
  /** The joins and the brain's faction work (#203): the rule, the join it asks for now, the work it sends, or null. */
  readonly #factions: FactionRule;
  #join: Intent | null = null;
  /** A join that bans nothing, sent beside `#join` while that one, a city faction's, waits at the gate (#269). */
  #joinAlongside: Intent | null = null;
  /** The travel for invitations (#228), Tian Di Hui's and the city group's: the rule, and the travel it asks for. */
  readonly #invitations: InvitationRule;
  #travel: Intent | null = null;
  #factionWork: { faction: string; workType: FactionWorkType } | null = null;
  /** Who gets the rules' events (#203, #210): the store, through main.ts. */
  readonly #listeners = new Set<(event: RuleEvent) => void>();
  /** When the connected Agent's latest medium and slow snapshots arrived, or null. */
  #mediumAtMs: number | null = null;
  /** The game's time of the connected Agent's latest medium and fast snapshots (their `gameTimeMs`), or null (#213). */
  #mediumGameTimeMs: number | null = null;
  #fastGameTimeMs: number | null = null;
  #slowAtMs: number | null = null;
  /** The game's time in the connected Agent's latest slow snapshot (its `gameTimeMs`), or null (#210). */
  #slowGameTimeMs: number | null = null;
  /** The latest channel event's time: the controller's clock, for the rules' events (#210). Null before any. */
  #lastEventAtMs: number | null = null;
  /**
   * Augmentations and the reset (#210): the rule, the purchase it asks for now, whether it asks for the install, and
   * whether it's committed to one (the programs then stand down).
   */
  readonly #augmentations: AugmentationRule;
  #augmentationIntent: Intent | null = null;
  #augmentationInstall = false;
  #augmentationsCommitted = false;
  /** The World Daemon (#215): the rule, and whether it asks for the destroy. */
  readonly #worldDaemon: WorldDaemonRule;
  #worldDaemonDestroy = false;
  /** The planner's levelling choice (#336): the rule, and its plan as of the last update. */
  readonly #levelling: LevellingRule;
  #levellingPlan: LevellingPlan = { mode: "money", levelling: null };
  /** Whether levelling weighs (d) (#380): the planner's; off for a test's A/B alone. */
  readonly #levellingBatch: boolean;
  /** The time to the destroy (#360): estimated at the BitNode's start, each install, Daedalus joined and levelling. */
  readonly #destroyEstimate: DestroyEstimateRule;
  /** The BitNode whose BN1-only assumptions (#321) were last logged: logged again only for another. */
  #assumptionsLoggedFor: number | null = null;
  /** `HACKING_MULTIPLIERS_UNREAD` logged, until a slow snapshot says the BitNode: once, not every update. */
  #hackingUnreadLogged = false;
  /** The stop at the BitNode's end (#303): it asks main.ts, through its event, to shut the brain down. */
  readonly #bitNodeEnd: BitNodeEndWatch;
  /** The close of the game at the BitNode's end (#303): when it went out, and whether it's withdrawn, tried enough. */
  #closeGameSentAtMs: number | null = null;
  #closeGameWithdrawn = false;
  /** The tries of the close the Agent has reported (#303 review), each stored as `gameCloseTried`. */
  #closeGameTries = 0;
  /** When the Agent disconnected with an install out (its reset note written), until a slow snapshot shows a reset. */
  #installDisconnectedAtMs: number | null = null;
  readonly #log: (line: string) => void;
  /** The intents left out to keep to the protocol's 100, as last logged (#195 review): logged on a change. */
  #leftOut = "";

  /** `log` is the brain's: the backdoors' lines (#195). */
  constructor({
    channel,
    store,
    saveBackups = null,
    log = () => {},
    installTiming = "planner",
    bn2Route = "planner",
    gangRoute = bn2Route,
    environment = null,
    levellingBatch = true,
  }: {
    channel: ControlChannel;
    store: TelemetryStore;
    saveBackups?: BackupsBeforeIrreversibleIntents | null;
    log?: (line: string) => void;
    /** Who times installs short of Daedalus's count (#343): the planner; the count rule for a test's A/B alone. */
    installTiming?: InstallTimingPolicy;
    /** BN2's route (#357): the planner's; the rules' (#343's before the gang, money at 12) for a test's A/B alone. */
    bn2Route?: Bn2Route;
    /**
     * The gang rule's own route (#357's (3) A/B, a test's alone): the objective at 12 the planner's while A6's install
     * timing is the rules', so the A/B weighs the installs alone. Absent, `bn2Route`.
     */
    gangRoute?: Bn2Route;
    /**
     * The store's environment (#360): the destroy estimate's prior is read from its slow snapshots, once a BitNode.
     * Null (tests of other rules): no prior, the estimate's time online from 0.
     */
    environment?: Environment | null;
    /** Levelling's (d), batching for the money then an install (#380): weighed; off for a test's A/B alone. */
    levellingBatch?: boolean;
  }) {
    this.#levellingBatch = levellingBatch;
    this.#channel = channel;
    this.#store = store;
    this.#log = log;
    this.#backdoors = new BackdoorRule(log);
    this.#gang = new GangRule(log, store, { emit: (event) => this.#emit(event), route: gangRoute });
    this.#bladeburner = new BladeburnerRule(log, (event) => this.#emit(event));
    this.#augmentations = new AugmentationRule({
      store,
      log,
      emit: (event) => this.#emit(event),
      installTiming,
      bn2Route,
    });
    this.#factions = new FactionRule({ log, emit: (event) => this.#emit(event) });
    this.#worldDaemon = new WorldDaemonRule({ log, emit: (event) => this.#emit(event) });
    this.#levelling = new LevellingRule({ log, emit: (event) => this.#emit(event) });
    this.#invitations = new InvitationRule({ log, emit: (event) => this.#emit(event) });
    this.#bitNodeEnd = new BitNodeEndWatch({ log, emit: (event) => this.#emit(event) });
    this.#destroyEstimate = new DestroyEstimateRule({
      store,
      log,
      emit: (event) => this.#emit(event),
      ...(environment === null ? {} : { seedOf: (live) => readDestroySeed(store, environment, live) }),
    });
    this.#resetSent = readResetSentNote(store);
    // A restarted brain with its destroy out (#215 review): held, and its note kept, until the BitNode's reset shows.
    const restoredInto = this.#resetSent?.field === "lastNodeReset" ? worldDaemonDestroyInto(this.#resetSent.id) : null;
    if (this.#resetSent !== null && restoredInto !== null)
      this.#worldDaemon.restore(this.#resetSent.resetAt, restoredInto);
    // A brain restarted with an install out: the Agent went with it, as far as this brain knows, since it went out.
    if (this.#resetSent?.field === "lastAugReset" && this.#resetSent.sentAtMs !== undefined) {
      this.#installDisconnectedAtMs = this.#resetSent.sentAtMs;
    }
    this.#gates = new IrreversibleIntentGates({ saveBackups, onChange: () => this.#update() });
    channel.subscribe((event) => {
      this.#lastEventAtMs = event.atMs;
      if (event.type === "agentConnected" || event.type === "agentDisconnected") {
        // A close sent to the Agent that went (#303 review): never sent again, the brain's or one in the queue.
        if (event.type === "agentDisconnected") this.#dropCloseGameSent();
        this.#staticData = null;
        this.#mediumData = null;
        this.#mediumAtMs = null;
        this.#mediumGameTimeMs = null;
        this.#fastGameTimeMs = null;
        this.#slowData = null;
        this.#slowSnapshot = null;
        this.#slowGameTimeMs = null;
        this.#slowAtMs = null;
        this.#fastData = null;
        // Counted on the last Agent's snapshots: every gate starts again, and the cloud servers' income is measured
        // afresh (#194). The augmentations' income is the game's own count since the install: kept (#210).
        this.#gates.forget();
        this.#income.clear();
        // An install out when the Agent goes: the reset should show within minutes (#210, `installNotRestarted`). An
        // Agent back is no longer awaited: its slow snapshot shows the reset, or the gate sends the install again.
        if (event.type === "agentDisconnected" && this.#resetSent?.field === "lastAugReset") {
          this.#installDisconnectedAtMs ??= event.atMs;
        }
        if (event.type === "agentConnected") this.#installDisconnectedAtMs = null;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "fast") {
        // The intents' and the work's outcomes: for the views, and the manual intents done, or the augmentation
        // purchase asked for (#210), whose next one goes at once. Anything else changes nothing to send: the work's
        // outcome, which turns sharing on or off (#224), and the share bonus the batcher reports, are sent with the next
        // medium snapshot's update.
        this.#fastData = event.snapshot.data as FastSnapshotData;
        this.#fastGameTimeMs = event.snapshot.gameTimeMs;
        // A batcher sent but not running, logged when that changes (#211); the dashboard and the run report say more.
        const notRunning = batcherNotRunning(this.#fastData?.batcherDeploy);
        if (notRunning !== this.#batcherNotRunning) {
          this.#log(
            notRunning === null ? "batcher: running, or no longer wanted" : `batcher: sent, not running: ${notRunning}`,
          );
          this.#batcherNotRunning = notRunning;
        }
        const problemNoted = this.#noteCloudServerProblem();
        const dropped = this.#dropDoneManualIntents();
        const closeWithdrawn = this.#noteCloseGameTries();
        if (!dropped && !problemNoted && !closeWithdrawn && !this.#augmentations.askedDone(this.#doneIds())) return;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "static") {
        this.#staticData = event.snapshot.data as StaticSnapshotData;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "medium") {
        this.#mediumData = event.snapshot.data as MediumSnapshotData;
        this.#income.add(event.atMs, this.#staticData, this.#mediumData);
        this.#mediumAtMs = event.atMs;
        this.#mediumGameTimeMs = event.snapshot.gameTimeMs;
        this.#gates.mediumSnapshot(this.#mediumData, this.#judgedQueue(), this.#staticData);
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "slow") {
        this.#slowSnapshot = event.snapshot.data as SlowSnapshotData;
        this.#slowData = withoutGangFaction(this.#slowSnapshot, this.#gang.hiddenFactions());
        this.#slowGameTimeMs = event.snapshot.gameTimeMs;
        this.#slowAtMs = event.atMs;
        this.#logBitNodeAssumptions();
        // The stop at the BitNode's end (#303): a destroy's note read before the reset it shows drops it.
        const reading = bitNodeReadingOf(this.#slowSnapshot, event.snapshot.gameTimeMs);
        if (reading !== null) {
          this.#bitNodeEnd.slowSnapshot(reading, {
            setting: readStopAtBitNodeEnd(this.#store),
            destroySentAt: this.#resetSent?.field === "lastNodeReset" ? this.#resetSent.resetAt : null,
            atMs: event.atMs,
          });
        }
        this.#dropResetIntentOnceReset();
      } else {
        return;
      }
      this.#update();
    });
    this.#update();
  }

  /** The hack loop's switch: kept in the store, so it survives restarts of the brain, and sent at once. */
  setHackLoopEnabled(enabled: boolean): void {
    writeSwitch(this.#store, HACK_LOOP_ENABLED_SETTING, enabled);
    this.#update();
  }

  /** The batcher's switch (#205), likewise; on by default since #206. */
  setBatcherEnabled(enabled: boolean): void {
    writeSwitch(this.#store, BATCHER_ENABLED_SETTING, enabled);
    this.#update();
  }

  /** The batcher (#205): its switch, what was sent or why not, and the connected Agent's last report of its health. */
  batcherView(): BatcherView {
    return batcherViewOf(
      readBatcherEnabled(this.#store),
      this.#desired?.batcher ?? null,
      this.#batcherWhy,
      this.#batcherHealth(),
    );
  }

  /** Sharing's switch (#224, owner decision 52), likewise; on by default. */
  setShareEnabled(enabled: boolean): void {
    writeShareEnabled(this.#store, enabled);
    this.#update();
  }

  /** Sharing (#224): its switch, whether the batcher is asked to share or why not, and its last report. */
  shareView(): ShareView {
    const enabled = readShareEnabled(this.#store);
    const asked = this.#desired?.batcher?.config.sharing !== undefined;
    return {
      enabled,
      asked,
      why: enabled && !asked ? (this.#shareWhy ?? "waiting for the Agent's snapshots") : null,
      sharing: sharingOf(this.#batcherHealth()),
    };
  }

  /**
   * The batcher's health in the latest fast snapshot, or null; null too when it was written before the game's last
   * install (#216's review): ports outlive an install, so a batcher the reset killed would still read as batching.
   */
  #batcherHealth(): BatcherHealth | null {
    const health = this.#fastData?.batcher ?? null;
    const resetAt = resetTimeOf(this.#slowData, "lastAugReset");
    if (health === null || (resetAt !== null && typeof health.atMs === "number" && health.atMs < resetAt)) return null;
    return health;
  }

  /** The hacking programs' switch, likewise. */
  setProgramsEnabled(enabled: boolean): void {
    writeSwitch(this.#store, PROGRAMS_ENABLED_SETTING, enabled);
    this.#update();
  }

  /** Home RAM's switch, likewise. */
  setHomeRamEnabled(enabled: boolean): void {
    writeSwitch(this.#store, HOME_RAM_ENABLED_SETTING, enabled);
    this.#update();
  }

  /**
   * Cloud servers' switch, likewise. Turned off, a problem noted is forgotten, so turning it on again goes on buying
   * (#194).
   */
  setCloudServersEnabled(enabled: boolean): void {
    writeSwitch(this.#store, CLOUD_SERVERS_ENABLED_SETTING, enabled);
    if (!enabled && this.#cloudServerProblem !== null) {
      this.#seenCloudServerProblems.add(this.#cloudServerProblem.id);
      this.#cloudServerProblem = null;
    }
    this.#update();
  }

  /** The brain's faction work's switch (#203), likewise. The joins have none. */
  setFactionWorkEnabled(enabled: boolean): void {
    writeFactionWorkEnabled(this.#store, enabled);
    this.#update();
  }

  /** Buying and installing augmentations' switch (#210), likewise: off calls a cycle under way off. */
  setAugmentationsEnabled(enabled: boolean): void {
    writeAugmentationsEnabled(this.#store, enabled);
    this.#update();
  }

  /** Destroying the BitNode's switch (#215), likewise: off, a destroy the brain asked for is withdrawn. */
  setWorldDaemonEnabled(enabled: boolean): void {
    writeWorldDaemonEnabled(this.#store, enabled);
    this.#update();
  }

  /** The stop at the BitNode's end's switch (#303), likewise: on, a BitNode already at its end stops the brain now. */
  setStopAtBitNodeEnd(setting: StopAtBitNodeEnd): void {
    writeStopAtBitNodeEnd(this.#store, setting);
    // Back to "play on" with the close asked for and not yet out (#303 review): called off, the brain stops alone.
    if (
      setting === "off" &&
      this.#bitNodeEnd.closeGameAsked() &&
      this.#closeGameSentAtMs === null &&
      !this.#closeGameWithdrawn
    ) {
      this.#closeGameWithdrawn = true;
      this.#log("closing the game: called off from the dashboard before it went out; the brain stops alone");
      this.#emit({ type: GAME_CLOSE_CALLED_OFF_EVENT_KIND, atMs: this.#lastEventAtMs ?? 0 });
    }
    this.#update();
  }

  /** What the dashboard shows of the stop at the BitNode's end (#303). */
  stopAtBitNodeEndView(): StopAtBitNodeEndView {
    return { setting: readStopAtBitNodeEnd(this.#store) };
  }

  /** Whether the brain has stopped at the BitNode's end (#303): main.ts's Ctrl+C then sets the switch back too. */
  stoppedAtBitNodeEnd(): boolean {
    return this.#bitNodeEnd.stopped();
  }

  /** Why the close of the game at the BitNode's end (#303) hasn't gone out, or null: its gate's, or not asked for. */
  closeGameWaitingFor(): string | null {
    if (!this.#bitNodeEnd.closeGameAsked()) return "not asked for";
    if (this.#closeGameSentAtMs !== null) return null;
    return this.intentsView().find((view) => view.id === CLOSE_GAME_INTENT.id)?.waitingFor ?? "not sent yet";
  }

  /**
   * Whether levelling mode's loop runs (#336's review): the state last sent levels with the hack loop on, and the threads
   * the fast snapshot shows of levelling mode's loops on home (the Agent's word, so checked).
   */
  #levelLoopRunning(): { sent: boolean; homeThreads: number } {
    const hackLoop = this.#desired?.hackLoop;
    const processes = this.#fastData?.game?.homeProcesses;
    let homeThreads = 0;
    for (const process of Array.isArray(processes) ? processes : []) {
      const { filename, threads } = process ?? {};
      if (typeof filename !== "string" || typeof threads !== "number" || !isHackLoopFile(filename)) continue;
      if (filename.endsWith(`/${LEVEL_LOOP_SCRIPT_NAME}`) || filename.endsWith(`/${LEVEL_GROW_SCRIPT_NAME}`)) {
        homeThreads += threads;
      }
    }
    // Levelling is only ever sent with the hack loop on (the protocol refuses it off).
    return { sent: hackLoop?.levelling != null, homeThreads };
  }

  /** The planner's levelling choice (#336): the candidates, the choice and the fitted factor. */
  levellingView(): LevellingView {
    return this.#levelling.view();
  }

  /** What the dashboard shows of the path to the World Daemon (#215), the levelling choice's lines with it (#336). */
  worldDaemonView(): WorldDaemonView {
    const owners = readManualIntents(this.#store).find((each) => each.action === "destroyBitNode");
    const daemon = this.#worldDaemon.view();
    const view = {
      ...daemon,
      lines: [...daemon.lines, ...this.#levelling.view().lines, ...this.#destroyEstimate.lines()],
    };
    // The owner's queued destroy goes instead (#321): the dashboard names the BitNode it enters.
    return owners?.action === "destroyBitNode"
      ? { ...view, ownersDestroy: true, nextBitNode: owners.args.nextBitNode, replay: null, skipped: null }
      : { ...view, ownersDestroy: false };
  }

  /** The travel for invitations (#228): the city group chosen, the travel, and the money held. */
  invitationsView(): InvitationView {
    return this.#invitations.view();
  }

  /** A step on the path stalled (#215), or null: the `worldDaemonStalled` alert's. */
  worldDaemonStall(): WorldDaemonStall | null {
    return this.#worldDaemon.stall();
  }

  /** Listens for the rules' events (#203, #210, #215, #228), to store them; returns a function that stops it. */
  subscribe(listener: (event: RuleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** What the dashboard shows of augmentations (#210). */
  augmentationsView(): AugmentationsView {
    return this.#augmentations.view();
  }

  /**
   * The money gang equipment leaves alone now (#330, `#gangEquipmentHold`), as the last update's plans have it: the
   * dashboard's figure behind the gang's "waiting for money above …", in any BitNode (only BN2's gang spends above it).
   */
  gangEquipmentHold(): GangMoneyHold {
    return this.#gangEquipmentHold();
  }

  /**
   * The money held back for augmentations (#210, the rule's `reserve()`): Infinity once an install is chosen; in the
   * install's countdown, what the counted purchases cost (#222); before it, that only for an install the count rule
   * would choose with `AUGMENTATION_RESERVE_LOOKAHEAD_MS` more income, else 0; Daedalus's $100b while it holds for its
   * invitation (#215). `#reserveForOtherPurchase` holds it back from cloud servers (#194) where it's more than the
   * program's or home RAM's.
   */
  augmentationReserve(): number {
    return this.#augmentations.reserve();
  }

  /** The purchases reported done that the faction state never showed queued (#210): `augmentationNotQueued`'s. */
  augmentationsNotQueued(): NotQueued[] {
    return this.#augmentations.notQueued();
  }

  /**
   * The install out when the Agent disconnected (or, for a restarted brain, when it went out), and since when, until a
   * slow snapshot shows the reset or the Agent connects again (#210): the `installNotRestarted` alert's. Or an install
   * reported done with no reset in the next slow snapshot (`doneNotReset`, #213 re-review), until a reset. Null with
   * neither.
   */
  installAwaitingRestart(): InstallAwaitingRestart | null {
    const notReset = this.#augmentations.installNotReset();
    if (notReset !== null) return { id: INSTALL_INTENT.id, sinceMs: notReset.atMs, doneNotReset: true };
    const sent = this.#resetSent;
    if (sent === null || sent.field !== "lastAugReset" || this.#installDisconnectedAtMs === null) return null;
    return { id: sent.id, sinceMs: this.#installDisconnectedAtMs };
  }

  /** Adds `request` (`{ action, args }`) to the manual queue, kept in the store, and sends it at once. */
  addManualIntent(request: unknown): AddedIntent {
    const parsed = parseIntentRequest(request);
    if (!parsed.ok) return parsed;
    // Only the switch closes the game (#303 review): queued, the Agent goes before reporting it done, so it stayed.
    if (parsed.message.action === "closeGame") {
      return {
        ok: false,
        reason:
          "closeGame isn't queued by hand: set the dashboard's \"The BitNode's end\" to \"Stop the brain and close the " +
          'game", which closes it once, then stops the brain',
      };
    }
    const queue = readManualIntents(this.#store);
    // Room for the purchase, the backdoor and the augmentation's (#210): a desired state over the protocol's limit
    // would be refused by the Agent.
    if (!queue.some((each) => each.id === parsed.message.id)) {
      if (queue.length >= MANUAL_QUEUE_LIMIT) {
        return { ok: false, reason: `the manual queue is full: ${MANUAL_QUEUE_LIMIT} intents at most` };
      }
      writeManualIntents(this.#store, [...queue, parsed.message]);
      this.#update();
    }
    return { ok: true, intent: parsed.message };
  }

  /**
   * The work the owner wants (#151, #153, #156, #158): `{ faction, workType }`, `{ kind: "company", company, field }`,
   * `{ kind: "crime", crime }` or `{ kind: "class", location, classType }`, kept in the store and sent at once, or null
   * to stop managing work (the game's work is then left as it is).
   */
  setWork(request: unknown): { ok: true } | { ok: false; reason: string } {
    const parsed = parseOwnersWork(request);
    if (!parsed.ok) return parsed;
    writeOwnersWork(this.#store, parsed.work);
    this.#update();
    return { ok: true };
  }

  /**
   * What the brain sends of the work, whose it is, and how the connected Agent last reported it: the owner's, or else
   * the brain's: Bladeburner's training at the gym (#367), or its faction work (#203).
   */
  workView(): WorkView {
    const owners = readOwnersWork(this.#store);
    const work =
      owners ??
      this.#bladeburnerWork ??
      (this.#factionWork === null ? null : { kind: "faction" as const, ...this.#factionWork });
    return {
      desired: work === null ? null : { ...work, focus: workFocus(work, this.#slowData) },
      source: owners !== null ? "owner" : work === null ? null : "brain",
      outcome: work === null ? null : reportedWorkOutcome(this.#fastData?.work),
    };
  }

  /** What the dashboard shows of the joins and the brain's faction work (#203). */
  factionsView(): FactionsView {
    // With the travel for invitations (#228 review): the travel, the hold, or why it waits.
    return { ...this.#factions.view(), invitations: this.#invitations.view() };
  }

  /** Where the gang stands (#325): the dashboard's line. */
  gangView(): GangView {
    return this.#gang.view();
  }

  /** Where Bladeburner stands (#367): the dashboard's line. */
  bladeburnerView(): BladeburnerView {
    return this.#bladeburner.view();
  }

  /** The gang's silent stalls (#354) past their bounds: the `gangStalled` alerts. */
  gangStalls(): GangStallStretch[] {
    return this.#gang.stalls();
  }

  /** The gang's plan earning no respect (#374): its pause, the rule's estimate and bound; null while it earns. */
  gangPause(): GangStallStretch | null {
    return this.#gang.earningPause();
  }

  /** The brain's faction work's watch (#203): its faction, its stall's window, its newest reading; or null. */
  factionWorkStall(): FactionWorkStall | null {
    return this.#factions.stall();
  }

  /** Takes the intent `id` off the manual queue; false if it isn't there. */
  cancelManualIntent(id: string): boolean {
    const queue = readManualIntents(this.#store);
    const kept = queue.filter((each) => each.id !== id);
    if (kept.length === queue.length) return false;
    writeManualIntents(this.#store, kept);
    this.#update();
    return true;
  }

  /**
   * The intents the brain wants done, in order: the manual queue (shown even before the Agent's snapshots, or without
   * an Agent, so it can be cancelled), then the purchase. Each with the connected Agent's outcome, if it has reported
   * one. While the brain holds, none of them goes out (the alerts say why).
   */
  intentsView(): IntentView[] {
    const outcomes = this.#reportedOutcomes();
    const manual = readManualIntents(this.#store);
    const fromRule = (intent: Intent | null) =>
      this.#desired !== null && intent && !manual.some((each) => each.id === intent.id) ? [intent] : [];
    const brainsResets = this.#queueWithBrainsResets().slice(manual.length);
    return [
      ...manual.map((intent) => ({ intent, source: "manual" as const })),
      ...brainsResets.map((intent) => ({
        intent,
        source:
          intent.action === "destroyBitNode"
            ? ("worldDaemon" as const)
            : intent.action === "closeGame"
              ? ("bitNodeEnd" as const)
              : ("augmentation" as const),
      })),
      ...fromRule(this.#purchase).map((intent) => ({ intent, source: "purchase" as const })),
      ...fromRule(this.#augmentationIntent).map((intent) => ({ intent, source: "augmentation" as const })),
      ...fromRule(this.#backdoor).map((intent) => ({ intent, source: "backdoor" as const })),
      ...fromRule(this.#join).map((intent) => ({ intent, source: "join" as const })),
      ...fromRule(this.#joinAlongside).map((intent) => ({ intent, source: "join" as const })),
      ...fromRule(this.#travel).map((intent) => ({ intent, source: "travel" as const })),
      ...fromRule(this.#gangIntent).map((intent) => ({ intent, source: "gang" as const })),
      ...fromRule(this.#bladeburnerIntent).map((intent) => ({ intent, source: "bladeburner" as const })),
      ...this.#bladeburnerSkillIntents.flatMap(fromRule).map((intent) => ({ intent, source: "bladeburner" as const })),
    ].map(({ intent, source }, index) => ({
      id: intent.id,
      source,
      outcome: outcomes.find((outcome) => outcome.id === intent.id) ?? null,
      waitingFor:
        source === "manual" && afterReset(manual, index)
          ? waitingForReset(manual.find(resetsTheGame) as Intent)
          : (this.#gates.waitingFor(intent.id) ?? this.#resetTimeAwaited(intent)),
    }));
  }

  /**
   * The owner's queue, then the brain's resets: its destroy (#215) unless the owner queued a destroy (theirs wins,
   * whatever BitNode it enters); then its install (#210) unless the owner queued one. Each waits behind the whole queue
   * (a reset's guard: nothing before it undone). The destroy goes before the install (#215 review): an install resets
   * the hacking level w0r1d_d43m0n needs, and drops its root. The gates judge it with the rules' irreversible intents
   * after it (`#judgedQueue`).
   */
  #queueWithBrainsResets(): Intent[] {
    const manual = readManualIntents(this.#store);
    const queue = [...manual];
    // The close of the game at the BitNode's end (#303), before the brain's resets: none goes after it.
    if (
      this.#bitNodeEnd.closeGameAsked() &&
      !this.#closeGameWithdrawn &&
      !manual.some((each) => each.id === CLOSE_GAME_INTENT.id)
    ) {
      queue.push(CLOSE_GAME_INTENT);
    }
    // The rule holds its ask until a slow snapshot shows the BitNode reset, so its reset note stays too.
    // Into the BitNode it was asked for (#321).
    const destroy = this.#worldDaemon.destroyIntent();
    if (this.#worldDaemonDestroy && destroy !== null && !manual.some((each) => each.action === "destroyBitNode")) {
      queue.push(destroy);
    }
    // Once sent, it stays while the cycle is committed, the snapshots gone with the Agent it killed (or a restarted
    // brain's not yet in), so its reset note does too, until a slow snapshot shows the reset.
    const sent = this.#augmentationsCommitted && this.#resetSent?.id === INSTALL_INTENT.id;
    if ((this.#augmentationInstall || sent) && !manual.some((each) => each.id === INSTALL_INTENT.id)) {
      queue.push(INSTALL_INTENT);
    }
    return queue;
  }

  /**
   * The rules' intents, in order, each only if the owner hasn't queued the same: the purchase, the augmentation purchase
   * (#210), the backdoor (#195), the join (#203) and the one beside it (#269 review), the travel for an invitation
   * (#228), the gang's forming (#325), the Bladeburner division's join (#367) and its skills (#379).
   */
  #ruleIntents(): Intent[] {
    const manual = readManualIntents(this.#store);
    const rules = [
      this.#purchase,
      this.#augmentationIntent,
      this.#backdoor,
      this.#join,
      this.#joinAlongside,
      this.#travel,
      this.#gangIntent,
      this.#bladeburnerIntent,
      ...this.#bladeburnerSkillIntents,
    ];
    return rules.filter((intent): intent is Intent => intent !== null && !manual.some((each) => each.id === intent.id));
  }

  /**
   * The intents the irreversible gate judges (R8, #147), in order: the owner's queue and the brain's resets
   * (`#queueWithBrainsResets`), then the rules' irreversible ones (#269: the brain's join of a city faction, #228), so
   * each waits for its guard and backup, one irreversible intent at a time, and after a reset queued before it.
   */
  #judgedQueue(): Intent[] {
    return [...this.#queueWithBrainsResets(), ...this.#ruleIntents().filter(isIrreversibleIntent)];
  }

  /** The done intents in the connected Agent's latest fast snapshot. */
  #doneIds(): Set<string> {
    return new Set(
      this.#reportedOutcomes()
        .filter((outcome) => outcome.done)
        .map((outcome) => outcome.id),
    );
  }

  #emit(event: RuleEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  /**
   * The connected Agent's intent outcomes, from its latest fast snapshot: only the well-formed, as it's its word. An
   * Agent from before backends (#145) names none: its backend is unknown (null).
   */
  #reportedOutcomes(): IntentOutcome[] {
    const outcomes: unknown[] = Array.isArray(this.#fastData?.intents) ? this.#fastData.intents : [];
    return outcomes
      .filter((outcome): outcome is IntentOutcome => {
        const fields = outcome as Partial<IntentOutcome> | null;
        return (
          typeof fields?.id === "string" &&
          typeof fields.done === "boolean" &&
          typeof fields.tries === "number" &&
          (fields.problem === null || typeof fields.problem === "string") &&
          (fields.backend === undefined ||
            fields.backend === null ||
            (EFFECTOR_BACKENDS as readonly string[]).includes(fields.backend))
        );
      })
      .map(({ id, done, tries, problem, backend }) => ({ id, done, tries, problem, backend: backend ?? null }));
  }

  /** Each of the hacker factions' servers due a backdoor, and since when (#195): the `backdoorOverdue` alert's. */
  backdoorsDue(): BackdoorDue[] {
    return this.#backdoors.due();
  }

  hackLoopView(): HackLoopView {
    const enabled = readHackLoopEnabled(this.#store);
    const hackLoop = this.#desired?.hackLoop;
    const hackThreadsOn = (hosts: string[]) => hackThreadsAddedUp(hackLoop?.hackThreads, hosts);
    const preparing = enabled ? (hackLoop?.preparing ?? null) : null;
    return {
      enabled,
      waiting: enabled && this.#desired === null,
      target: enabled ? (hackLoop?.target ?? null) : null,
      hosts: enabled ? (hackLoop?.hosts ?? []) : [],
      hackThreads: enabled ? hackThreadsOn(hackLoop?.hosts ?? []) : null,
      preparing: preparing === null ? null : { ...preparing, hackThreads: hackThreadsOn(preparing.hosts) },
      ...(enabled && hackLoop?.levelling ? { levelling: true } : {}),
    };
  }

  programsView(): ProgramsView {
    const enabled = readProgramsEnabled(this.#store);
    // Read from what was sent and what it was worked out from: either missing is waiting, never "all bought".
    const waiting = enabled && (this.#desired === null || this.#programsPlan === null);
    const purchase = this.#desired === null ? null : this.#purchase;
    return {
      enabled,
      waiting,
      owned: this.#programsPlan?.owned ?? [],
      buying:
        purchase?.action === "buyTor" ? "TOR router" : purchase?.action === "buyProgram" ? purchase.args.program : null,
      waitingFor: enabled && !waiting ? this.#waitingFor.programs : null,
    };
  }

  homeRamView(): HomeRamView {
    const enabled = readHomeRamEnabled(this.#store);
    const waiting = enabled && (this.#desired === null || this.#homeRamPlan === null);
    const purchase = this.#desired === null ? null : this.#purchase;
    return {
      enabled,
      waiting,
      ram: this.#homeRamPlan?.ram ?? null,
      upgradingTo: purchase?.action === "upgradeHomeRam" ? purchase.args.fromRam * 2 : null,
      waitingFor: enabled && !waiting ? this.#waitingFor.homeRam : null,
    };
  }

  cloudServersView(): CloudServersView {
    const enabled = readCloudServersEnabled(this.#store);
    const waiting = enabled && (this.#desired === null || this.#cloudServersPlan === null);
    const purchase = this.#desired === null ? null : this.#purchase;
    const buying =
      purchase?.action === "buyServer" || purchase?.action === "upgradeServer" ? this.#lastCloudPurchase : null;
    return {
      enabled,
      waiting,
      servers: this.#cloudServersPlan?.servers ?? [],
      buying:
        buying === null
          ? null
          : {
              action: buying.action,
              hostname: buying.hostname,
              ram: buying.ram,
              price: buying.price,
              paybackMs: buying.paybackMs,
            },
      waitingFor: enabled && !waiting ? this.#waitingFor.cloudServers : null,
      problem: this.#cloudServerProblem?.text ?? null,
    };
  }

  /**
   * Notes the first cloud purchase the connected Agent reports done with a problem (#194): bought under another name,
   * say, which the rule didn't ask for. Whether it noted one now.
   */
  #noteCloudServerProblem(): boolean {
    if (this.#cloudServerProblem !== null) return false;
    const outcome = this.#reportedOutcomes().find(
      ({ id, done, problem }) =>
        done &&
        problem !== null &&
        (id.startsWith("buyServer(") || id.startsWith("upgradeServer(")) &&
        !this.#seenCloudServerProblems.has(id),
    );
    if (outcome === undefined) return false;
    this.#cloudServerProblem = { id: outcome.id, text: `${outcome.id}: ${outcome.problem}` };
    return true;
  }

  /** The purchase to ask for now, as an intent: one at a time, cheapest first, among the activities switched on. */
  #choosePurchase(): Intent | null {
    const other = this.#chooseProgramOrHomeRam();
    const cloud = this.#chooseCloudServer(other);
    return other ?? cloud;
  }

  /**
   * The cloud purchase (#194), when nothing else (`other`) is bought: the plan, and why it waits. The plan is worked
   * out with the switch off too, for the dashboard's list of servers.
   */
  #chooseCloudServer(other: Intent | null): Intent | null {
    const enabled = readCloudServersEnabled(this.#store);
    if (this.#staticData === null || this.#mediumData === null) {
      // No Agent, or a new one's snapshots not in yet: the purchase in flight, if any, is chosen afresh.
      this.#cloudServersPlan = null;
      this.#waitingFor.cloudServers = null;
      this.#lastCloudPurchase = null;
      return null;
    }
    const income = this.#income.rate();
    const plan = chooseCloudServerPurchase({
      staticData: this.#staticData,
      mediumData: this.#mediumData,
      slowData: this.#slowData,
      income,
      reserve: this.#reserveForOtherPurchase(income?.perSecond ?? 0),
      previous: this.#lastCloudPurchase,
    });
    this.#cloudServersPlan = plan;
    this.#waitingFor.cloudServers = plan.waitingFor;
    let next = enabled ? plan.next : null;
    // An install chosen (#210): cloud servers are lost at it, so none is bought or upgraded until the reset.
    if (enabled && this.#augmentationsCommitted) {
      this.#waitingFor.cloudServers = "the install of augmentations chosen (cloud servers are lost at it)";
      next = null;
    }
    if (next !== null && !readHackLoopEnabled(this.#store)) {
      this.#waitingFor.cloudServers = "the hack loop, switched off: cloud servers only run it";
      next = null;
    }
    if (next !== null && this.#cloudServerProblem !== null) {
      this.#waitingFor.cloudServers = `you to look at ${this.#cloudServerProblem.text}, then turn cloud servers off and on again`;
      next = null;
    }
    if (next !== null && other !== null) {
      this.#waitingFor.cloudServers = `${describePurchase(other)} first`;
      next = null;
    }
    this.#lastCloudPurchase = next;
    if (next === null) return null;
    const args = { hostname: next.hostname, ram: next.ram };
    return next.action === "buyServer"
      ? { id: intentId("buyServer", args), action: "buyServer", args }
      : { id: intentId("upgradeServer", args), action: "upgradeServer", args };
  }

  /**
   * The money held back from cloud servers (#194): the price of the program or home RAM upgrade bought next (the
   * cheaper, among those switched on) while it waits for money, if the hack loop's income (`perSecond`) would cover
   * what's still short of it within `CLOUD_SERVER_RESERVE_HORIZON_MS`; else none. Or the augmentations' (#210), the
   * money of the set the money will cover within that horizon, where that's more. `leaveOutNearlyAffordable` (gang
   * equipment's, #330): without the program or home RAM, when it goes out this round, held at its price instead.
   */
  #reserveForOtherPurchase(perSecond: number, leaveOutNearlyAffordable = false): MoneyReserve | null {
    const waiting: MoneyReserve[] = [];
    const programs = this.#programsPlan;
    if (readProgramsEnabled(this.#store) && programs !== null && programs.price !== null) {
      const item = [TOR_ROUTER, ...PORT_OPENER_PROGRAMS].find((each) => !programs.owned.includes(each));
      waiting.push({ amount: programs.price, forWhat: item ?? "the next program" });
    }
    const homeRam = this.#homeRamPlan;
    if (readHomeRamEnabled(this.#store) && typeof homeRam?.price === "number" && homeRam.ram !== null) {
      waiting.push({ amount: homeRam.price, forWhat: `home RAM to ${homeRam.ram * 2} GB` });
    }
    const cheaper = waiting.sort((a, b) => a.amount - b.amount)[0];
    const money = this.#mediumData?.player?.money;
    const shortfall = (cheaper?.amount ?? 0) - (typeof money === "number" ? money : 0);
    const nearly = shortfall <= (perSecond * CLOUD_SERVER_RESERVE_HORIZON_MS) / 1000;
    const other = !leaveOutNearlyAffordable && cheaper !== undefined && nearly ? cheaper : null;
    const augmentations = this.#augmentations.reserve();
    const invitation = this.#invitations.hold();
    if (invitation > Math.max(augmentations, other?.amount ?? 0)) {
      return { amount: invitation, forWhat: "an invitation travelled for (#228)" };
    }
    return augmentations > (other?.amount ?? 0)
      ? { amount: augmentations, forWhat: "the augmentations to buy before the install" }
      : other;
  }

  /**
   * The money gang equipment leaves alone (G3, #330): it's the brain's last purchase. The most of every hold the brain
   * keeps for its other spending: what cloud servers leave alone (`#reserveForOtherPurchase`: the program or home RAM
   * upgrade a minute's income from its price, A6's augmentation reserve, Infinity once an install is chosen, an
   * invitation's money), and Daedalus's invitation's, the install countdown's and The Red Pill's donation's, as home
   * RAM keeps them. Then, on top, the price of this round's purchase (`#purchase`), and the cloud server that pays back
   * and waits for money (`awaitingMoney`): neither is starved.
   */
  #gangEquipmentHold(): GangMoneyHold {
    const purchase = this.#purchase;
    // A program or home RAM going out this round is the one the reserve holds (the cheaper, affordable): held once, at
    // its price, below (#330's re-review).
    const goingOut = purchase !== null && ["buyTor", "buyProgram", "upgradeHomeRam"].includes(purchase.action);
    const reserve = this.#reserveForOtherPurchase(this.#income.rate()?.perSecond ?? 0, goingOut);
    const reserves = [...(reserve === null ? [] : [reserve]), ...this.#homeRamHolds()];
    const purchases = gangPurchasesSpokenFor({
      purchase: purchase === null ? null : { intent: purchase, forWhat: describePurchase(purchase) },
      prices: {
        programs: this.#programsPlan?.price,
        homeRam: this.#homeRamPlan?.price,
        cloudServer: this.#cloudServersPlan?.next?.price,
      },
      cloud: {
        awaiting: this.#cloudServersPlan?.awaitingMoney,
        enabled: readCloudServersEnabled(this.#store),
        hackLoop: readHackLoopEnabled(this.#store),
        committed: this.#augmentationsCommitted,
        problem: this.#cloudServerProblem !== null,
      },
    });
    return gangMoneyHoldOf(reserves, purchases);
  }

  /** The countdown, or an install held for Daedalus's count (#243): the install's minutes off. */
  #countdownWords(): string {
    return this.#augmentations.countdownUnderWay()
      ? "the augmentations' install countdown"
      : "the augmentations' install, held for Daedalus's count";
  }

  /**
   * The holds home RAM buys above (the most of them): Daedalus's $100b for its invitation (#215 review), the install
   * countdown's money (#222), The Red Pill's donation's (#225 review) and an invitation's (#228). Gang equipment (#330)
   * keeps them too.
   */
  #homeRamHolds(): MoneyReserve[] {
    return [
      { amount: this.#augmentations.daedalusHold(), forWhat: "Daedalus's invitation" },
      { amount: this.#augmentations.countdownReserve(), forWhat: this.#countdownWords() },
      { amount: this.#augmentations.redPillHold(), forWhat: "The Red Pill's donation" },
      { amount: this.#invitations.hold(), forWhat: "an invitation travelled for" },
    ];
  }

  /** The next program or home RAM upgrade, as an intent: one at a time, cheapest first, among those switched on. */
  #chooseProgramOrHomeRam(): Intent | null {
    const programsEnabled = readProgramsEnabled(this.#store);
    const homeRamEnabled = readHomeRamEnabled(this.#store);
    const programsPlan = this.#mediumData === null ? null : chooseNextPurchase(this.#mediumData);
    const homeRamPlan = this.#mediumData === null ? null : chooseHomeRamUpgrade(this.#mediumData, this.#slowData);
    this.#programsPlan = programsPlan;
    this.#homeRamPlan = homeRamPlan;
    let programsNext = programsEnabled ? (programsPlan?.next ?? null) : null;
    let homeRamNext = homeRamEnabled ? (homeRamPlan?.next ?? null) : null;
    this.#waitingFor = {
      programs: programsPlan?.waitingFor ?? null,
      homeRam: homeRamPlan?.waitingFor ?? null,
      cloudServers: null,
    };
    // An install chosen (#210): programs are lost at it, and home's RAM is the augmentation rule's, after the set.
    if (this.#augmentationsCommitted) {
      const held = "the install of augmentations chosen (the augmentation rule buys for it)";
      this.#waitingFor = {
        programs: programsNext === null ? this.#waitingFor.programs : held,
        homeRam: homeRamNext === null ? this.#waitingFor.homeRam : held,
        cloudServers: null,
      };
      return null;
    }
    // Daedalus's $100b held for its invitation (#215 review), or the money the install's countdown holds (#222): home
    // RAM only with the money above it.
    const countdownHold = this.#augmentations.countdownReserve();
    const countdownWords = this.#countdownWords();
    // In the countdown, programs are bought no more: they're lost at the install, minutes off.
    if (countdownHold > 0 && programsNext !== null) {
      this.#waitingFor.programs = `${countdownWords} (programs are lost at the install)`;
      programsNext = null;
    }
    // And The Red Pill's donation's money (#225 review), and an invitation's money (#228), from programs
    // too.
    const redPillHold = this.#augmentations.redPillHold();
    const invitationHold = this.#invitations.hold();
    const { amount: hold, forWhat: heldFor } = this.#homeRamHolds().reduce((most, each) =>
      each.amount > most.amount ? each : most,
    );
    const playerMoney = this.#mediumData?.player?.money;
    const [programsHold, programsHeldFor] =
      redPillHold >= invitationHold
        ? [redPillHold, "The Red Pill's donation"]
        : [invitationHold, "an invitation travelled for"];
    if (
      programsNext !== null &&
      programsHold > 0 &&
      (typeof playerMoney === "number" ? playerMoney : 0) - (programsPlan?.price ?? 0) < programsHold
    ) {
      this.#waitingFor.programs = `money above the $${Math.round(programsHold).toLocaleString("en-US")} held for ${programsHeldFor}`;
      programsNext = null;
    }
    if (
      homeRamNext !== null &&
      hold > 0 &&
      (typeof playerMoney === "number" ? playerMoney : 0) - (homeRamPlan?.price ?? 0) < hold
    ) {
      this.#waitingFor.homeRam = `money above the $${Math.round(hold).toLocaleString("en-US")} held for ${heldFor}`;
      homeRamNext = null;
    }
    // Until the slow snapshot says which BitNode, the upgrade's price isn't known, so neither is which goes first.
    if (programsNext !== null && homeRamEnabled && this.#slowData === null) {
      this.#waitingFor.programs = "the Agent's slow snapshot (which BitNode), to compare with home RAM";
      programsNext = null;
    }
    if (programsNext !== null && homeRamNext !== null) {
      // Both plans have a price when they have a next item.
      if ((homeRamPlan?.price ?? 0) < (programsPlan?.price ?? 0)) {
        this.#waitingFor.programs = `home RAM to ${homeRamNext.fromRam * 2} GB first (cheaper)`;
        programsNext = null;
      } else {
        this.#waitingFor.homeRam = `${programsNext.item} first (cheaper)`;
        homeRamNext = null;
      }
    }
    if (programsNext?.vendor) {
      const args = { vendor: programsNext.vendor };
      return { id: intentId("buyTor", args), action: "buyTor", args };
    }
    if (programsNext) {
      const args = { program: programsNext.item };
      return { id: intentId("buyProgram", args), action: "buyProgram", args };
    }
    if (homeRamNext) {
      const args = { fromRam: homeRamNext.fromRam, vendor: homeRamNext.vendor };
      return { id: intentId("upgradeHomeRam", args), action: "upgradeHomeRam", args };
    }
    return null;
  }

  /**
   * A slow snapshot showing the game reset since the intent that resets it was sent (#164, #175): it's done, and leaves
   * the queue. Its reset time moves only with a reset or another save loaded. Any other value counts, not just a later
   * one: it comes from the clock, which can be set back (#167).
   */
  #dropResetIntentOnceReset(): void {
    const sent = this.#resetSent;
    if (sent === null) return;
    const resetAt = resetTimeOf(this.#slowData, sent.field);
    if (resetAt === null || resetAt === sent.resetAt) return;
    this.#noteResetSent(null);
    writeManualIntents(
      this.#store,
      readManualIntents(this.#store).filter((each) => each.id !== sent.id),
    );
  }

  /**
   * Why `intent`, one that resets the game, isn't sent though its gate let it, or null (#175 review): its done check
   * needs the connected Agent's reset time from before it, so it waits for a slow snapshot that says it. Sent without
   * one, a reset seen first in the next game's snapshot would be no change: the intent would stay queued, and a destroy
   * would wait in the next BitNode for its requirements, then destroy that one too.
   */
  #resetTimeAwaited(intent: Intent | undefined): string | null {
    if (intent === undefined || !resetsTheGame(intent)) return null;
    if (resetTimeOf(this.#slowData, resetFieldOf(intent)) !== null) return null;
    return "waiting for the Agent's slow snapshot (the game's last reset), to see the reset when it comes";
  }

  /**
   * The BitNode's hacking multipliers for the hack loop's and the batcher's player (#321, `bitNodeHackingOf`), from the
   * slow snapshot's BitNode. Before one says it, BN1's, logged once (`HACKING_MULTIPLIERS_UNREAD`); a BitNode core has
   * none for, BN1's too, which its `bitNodeAssumptions` line says.
   */
  #hackingMultipliers(): BitNodeHackingMultipliers {
    const currentNode = this.#slowData?.resetInfo?.currentNode;
    const { multipliers } = bitNodeHackingOf(currentNode);
    if (currentNode === undefined && !this.#hackingUnreadLogged) this.#log(HACKING_MULTIPLIERS_UNREAD);
    this.#hackingUnreadLogged = currentNode === undefined;
    return multipliers;
  }

  /**
   * What the brain takes as BN1's in the BitNode the slow snapshot shows (#321, core's `bitNodeAssumptions`): a line
   * each, once per BitNode this brain sees, the known risks of playing it with BN1's rules. None in BN1, BN2, BN4 or BN5.
   */
  #logBitNodeAssumptions(): void {
    const currentNode = this.#slowData?.resetInfo?.currentNode;
    if (!isBitNodeNumber(currentNode) || currentNode === this.#assumptionsLoggedFor) return;
    this.#assumptionsLoggedFor = currentNode;
    for (const assumption of bitNodeAssumptions(currentNode)) {
      this.#log(`in BitNode ${currentNode}, taken as BN1's: ${assumption}`);
    }
  }

  /** The note, here and in the store, written only when it changes. */
  #noteResetSent(note: ResetSentNote | null): void {
    if (JSON.stringify(note) === JSON.stringify(this.#resetSent)) return;
    this.#resetSent = note;
    writeResetSentNote(this.#store, note);
    if (note === null) this.#installDisconnectedAtMs = null;
    // A destroy going out (#215): stored, for the run report.
    if (note?.field === "lastNodeReset") {
      const manual = readManualIntents(this.#store).find((each) => each.id === note.id);
      // The brain's, into the BitNode it was asked for (#321).
      const destroy = manual ?? this.#worldDaemon.destroyIntent();
      if (destroy?.action !== "destroyBitNode") {
        this.#log(`a destroy went out (${note.id}) that's neither yours nor the brain's: not stored as sent`);
        return;
      }
      const nextBitNode = destroy.args.nextBitNode;
      this.#emit({
        type: BITNODE_DESTROY_SENT_EVENT_KIND,
        atMs: this.#lastEventAtMs ?? 0,
        source: manual === undefined ? "brain" : "manual",
        nextBitNode,
        // With nothing playable left in the order to gain, into BitNode 1 (#311, #321): said in the run report.
        replay: replayOf(this.#slowData?.resetInfo, nextBitNode),
        // The BitNodes the order skipped on the way to it (#323): said in the run report; the brain's order's, so
        // never on the owner's destroy, though into the same BitNode.
        skipped: manual === undefined ? skippedOf(this.#slowData?.resetInfo, nextBitNode) : null,
      });
    }
    // An install going out (#210): stored, so the run report can look for the reset after it.
    if (note?.field === "lastAugReset") {
      this.#emit({
        type: AUGMENTATION_INSTALL_SENT_EVENT_KIND,
        atMs: this.#lastEventAtMs ?? 0,
        source: readManualIntents(this.#store).some((each) => each.id === note.id) ? "manual" : "brain",
        queued: this.#augmentations.queued(),
      });
    }
  }

  /**
   * The close of the game (#303) withdrawn once the Agent reports it tried enough (`closeGameTriedEnough`): never a
   * loop of saves and closes. Whether it was withdrawn now.
   */
  #noteCloseGameTries(): boolean {
    if (this.#closeGameWithdrawn || !this.#bitNodeEnd.closeGameAsked()) return false;
    const outcome = this.#reportedOutcomes().find((each) => each.id === CLOSE_GAME_INTENT.id);
    if (outcome === undefined || outcome.tries <= this.#closeGameTries) return false;
    // A try reported: the game didn't close then. Stored, so main.ts waits afresh for the next.
    this.#closeGameTries = outcome.tries;
    this.#log(`closing the game: try ${outcome.tries} of ${CLOSE_GAME_MOST_TRIES} reported: ${outcome.problem}`);
    this.#emit({
      type: GAME_CLOSE_TRIED_EVENT_KIND,
      atMs: this.#lastEventAtMs ?? 0,
      tries: outcome.tries,
      problem: outcome.problem,
    });
    if (!closeGameTriedEnough(outcome)) return false;
    this.#closeGameWithdrawn = true;
    this.#log(
      `closing the game: withdrawn after ${outcome.tries} ${outcome.tries === 1 ? "try" : "tries"}: ${outcome.problem}`,
    );
    return true;
  }

  /**
   * A close in the desired state sent when the Agent went (#303 review): the brain's withdrawn, and one in the manual
   * queue (the queue refuses it, but a store written before may hold one) dropped, so a game closed is never closed
   * again as it starts.
   */
  #dropCloseGameSent(): void {
    if (!this.#desired?.intents.some((each) => each.id === CLOSE_GAME_INTENT.id)) return;
    if (this.#bitNodeEnd.closeGameAsked() && !this.#closeGameWithdrawn) {
      this.#closeGameWithdrawn = true;
      this.#log("closing the game: the Agent went after it went out; not sent again");
    }
    const queue = readManualIntents(this.#store);
    const kept = queue.filter((each) => each.id !== CLOSE_GAME_INTENT.id);
    if (kept.length !== queue.length) writeManualIntents(this.#store, kept);
  }

  /** Takes off the manual queue what the connected Agent reports done (a close tried enough); whether it took any. */
  #dropDoneManualIntents(): boolean {
    // Your close of the game (#303) too, once tried enough: never done by the game's word, and never a loop of saves.
    const doneIds = new Set(
      this.#reportedOutcomes()
        .filter((outcome) => outcome.done || (outcome.id === CLOSE_GAME_INTENT.id && closeGameTriedEnough(outcome)))
        .map((outcome) => outcome.id),
    );
    const queue = readManualIntents(this.#store);
    const notDone = queue.filter((each) => !doneIds.has(each.id));
    if (notDone.length === queue.length) return false;
    writeManualIntents(this.#store, notDone);
    return true;
  }

  /**
   * The hack loop as planned, and the batcher with its switch on (#205) on all the hack loop's hosts, which the hack
   * loop then leaves (it still roots), with the brain's own target (#206, `chooseBatcher`). The mode switch, from the
   * RAM: the batcher when a host holds it and a plan on the hosts' RAM earns; otherwise (the switch off, or no batcher
   * to plan, the reason kept for the dashboard) the hack loop as planned. Logged when it changes, and when the target
   * or the next target does. With faction work going on (`factionWorking`, from the work sent and the Agent's word) and
   * sharing's switch on, the batcher's config asks it to share (#224); so it starts or stops at the next update after
   * the work's outcome changes, a medium snapshot at most. Home is one of its hosts too (#340), for its RAM beyond what
   * it keeps for the Agent, unless `BATCHER_ON_HOME_SETTING` is off.
   */
  #withBatcher(
    hackLoop: DesiredState["hackLoop"],
    factionWorking: boolean,
    levelling: LevellingPlan["levelling"] = null,
  ): Pick<DesiredState, "hackLoop" | "batcher"> {
    const result = this.#chooseMode(hackLoop, factionWorking, levelling);
    const sent = result.batcher;
    const mode =
      levelling !== null
        ? `batcher: not sent, levelling mode on ${levelling.target} has its hosts (#336)`
        : sent === undefined || sent === null
          ? `batcher: the hack loop hacks${this.#batcherWhy === null ? "" : `, not the batcher: ${this.#batcherWhy}`}`
          : `batcher: batches ${sent.config.target}` +
            (sent.config.next === undefined ? "" : `, preparing ${sent.config.next.target} next`) +
            (sent.config.sharing === undefined ? "" : ", sharing its spare RAM") +
            (this.#homeSharesInstead ? ", home sharing rather than batching (#340's placeholder)" : "");
    if (mode !== this.#batcherMode) {
      // Not before the switch is first on: the hack loop is the default's mode then.
      if (this.#batcherMode !== null || (sent !== undefined && sent !== null)) this.#log(mode);
      this.#batcherMode = mode;
    }
    return result;
  }

  /**
   * What home keeps beside `homeKeptGbOf` for the batches, the share and levelling mode (#377's review): Bladeburner's
   * reading worker's `BLADEBURNER_WORKER_RAM_GB` while the rule asks for it (in the division, the RAM gate open: the
   * gate counts home's RAM beyond `homeKeptGbOf` alone, so this doesn't close it), else nothing; and (#381's review)
   * the skills' worker's `BLADEBURNER_SKILL_WORKER_RAM_GB` while the rule has skills to buy.
   */
  #homeAlsoKeptGb(): number {
    const reading = this.#bladeburnerState === null ? 0 : BLADEBURNER_WORKER_RAM_GB;
    return reading + (this.#bladeburnerSkillIntents.length > 0 ? BLADEBURNER_SKILL_WORKER_RAM_GB : 0);
  }

  #chooseMode(
    hackLoop: DesiredState["hackLoop"],
    factionWorking: boolean,
    levelling: LevellingPlan["levelling"],
  ): Pick<DesiredState, "hackLoop" | "batcher"> {
    this.#batcherWhy = null;
    this.#homeSharesInstead = false;
    this.#shareWhy = "the batcher isn't sent";
    // Levelling mode (#336): the level loop on the batcher's hosts and home's RAM beyond what it keeps, no batcher.
    if (levelling !== null) {
      this.#batcherWhy = `levelling mode on ${levelling.target} has its hosts (#336)`;
      return {
        hackLoop: {
          enabled: true,
          target: levelling.target,
          hosts: levelling.hosts,
          levelling: { homeKeptGb: levelling.homeKeptGb, operation: levelling.operation },
        },
      };
    }
    if (!readBatcherEnabled(this.#store) || this.#staticData === null || this.#mediumData === null) return { hackLoop };
    if (hackLoop.target === null) {
      this.#batcherWhy = "no target yet";
      return { hackLoop };
    }
    const hosts = batcherHostsOf(hackLoop);
    // Where it runs now, kept while it still fits (#211), so a larger host doesn't restart it; the target it batches,
    // kept unless another is worth the move (#206). Recovering from a desync it batches on in place, its hacks back as
    // soon as the target is (#315): still the one batched. Read as nothing batched, on 2026-11-08 a desync on
    // clarkinc, its preparation then counted against the 5 minutes a start may idle, sent the batcher to
    // rho-construction and back.
    const health = this.#batcherHealth();
    const batching = health?.state === "batching" || health?.state === "recovering" ? health.target : null;
    // Home among the hosts (#340), for its RAM beyond what it keeps for the Agent and its workers: the one reserve
    // the share and levelling mode keep (`homeKeptGbOf`), with Singularity its largest worker's too.
    const homeKeptGb = readBatcherOnHome(this.#store)
      ? homeKeptGbOf(singularityRamMultiplierOf(this.#slowData)) + this.#homeAlsoKeptGb()
      : null;
    const chooseOn = (kept: number | null) =>
      chooseBatcher(
        this.#staticData as StaticSnapshotData,
        this.#mediumData as MediumSnapshotData,
        this.#hackingMultipliers(),
        hosts,
        this.#desired?.batcher ?? null,
        batching,
        kept,
      );
    let planned = chooseOn(homeKeptGb);
    // While sharing is asked (#340's review), home batches only if the batches gain more with it than the share would
    // on it: `homeBatchesWhileSharing`, a placeholder until the planner splits home's RAM (owner decision 67).
    const sharingAsked = factionWorking && readShareEnabled(this.#store);
    const onHome = planned.batcher?.config.hosts.includes("home") === true;
    if (sharingAsked && onHome && planned.batcher !== null && homeKeptGb !== null) {
      const { runOn, config } = planned.batcher;
      const planOn = (kept: number | null) =>
        planBatcher(
          this.#staticData as StaticSnapshotData,
          this.#mediumData as MediumSnapshotData,
          this.#hackingMultipliers(),
          config.target,
          hosts,
          runOn,
          1,
          kept,
        );
      const withHome = planOn(homeKeptGb);
      const withoutHome = planOn(null);
      const home = this.#mediumData.servers.find((server) => server?.hostname === "home");
      const intelligence = (this.#mediumData.player as { skills?: { intelligence?: unknown } }).skills?.intelligence;
      const choice = homeBatchesWhileSharing({
        withHomeIncomePerSecond: withHome.batcher === null ? 0 : withHome.incomePerSecond,
        withoutHomeIncomePerSecond: withoutHome.batcher === null ? 0 : withoutHome.incomePerSecond,
        homeShareGb: (home?.maxRam ?? 0) - homeKeptGb - (runOn === "home" ? BATCHER_RAM_BUDGET_GB : 0),
        homeCores: typeof home?.cpuCores === "number" ? home.cpuCores : 1,
        intelligence: typeof intelligence === "number" ? intelligence : 0,
      });
      const without = choice.batches ? null : chooseOn(null);
      if (without?.batcher) {
        planned = without;
        this.#homeSharesInstead = true;
      }
    }
    if (planned.batcher === null) {
      this.#batcherWhy = planned.why;
      return { hackLoop };
    }
    // Sharing its spare RAM (#224), while the player works for a faction, the brain's work or the owner's.
    const sharingConfig = factionWorking
      ? sharingConfigOf(
          planned.batcher.config,
          this.#mediumData,
          this.#hackingMultipliers(),
          singularityRamMultiplierOf(this.#slowData),
          this.#homeAlsoKeptGb(),
        )
      : null;
    const sharing = readShareEnabled(this.#store) ? sharingConfig : null;
    this.#shareWhy = !factionWorking
      ? "no faction work going on"
      : sharingConfig === null
        ? "the medium snapshot has no hacking figures for the player"
        : null;
    const batcher =
      sharing === null ? planned.batcher : { ...planned.batcher, config: { ...planned.batcher.config, sharing } };
    return { hackLoop: { enabled: true, target: hackLoop.target, hosts: [] }, batcher };
  }

  /**
   * An install under way (#228 review): A6 committed to one, or counting down to it. Either way it puts the player back
   * in Sector-12 and drops every faction within minutes, so the travel for invitations stands down (but for a tech
   * vendor). The purchases stand down at the commit alone (`#augmentationsCommitted`): in the countdown, the money held
   * keeps them in check. Not an install held for Daedalus's count (#243 review): the travel is there for the count.
   */
  #installUnderWay(): boolean {
    return this.#augmentationsCommitted || this.#augmentations.countdownUnderWay();
  }

  /** What the travel for invitations (#228) reads of the snapshots, or null where they don't say it all. */
  #invitationInputs(): InvitationInputs | null {
    const slow = this.#slowData;
    const player = this.#mediumData?.player as
      | { skills?: { hacking?: unknown }; money?: unknown; city?: unknown }
      | undefined;
    const state = slow === null ? null : (factionReadingOf(slow)?.state ?? null);
    const resetInfo = slow === null ? null : resetInfoOf(slow);
    const hacking = player?.skills?.hacking;
    const money = player?.money;
    const city = player?.city;
    const lastAugReset = slow?.resetInfo?.lastAugReset;
    if (state === null || resetInfo === null || typeof city !== "string") return null;
    if (typeof lastAugReset !== "number" || !Number.isFinite(lastAugReset)) return null;
    if (typeof hacking !== "number" || !Number.isFinite(hacking)) return null;
    if (typeof money !== "number" || !Number.isFinite(money)) return null;
    try {
      return {
        state,
        // Never short with The Red Pill at the gang's faction (#335's review): no travel for Daedalus's count.
        count: countOf(state, resetInfo, gangSellsRedPill(this.#gangShop?.name ?? null, resetInfo.currentNode)),
        currentNode: resetInfo.currentNode,
        lastAugReset,
        installed: resetInfo.ownedAugs,
        // The owner's queued joins of city factions (#228 review): one fixes the city group.
        ownersJoins: readManualIntents(this.#store).flatMap((each) =>
          each.action === "joinFaction" && FACTION_ENEMIES[each.args.faction] !== undefined ? [each.args.faction] : [],
        ),
        hackingLevel: hacking,
        money,
        city,
      };
    } catch {
      // A BitNode core doesn't know (another game version): nothing asked or held.
      return null;
    }
  }

  /**
   * BN2 before the gang (#357's (1)): avmnite-02h's required level (its roll, the connected Agent's static snapshot)
   * while the gang rule reads no gang in BN2 (none formed, a gang faction joined or not), or one formed whose faction no
   * slow snapshot shows yet; null otherwise.
   */
  #gangFormingInputs(): { required: number; unread: boolean } | null {
    const stage = this.#gang.view().stage;
    // Unread with no gang known (#368's review: no reading yet, a worker's problem, a brain just restarted): the gang's
    // route too, installing now held, as #343's install now would otherwise go before a gang there may be.
    const unread = stage === "waiting" && this.#gang.gangUnread();
    // Formed, its faction not in a slow snapshot yet (one a minute): still the gang's route, not Daedalus's count, which
    // the faction's shop ends (`gangSellsRedPill`). Else #343's install now could go in that minute (#363's seed 5).
    const forming =
      unread || stage === "noFaction" || stage === "forming" || (stage === "managed" && this.#gangShop === null);
    if (bitNodeOfSlow(this.#slowSnapshot) !== GANG_BITNODE || !forming) return null;
    const required = this.#staticData?.servers.find(
      (server) => server?.hostname === GANG_ROUTE_SERVER,
    )?.requiredHackingSkill;
    return typeof required === "number" && Number.isFinite(required) ? { required, unread } : null;
  }

  #update(): void {
    const hackLoopEnabled = readHackLoopEnabled(this.#store);
    // The gang (#325) first: its faction, once formed, is left out of what the other rules see as joined.
    // The Red Pill reported bought, not yet shown queued (A6's queue as of its last update): the objective's money (#357).
    const gang = this.#gang.update({
      mediumData: this.#mediumData,
      slowData: this.#slowSnapshot,
      nowMs: this.#lastEventAtMs,
      redPillBought: this.#augmentations.queued().includes(THE_RED_PILL),
      mediumAtMs: this.#mediumAtMs,
    });
    this.#gangIntent = gang.intent;
    this.#gangState = gang.gang;
    this.#slowData = withoutGangFaction(this.#slowSnapshot, this.#gang.hiddenFactions());
    // Bladeburner (#367) in BN6 and BN7: the training to join, sent as the brain's work ahead of A5's, the join, and
    // the worker's state, run only in home's RAM beyond what it keeps for the Agent and its workers.
    const bladeburner = this.#bladeburner.update({
      mediumData: this.#mediumData,
      slowData: this.#slowSnapshot,
      homeKeptGb: homeKeptGbOf(singularityRamMultiplierOf(this.#slowSnapshot)),
      ownersWork: readOwnersWork(this.#store) !== null,
      nowMs: this.#lastEventAtMs,
    });
    this.#bladeburnerIntent = bladeburner.intent;
    this.#bladeburnerSkillIntents = bladeburner.skillIntents;
    this.#bladeburnerState = bladeburner.state;
    this.#bladeburnerWork = bladeburner.work;
    // The gang's faction's shop (#334), apart: A6 buys there, and A8's The Red Pill is sold there in BN2.
    const gangShop = gangShopOf(this.#slowSnapshot, this.#gang.gangFaction());
    // The same for the invitations' count (#335's re-review), which reads it from `#invitationInputs`.
    this.#gangShop = gangShop;
    // The bonus of the share threads the batcher reports running (#224): A5's rate and ETA, The Red Pill's, and since
    // #345 A6's estimates by work. Not from a health gone stale, or a batcher reported not running (#226's review).
    const shareBonus = shareBonusOf(
      this.#batcherHealth(),
      this.#fastGameTimeMs,
      batcherNotRunning(this.#fastData?.batcherDeploy) !== null,
    );
    // Augmentations and the reset (#210) first: an install chosen holds the programs back.
    const augmentations = this.#augmentations.update({
      mediumData: this.#mediumData,
      mediumGameTimeMs: this.#mediumGameTimeMs,
      slowData: this.#slowData,
      slowGameTimeMs: this.#slowGameTimeMs,
      doneIds: this.#doneIds(),
      fastGameTimeMs: this.#fastGameTimeMs,
      nowMs: this.#lastEventAtMs,
      enabled: readAugmentationsEnabled(this.#store),
      homeRamEnabled: readHomeRamEnabled(this.#store),
      // The destroy wanted once The Red Pill is installed (#215 review): ordinary installs held for it. With nothing
      // left in the campaign's order to gain too: a replay (#311, #321).
      destroyWanted: readWorldDaemonEnabled(this.#store),
      // Who works for a faction while an install is held for Daedalus's count (#243 review): A5 under the hold.
      holdWork: { owners: readOwnersWork(this.#store), brainWorks: readFactionWorkEnabled(this.#store) },
      gangShop,
      gangUnread: this.#gang.gangUnread(),
      // The planner's levelling choice (#336), as of the last update: NeuroFlux Governor's levels and an install.
      levellingInstall: this.#levelling.mode() === "install",
      // #228's invitation hold, as of the invitations rule's last update (#343: installing now held meanwhile).
      invitationHold: this.#invitations.hold(),
      shareBonus,
      // BN2 before the gang (#357's (1)): avmnite-02h's level, while the gang rule reads none.
      gangForming: this.#gangFormingInputs(),
      // With the gang (#357's (3)): p and the plan's respect a cycle, as the gang rule's managed decision has them.
      gangInstall: this.#gang.installFigures(),
    });
    this.#augmentationIntent = augmentations.intent;
    this.#augmentationInstall = augmentations.install;
    this.#augmentationsCommitted = augmentations.committed;
    // The World Daemon (#215): the destroy once w0r1d_d43m0n is ready, through the gate after the install.
    this.#worldDaemonDestroy = this.#worldDaemon.update({
      staticData: this.#staticData,
      mediumData: this.#mediumData,
      mediumGameTimeMs: this.#mediumGameTimeMs,
      slowData: this.#slowData,
      nowMs: this.#lastEventAtMs,
      enabled: readWorldDaemonEnabled(this.#store),
      shareBonus,
      // The reach counts the city group the brain chose (#228 review): the last update's choice.
      cityGroup: this.#invitations.chosenGroup(resetTimeOf(this.#slowData, "lastAugReset")),
      // A6's commit's facts while short (#238): an install that added none to the count is judged on them.
      countFacts: this.#augmentations.countFacts(),
      augmentationsInstalling: this.#augmentations.installAskedFor(),
      // The Red Pill's seller in BN2 with a gang (#334), and the game's time for its rate.
      gangShop,
      slowGameTimeMs: this.#slowGameTimeMs,
      // A6 holding installs for it there (#335's review): the reputation not rising is then loud; while the gang's plan
      // earns no respect, past the plan's own bound (#374).
      redPillHeldAtGang: this.#augmentations.redPillHeldAtGang(),
      gangPause: this.#gang.earningPause(),
    });
    // The planner's levelling choice (#336), on A8's path as it now reads, and A6's offer of NeuroFlux Governor levels.
    const batcherConfig = this.#desired?.batcher?.config ?? null;
    this.#levellingPlan = this.#levelling.update({
      path: this.#worldDaemon.view().path,
      enabled: readWorldDaemonEnabled(this.#store),
      staticData: this.#staticData,
      mediumData: this.#mediumData,
      mediumGameTimeMs: this.#mediumGameTimeMs,
      slowData: this.#slowData,
      // The BitNode's, unlogged here: the hack loop's and the batcher's plans log what's taken as BN1's (#321).
      hacking: bitNodeHackingOf(this.#slowData?.resetInfo?.currentNode).multipliers,
      neuroFluxLevels: this.#augmentations.neuroFluxOffer(),
      // And (#355) its set that adds to levelling.
      installAugmentations: this.#augmentations.installAugmentationsOffer(),
      installCommitted: augmentations.committed,
      batcherTarget: batcherConfig === null ? null : { hostname: batcherConfig.target, figures: batcherConfig.figures },
      levelLoop: this.#levelLoopRunning(),
      nowMs: this.#lastEventAtMs,
      homeAlsoKeptGb: this.#homeAlsoKeptGb(),
      // (d) (#380): A6's ladder and set (none where a test's A/B turns (d) off).
      batchOffer: this.#levellingBatch ? this.#augmentations.batchOffer() : null,
    });
    // The travel for invitations (#228), before the purchases: its hold keeps their money.
    this.#travel = this.#invitations.update({
      inputs: this.#invitationInputs(),
      stood:
        readOwnersWork(this.#store) !== null
          ? "your work on the dashboard (it may be in a city)"
          : this.#bladeburner.training()
            ? "Bladeburner's combat training at the gym (#367)"
            : readManualIntents(this.#store).some((each) => each.action === "travel")
              ? "your travel in the queue"
              : !readAugmentationsEnabled(this.#store)
                ? "the Augmentations switch, off"
                : null,
      // An install chosen, or counting down: it puts the player back in Sector-12 and drops every faction.
      beforeInstall: this.#installUnderWay(),
      nowMs: this.#lastEventAtMs,
    });
    this.#purchase = this.#choosePurchase();
    // Gang equipment (G3, #330), the last purchase: from the money above every hold, this round's purchase and the
    // cloud server waiting for money (`#gangEquipmentHold`).
    const playerMoney = this.#mediumData?.player?.money;
    this.#gangState = this.#gang.equip({
      money: typeof playerMoney === "number" ? playerMoney : null,
      hold: this.#gangEquipmentHold(),
    });
    this.#backdoor = this.#backdoors.intent({
      staticData: this.#staticData,
      mediumData: this.#mediumData,
      mediumAtMs: this.#mediumAtMs,
      resetAt: resetTimeOf(this.#slowData, "lastAugReset"),
      doneIds: this.#doneIds(),
    });
    // The joins and the brain's faction work (#203): its work only with no owner's work and the switch on.
    const factions = this.#factions.update({
      mediumData: this.#mediumData,
      slowData: this.#slowData,
      slowAtMs: this.#slowAtMs,
      nowMs: this.#lastEventAtMs,
      ownersWork: readOwnersWork(this.#store) !== null,
      // Bladeburner's training (#367) goes as the brain's work ahead of A5's; its actions (#375) hold A5's work, which
      // would stop them (`Bladeburner/Bladeburner.ts:1356-1368`).
      heldFor: this.#bladeburner.training()
        ? "Bladeburner's combat training at the gym (#367)"
        : this.#bladeburner.acting()
          ? BLADEBURNER_ACTIONS_HOLD
          : null,
      enabled: readFactionWorkEnabled(this.#store),
      augmentationsEnabled: readAugmentationsEnabled(this.#store),
      shareBonus,
      // Owner decision 54 (#228): the city factions of the group the brain chose, and none of another's.
      cityFactions: this.#invitations.cityFactions(),
      cityGroup: this.#invitations.view().cityGroup,
      // An install held for Daedalus's count by work (#243 review): its augmentation's seller, worked for first.
      countHoldTarget: this.#augmentations.countHoldTarget(),
      // The gang's faction's shop (#335's review): what its reputation reaches isn't worked for.
      gangShop,
    });
    this.#join = factions.join;
    this.#joinAlongside = factions.joinAlongside;
    this.#factionWork = factions.work;
    // The time to the destroy (#360), after A5's choice (the hold's ETA) and levelling's (the level's); in BN2 (#357's
    // slice 3) after the gang rule's and A6's: the gang formed, the planner's τ_g or (3)'s estimate, the plan's pause.
    const factionsView = this.#factions.view();
    this.#destroyEstimate.update({
      slowData: this.#slowData,
      slowGameTimeMs: this.#slowGameTimeMs,
      slowAtMs: this.#slowAtMs,
      factionChoice: factionsView.sent ? factionsView.choice : null,
      levelling: this.#levelling.view(),
      nowMs: this.#lastEventAtMs,
      gang: {
        formed: this.#gang.view().stage === "managed",
        unread: this.#gang.gangUnread(),
        // Its cycle too: A6 keeps the last cycle's view on its early returns (#378's review).
        timing: this.#augmentations.view().progress?.timing ?? null,
        timingLastAugReset: this.#augmentations.view().progress?.lastAugReset ?? null,
        pause: this.#gang.earningPause(),
      },
    });
    // The owner's queue and the brain's resets first, then the rules' intents (`#ruleIntents`, in its order). The
    // purchases before the backdoor: a `buy` never waits for its terminal action.
    const manual = readManualIntents(this.#store);
    const queueWithBrainsResets = this.#queueWithBrainsResets();
    const ruleIntents = this.#ruleIntents();
    // An irreversible intent goes once its gate lets it, and nothing queued after a reset's intent before it's done:
    // the rules' irreversible ones too (#269: the brain's join of a city faction, #228), judged after the queue's.
    const judgedQueue = this.#judgedQueue();
    this.#gates.sync(judgedQueue);
    const goesOut = (intent: Intent) =>
      !afterReset(
        judgedQueue,
        judgedQueue.findIndex((judged) => judged.id === intent.id),
      ) &&
      this.#gates.isReleased(intent.id) &&
      this.#resetTimeAwaited(intent) === null;
    // The rules' reversible ones at once.
    const intents = [
      ...queueWithBrainsResets.filter(goesOut),
      ...ruleIntents.filter((intent) => !isIrreversibleIntent(intent) || goesOut(intent)),
    ];
    // A queue stored under an old limit (99 before #195, 98 before #203) would make the state too long, and the Agent
    // would refuse it whole: the rules' intents wait for room, the last first.
    const leftOut = intents.splice(MAX_INTENTS).map((each) => each.id);
    if (leftOut.join() !== this.#leftOut) {
      this.#leftOut = leftOut.join();
      if (leftOut.length > 0) {
        this.#log(
          `intents: the manual queue holds ${manual.length}, over its ${MANUAL_QUEUE_LIMIT}: ${leftOut.join(", ")} ` +
            `wait for room in the protocol's ${MAX_INTENTS} (cancel one)`,
        );
      }
    }
    // The owner's work, or the brain's faction work (#203), its focus from the connected Agent's slow snapshot
    // (decision 37): sent only once that says whether the implant is in, so the focus never flips on a connect. None:
    // not managed.
    const work = this.#slowData === null ? null : this.workView().desired;
    // Every state, so the Agent's safe mode keeps it (#160). The gang (#325) with it: safe mode doesn't keep that.
    const workAndTtl = {
      ...(work === null ? {} : { work }),
      ...(this.#gangState === null ? {} : { gang: this.#gangState }),
      ...(this.#bladeburnerState === null ? {} : { bladeburner: this.#bladeburnerState }),
      ttlMs: SAFE_MODE_TTL_MS,
    };
    // Sharing (#224) goes with the batcher: none without it.
    this.#shareWhy = "the batcher isn't sent";
    if (!hackLoopEnabled) {
      this.#lastSetHackTarget = null;
      // The batcher batches what the hack loop would: with the hack loop off, it isn't sent (#211).
      this.#batcherWhy = readBatcherEnabled(this.#store) ? "it needs the hack loop on" : null;
      this.#desired = { hackLoop: { enabled: false, target: null, hosts: [] }, intents, ...workAndTtl };
    } else if (this.#staticData === null || this.#mediumData === null) {
      this.#batcherWhy = null;
      this.#desired = null;
    } else {
      // One set before a reset (another `lastAugReset`) was that game's, not this one's.
      const resetAt = resetTimeOf(this.#slowData, "lastAugReset");
      if (resetAt !== null && this.#lastSetHackTargetResetAt !== null && resetAt !== this.#lastSetHackTargetResetAt) {
        this.#lastSetHackTarget = null;
      }
      const { hackLoop, lastSet } = planHackLoop(
        this.#staticData,
        this.#mediumData,
        this.#hackingMultipliers(),
        this.#lastSetHackTarget,
      );
      this.#lastSetHackTarget = lastSet;
      this.#lastSetHackTargetResetAt = resetAt ?? this.#lastSetHackTargetResetAt;
      const factionWorking = factionWorkGoingOn(work, this.#fastData?.work);
      this.#desired = {
        ...this.#withBatcher({ enabled: true, ...hackLoop }, factionWorking, this.#levellingPlan.levelling),
        intents,
        ...workAndTtl,
      };
    }
    this.#channel.setDesiredState(this.#desired);
    // The close of the game going out (#303), past its gate, in a desired state sent (none goes before the Agent's
    // snapshots with the hack loop on): stored, for main.ts's wait for the Agent to go.
    if (
      this.#closeGameSentAtMs === null &&
      this.#bitNodeEnd.closeGameAsked() &&
      this.#desired?.intents.some((each) => each.id === CLOSE_GAME_INTENT.id) === true
    ) {
      this.#closeGameSentAtMs = this.#lastEventAtMs ?? 0;
      this.#log("closing the game: its own Save Game, then its window closed (a save backup taken first)");
      this.#emit({ type: GAME_CLOSE_SENT_EVENT_KIND, atMs: this.#closeGameSentAtMs });
    }
    // The done check of the first intent that resets the game: the reset as of its sending, noted once (#164, #175).
    // Only the first can be out: what's after it waits.
    const reset = queueWithBrainsResets.find(resetsTheGame);
    if (reset === undefined || (this.#resetSent !== null && this.#resetSent.id !== reset.id)) {
      this.#noteResetSent(null);
    }
    if (
      reset !== undefined &&
      this.#resetSent === null &&
      this.#desired?.intents.some((each) => each.id === reset.id)
    ) {
      const field = resetFieldOf(reset);
      const resetAt = resetTimeOf(this.#slowData, field);
      if (resetAt !== null) {
        this.#noteResetSent({ id: reset.id, field, resetAt, sentAtMs: this.#lastEventAtMs ?? undefined });
      }
    }
  }
}

/** The install of augmentations (#164), as the brain's rule asks for it (#210): the owner's would have the same id. */
const INSTALL_INTENT: Intent = AUGMENTATION_INSTALL_INTENT;
/** A program or home RAM purchase, for the dashboard: "BruteSSH.exe", "the TOR router", "home RAM to 16 GB". */
function describePurchase(intent: Intent): string {
  if (intent.action === "buyTor") return "the TOR router";
  if (intent.action === "buyProgram") return intent.args.program;
  if (intent.action === "upgradeHomeRam") return `home RAM to ${intent.args.fromRam * 2} GB`;
  return intent.id;
}

/** Whether the queue's intent at `index` comes after one that resets the game, so waits for it (#164, #175, #269). */
function afterReset(queue: Intent[], index: number): boolean {
  const resetAt = queue.findIndex(resetsTheGame);
  return resetAt !== -1 && index > resetAt;
}

/** What an intent queued after `reset` waits for, to follow "not sent: ". */
function waitingForReset(reset: Intent): string {
  return reset.action === "destroyBitNode"
    ? `waiting for ${reset.id} first: queued after a destroy, it's for the next BitNode`
    : `waiting for ${reset.id} first: queued after an install, it's for the game after the reset`;
}

/** The reset time that moves when `reset` is done: a destroy's `lastNodeReset`, which an install leaves alone. */
function resetFieldOf(reset: Intent): ResetSentNote["field"] {
  return reset.action === "destroyBitNode" ? "lastNodeReset" : "lastAugReset";
}

/** The slow snapshot's reset time `field`, or null if it hasn't one: the Agent's word, so checked. */
function resetTimeOf(slow: SlowSnapshotData | null, field: ResetSentNote["field"]): number | null {
  const resetAt = (slow?.resetInfo as Record<string, unknown> | undefined)?.[field];
  return typeof resetAt === "number" && Number.isFinite(resetAt) ? resetAt : null;
}
