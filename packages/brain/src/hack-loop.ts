// The brain's side of the hack loop (#134, M3's first slice): its switch, and the starter rules for its target and the
// servers it runs on, over the connected Agent's snapshots, until the planner (M4) decides, and the move from one
// target to the next without a stop in income (#184), and the threads each host hacks with, so the hosts together never
// hack a target dry (#187), and the hosts it runs on, the brain's cloud servers among them (#194). The dashboard's
// switch turns it on and off; on is the default (owner decision 34). `DesiredStateController` (desired-state.ts)
// sends it.
import {
  growthLogPerThread,
  HACK_LOOP_RAM_BUDGET_GB,
  HACK_LOOP_SECURITY_MARGIN,
  type HackLoopState,
  isBrainCloudServerName,
  isHackLoopReady,
  MAX_FIELD_LENGTH,
  MAX_HACK_LOOP_HOSTS,
  type MediumSnapshotData,
  percentMoneyHackedPerThread,
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

/** A name the protocol takes for a host: one it refused would leave the Agent on its old state, unaware. */
function isProtocolHostname(hostname: unknown): hostname is string {
  return typeof hostname === "string" && hostname !== "" && hostname.length <= MAX_FIELD_LENGTH;
}

/**
 * The servers that are the game's own, not the player's: in the static snapshot, not home and not purchased (Hacknet
 * servers count as purchased). Snapshot data comes from the game, so nothing in it is taken on trust.
 */
function gameServers(staticData: StaticSnapshotData): StaticServer[] {
  return staticData.servers.filter(
    (server) =>
      isProtocolHostname(server?.hostname) && server.hostname !== "home" && server.purchasedByPlayer === false,
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

/** A host of the hack loop's, and its RAM (GB) as the medium snapshot shows it. */
export interface HackLoopHost {
  hostname: string;
  ram: number;
}

/**
 * Where the loop runs, the one place that says (#194): the rooted servers with RAM in the medium snapshot, sorted by
 * name, that are the game's own (the static snapshot's, not purchased: never home, which is the Agent's, nor a Hacknet
 * server) or the brain's cloud servers (core's `isBrainCloudServerName`, `pserv-<n>`). Those are hosts from the first
 * medium snapshot after they're bought, at their RAM after an upgrade: the medium snapshot scans afresh every 10 s,
 * where the static one is the Agent's start. The owner's own cloud servers, under other names, are left to the owner
 * (#134), and so are the owner's scripts on the brain's. The hack loop's plan, the cloud server rule (cloud-servers.ts)
 * and the run report read it, and so does A1's hacking ceiling (#196). None without both snapshots.
 */
export function hackLoopHosts(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
): HackLoopHost[] {
  const snapshots = usableSnapshots(staticData, mediumData);
  if (snapshots === null) return [];
  const gameServerNames = new Set(gameServers(snapshots.staticData).map((server) => server.hostname));
  return snapshots.mediumData.servers
    .filter(
      (server) =>
        server?.hasAdminRights === true &&
        isProtocolHostname(server.hostname) &&
        (gameServerNames.has(server.hostname) || isBrainCloudServerName(server.hostname)) &&
        typeof server.maxRam === "number" &&
        server.maxRam > 0,
    )
    .map((server) => ({ hostname: server.hostname, ram: server.maxRam }))
    .sort((a, b) => (a.hostname < b.hostname ? -1 : 1))
    .slice(0, MAX_HACK_LOOP_HOSTS);
}

/** `hackLoopHosts`'s hostnames. */
export function chooseHackHosts(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
): string[] {
  return hackLoopHosts(staticData, mediumData).map(({ hostname }) => hostname);
}

/** `hackLoopHosts` as pairs, as the plan below reads them. */
function hackHostsWithRam(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
): [string, number][] {
  return hackLoopHosts(staticData, mediumData).map(({ hostname, ram }) => [hostname, ram]);
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

/**
 * A server's money as a fresh start has it, of its maximum: 1/25 (Server.ts:74-75). A target with more has been grown
 * since, so it's being worked.
 */
const STARTING_MONEY_FRACTION = 1 / 25;

/** The target last set for the connected Agent, for the next plan (#184). */
export interface LastHackTarget {
  target: string;
  /** A medium snapshot has shown it ready since it was set: the loop hacks it. */
  earning: boolean;
  /** The hosts preparing the next target, kept while they still hold at least half the RAM. */
  preparingHosts: string[];
}

/**
 * The hack loop while on (#184): the target it earns on, its hosts, and the next target being prepared on the rest,
 * with what to remember for the next plan.
 * - `best` is the starter rule's choice (`chooseHackTarget`). `current` is `lastSet`'s target, the one last set for
 *   this Agent, while it's still a candidate. With none set (a brain restart, the switch turned on, or a reset that took
 *   it away), it's the best candidate that's ready; else the one with the most of its money, if more than a fresh
 *   start's 4% (it's being worked: a server caught between a hack and its weaken isn't ready, but beats one at 4%);
 *   else `best`.
 * - `current` earns once a medium snapshot has shown it ready since it became the target, or when it was taken as the
 *   one being worked.
 * - `best` is `current`, or ready, or `current` doesn't earn yet: every host on `best`, as nothing earning is given up.
 *   A move from a target that earns to one that isn't ready would earn nothing for the 35 to 45 minutes its weakening
 *   and growing take: `7990834` on Steam, n00dles to zer0 at hacking 150.
 * - Otherwise every host keeps earning on `current` but the largest, which prepare `best` (the same loop: it weakens
 *   and grows it, and hacks once it's ready) until they hold at least half the hosts' RAM. The hosts that prepared it
 *   last time stay while they still hold half and leave some to earn, so a larger host rooted since doesn't stop a
 *   weaken or grow under way. Once a medium snapshot shows `best` ready, all move to it. A single host holds all the
 *   RAM, so it prepares, and nothing earns meanwhile; with no host, nothing is prepared.
 * - `hackThreads` (#187): each host's count of hack threads, the earning hosts' against `current` (or `best`), the
 *   preparing hosts' against `best` (`hackThreadsOf`); absent with no host.
 */
export function planHackLoop(
  staticData: StaticSnapshotData | null,
  mediumData: MediumSnapshotData | null,
  lastSet: LastHackTarget | null,
): { hackLoop: Omit<HackLoopState, "enabled">; lastSet: LastHackTarget | null } {
  const candidates = hackTargetCandidates(staticData, mediumData);
  const hostsWithRam = hackHostsWithRam(staticData, mediumData);
  const hosts = hostsWithRam.map(([hostname]) => hostname);
  const best = candidates[0];
  if (best === undefined || mediumData === null) return { hackLoop: { target: null, hosts }, lastSet: null };
  const ready = (server: StaticServer) => isReady(server, mediumData);
  const kept = candidates.find((server) => server.hostname === lastSet?.target);
  const mostWorked = mostOfItsMoney(candidates, mediumData);
  const current = kept ?? candidates.find(ready) ?? mostWorked ?? best;
  const currentEarns = (kept !== undefined ? lastSet?.earning === true : current === mostWorked) || ready(current);
  if (current === best || ready(best) || !currentEarns) {
    const earning = current === best ? currentEarns : ready(best);
    return {
      hackLoop: { target: best.hostname, hosts, ...hackThreadsOf(best, hostsWithRam, mediumData) },
      lastSet: { target: best.hostname, earning, preparingHosts: [] },
    };
  }
  const preparingHosts = splitForPreparing(hostsWithRam, lastSet?.preparingHosts ?? []);
  const preparing = hosts.filter((hostname) => preparingHosts.has(hostname));
  const lastSetNow = { target: current.hostname, earning: true, preparingHosts: preparing };
  // No host to prepare on (none rooted with RAM): nothing prepared, rather than "preparing on 0 servers".
  if (preparing.length === 0) {
    return {
      hackLoop: { target: current.hostname, hosts, ...hackThreadsOf(current, hostsWithRam, mediumData) },
      lastSet: lastSetNow,
    };
  }
  const earningWithRam = hostsWithRam.filter(([hostname]) => !preparingHosts.has(hostname));
  const preparingWithRam = hostsWithRam.filter(([hostname]) => preparingHosts.has(hostname));
  const earningThreads = hackThreadsOf(current, earningWithRam, mediumData).hackThreads ?? {};
  const preparingThreads = hackThreadsOf(best, preparingWithRam, mediumData).hackThreads ?? {};
  return {
    hackLoop: {
      target: current.hostname,
      hosts: earningWithRam.map(([hostname]) => hostname),
      preparing: { target: best.hostname, hosts: preparing },
      hackThreads: { ...earningThreads, ...preparingThreads },
    },
    lastSet: lastSetNow,
  };
}

/**
 * How many rounds of the hosts' grows may bring back what a round of their hacks takes (#187). Tuned in the
 * simulator (hack-loop-income.test.ts, over 8 seeds): at 2, no seed's money went 8 minutes without rising, and they
 * earned 14% more than with all threads hacking. At 3 or more the cap no longer binds on max-hardware at the move (one
 * thread's share, about 0.2%, is under 3 threads' log of growth), and seed 4 went 11 minutes without a rise; at 0.5,
 * with nearly every hack capped, they earned about half.
 */
export const HACK_REGROW_ROUNDS = 2;

/**
 * Each host's hack threads against `target` (#187): so many that a round of hacks by every host takes no more than
 * `HACK_REGROW_ROUNDS` rounds of their grows bring back. The loop hacks once money is at 75% of the maximum, so every
 * host's loop hacks at about the same time: with all their threads, they took max-hardware from $124m to $111 in the
 * simulator, and its growth of 30 took 25 minutes to bring it back. n00dles (growth 3000) is still hacked with all
 * their threads.
 * - **A round of grows** multiplies the target's money by e^g, g being the hosts' threads (their RAM over the loop's
 *   budget) times one thread's log of growth at the target's minimum security plus 5, the slowest the loop lets it
 *   grow (core's `growthLogPerThread`).
 * - **A host's hack** with t threads keeps 1 - t x p of what the hosts before it left, p being one thread's share at
 *   the target's minimum security, the most it ever is (core's `percentMoneyHackedPerThread`). Each host's part of the
 *   rounds' growth, `HACK_REGROW_ROUNDS` x g, is its part of the RAM, G_i, and its threads are the most whose hack
 *   keeps at least e^-G_i: t <= (1 - e^-G_i) / p. Together the hosts' hacks keep at least e^-(rounds x g).
 * - **Each host's count** is at least 1, then rounded down to a power of two, so the share's slow rise with the
 *   hacking level changes a host's count, and restarts its loop, only now and then; then at most the threads its RAM
 *   holds by the loop's budget (n00dles's, all of them), still at least 1. A count over the loop's threads, the deploy
 *   worker caps.
 * The player's multipliers are 1 where the snapshot doesn't say. None (absent) with no host; 1 each without the
 * target's minimum security, when a thread takes nothing, or when the inputs give no finite count (an infinite
 * multiplier, say, which the game can't produce). The BitNode's `ServerGrowthRate` is taken as 1 (core's
 * `growthLogPerThread`): in BN2, BN3 and BN11 that makes the counts up to 5x too generous, the unsafe side; to revisit
 * when BitNode multipliers come to core. BN1 is exact.
 */
function hackThreadsOf(
  target: StaticServer,
  hostsWithRam: [string, number][],
  mediumData: MediumSnapshotData,
): { hackThreads?: Record<string, number> } {
  if (hostsWithRam.length === 0) return {};
  const player = mediumData.player as {
    skills?: { hacking?: unknown };
    mults?: { hacking_money?: unknown; hacking_grow?: unknown };
  };
  const numberOr1 = (value: unknown) => (typeof value === "number" ? value : 1);
  const hacking = typeof player.skills?.hacking === "number" ? player.skills.hacking : 0;
  const { minDifficulty, requiredHackingSkill, serverGrowth } = target;
  const hackSharePerThread =
    typeof minDifficulty === "number"
      ? percentMoneyHackedPerThread(
          { hackDifficulty: minDifficulty, requiredHackingSkill: requiredHackingSkill ?? 0 },
          { skills: { hacking }, mults: { hacking_money: numberOr1(player.mults?.hacking_money) } },
        )
      : 0;
  const growthLogPerHostThread =
    typeof minDifficulty === "number"
      ? growthLogPerThread(
          { serverGrowth: serverGrowth ?? 0, hackDifficulty: minDifficulty + HACK_LOOP_SECURITY_MARGIN },
          { mults: { hacking_grow: numberOr1(player.mults?.hacking_grow) } },
        )
      : 0;
  const hostThreads = hostsWithRam.reduce((total, [, ram]) => total + Math.floor(ram / HACK_LOOP_RAM_BUDGET_GB), 0);
  const roundsGrowthLog = HACK_REGROW_ROUNDS * growthLogPerHostThread * hostThreads;
  const totalRam = hostsWithRam.reduce((total, [, ram]) => total + ram, 0);
  return {
    hackThreads: Object.fromEntries(
      hostsWithRam.map(([hostname, ram]) => {
        // 1 - e^-G_i: the most of what it finds this host's hack may take.
        const share = -Math.expm1((-roundsGrowthLog * ram) / totalRam);
        const count = Math.floor(share / hackSharePerThread);
        const threads = hackSharePerThread > 0 && Number.isFinite(count) ? Math.max(1, count) : 1;
        // Rounded, then at most the threads its RAM holds: n00dles's 128 on a 64 GB host is its 26.
        const ramThreads = Math.floor(ram / HACK_LOOP_RAM_BUDGET_GB);
        return [hostname, Math.max(1, Math.min(2 ** Math.floor(Math.log2(threads)), ramThreads))];
      }),
    ),
  };
}

/** The candidate with the most of its money, of its maximum, if more than a fresh start's: the first such, best first. */
function mostOfItsMoney(candidates: StaticServer[], mediumData: MediumSnapshotData): StaticServer | undefined {
  let most: { server: StaticServer; fraction: number } | undefined;
  for (const server of candidates) {
    const moneyAvailable = mediumData.servers.find((each) => each?.hostname === server.hostname)?.moneyAvailable;
    if (typeof moneyAvailable !== "number") continue;
    const fraction = moneyAvailable / (server.moneyMax as number);
    if (fraction > STARTING_MONEY_FRACTION && (most === undefined || fraction > most.fraction)) {
      most = { server, fraction };
    }
  }
  return most?.server;
}

/**
 * The hosts to prepare the next target on: those that prepared it last time, while they still hold at least half the
 * RAM and leave some to earn; otherwise the largest first, ties by name, until they hold at least half. With two hosts
 * or more, some are left to earn: the largest n - 1 of n hold at least half.
 */
function splitForPreparing(hostsWithRam: [string, number][], lastPreparing: string[]): Set<string> {
  const totalRam = hostsWithRam.reduce((total, [, ram]) => total + ram, 0);
  const ramOf = new Map(hostsWithRam);
  const stillThere = lastPreparing.filter((hostname) => ramOf.has(hostname));
  const stillThereRam = stillThere.reduce((total, hostname) => total + (ramOf.get(hostname) ?? 0), 0);
  if (stillThere.length > 0 && stillThere.length < hostsWithRam.length && stillThereRam * 2 >= totalRam) {
    return new Set(stillThere);
  }
  const preparingHosts = new Set<string>();
  let preparingRam = 0;
  for (const [hostname, ram] of [...hostsWithRam].sort(([a, ramA], [b, ramB]) => ramB - ramA || (a < b ? -1 : 1))) {
    if (preparingRam * 2 >= totalRam) break;
    preparingHosts.add(hostname);
    preparingRam += ram;
  }
  return preparingHosts;
}
