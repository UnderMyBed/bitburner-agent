// What the brain wants running in the game (architecture D2), kept in step with the dashboard's switches and the
// connected Agent's snapshots, and handed to the control channel to send: the hack loop (#134) and the intents (#141):
// the next purchase of the hacking programs (#136), home's RAM (#138) or a cloud server (#194), the next backdoor for
// the hacker factions (#195, ./backdoors.ts), the next faction to join and the brain's faction work (#203,
// ./factions.ts), the augmentations' purchases and install (#210, ./augmentations.ts), and the owner's manual queue and
// work. Irreversible intents wait for their guard and a save backup first (#147). Each state carries how long the Agent
// keeps it with the brain gone (`ttlMs`, safe mode, #160). An install of augmentations (#164) or a destroy of the
// BitNode (#175) holds back what's queued after it, and leaves the queue once a slow snapshot shows the game reset.
import type { ControlChannel } from "@bitburner-agent/bridge";
import {
  type DesiredState,
  EFFECTOR_BACKENDS,
  type FactionWorkType,
  type FastSnapshotData,
  type Intent,
  type IntentOutcome,
  intentId,
  MAX_INTENTS,
  type MediumSnapshotData,
  PORT_OPENER_PROGRAMS,
  parseIntentRequest,
  resetsTheGame,
  type SlowSnapshotData,
  type StaticSnapshotData,
  TOR_ROUTER,
} from "@bitburner-agent/core";
import {
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  type AugmentationEvent,
  AugmentationRule,
  type AugmentationsView,
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
  planBatcher,
  readBatcherEnabled,
} from "./batcher.ts";
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
import {
  FactionRule,
  type FactionsView,
  type FactionWorkEvent,
  type FactionWorkStall,
  readFactionWorkEnabled,
  writeFactionWorkEnabled,
} from "./factions.ts";
import { HACK_LOOP_ENABLED_SETTING, type LastHackTarget, planHackLoop, readHackLoopEnabled } from "./hack-loop.ts";
import { chooseHomeRamUpgrade, HOME_RAM_ENABLED_SETTING, type HomeRamPlan, readHomeRamEnabled } from "./home-ram.ts";
import { type BackupsBeforeIrreversibleIntents, IrreversibleIntentGates } from "./irreversible-gate.ts";
import {
  type ResetSentNote,
  readManualIntents,
  readResetSentNote,
  writeManualIntents,
  writeResetSentNote,
} from "./manual-intents.ts";
import { chooseNextPurchase, PROGRAMS_ENABLED_SETTING, type ProgramsPlan, readProgramsEnabled } from "./programs.ts";
import { writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";
import {
  parseOwnersWork,
  readOwnersWork,
  reportedWorkOutcome,
  type WorkView,
  workFocus,
  writeOwnersWork,
} from "./work.ts";

/**
 * Safe mode (#160, architecture §5.4): how long the Agent keeps converging on the last state, minus its intents, after
 * it was last connected to this brain. Nothing in a state turns harmful with time alone (a reset, which does, drops it
 * at once), and the loops and the work carry on after it anyway: it bounds how long a stopped brain's choices outlive
 * it. 12 hours covers a night or a working day with the brain stopped or crashed for good.
 */
export const SAFE_MODE_TTL_MS = 12 * 60 * 60_000;

/**
 * The owner's manual queue's limit: the protocol's 100, less room for the purchase (a program, home RAM or a cloud
 * server, #194, one at a time), the backdoor (#195), the join (#203) and the augmentation purchase or install (#210).
 */
export const MANUAL_QUEUE_LIMIT = MAX_INTENTS - 4;

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

/** What the dashboard shows of each intent sent: where it came from, and how it went in the game. */
export interface IntentView {
  id: string;
  /**
   * The owner's manual queue, the brain's purchase rules, its backdoors (#195), its joins (#203), or its augmentations'
   * purchases and install (#210).
   */
  source: "manual" | "purchase" | "backdoor" | "join" | "augmentation";
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
 * - Intents go in order: the owner's manual queue first, as added, then the brain's install of augmentations (#210,
 *   ./augmentations.ts) behind it, then the purchase, then the augmentation purchase (#210), then the backdoor (#195),
 *   asked for until the connected Agent reports it done, then the join (#203). A manual intent leaves the queue once
 *   the connected Agent reports it done: the game's state can change again (a travel there and back), so a snapshot
 *   can't say it was done. Never more than the protocol's 100: a queue stored under an older limit leaves the rules'
 *   intents out, logged.
 * - Augmentations (#210): once an install is chosen, the programs and cloud servers stand down (an install loses
 *   them), and home's RAM is the augmentation rule's. Before that, cloud servers leave alone the augmentation rule's
 *   reserve too: the set's money, for an install projected within A2's payback limit.
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
  #slowData: SlowSnapshotData | null = null;
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
  /** Why the batcher sent isn't running, as the last fast snapshot said, or null (#211). */
  #batcherNotRunning: string | null = null;
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
  #backdoor: Intent | null = null;
  /** The joins and the brain's faction work (#203): the rule, the join it asks for now, the work it sends, or null. */
  readonly #factions: FactionRule;
  #join: Intent | null = null;
  #factionWork: { faction: string; workType: FactionWorkType } | null = null;
  /** Who gets the rules' events (#203, #210): the store, through main.ts. */
  readonly #listeners = new Set<(event: FactionWorkEvent | AugmentationEvent) => void>();
  /** When the connected Agent's latest medium and slow snapshots arrived, or null. */
  #mediumAtMs: number | null = null;
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
  }: {
    channel: ControlChannel;
    store: TelemetryStore;
    saveBackups?: BackupsBeforeIrreversibleIntents | null;
    log?: (line: string) => void;
  }) {
    this.#channel = channel;
    this.#store = store;
    this.#log = log;
    this.#backdoors = new BackdoorRule(log);
    this.#augmentations = new AugmentationRule({ store, log, emit: (event) => this.#emit(event) });
    this.#factions = new FactionRule({ log, emit: (event) => this.#emit(event) });
    this.#resetSent = readResetSentNote(store);
    // A brain restarted with an install out: the Agent went with it, as far as this brain knows, since it went out.
    if (this.#resetSent?.field === "lastAugReset" && this.#resetSent.sentAtMs !== undefined) {
      this.#installDisconnectedAtMs = this.#resetSent.sentAtMs;
    }
    this.#gates = new IrreversibleIntentGates({ saveBackups, onChange: () => this.#update() });
    channel.subscribe((event) => {
      this.#lastEventAtMs = event.atMs;
      if (event.type === "agentConnected" || event.type === "agentDisconnected") {
        this.#staticData = null;
        this.#mediumData = null;
        this.#mediumAtMs = null;
        this.#slowData = null;
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
        // purchase asked for (#210), whose next one goes at once. Anything else changes nothing to send.
        this.#fastData = event.snapshot.data as FastSnapshotData;
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
        if (!dropped && !problemNoted && !this.#augmentations.askedDone(this.#doneIds())) return;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "static") {
        this.#staticData = event.snapshot.data as StaticSnapshotData;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "medium") {
        this.#mediumData = event.snapshot.data as MediumSnapshotData;
        this.#income.add(event.atMs, this.#staticData, this.#mediumData);
        this.#mediumAtMs = event.atMs;
        this.#gates.mediumSnapshot(this.#mediumData, this.#gatedQueue(), this.#staticData);
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "slow") {
        this.#slowData = event.snapshot.data as SlowSnapshotData;
        this.#slowGameTimeMs = event.snapshot.gameTimeMs;
        this.#slowAtMs = event.atMs;
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

  /** The batcher's switch (#205), likewise; off by default. */
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
      this.#fastData?.batcher,
    );
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

  /** Listens for the rules' events (#203, #210), to store them; returns a function that stops it. */
  subscribe(listener: (event: FactionWorkEvent | AugmentationEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** What the dashboard shows of augmentations (#210). */
  augmentationsView(): AugmentationsView {
    return this.#augmentations.view();
  }

  /**
   * The money held back for augmentations (#210): the set the money covers, or will within the cloud servers' reserve
   * horizon of income, and all of it once an install is chosen. `#reserveForOtherPurchase` holds it back from cloud
   * servers (#194) where it's more than the program's or home RAM's.
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
   * slow snapshot shows the reset or the Agent connects again (#210): the `installNotRestarted` alert's. Null with none.
   */
  installAwaitingRestart(): { id: string; sinceMs: number } | null {
    const sent = this.#resetSent;
    if (sent === null || sent.field !== "lastAugReset" || this.#installDisconnectedAtMs === null) return null;
    return { id: sent.id, sinceMs: this.#installDisconnectedAtMs };
  }

  /** Adds `request` (`{ action, args }`) to the manual queue, kept in the store, and sends it at once. */
  addManualIntent(request: unknown): AddedIntent {
    const parsed = parseIntentRequest(request);
    if (!parsed.ok) return parsed;
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
   * the brain's faction work (#203).
   */
  workView(): WorkView {
    const owners = readOwnersWork(this.#store);
    const work = owners ?? (this.#factionWork === null ? null : { kind: "faction" as const, ...this.#factionWork });
    return {
      desired: work === null ? null : { ...work, focus: workFocus(work, this.#slowData) },
      source: owners !== null ? "owner" : work === null ? null : "brain",
      outcome: work === null ? null : reportedWorkOutcome(this.#fastData?.work),
    };
  }

  /** What the dashboard shows of the joins and the brain's faction work (#203). */
  factionsView(): FactionsView {
    return this.#factions.view();
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
    const install = this.#gatedQueue().slice(manual.length);
    return [
      ...manual.map((intent) => ({ intent, source: "manual" as const })),
      ...install.map((intent) => ({ intent, source: "augmentation" as const })),
      ...fromRule(this.#purchase).map((intent) => ({ intent, source: "purchase" as const })),
      ...fromRule(this.#augmentationIntent).map((intent) => ({ intent, source: "augmentation" as const })),
      ...fromRule(this.#backdoor).map((intent) => ({ intent, source: "backdoor" as const })),
      ...fromRule(this.#join).map((intent) => ({ intent, source: "join" as const })),
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
   * The intents the gates judge, in order: the owner's queue, then the brain's install (#210) unless the owner queued
   * one, so it waits behind the whole queue (an install's guard: nothing before it undone).
   */
  #gatedQueue(): Intent[] {
    const manual = readManualIntents(this.#store);
    // Once sent, it stays while the cycle is committed, the snapshots gone with the Agent it killed (or a restarted
    // brain's not yet in), so its reset note does too, until a slow snapshot shows the reset.
    const sent = this.#augmentationsCommitted && this.#resetSent?.id === INSTALL_INTENT.id;
    if (!(this.#augmentationInstall || sent) || manual.some((each) => each.id === INSTALL_INTENT.id)) return manual;
    return [...manual, INSTALL_INTENT];
  }

  /** The done intents in the connected Agent's latest fast snapshot. */
  #doneIds(): Set<string> {
    return new Set(
      this.#reportedOutcomes()
        .filter((outcome) => outcome.done)
        .map((outcome) => outcome.id),
    );
  }

  #emit(event: FactionWorkEvent | AugmentationEvent): void {
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
   * money of the set the money will cover within that horizon, where that's more.
   */
  #reserveForOtherPurchase(perSecond: number): MoneyReserve | null {
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
    const other =
      cheaper !== undefined && shortfall <= (perSecond * CLOUD_SERVER_RESERVE_HORIZON_MS) / 1000 ? cheaper : null;
    const augmentations = this.#augmentations.reserve();
    return augmentations > (other?.amount ?? 0)
      ? { amount: augmentations, forWhat: "the augmentations to buy before the install" }
      : other;
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

  /** The note, here and in the store, written only when it changes. */
  #noteResetSent(note: ResetSentNote | null): void {
    if (JSON.stringify(note) === JSON.stringify(this.#resetSent)) return;
    this.#resetSent = note;
    writeResetSentNote(this.#store, note);
    if (note === null) this.#installDisconnectedAtMs = null;
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

  /** Takes off the manual queue what the connected Agent reports done; whether it took any. */
  #dropDoneManualIntents(): boolean {
    const doneIds = new Set(
      this.#reportedOutcomes()
        .filter((outcome) => outcome.done)
        .map((outcome) => outcome.id),
    );
    const queue = readManualIntents(this.#store);
    const notDone = queue.filter((each) => !doneIds.has(each.id));
    if (notDone.length === queue.length) return false;
    writeManualIntents(this.#store, notDone);
    return true;
  }

  /**
   * The hack loop as planned, and the batcher with its switch on (#205): on the hack loop's target and all its hosts,
   * which the hack loop then leaves (it still roots). With the switch off, or no batcher to plan (the reason kept for
   * the dashboard), the hack loop as planned.
   */
  #withBatcher(hackLoop: DesiredState["hackLoop"]): Pick<DesiredState, "hackLoop" | "batcher"> {
    this.#batcherWhy = null;
    if (!readBatcherEnabled(this.#store) || this.#staticData === null || this.#mediumData === null) return { hackLoop };
    if (hackLoop.target === null) {
      this.#batcherWhy = "no target yet";
      return { hackLoop };
    }
    const hosts = batcherHostsOf(hackLoop);
    // Where it runs now, kept while it still fits (#211), so a larger host doesn't restart it.
    const runOn = this.#desired?.batcher?.runOn ?? null;
    const planned = planBatcher(this.#staticData, this.#mediumData, hackLoop.target, hosts, runOn);
    if (planned.batcher === null) {
      this.#batcherWhy = planned.why;
      return { hackLoop };
    }
    return { hackLoop: { enabled: true, target: hackLoop.target, hosts: [] }, batcher: planned.batcher };
  }

  #update(): void {
    const hackLoopEnabled = readHackLoopEnabled(this.#store);
    // Augmentations and the reset (#210) first: an install chosen holds the programs back.
    const augmentations = this.#augmentations.update({
      mediumData: this.#mediumData,
      mediumAtMs: this.#mediumAtMs,
      slowData: this.#slowData,
      slowGameTimeMs: this.#slowGameTimeMs,
      doneIds: this.#doneIds(),
      nowMs: this.#lastEventAtMs,
      enabled: readAugmentationsEnabled(this.#store),
      homeRamEnabled: readHomeRamEnabled(this.#store),
    });
    this.#augmentationIntent = augmentations.intent;
    this.#augmentationInstall = augmentations.install;
    this.#augmentationsCommitted = augmentations.committed;
    this.#purchase = this.#choosePurchase();
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
      enabled: readFactionWorkEnabled(this.#store),
    });
    this.#join = factions.join;
    this.#factionWork = factions.work;
    // The manual queue first, then the brain's install (#210) behind it; then the purchase, the augmentation purchase
    // (#210), the backdoor (#195) and the join (#203), each only if the owner hasn't queued the same. The purchases
    // before the backdoor: a `buy` never waits for its terminal action.
    const manual = readManualIntents(this.#store);
    const gated = this.#gatedQueue();
    const notManual = (intent: Intent | null) =>
      intent && !manual.some((each) => each.id === intent.id) ? [intent] : [];
    // An irreversible intent goes once its gate lets it, and nothing queued after a reset's intent before it's done.
    this.#gates.sync(gated);
    const intents = [
      ...gated.filter(
        (each, index) =>
          !afterReset(gated, index) && this.#gates.isReleased(each.id) && this.#resetTimeAwaited(each) === null,
      ),
      ...notManual(this.#purchase),
      ...notManual(this.#augmentationIntent),
      ...notManual(this.#backdoor),
      ...notManual(this.#join),
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
    // Every state, so the Agent's safe mode keeps it (#160).
    const workAndTtl = { ...(work === null ? {} : { work }), ttlMs: SAFE_MODE_TTL_MS };
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
      const { hackLoop, lastSet } = planHackLoop(this.#staticData, this.#mediumData, this.#lastSetHackTarget);
      this.#lastSetHackTarget = lastSet;
      this.#lastSetHackTargetResetAt = resetAt ?? this.#lastSetHackTargetResetAt;
      this.#desired = { ...this.#withBatcher({ enabled: true, ...hackLoop }), intents, ...workAndTtl };
    }
    this.#channel.setDesiredState(this.#desired);
    // The done check of the first intent that resets the game: the reset as of its sending, noted once (#164, #175).
    // Only the first can be out: what's after it waits.
    const reset = gated.find(resetsTheGame);
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
const INSTALL_INTENT: Intent = {
  id: intentId("installAugmentations", {}),
  action: "installAugmentations",
  args: {},
};
/** A program or home RAM purchase, for the dashboard: "BruteSSH.exe", "the TOR router", "home RAM to 16 GB". */
function describePurchase(intent: Intent): string {
  if (intent.action === "buyTor") return "the TOR router";
  if (intent.action === "buyProgram") return intent.args.program;
  if (intent.action === "upgradeHomeRam") return `home RAM to ${intent.args.fromRam * 2} GB`;
  return intent.id;
}

/** Whether the manual queue's intent at `index` comes after one that resets the game, so waits for it (#164, #175). */
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
