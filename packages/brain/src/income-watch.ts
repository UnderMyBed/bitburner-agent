// The player's money over the connected Agent's medium snapshots (#184): when it last rose, for the dashboard's
// `incomeStalled` alert (dashboard/alerts.ts), and a line in the brain's log as a stall starts and as it ends.
// It's kept here, as each snapshot arrives, rather than read back from the store at each status read: a stall can
// last hours, and every medium snapshot holds the whole network.
import type { ControlChannel } from "@bitburner-agent/bridge";
import type { MediumSnapshotData } from "@bitburner-agent/core";
import { type Alert, type IncomeFacts, incomeStalledAlert } from "./dashboard/alerts.ts";

export class IncomeWatch {
  #income: IncomeFacts | null = null;
  /** The alert as of the last medium snapshot: its start and end are logged once each. */
  #stalled: Alert | null = null;

  /**
   * `hackLoopTarget` is the hack loop's target while it's on, or null (the controller's view: it's subscribed to the
   * channel first, so it has seen each snapshot by the time this does).
   */
  constructor({
    channel,
    hackLoopTarget,
    log = () => {},
  }: {
    channel: ControlChannel;
    hackLoopTarget: () => string | null;
    log?: (line: string) => void;
  }) {
    channel.subscribe((event) => {
      if (event.type === "agentConnected" || event.type === "agentDisconnected") {
        // Another Agent, or the same one after a reload, is watched afresh: a stall is the agentSilent alert's meanwhile.
        if (this.#stalled !== null)
          log(`income stall over: the Agent ${event.type === "agentConnected" ? "connected" : "disconnected"}`);
        this.#income = null;
        this.#stalled = null;
        return;
      }
      if (event.type !== "snapshotReceived" || event.snapshot.tier !== "medium") return;
      // The Agent's word: only a number counts.
      const money = (event.snapshot.data as Partial<MediumSnapshotData> | null)?.player?.money;
      if (typeof money !== "number" || !Number.isFinite(money)) return;
      const target = hackLoopTarget();
      // Off or with no target, nothing is expected to earn: the watch starts again once the loop has a target.
      const risen = target === null || this.#income === null || money > this.#income.money;
      this.#income = { money, lastRiseAtMs: risen ? event.atMs : (this.#income as IncomeFacts).lastRiseAtMs };
      const stalled = incomeStalledAlert({ nowMs: event.atMs, hackLoopTarget: target, income: this.#income });
      if (stalled !== null && this.#stalled === null) log(`income stalled: ${stalled.detail}`);
      if (stalled === null && this.#stalled !== null) {
        const minutes = Math.floor((event.atMs - this.#stalled.sinceMs) / 60_000);
        log(
          target === null
            ? `income stall over: the hack loop is off or has no target, after ${minutes} min`
            : `income stall over: money rose to $${Math.round(money).toLocaleString("en-US")} after ${minutes} min`,
        );
      }
      this.#stalled = stalled;
    });
  }

  /** The money and its last rise, as of the newest medium snapshot, or null before one since the Agent connected. */
  facts(): IncomeFacts | null {
    return this.#income;
  }
}
