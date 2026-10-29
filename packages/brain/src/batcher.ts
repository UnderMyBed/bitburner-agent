// The brain's side of the batcher (#205 and #206, M4 phase A slices A7b and A7c): its dashboard switch, on by default
// since #206, and its plan while it's on, on the servers the hack loop would hack from, which the hack loop then leaves
// to it (it still roots): the target worth most over the next minutes, counting the time to prepare it
// (`chooseBatcher`), the next target prepared beside the batches, and core's `batchPlan` (#204) for the share and the
// spacing, at the hacking level of the latest medium snapshot, so the plan follows the level as it rises. The
// dashboard's lines, its alerts' facts and the run report's section 6 read what comes back. `DesiredStateController`
// (desired-state.ts) sends it.
import {
  BATCHER_RAM_BUDGET_GB,
  type BatcherHealth,
  type BatcherState,
  batcherIncomePerGigabyteSecond,
  batchPlan,
  batchRamGb,
  type HackingPlayer,
  type HackingTarget,
  hackChance,
  hackSharePerThread,
  type MediumSnapshotData,
  operationTimeMs,
  preparationTimeMs,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { readSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

export const BATCHER_ENABLED_SETTING = "batcher.enabled";

/**
 * The dashboard's switch: on unless the owner turned it off (#206). Off by default in #205; on since #206's score, the
 * batcher ahead of the hack loop on A1's measure on every seed of its suite (batcher-score.test.ts).
 */
export function readBatcherEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, BATCHER_ENABLED_SETTING, true);
}

/**
 * What home keeps for the Agent and its workers, GB: a fresh save's 8, of which the Agent and its largest worker take
 * 7.55 (architecture §14, Q1). The batcher runs on home only with its budget free beyond it: home of 16 GB or more.
 */
export const HOME_KEPT_FOR_THE_AGENT_GB = 8;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The player's hacking figures from the medium snapshot (the Agent's word), or null if any is missing. */
function hackingPlayerOf(player: unknown): HackingPlayer | null {
  const { skills, mults } = (player ?? {}) as { skills?: Record<string, unknown>; mults?: Record<string, unknown> };
  const hacking = skills?.hacking;
  const intelligence = skills?.intelligence;
  const multNames = ["hacking_chance", "hacking_speed", "hacking_money", "hacking_grow"] as const;
  if (!isNumber(hacking) || !isNumber(intelligence) || !multNames.every((name) => isNumber(mults?.[name]))) return null;
  return {
    skills: { hacking, intelligence },
    mults: Object.fromEntries(multNames.map((name) => [name, mults?.[name] as number])) as HackingPlayer["mults"],
  };
}

/** A target's figures from the static snapshot, or null if any is missing. */
function figuresOf(staticData: StaticSnapshotData, target: string): HackingTarget | null {
  const server = staticData.servers.find((each) => each?.hostname === target);
  const { moneyMax, minDifficulty, requiredHackingSkill, serverGrowth } = server ?? {};
  if (![moneyMax, minDifficulty, requiredHackingSkill, serverGrowth].every(isNumber)) return null;
  return { moneyMax, minDifficulty, requiredHackingSkill, serverGrowth } as HackingTarget;
}

/**
 * The batcher's desired state (#205), on `target` and `hosts` (the hack loop's), or why there's none:
 * - **where it runs:** where it runs now (`current`), while that still holds it (#211: a move restarts it); else home,
 *   when its RAM in the medium snapshot leaves the batcher's budget (`BATCHER_RAM_BUDGET_GB`) beyond what home keeps
 *   for the Agent; otherwise the host with the most RAM. The host it runs on has that much less for operations;
 * - **its plan:** core's `batchPlan` on the hosts' RAM (`batchRamGb`), at the hacking level and multipliers of the
 *   medium snapshot. Its share and spacing go in the config; the batcher works out each batch's threads itself.
 */
export function planBatcher(
  staticData: StaticSnapshotData,
  mediumData: MediumSnapshotData,
  target: string,
  hosts: string[],
  current: string | null = null,
  ramShare = 1,
):
  | { batcher: BatcherState; incomePerSecond: number; ramGb: number; peakRamGb: number }
  | { batcher: null; why: string } {
  const player = hackingPlayerOf(mediumData.player);
  if (player === null) return { batcher: null, why: "the medium snapshot has no hacking figures for the player" };
  const figures = figuresOf(staticData, target);
  if (figures === null) return { batcher: null, why: `the static snapshot has no figures for ${target}` };
  const ramOf = new Map(
    mediumData.servers
      .filter((server) => typeof server?.hostname === "string" && isNumber(server.maxRam))
      .map((server) => [server.hostname, server.maxRam]),
  );
  const hostsRam = hosts.map((host) => [host, ramOf.get(host) ?? 0] as const).filter(([, ram]) => ram > 0);
  if (hostsRam.length === 0) return { batcher: null, why: "no host with RAM" };
  const onHome = (ramOf.get("home") ?? 0) - HOME_KEPT_FOR_THE_AGENT_GB >= BATCHER_RAM_BUDGET_GB;
  const holds = (host: string) =>
    host === "home" ? onHome : hosts.includes(host) && (ramOf.get(host) ?? 0) >= BATCHER_RAM_BUDGET_GB;
  const largest = [...hostsRam]
    .filter(([, ram]) => ram >= BATCHER_RAM_BUDGET_GB)
    .sort(([a, ramA], [b, ramB]) => ramB - ramA || (a < b ? -1 : 1))
    .map(([host]) => host)[0];
  // Kept where it runs while it still fits there (#211): a move restarts it.
  const runOn = current !== null && holds(current) ? current : onHome ? "home" : largest;
  if (runOn === undefined) return { batcher: null, why: "no host holds the batcher" };
  const operationsRam = hostsRam.map(([host, ram]) => (host === runOn ? ram - BATCHER_RAM_BUDGET_GB : ram));
  const ramGb = batchRamGb(operationsRam) * ramShare;
  const plan = batchPlan(figures, player, ramGb);
  if (plan === null) return { batcher: null, why: `no batch on ${target} fits the hosts' RAM, or it can't be hacked` };
  return {
    incomePerSecond: plan.incomePerSecond,
    ramGb,
    peakRamGb: plan.peakRamGb,
    batcher: {
      runOn,
      config: {
        target,
        figures,
        player: { intelligence: player.skills.intelligence, mults: player.mults },
        hosts: hostsRam.map(([host]) => host),
        hackShare: plan.hackShare,
        spacingMs: plan.spacingMs,
      },
    },
  };
}

/** How many targets, best by A1's batcher ceiling, `chooseBatcher` plans: a plan is costlier than a ceiling. */
export const BATCHER_TARGETS_PLANNED = 5;
/**
 * How far ahead `chooseBatcher` weighs a target's income (#206): what it earns in this long, less the time to prepare
 * it and for its first batch to land. A1's score is the best 10 minutes.
 */
export const BATCHER_TARGET_HORIZON_MS = 15 * 60_000;
/** How much more a new target must be worth over the horizon than the one batched to move to it: a move costs. */
export const BATCHER_MOVE_GAIN = 1.25;
/** The part of the hosts' RAM the next target is prepared on, while the batches have the rest. */
export const BATCHER_NEXT_RAM_SHARE = 0.2;
/**
 * The longest a target other than the one batched may take to earn and still be chosen (#216's review): under the
 * 10 minutes of `incomeStalled`, so a move or a start never leaves the brain long without income. Past it, it's prepared
 * as the next instead.
 */
export const BATCHER_MOST_IDLE_MS = 5 * 60_000;

/** A target `chooseBatcher` weighed: its plan's income, how long until it earns, and so its worth over the horizon. */
export interface BatcherTargetWorth {
  target: string;
  incomePerSecond: number;
  /** To prepare it from its money and security in the medium snapshot, then for a batch to land; 0 if batched now. */
  untilEarningMs: number;
  worth: number;
}

/**
 * The batcher's desired state with the brain's own target (#206), or why there's none. The candidates are the game's
 * servers rooted with money that the player can hack (`batcherTargetsOf`), the `BATCHER_TARGETS_PLANNED` best by A1's
 * batcher ceiling, the one sent and the one batched now. Each is planned (`planBatcher`) on the hosts, and its worth is
 * its plan's income over `BATCHER_TARGET_HORIZON_MS` less the time until it earns: preparing it (core's
 * `preparationTimeMs`, from its money and security in the medium snapshot), then a weaken's time for its first batch.
 * A target is prepared on the RAM the batches of the one batched now leave (#216's review), or all of it.
 * - **Never long without income (#184's lesson, #216's review):** the one batched now (`batching`, from the batcher's
 *   health) earns at once; any other is chosen only if it earns within `BATCHER_MOST_IDLE_MS`. With none such and
 *   nothing batched (a fresh start, a handover, a restart), the soonest to earn.
 * - **The move:** of those, the worthiest; the one sent is kept unless another is worth `BATCHER_MOVE_GAIN` times it.
 * - **The next:** of the rest, the one worth most once prepared (its income less a batch's weaken), if that's worth the
 *   move from the one chosen and it can be prepared on `BATCHER_NEXT_RAM_SHARE` of the RAM within the horizon: the
 *   batcher prepares it beside the batches, which are planned on the rest, and once it's prepared the same test moves
 *   to it, so its RAM never sits idle.
 */
export function chooseBatcher(
  staticData: StaticSnapshotData,
  mediumData: MediumSnapshotData,
  hosts: string[],
  current: BatcherState | null,
  batching: string | null,
): { batcher: BatcherState; worths: BatcherTargetWorth[] } | { batcher: null; why: string } {
  const player = hackingPlayerOf(mediumData.player);
  if (player === null) return { batcher: null, why: "the medium snapshot has no hacking figures for the player" };
  const targets = batcherTargetsOf(staticData, mediumData, player);
  if (targets.length === 0) return { batcher: null, why: "no rooted server with money the player can hack" };
  const byCeiling = targets
    .map(({ hostname, figures }) => ({
      hostname,
      figures,
      ceiling: batcherIncomePerGigabyteSecond(figures, player, 1),
    }))
    .sort((a, b) => b.ceiling - a.ceiling || (a.hostname < b.hostname ? -1 : 1));
  const sent = current?.config.target ?? null;
  const weighed = byCeiling.filter(
    (each, index) => index < BATCHER_TARGETS_PLANNED || each.hostname === batching || each.hostname === sent,
  );
  const nowOf = new Map(
    mediumData.servers
      .filter((server) => typeof server?.hostname === "string")
      .map((server) => [server.hostname, server] as const),
  );
  let firstWhy: string | null = null;
  const plans: { hostname: string; figures: HackingTarget; plan: PlannedBatcher }[] = [];
  for (const { hostname, figures } of weighed) {
    const plan = planBatcher(staticData, mediumData, hostname, hosts, current?.runOn ?? null);
    if (plan.batcher === null) firstWhy ??= plan.why;
    else plans.push({ hostname, figures, plan });
  }
  // The RAM a target is prepared on: what the batches of the one batched now leave, or all of it.
  const batchedPeakGb = plans.find((each) => each.hostname === batching)?.plan.peakRamGb ?? 0;
  const planned: Weighed[] = plans.map(({ hostname, figures, plan }) => {
    const server = nowOf.get(hostname);
    const now = {
      money: isNumber(server?.moneyAvailable) ? server.moneyAvailable : 0,
      security: isNumber(server?.hackDifficulty) ? server.hackDifficulty : figures.minDifficulty * 3,
    };
    const preparingGb = Math.max(plan.ramGb - batchedPeakGb, plan.ramGb * BATCHER_NEXT_RAM_SHARE);
    const firstBatchMs = operationTimeMs("weaken1", figures, player);
    const untilEarningMs =
      hostname === batching ? 0 : preparationTimeMs(figures, player, now, preparingGb) + firstBatchMs;
    const nextPrepareMs = preparationTimeMs(figures, player, now, plan.ramGb * BATCHER_NEXT_RAM_SHARE);
    return {
      state: plan.batcher,
      figures,
      ramGb: plan.ramGb,
      // Prepared beside the batches, on the next's part of the RAM, within the horizon; and its worth once it is.
      preparable: nextPrepareMs <= BATCHER_TARGET_HORIZON_MS,
      preparedWorth: plan.incomePerSecond * Math.max(0, BATCHER_TARGET_HORIZON_MS - firstBatchMs),
      weighed: {
        target: hostname,
        incomePerSecond: plan.incomePerSecond,
        untilEarningMs,
        worth: plan.incomePerSecond * Math.max(0, BATCHER_TARGET_HORIZON_MS - untilEarningMs),
      },
    };
  });
  if (planned.length === 0) return { batcher: null, why: firstWhy ?? "no target can be planned" };
  // Of those alike, or with none earning within the horizon, the soonest to earn.
  const byWorth = (a: Weighed, b: Weighed) =>
    b.weighed.worth - a.weighed.worth || a.weighed.untilEarningMs - b.weighed.untilEarningMs;
  const soon = planned.filter((each) => each.weighed.untilEarningMs <= BATCHER_MOST_IDLE_MS);
  const soonest = [...planned].sort((a, b) => a.weighed.untilEarningMs - b.weighed.untilEarningMs)[0] as Weighed;
  const worthiest = soon.length === 0 ? soonest : ([...soon].sort(byWorth)[0] as Weighed);
  const kept = soon.find((each) => each.weighed.target === sent);
  // Kept while nothing is worth the move; one worth nothing gives way (nothing is less than 0).
  const chosen =
    kept !== undefined && worthiest.weighed.worth < kept.weighed.worth * BATCHER_MOVE_GAIN ? kept : worthiest;
  const worths = planned.map((each) => each.weighed);
  // The next target: of the rest preparable beside the batches, the worthiest once prepared, if that's worth the move.
  const next = planned
    .filter((each) => each.preparable && each !== chosen)
    .sort((a, b) => b.preparedWorth - a.preparedWorth)[0];
  if (next === undefined || next.preparedWorth < chosen.weighed.worth * BATCHER_MOVE_GAIN) {
    return { batcher: chosen.state, worths };
  }
  const rest = planBatcher(
    staticData,
    mediumData,
    chosen.weighed.target,
    hosts,
    current?.runOn ?? null,
    1 - BATCHER_NEXT_RAM_SHARE,
  );
  if (rest.batcher === null) return { batcher: chosen.state, worths };
  const nextConfig = {
    target: next.weighed.target,
    figures: next.figures,
    ramGb: next.ramGb * BATCHER_NEXT_RAM_SHARE,
  };
  return { batcher: { ...rest.batcher, config: { ...rest.batcher.config, next: nextConfig } }, worths };
}

/** `planBatcher`'s plan, when there is one. */
type PlannedBatcher = Extract<ReturnType<typeof planBatcher>, { batcher: BatcherState }>;

/** A target `chooseBatcher` planned: its state, and how it weighs. */
interface Weighed {
  state: BatcherState;
  figures: HackingTarget;
  ramGb: number;
  preparable: boolean;
  preparedWorth: number;
  weighed: BatcherTargetWorth;
}

/**
 * The batcher's possible targets (#206): the game's servers (not purchased: never home, nor a cloud or Hacknet server)
 * rooted in the medium snapshot, with money and their figures in the static snapshot, that a hack takes something
 * from at the player's level (a share and a chance above 0).
 */
export function batcherTargetsOf(
  staticData: StaticSnapshotData,
  mediumData: MediumSnapshotData,
  player: HackingPlayer,
): { hostname: string; figures: HackingTarget }[] {
  const rooted = new Set(
    mediumData.servers
      .filter((server) => server?.hasAdminRights === true && typeof server.hostname === "string")
      .map((server) => server.hostname),
  );
  const targets: { hostname: string; figures: HackingTarget }[] = [];
  for (const server of staticData.servers) {
    const hostname = server?.hostname;
    if (typeof hostname !== "string" || server.purchasedByPlayer !== false || !rooted.has(hostname)) continue;
    const figures = figuresOf(staticData, hostname);
    if (figures === null || !(figures.moneyMax > 0)) continue;
    if (!(hackSharePerThread(figures, player) > 0) || !(hackChance(atMinimumOf(figures), player) > 0)) continue;
    targets.push({ hostname, figures });
  }
  return targets;
}

const atMinimumOf = (figures: HackingTarget) => ({
  hackDifficulty: figures.minDifficulty,
  requiredHackingSkill: figures.requiredHackingSkill,
});

/** The batcher on the dashboard (#205): the switch, what the brain sent, why nothing, and the health last reported. */
export interface BatcherView {
  enabled: boolean;
  /** Where it runs, its target and hosts, its share and spacing, as sent; null when none is. */
  sent: { runOn: string; target: string; hosts: number; hackShare: number; spacingMs: number } | null;
  /** Why none is sent while on (no snapshots yet, no target, no room), or null. */
  why: string | null;
  /** The batcher's health in the latest fast snapshot, or null. */
  health: BatcherHealth | null;
}

/** The view, from the switch, what was sent (or why not) and the latest fast snapshot's health. */
export function batcherViewOf(
  enabled: boolean,
  sent: BatcherState | null,
  why: string | null,
  health: BatcherHealth | null | undefined,
): BatcherView {
  return {
    enabled,
    sent:
      sent === null
        ? null
        : {
            runOn: sent.runOn,
            target: sent.config.target,
            hosts: sent.config.hosts.length,
            hackShare: sent.config.hackShare,
            spacingMs: sent.config.spacingMs,
          },
    why: enabled ? why : null,
    health: health ?? null,
  };
}

/**
 * Fast snapshots in a row whose deploy report says the batcher, wanted, isn't running (#211): then it's an alert,
 * `batcherNotRunning`, and a run report failure. The Agent tries again 2 rounds after a failed start, so a start that
 * fails once and then works shows in 2 at most; a host without the room, or without access, keeps failing.
 */
export const BATCHER_NOT_RUNNING_AFTER = 3;

/**
 * What a fast snapshot's `batcherDeploy` says (#211): null when the batcher isn't wanted, or runs; else why not (the
 * worker's problem, or "it isn't running"). The Agent's word, so checked as it's read.
 */
export function batcherNotRunning(deploy: unknown): string | null {
  if (typeof deploy !== "object" || deploy === null) return null;
  const { running, problem } = deploy as Record<string, unknown>;
  if (typeof problem === "string") return problem;
  return typeof running === "string" ? null : "it isn't running";
}

/**
 * The batcher out of step lately (#206), from fast snapshots' health, newest first: what its run's desyncs, late and
 * lost operations rose by over them, and the first snapshot that showed a rise; null with no rise. Only the newest
 * snapshot's run counts (a new run starts from 0). The Agent's word, so checked as it's read.
 */
export function batcherOutOfStep(
  newestFirst: { receivedAtMs: number; health: unknown }[],
): { sinceMs: number; target: string; desyncs: number; late: number; lost: number } | null {
  const countsOf = (health: unknown) => {
    const { runName, target, desyncs, late, lost } = (health ?? {}) as Record<string, unknown>;
    if (typeof runName !== "string" || ![desyncs, late, lost].every(isNumber)) return null;
    return { runName, target: typeof target === "string" ? target : "", desyncs, late, lost } as {
      runName: string;
      target: string;
      desyncs: number;
      late: number;
      lost: number;
    };
  };
  const newest = countsOf(newestFirst[0]?.health);
  if (newest === null) return null;
  const sum = (each: typeof newest) => each.desyncs + each.late + each.lost;
  let oldest = newest;
  let oldestAtMs = newestFirst[0]?.receivedAtMs ?? 0;
  let sinceMs: number | null = null;
  for (const { receivedAtMs, health } of newestFirst) {
    const each = countsOf(health);
    if (each === null || each.runName !== newest.runName) break;
    // A rise between this one and the newer one before it: the newer showed it first, going back.
    if (sum(each) < sum(oldest)) sinceMs = oldestAtMs;
    oldest = each;
    oldestAtMs = receivedAtMs;
  }
  const rise = {
    desyncs: newest.desyncs - oldest.desyncs,
    late: newest.late - oldest.late,
    lost: newest.lost - oldest.lost,
  };
  if (sinceMs === null || rise.desyncs + rise.late + rise.lost <= 0) return null;
  return { sinceMs, target: newest.target, ...rise };
}

/** The batcher's hosts (#205): all the hack loop's, its preparing ones included, which the hack loop then leaves. */
export function batcherHostsOf(hackLoop: { hosts: string[]; preparing?: { hosts: string[] } | null }): string[] {
  return [...hackLoop.hosts, ...(hackLoop.preparing?.hosts ?? [])];
}
