// What the brain wants running in the game (architecture D2), kept in step with the dashboard's switches and the
// connected Agent's snapshots, and handed to the control channel to send: the hack loop (#134) and the intents (#141):
// the next purchase of the hacking programs (#136) or home's RAM (#138), and the owner's manual queue. Irreversible
// intents wait for their guard and a save backup first (#147).
import type { ControlChannel } from "@bitburner-agent/bridge";
import {
  type DesiredState,
  FACTION_ENEMIES,
  type FastSnapshotData,
  INTENT_BACKENDS,
  type Intent,
  type IntentOutcome,
  intentId,
  isIrreversibleIntent,
  MAX_INTENTS,
  type MediumSnapshotData,
  parseIntentRequest,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { chooseHackHosts, chooseHackTarget, HACK_LOOP_ENABLED_SETTING, readHackLoopEnabled } from "./hack-loop.ts";
import { chooseHomeRamUpgrade, HOME_RAM_ENABLED_SETTING, type HomeRamPlan, readHomeRamEnabled } from "./home-ram.ts";
import { readManualIntents, writeManualIntents } from "./manual-intents.ts";
import { chooseNextPurchase, PROGRAMS_ENABLED_SETTING, type ProgramsPlan, readProgramsEnabled } from "./programs.ts";
import type { SaveBackupEvent } from "./save-backups.ts";
import { writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

/** Consecutive medium snapshots an irreversible intent's guard must hold on before its backup (R8). */
const GUARD_SNAPSHOTS = 2;

/** What the dashboard shows of the hack loop. */
export interface HackLoopView {
  enabled: boolean;
  /** On, but the brain hasn't yet had the connected Agent's static and medium snapshots, so it has sent nothing new. */
  waiting: boolean;
  target: string | null;
  hosts: string[];
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
  /** What an irreversible intent waits for before it's sent (#147), or null once it's sent, or for any other. */
  waitingFor: string | null;
}

/** What the controller needs of the brain's save backups: one now, and its own event (`SaveBackups.backupNow`). */
export interface BackupsBeforeIrreversibleIntents {
  backupNow(): Promise<SaveBackupEvent>;
}

/** Where an irreversible intent is on its way out (#147). Forgotten with the connected Agent's snapshots. */
interface IrreversibleGate {
  /** Consecutive medium snapshots, since it was queued, on which its guard held. */
  guardHeldSnapshots: number;
  /** Why the guard failed on the latest medium snapshot, or null. */
  guardFailure: string | null;
  /** Its backup: none asked for yet, being taken, or taken (then it's sent). */
  backup: "none" | "taking" | "taken";
  /** Why the last backup failed, until the next is asked for, or null. */
  backupFailure: string | null;
}

/**
 * Why `intent`'s guard doesn't hold on `medium`, or null if it does (R2). Joining a faction: none of its enemies is
 * joined (the game would refuse it then, `Faction/FactionHelpers.tsx:44-51`).
 */
function guardFailure(intent: Intent, medium: MediumSnapshotData): string | null {
  if (intent.action !== "joinFaction") return null;
  const joined = Array.isArray(medium.player.factions) ? (medium.player.factions as string[]) : [];
  const joinedEnemy = (FACTION_ENEMIES[intent.args.faction] ?? []).find((enemy) => joined.includes(enemy));
  return joinedEnemy === undefined ? null : `${intent.args.faction}'s enemy ${joinedEnemy} is joined`;
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
 * - An irreversible intent (R8, #147) goes out only once its guard has held on two consecutive medium snapshots from
 *   the connected Agent, received after it was queued, and a save backup asked for then has succeeded. A failed guard
 *   or backup starts the count again; a disconnect, a new Agent or a restarted brain forgets it, the safe way. Once
 *   out, it stays out until it's done.
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
  /** The purchase the brain's rules ask for now, or null. */
  #purchase: Intent | null = null;
  /** From the connected Agent's latest medium snapshot, or null. */
  #programsPlan: ProgramsPlan | null = null;
  /** From its latest medium and slow snapshots, or null. */
  #homeRamPlan: HomeRamPlan | null = null;
  /** Why each activity's purchase isn't asked for now, or null: its plan's reason, or the cheaper purchase first. */
  #waitingFor: { programs: string | null; homeRam: string | null } = { programs: null, homeRam: null };
  /** The brain's save backups, or null for a brain that takes none (no irreversible intent goes out then). */
  readonly #saveBackups: BackupsBeforeIrreversibleIntents | null;
  /** Each irreversible intent queued and not yet done, by id. */
  #gates = new Map<string, IrreversibleGate>();

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
    this.#saveBackups = saveBackups;
    channel.subscribe((event) => {
      if (event.type === "agentConnected" || event.type === "agentDisconnected") {
        this.#staticData = null;
        this.#mediumData = null;
        this.#slowData = null;
        this.#fastData = null;
        // Counted on the last Agent's snapshots: a backup still being taken for them releases nothing.
        this.#gates.clear();
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "fast") {
        // The intents' outcomes: for the views, and the manual intents done. Anything else changes nothing to send.
        this.#fastData = event.snapshot.data as FastSnapshotData;
        if (!this.#dropDoneManualIntents()) return;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "static") {
        this.#staticData = event.snapshot.data as StaticSnapshotData;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "medium") {
        this.#mediumData = event.snapshot.data as MediumSnapshotData;
        this.#advanceGates(this.#mediumData);
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "slow") {
        this.#slowData = event.snapshot.data as SlowSnapshotData;
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
    ].map((view) => ({
      ...view,
      outcome: outcomes.find((outcome) => outcome.id === view.id) ?? null,
      waitingFor: this.#waitingForOf(view.id),
    }));
  }

  /** What the irreversible intent `id` waits for before it's sent, or null. */
  #waitingForOf(id: string): string | null {
    const gate = this.#gates.get(id);
    if (gate === undefined || gate.backup === "taken") return null;
    if (gate.guardFailure !== null) return gate.guardFailure;
    if (gate.backup === "taking") return "a save backup first";
    if (gate.guardHeldSnapshots >= GUARD_SNAPSHOTS) return "a save backup first, which this brain doesn't take";
    const count = `the guard to hold on ${GUARD_SNAPSHOTS} consecutive medium snapshots (${gate.guardHeldSnapshots} so far)`;
    return gate.backupFailure === null ? count : `${count}, after the save backup failed: ${gate.backupFailure}`;
  }

  /** A medium snapshot from the connected Agent: each irreversible intent's guard, and its backup once it's held. */
  #advanceGates(medium: MediumSnapshotData): void {
    for (const [id, gate] of this.#gates) {
      if (gate.backup === "taken") continue;
      const intent = readManualIntents(this.#store).find((each) => each.id === id);
      if (intent === undefined) continue;
      gate.guardFailure = guardFailure(intent, medium);
      if (gate.guardFailure !== null) {
        // Starts again: a backup being taken now releases nothing.
        gate.guardHeldSnapshots = 0;
        gate.backup = "none";
        continue;
      }
      gate.guardHeldSnapshots += 1;
      if (gate.guardHeldSnapshots >= GUARD_SNAPSHOTS && gate.backup === "none") this.#takeBackup(id, gate);
    }
  }

  /** Asks for the backup before `gate`'s intent; on success it's sent, on failure the count starts again. */
  #takeBackup(id: string, gate: IrreversibleGate): void {
    if (this.#saveBackups === null) return;
    gate.backup = "taking";
    gate.backupFailure = null;
    void this.#saveBackups.backupNow().then((event) => {
      // Forgotten (a disconnect, the intent gone) or started again (its guard failed) since: nothing to release.
      if (this.#gates.get(id) !== gate || gate.backup !== "taking") return;
      if ("file" in event) {
        gate.backup = "taken";
      } else {
        gate.backup = "none";
        gate.guardHeldSnapshots = 0;
        gate.backupFailure = event.failure;
      }
      this.#update();
    });
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
            (INTENT_BACKENDS as readonly string[]).includes(fields.backend))
        );
      })
      .map(({ id, done, tries, problem, backend }) => ({ id, done, tries, problem, backend: backend ?? null }));
  }

  hackLoopView(): HackLoopView {
    const enabled = readHackLoopEnabled(this.#store);
    const hackLoop = this.#desired?.hackLoop;
    return {
      enabled,
      waiting: enabled && this.#desired === null,
      target: enabled ? (hackLoop?.target ?? null) : null,
      hosts: enabled ? (hackLoop?.hosts ?? []) : [],
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
    // A gate for each irreversible intent queued, kept while it stays; only those whose backup is taken go out.
    const irreversibleIds = new Set(manual.filter(isIrreversibleIntent).map((each) => each.id));
    for (const id of this.#gates.keys()) if (!irreversibleIds.has(id)) this.#gates.delete(id);
    for (const id of irreversibleIds) {
      if (!this.#gates.has(id)) {
        this.#gates.set(id, { guardHeldSnapshots: 0, guardFailure: null, backup: "none", backupFailure: null });
      }
    }
    const intents = [
      ...manual.filter((each) => (this.#gates.get(each.id)?.backup ?? "taken") === "taken"),
      ...(this.#purchase && !manual.some((each) => each.id === this.#purchase?.id) ? [this.#purchase] : []),
    ];
    if (!hackLoopEnabled) {
      this.#desired = { hackLoop: { enabled: false, target: null, hosts: [] }, intents };
    } else if (this.#staticData === null || this.#mediumData === null) {
      this.#desired = null;
    } else {
      this.#desired = {
        hackLoop: {
          enabled: true,
          target: chooseHackTarget(this.#staticData, this.#mediumData),
          hosts: chooseHackHosts(this.#staticData, this.#mediumData),
        },
        intents,
      };
    }
    this.#channel.setDesiredState(this.#desired);
  }
}
