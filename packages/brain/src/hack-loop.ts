// The brain's side of the hack loop (#134, M3's first slice): what it wants running, sent to the Agent as the desired
// state (architecture D2). The dashboard's switch turns it on and off; on is the default (owner decision 34). The
// target and the servers it runs on come from starter rules over the connected Agent's snapshots, until the planner
// (M4) decides.
import type { ControlChannel } from "@bitburner-agent/bridge";
import type { DesiredState, MediumSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import type { TelemetryStore } from "./telemetry-store.ts";

const ENABLED_SETTING = "hackLoop.enabled";

type StaticServer = StaticSnapshotData["servers"][number];
type HackLoop = DesiredState["hackLoop"];

/** The dashboard's switch: on unless the owner turned it off. Fails on a value it didn't write, rather than guess. */
export function readHackLoopEnabled(store: TelemetryStore): boolean {
  const enabled = store.getSetting(ENABLED_SETTING);
  if (enabled !== null && enabled !== "true" && enabled !== "false") {
    throw new Error(`the ${ENABLED_SETTING} setting is ${JSON.stringify(enabled)}, not true or false`);
  }
  return enabled !== "false";
}

/**
 * The servers that are the game's own, not the player's: in the static snapshot, not home and not purchased (Hacknet
 * servers count as purchased). Snapshot data comes from the game, so nothing in it is taken on trust.
 */
function gameServers(staticData: StaticSnapshotData): StaticServer[] {
  return staticData.servers.filter(
    (server) =>
      typeof server?.hostname === "string" && server.hostname !== "home" && server.purchasedByPlayer === false,
  );
}

/** Hostnames the medium snapshot shows as rooted, with their RAM. */
function rootedServers(mediumData: MediumSnapshotData): Map<string, number> {
  return new Map(
    mediumData.servers
      .filter((server) => server?.hasAdminRights === true && typeof server.hostname === "string")
      .map((server) => [server.hostname, typeof server.maxRam === "number" ? server.maxRam : 0]),
  );
}

/** Both snapshots, in the shape the rules read, or null if either isn't. */
function usableSnapshots(staticData: StaticSnapshotData | null, mediumData: MediumSnapshotData | null) {
  if (!Array.isArray(staticData?.servers) || !Array.isArray(mediumData?.servers)) return null;
  return { staticData, mediumData };
}

/**
 * The starter target rule: among the game's rooted servers with money that need at most half the player's hacking
 * level (at least 1), the one with the highest maximum money times growth; ties to the first hostname. Growth counts
 * because the loop hacks only once a server is back at 75% of its maximum, and servers start at 4%: in the simulator,
 * over an 8 GB fresh start's first hour, n00dles (growth 3000) earned $15m, and foodnstuff, joesguns and
 * sigma-cosmetics (growth 5–20, more money) nothing, still growing (#134). Null when there's none, or the snapshots
 * don't say.
 */
export function chooseHackTarget(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
): string | null {
  const snapshots = usableSnapshots(staticData, mediumData);
  const hacking = (mediumData?.player?.skills as { hacking?: unknown } | undefined)?.hacking;
  if (snapshots === null || typeof hacking !== "number") return null;
  const highestRequiredSkill = Math.max(1, Math.floor(hacking / 2));
  const rooted = rootedServers(snapshots.mediumData);
  const candidates = gameServers(snapshots.staticData).filter(
    (server) =>
      rooted.has(server.hostname) &&
      typeof server.moneyMax === "number" &&
      server.moneyMax > 0 &&
      typeof server.serverGrowth === "number" &&
      server.serverGrowth > 0 &&
      typeof server.requiredHackingSkill === "number" &&
      server.requiredHackingSkill <= highestRequiredSkill,
  );
  const score = (server: StaticServer) => (server.moneyMax as number) * (server.serverGrowth as number);
  candidates.sort((a, b) => score(b) - score(a) || (a.hostname < b.hostname ? -1 : 1));
  return candidates[0]?.hostname ?? null;
}

/**
 * Where the loop runs: the game's rooted servers with RAM, sorted. Never home, which is the Agent's, and never the
 * player's own purchased or Hacknet servers, which the owner uses (#134).
 */
export function chooseHackHosts(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
): string[] {
  const snapshots = usableSnapshots(staticData, mediumData);
  if (snapshots === null) return [];
  const rooted = rootedServers(snapshots.mediumData);
  return gameServers(snapshots.staticData)
    .map((server) => server.hostname)
    .filter((hostname) => (rooted.get(hostname) ?? 0) > 0)
    .sort();
}

/** What the dashboard shows of the hack loop. */
export interface HackLoopView {
  enabled: boolean;
  /** On, but the brain hasn't yet had the connected Agent's static and medium snapshots, so it has sent nothing new. */
  waiting: boolean;
  target: string | null;
  hosts: string[];
}

/**
 * Keeps the channel's desired state in step with the switch and the connected Agent's snapshots. Off is sent at once.
 * On waits for that Agent's own static and medium snapshots (they come in its first round), so a stale target or the
 * last brain's view is never sent: a brain that restarts sends the running Agent the same state, which changes
 * nothing, and an Agent after a reset is never given a target its game can't hack. Then it's on with the target (or
 * none yet, while servers get rooted) and the hosts. The channel sends each connection a state once, then on changes.
 */
export class HackLoopController {
  readonly #channel: ControlChannel;
  readonly #store: TelemetryStore;
  /** The connected Agent's latest snapshots: forgotten when another connects. */
  #staticData: StaticSnapshotData | null = null;
  #mediumData: MediumSnapshotData | null = null;
  #desired: HackLoop | null = null;

  constructor({ channel, store }: { channel: ControlChannel; store: TelemetryStore }) {
    this.#channel = channel;
    this.#store = store;
    channel.subscribe((event) => {
      if (event.type === "agentConnected") {
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

  /** The dashboard's switch: kept in the store, so it survives restarts of the brain, and sent at once. */
  setEnabled(enabled: boolean): void {
    this.#store.setSetting(ENABLED_SETTING, String(enabled));
    this.#update();
  }

  view(): HackLoopView {
    const enabled = readHackLoopEnabled(this.#store);
    return {
      enabled,
      waiting: enabled && this.#desired === null,
      target: this.#desired?.target ?? null,
      hosts: this.#desired?.hosts ?? [],
    };
  }

  #update(): void {
    if (!readHackLoopEnabled(this.#store)) {
      this.#desired = { enabled: false, target: null, hosts: [] };
    } else if (this.#staticData === null || this.#mediumData === null) {
      this.#desired = null;
    } else {
      this.#desired = {
        enabled: true,
        target: chooseHackTarget(this.#staticData, this.#mediumData),
        hosts: chooseHackHosts(this.#staticData, this.#mediumData),
      };
    }
    this.#channel.setDesiredState(this.#desired === null ? null : { hackLoop: this.#desired });
  }
}
