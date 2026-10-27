// The brain's side of the hack loop (#134, M3's first slice): what it wants running, sent to the Agent as the desired
// state (architecture D2). The dashboard's switch turns it on and off; on is the default (owner decision 34). The
// target comes from a starter rule over the Agent's snapshots, until the planner (M4) decides.
import type { ControlChannel } from "@bitburner-agent/bridge";
import type { DesiredState, MediumSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import type { TelemetryStore } from "./telemetry-store.ts";

const ENABLED_SETTING = "hackLoop.enabled";

/** The dashboard's switch: on unless the owner turned it off. Fails on a value it didn't write, rather than guess. */
export function readHackLoopEnabled(store: TelemetryStore): boolean {
  const enabled = store.getSetting(ENABLED_SETTING);
  if (enabled !== null && enabled !== "true" && enabled !== "false") {
    throw new Error(`the ${ENABLED_SETTING} setting is ${JSON.stringify(enabled)}, not true or false`);
  }
  return enabled !== "false";
}

/** The switch's new value, kept in the store so it survives restarts of the brain. */
export function setHackLoopEnabled(store: TelemetryStore, enabled: boolean): void {
  store.setSetting(ENABLED_SETTING, String(enabled));
}

/**
 * The starter rule: among the rooted servers with money, other than home and purchased ones, that need at most half
 * the player's hacking level (at least 1), the one with the highest maximum money times growth; ties to the first
 * hostname. Growth counts because the loop hacks only once a server is back at 75% of its maximum, and servers start at
 * 4%: in the simulator, over an 8 GB fresh start's first hour, n00dles (growth 3000) earned $15m and foodnstuff,
 * joesguns and sigma-cosmetics (growth 5–20, more money) nothing, still growing (#134). Null when there's none, or the
 * snapshots don't say. Snapshot data comes from the game, so nothing in it is taken on trust.
 */
export function chooseHackTarget(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
): string | null {
  const hacking = (mediumData?.player?.skills as { hacking?: unknown } | undefined)?.hacking;
  if (!Array.isArray(staticData?.servers) || !Array.isArray(mediumData?.servers) || typeof hacking !== "number") {
    return null;
  }
  const highestRequiredSkill = Math.max(1, Math.floor(hacking / 2));
  const rooted = new Set(
    mediumData.servers.filter((server) => server?.hasAdminRights === true).map((server) => server.hostname),
  );
  const candidates = staticData.servers.filter(
    (server) =>
      server?.hostname !== "home" &&
      server?.purchasedByPlayer === false &&
      rooted.has(server.hostname) &&
      typeof server.moneyMax === "number" &&
      server.moneyMax > 0 &&
      typeof server.serverGrowth === "number" &&
      server.serverGrowth > 0 &&
      typeof server.requiredHackingSkill === "number" &&
      server.requiredHackingSkill <= highestRequiredSkill,
  );
  const score = (server: StaticSnapshotData["servers"][number]) =>
    (server.moneyMax as number) * (server.serverGrowth as number);
  candidates.sort((a, b) => score(b) - score(a) || (a.hostname < b.hostname ? -1 : 1));
  return candidates[0]?.hostname ?? null;
}

/**
 * Keeps the channel's desired state in step with the switch and the latest static and medium snapshots: on at once
 * (with no target, so servers get rooted), with a target once the snapshots show one. The channel sends it only when
 * it changes, and to each newly welcomed Agent.
 */
export class HackLoopController {
  readonly #channel: ControlChannel;
  readonly #store: TelemetryStore;
  #staticData: StaticSnapshotData | null = null;
  #mediumData: MediumSnapshotData | null = null;

  constructor({ channel, store }: { channel: ControlChannel; store: TelemetryStore }) {
    this.#channel = channel;
    this.#store = store;
    channel.subscribe((event) => {
      if (event.type !== "snapshotReceived") return;
      const { tier, data } = event.snapshot;
      if (tier === "static") this.#staticData = data as StaticSnapshotData;
      else if (tier === "medium") this.#mediumData = data as MediumSnapshotData;
      else return;
      this.#update();
    });
    this.#update();
  }

  /** The dashboard's switch: takes effect at once. */
  setEnabled(enabled: boolean): void {
    setHackLoopEnabled(this.#store, enabled);
    this.#update();
  }

  #update(): void {
    const enabled = readHackLoopEnabled(this.#store);
    const desiredState: DesiredState = {
      hackLoop: { enabled, target: enabled ? chooseHackTarget(this.#staticData, this.#mediumData) : null },
    };
    this.#channel.setDesiredState(desiredState);
  }
}
