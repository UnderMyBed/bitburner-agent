// The brain's side of the hack loop (#134, M3's first slice): its switch, and the starter rules for its target and the
// servers it runs on, over the connected Agent's snapshots, until the planner (M4) decides. The dashboard's switch
// turns it on and off; on is the default (owner decision 34). `DesiredStateController` (desired-state.ts) sends it.
import {
  MAX_FIELD_LENGTH,
  MAX_HACK_LOOP_HOSTS,
  type MediumSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { readSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

export const HACK_LOOP_ENABLED_SETTING = "hackLoop.enabled";

type StaticServer = StaticSnapshotData["servers"][number];

/** The dashboard's switch: on unless the owner turned it off. */
export function readHackLoopEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, HACK_LOOP_ENABLED_SETTING, true);
}

/**
 * The servers that are the game's own, not the player's: in the static snapshot, not home and not purchased (Hacknet
 * servers count as purchased). Snapshot data comes from the game, so nothing in it is taken on trust.
 */
function gameServers(staticData: StaticSnapshotData): StaticServer[] {
  return staticData.servers.filter(
    (server) =>
      // Only names the protocol takes: one it refused would leave the Agent on its old state, unaware.
      typeof server?.hostname === "string" &&
      server.hostname !== "" &&
      server.hostname.length <= MAX_FIELD_LENGTH &&
      server.hostname !== "home" &&
      server.purchasedByPlayer === false,
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
    .sort()
    .slice(0, MAX_HACK_LOOP_HOSTS);
}
