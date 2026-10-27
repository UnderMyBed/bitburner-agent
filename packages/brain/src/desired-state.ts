// What the brain wants running in the game (architecture D2), kept in step with the dashboard's switches and the
// connected Agent's snapshots, and handed to the control channel to send: the hack loop (#134) and the hacking
// programs (#136).
import type { ControlChannel } from "@bitburner-agent/bridge";
import type { DesiredState, MediumSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import { chooseHackHosts, chooseHackTarget, HACK_LOOP_ENABLED_SETTING, readHackLoopEnabled } from "./hack-loop.ts";
import { chooseNextPurchase, PROGRAMS_ENABLED_SETTING, readProgramsEnabled } from "./programs.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

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

/**
 * Keeps the channel's desired state in step with the switches and the connected Agent's snapshots.
 * - Both activities go in one state, whole each time. With no snapshots from the connected Agent yet (it sends them
 *   in its first round), only a state that starts nothing goes out: the hack loop off, nothing bought. If the hack
 *   loop is on, nothing goes out until then. So a stale target or the last brain's view is never sent: a brain that
 *   restarts sends the running Agent the same state, which changes nothing, and an Agent after a reset is never given
 *   a target its game can't hack.
 * - The channel sends each connection a state once, then again on a change.
 */
export class DesiredStateController {
  readonly #channel: ControlChannel;
  readonly #store: TelemetryStore;
  /** The connected Agent's latest snapshots: forgotten when it disconnects, or another connects. */
  #staticData: StaticSnapshotData | null = null;
  #mediumData: MediumSnapshotData | null = null;
  #desired: DesiredState | null = null;
  #purchaseWaitingFor: string | null = null;
  #owned: string[] = [];

  constructor({ channel, store }: { channel: ControlChannel; store: TelemetryStore }) {
    this.#channel = channel;
    this.#store = store;
    channel.subscribe((event) => {
      if (event.type === "agentConnected" || event.type === "agentDisconnected") {
        this.#staticData = null;
        this.#mediumData = null;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "static") {
        this.#staticData = event.snapshot.data as StaticSnapshotData;
      } else if (event.type === "snapshotReceived" && event.snapshot.tier === "medium") {
        this.#mediumData = event.snapshot.data as MediumSnapshotData;
      } else {
        return;
      }
      this.#update();
    });
    this.#update();
  }

  /** The hack loop's switch: kept in the store, so it survives restarts of the brain, and sent at once. */
  setHackLoopEnabled(enabled: boolean): void {
    this.#store.setSetting(HACK_LOOP_ENABLED_SETTING, String(enabled));
    this.#update();
  }

  /** The hacking programs' switch, likewise. */
  setProgramsEnabled(enabled: boolean): void {
    this.#store.setSetting(PROGRAMS_ENABLED_SETTING, String(enabled));
    this.#update();
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
    return {
      enabled,
      waiting: this.#mediumData === null,
      owned: this.#owned,
      buying: this.#desired?.programs.next?.item ?? null,
      waitingFor: enabled ? this.#purchaseWaitingFor : null,
    };
  }

  #update(): void {
    const hackLoopEnabled = readHackLoopEnabled(this.#store);
    const programsEnabled = readProgramsEnabled(this.#store);
    const plan = this.#mediumData === null ? null : chooseNextPurchase(this.#mediumData);
    this.#owned = plan?.owned ?? [];
    this.#purchaseWaitingFor = plan?.waitingFor ?? null;
    const programs = { enabled: programsEnabled, next: programsEnabled ? (plan?.next ?? null) : null };
    if (!hackLoopEnabled) {
      this.#desired = { hackLoop: { enabled: false, target: null, hosts: [] }, programs };
    } else if (this.#staticData === null || this.#mediumData === null) {
      this.#desired = null;
    } else {
      this.#desired = {
        hackLoop: {
          enabled: true,
          target: chooseHackTarget(this.#staticData, this.#mediumData),
          hosts: chooseHackHosts(this.#staticData, this.#mediumData),
        },
        programs,
      };
    }
    this.#channel.setDesiredState(this.#desired);
  }
}
