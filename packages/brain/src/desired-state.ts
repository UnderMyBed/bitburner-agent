// What the brain wants running in the game (architecture D2), kept in step with the dashboard's switches and the
// connected Agent's snapshots, and handed to the control channel to send: the hack loop (#134) and the intents (#141):
// the next purchase of the hacking programs (#136) or home's RAM (#138), and the owner's manual queue. Irreversible
// intents wait for their guard and a save backup first (#147). Each state carries how long the Agent keeps it with the
// brain gone (`ttlMs`, safe mode, #160). An install of augmentations (#164) or a destroy of the BitNode (#175) holds
// back what's queued after it, and leaves the queue once a slow snapshot shows the game reset.
import type { ControlChannel } from "@bitburner-agent/bridge";
import {
  type DesiredState,
  EFFECTOR_BACKENDS,
  type FastSnapshotData,
  type Intent,
  type IntentOutcome,
  intentId,
  MAX_INTENTS,
  type MediumSnapshotData,
  parseIntentRequest,
  resetsTheGame,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
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

/** What the dashboard shows of each intent sent: where it came from, and how it went in the game. */
export interface IntentView {
  id: string;
  /** The owner's manual queue, or the brain's purchase rules. */
  source: "manual" | "purchase";
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
 * - Intents go in order: the owner's manual queue first, as added, then the purchase. A manual intent leaves the queue
 *   once the connected Agent reports it done: the game's state can change again (a travel there and back), so a
 *   snapshot can't say it was done.
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
  /** The purchase the brain's rules ask for now, or null. */
  #purchase: Intent | null = null;
  /** From the connected Agent's latest medium snapshot, or null. */
  #programsPlan: ProgramsPlan | null = null;
  /** From its latest medium and slow snapshots, or null. */
  #homeRamPlan: HomeRamPlan | null = null;
  /** Why each activity's purchase isn't asked for now, or null: its plan's reason, or the cheaper purchase first. */
  #waitingFor: { programs: string | null; homeRam: string | null } = { programs: null, homeRam: null };
  /** Each irreversible intent queued and not yet done (none goes out with a brain that takes no save backups). */
  readonly #gates: IrreversibleIntentGates;
  /** The reset time when the first intent that resets the game was sent, while it's queued, or null (#164, #175). */
  #resetSent: ResetSentNote | null;

  constructor({
    channel,
    store,
    saveBackups = null,
  }: {
    channel: ControlChannel;
    store: TelemetryStore;
    saveBackups?: BackupsBeforeIrreversibleIntents | null;
  }) {
    this.#channel = channel;
    this.#store = store;
    this.#resetSent = readResetSentNote(store);
    this.#gates = new IrreversibleIntentGates({ saveBackups, onChange: () => this.#update() });
    channel.subscribe((event) => {
      if (event.type === "agentConnected" || event.type === "agentDisconnected") {
        this.#staticData = null;
        this.#mediumData = null;
        this.#slowData = null;
        this.#fastData = null;
        // Counted on the last Agent's snapshots: every gate starts again.
        this.#gates.forget();
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "fast") {
        // The intents' and the work's outcomes: for the views, and the manual intents done. Anything else changes
        // nothing to send.
        this.#fastData = event.snapshot.data as FastSnapshotData;
        if (!this.#dropDoneManualIntents()) return;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "static") {
        this.#staticData = event.snapshot.data as StaticSnapshotData;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "medium") {
        this.#mediumData = event.snapshot.data as MediumSnapshotData;
        this.#gates.mediumSnapshot(this.#mediumData, readManualIntents(this.#store), this.#staticData);
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "slow") {
        this.#slowData = event.snapshot.data as SlowSnapshotData;
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

  /** Adds `request` (`{ action, args }`) to the manual queue, kept in the store, and sends it at once. */
  addManualIntent(request: unknown): AddedIntent {
    const parsed = parseIntentRequest(request);
    if (!parsed.ok) return parsed;
    const queue = readManualIntents(this.#store);
    // Room for the purchase too: a desired state over the protocol's limit would be refused by the Agent.
    if (!queue.some((each) => each.id === parsed.message.id)) {
      if (queue.length >= MAX_INTENTS - 1) {
        return { ok: false, reason: `the manual queue is full: ${MAX_INTENTS - 1} intents at most` };
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

  /** What the brain sends of the work, and how the connected Agent last reported it. */
  workView(): WorkView {
    const owners = readOwnersWork(this.#store);
    return {
      desired: owners === null ? null : { ...owners, focus: workFocus(owners, this.#slowData) },
      outcome: owners === null ? null : reportedWorkOutcome(this.#fastData?.work),
    };
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
    const purchase =
      this.#desired !== null && this.#purchase && !manual.some((each) => each.id === this.#purchase?.id)
        ? [this.#purchase]
        : [];
    return [
      ...manual.map(({ id }) => ({ id, source: "manual" as const })),
      ...purchase.map(({ id }) => ({ id, source: "purchase" as const })),
    ].map((view, index) => ({
      ...view,
      outcome: outcomes.find((outcome) => outcome.id === view.id) ?? null,
      waitingFor:
        view.source === "manual" && afterReset(manual, index)
          ? waitingForReset(manual.find(resetsTheGame) as Intent)
          : (this.#gates.waitingFor(view.id) ?? this.#resetTimeAwaited(manual[index])),
    }));
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

  hackLoopView(): HackLoopView {
    const enabled = readHackLoopEnabled(this.#store);
    const hackLoop = this.#desired?.hackLoop;
    // The hosts' hack threads added up (#187), or null where the state gives none: all their threads.
    const hackThreadsOn = (hosts: string[]) => {
      const hackThreads = hackLoop?.hackThreads;
      if (!hackThreads) return null;
      return hosts.reduce((total, host) => total + (hackThreads[host] ?? 0), 0);
    };
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

  /** The purchase to ask for now, as an intent: one at a time, cheapest first, among the activities switched on. */
  #choosePurchase(): Intent | null {
    const programsEnabled = readProgramsEnabled(this.#store);
    const homeRamEnabled = readHomeRamEnabled(this.#store);
    const programsPlan = this.#mediumData === null ? null : chooseNextPurchase(this.#mediumData);
    const homeRamPlan = this.#mediumData === null ? null : chooseHomeRamUpgrade(this.#mediumData, this.#slowData);
    this.#programsPlan = programsPlan;
    this.#homeRamPlan = homeRamPlan;
    let programsNext = programsEnabled ? (programsPlan?.next ?? null) : null;
    let homeRamNext = homeRamEnabled ? (homeRamPlan?.next ?? null) : null;
    this.#waitingFor = { programs: programsPlan?.waitingFor ?? null, homeRam: homeRamPlan?.waitingFor ?? null };
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

  #update(): void {
    const hackLoopEnabled = readHackLoopEnabled(this.#store);
    this.#purchase = this.#choosePurchase();
    // The manual queue first; the purchase only if the owner hasn't queued the same.
    const manual = readManualIntents(this.#store);
    // An irreversible intent goes once its gate lets it, and nothing queued after a reset's intent before it's done.
    this.#gates.sync(manual);
    const intents = [
      ...manual.filter(
        (each, index) =>
          !afterReset(manual, index) && this.#gates.isReleased(each.id) && this.#resetTimeAwaited(each) === null,
      ),
      ...(this.#purchase && !manual.some((each) => each.id === this.#purchase?.id) ? [this.#purchase] : []),
    ];
    // The owner's work, its focus from the connected Agent's slow snapshot (decision 37): sent only once that says
    // whether the implant is in, so the focus never flips on a connect. None set: not managed.
    const work = this.#slowData === null ? null : this.workView().desired;
    // Every state, so the Agent's safe mode keeps it (#160).
    const workAndTtl = { ...(work === null ? {} : { work }), ttlMs: SAFE_MODE_TTL_MS };
    if (!hackLoopEnabled) {
      this.#lastSetHackTarget = null;
      this.#desired = { hackLoop: { enabled: false, target: null, hosts: [] }, intents, ...workAndTtl };
    } else if (this.#staticData === null || this.#mediumData === null) {
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
      this.#desired = { hackLoop: { enabled: true, ...hackLoop }, intents, ...workAndTtl };
    }
    this.#channel.setDesiredState(this.#desired);
    // The done check of the first intent that resets the game: the reset as of its sending, noted once (#164, #175).
    // Only the first can be out: what's after it waits.
    const reset = manual.find(resetsTheGame);
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
      if (resetAt !== null) this.#noteResetSent({ id: reset.id, field, resetAt });
    }
  }
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
