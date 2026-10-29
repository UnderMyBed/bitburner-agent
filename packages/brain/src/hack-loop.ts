// The brain's side of the hack loop (#134, M3's first slice): its switch, and the starter rules for its target and the
// servers it runs on, over the connected Agent's snapshots, until the planner (M4) decides, and the move from one
// target to the next without a stop in income (#184). The dashboard's switch turns it on and off; on is the default
// (owner decision 34). `DesiredStateController` (desired-state.ts) sends it.
import {
  type HackLoopState,
  isHackLoopReady,
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
  return hackTargetCandidates(staticData, mediumData)[0]?.hostname ?? null;
}

/** The starter rule's candidates, best first (`chooseHackTarget`'s is the first). */
function hackTargetCandidates(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
): StaticServer[] {
  const snapshots = usableSnapshots(staticData, mediumData);
  const hacking = (mediumData?.player?.skills as { hacking?: unknown } | undefined)?.hacking;
  if (snapshots === null || typeof hacking !== "number") return [];
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
  return candidates;
}

/**
 * Where the loop runs: the game's rooted servers with RAM, sorted. Never home, which is the Agent's, and never the
 * player's own purchased or Hacknet servers, which the owner uses (#134).
 */
export function chooseHackHosts(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
): string[] {
  return hackHostsWithRam(staticData, mediumData).map(([hostname]) => hostname);
}

/** `chooseHackHosts`'s hosts, each with its RAM (GB). */
function hackHostsWithRam(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
): [string, number][] {
  const snapshots = usableSnapshots(staticData, mediumData);
  if (snapshots === null) return [];
  const rooted = rootedServers(snapshots.mediumData);
  return gameServers(snapshots.staticData)
    .map((server): [string, number] => [server.hostname, rooted.get(server.hostname) ?? 0])
    .filter(([, ram]) => ram > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, MAX_HACK_LOOP_HOSTS);
}

/**
 * Whether the medium snapshot shows `server` ready for the loop to hack at once (core's `isHackLoopReady`, the
 * loop's own thresholds): its money and security there, against its maximum and minimum here. Not when either
 * snapshot doesn't say.
 */
function isReady(server: StaticServer, mediumData: MediumSnapshotData): boolean {
  const now = mediumData.servers.find((each) => each?.hostname === server.hostname);
  const { moneyMax, minDifficulty } = server;
  const moneyAvailable = now?.moneyAvailable;
  const hackDifficulty = now?.hackDifficulty;
  return (
    typeof moneyMax === "number" &&
    typeof minDifficulty === "number" &&
    typeof moneyAvailable === "number" &&
    typeof hackDifficulty === "number" &&
    isHackLoopReady({ moneyAvailable, moneyMax, hackDifficulty, minDifficulty })
  );
}

/** The target last set for the connected Agent, and whether it earns: a medium snapshot has shown it ready since. */
export interface HackTargetNote {
  target: string;
  earning: boolean;
}

/**
 * The hack loop while on (#184): the target it earns on, its hosts, and the next target being prepared on the rest,
 * with the note for the next time.
 * - `best` is the starter rule's choice (`chooseHackTarget`). `current` is `last`'s target, the one last set for this
 *   Agent, while it's still a candidate. Otherwise (a brain restart, or a reset that took it away) it's the best
 *   candidate that's ready, or `best` if none is.
 * - `current` earns once a medium snapshot has shown it ready since it became the target: the loop hacks it then.
 * - `best` is `current`, or ready, or `current` doesn't earn yet: every host on `best`, as nothing earning is given up.
 *   A move from a target that earns to one that isn't ready would earn nothing for the 35 to 45 minutes its weakening
 *   and growing take: `7990834` on Steam, n00dles to zer0 at hacking 150.
 * - Otherwise every host keeps earning on `current` but the largest, which prepare `best` (the same loop: it weakens
 *   and grows it, and hacks once it's ready) until they hold at least half the hosts' RAM. Once a medium snapshot shows
 *   `best` ready, all move to it. A single host holds all the RAM, so it prepares, and nothing earns meanwhile.
 */
export function planHackLoop(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
  last: HackTargetNote | null,
): { hackLoop: Omit<HackLoopState, "enabled">; note: HackTargetNote | null } {
  const candidates = hackTargetCandidates(staticData, mediumData);
  const hostsWithRam = hackHostsWithRam(staticData, mediumData);
  const hosts = hostsWithRam.map(([hostname]) => hostname);
  const best = candidates[0];
  if (best === undefined || mediumData === null) return { hackLoop: { target: null, hosts }, note: null };
  const ready = (server: StaticServer) => isReady(server, mediumData);
  const kept = candidates.find((server) => server.hostname === last?.target);
  const current = kept ?? candidates.find(ready) ?? best;
  const currentEarns = (kept !== undefined && last?.earning === true) || ready(current);
  if (current === best || ready(best) || !currentEarns) {
    const earning = current === best ? currentEarns : ready(best);
    return { hackLoop: { target: best.hostname, hosts }, note: { target: best.hostname, earning } };
  }
  // The largest hosts first, ties by name, until they hold at least half the RAM. With two hosts or more, some are left
  // to earn: the largest n - 1 of n hold at least half.
  const totalRam = hostsWithRam.reduce((total, [, ram]) => total + ram, 0);
  const preparingHosts = new Set<string>();
  let preparingRam = 0;
  for (const [hostname, ram] of [...hostsWithRam].sort(([a, ramA], [b, ramB]) => ramB - ramA || (a < b ? -1 : 1))) {
    if (preparingRam * 2 >= totalRam) break;
    preparingHosts.add(hostname);
    preparingRam += ram;
  }
  return {
    hackLoop: {
      target: current.hostname,
      hosts: hosts.filter((hostname) => !preparingHosts.has(hostname)),
      preparing: { target: best.hostname, hosts: hosts.filter((hostname) => preparingHosts.has(hostname)) },
    },
    note: { target: current.hostname, earning: true },
  };
}
