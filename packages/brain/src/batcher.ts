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
  isTargetPrepared,
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
export function hackingPlayerOf(player: unknown): HackingPlayer | null {
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
 * Where the batcher runs on `hosts`, their RAM, and the RAM its batches can count on there (`batchRamGb`), whatever the
 * target; or why it can't run. `planBatcher`'s, and `chooseBatcher`'s steps' (#274).
 */
function batcherRoomOf(
  mediumData: MediumSnapshotData,
  hosts: string[],
  current: string | null,
): { runOn: string; hostsRam: (readonly [string, number])[]; ramGb: number } | { why: string } {
  const ramOf = new Map(
    mediumData.servers
      .filter((server) => typeof server?.hostname === "string" && isNumber(server.maxRam))
      .map((server) => [server.hostname, server.maxRam]),
  );
  const hostsRam = hosts.map((host) => [host, ramOf.get(host) ?? 0] as const).filter(([, ram]) => ram > 0);
  if (hostsRam.length === 0) return { why: "no host with RAM" };
  const onHome = (ramOf.get("home") ?? 0) - HOME_KEPT_FOR_THE_AGENT_GB >= BATCHER_RAM_BUDGET_GB;
  const holds = (host: string) =>
    host === "home" ? onHome : hosts.includes(host) && (ramOf.get(host) ?? 0) >= BATCHER_RAM_BUDGET_GB;
  const largest = [...hostsRam]
    .filter(([, ram]) => ram >= BATCHER_RAM_BUDGET_GB)
    .sort(([a, ramA], [b, ramB]) => ramB - ramA || (a < b ? -1 : 1))
    .map(([host]) => host)[0];
  // Kept where it runs while it still fits there (#211): a move restarts it.
  const runOn = current !== null && holds(current) ? current : onHome ? "home" : largest;
  if (runOn === undefined) return { why: "no host holds the batcher" };
  const operationsRam = hostsRam.map(([host, ram]) => (host === runOn ? ram - BATCHER_RAM_BUDGET_GB : ram));
  return { runOn, hostsRam, ramGb: batchRamGb(operationsRam) };
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
  const room = batcherRoomOf(mediumData, hosts, current);
  if ("why" in room) return { batcher: null, why: room.why };
  const { runOn, hostsRam } = room;
  const ramGb = room.ramGb * ramShare;
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

/**
 * How far ahead `chooseBatcher` weighs a target's income (#206): what it earns in this long, less the time to prepare
 * it and for its first batch to land. A1's score is the best 10 minutes.
 */
export const BATCHER_TARGET_HORIZON_MS = 15 * 60_000;
/**
 * How many targets, best by A1's batcher ceiling, `chooseBatcher` plans of all, and of the steps (#274): a plan is
 * costlier than a ceiling, 0.1 to 4 ms on BN1's richest at hacking 1,300, and 365 ms on one whose hacking level is the
 * player's (its tiny share a thread, many threads to try). Every target prepared is planned too, whatever its rank.
 */
export const BATCHER_TARGETS_PLANNED = 5;
/**
 * How far ahead `chooseBatcher` weighs a next target (#274): what it earns in this long, less the time to prepare it on
 * the next's RAM and for its first batch to land; one that earns nothing in it isn't the next. Preparing it beside the
 * batches costs at most the next's share of their RAM, and none where they leave it idle, so it may take longer than
 * `BATCHER_TARGET_HORIZON_MS`: after an install every target but n00dles is at 3 times its minimum security, and in
 * BN1.3's exit run one weaken there took 17 to 32 minutes on the richest (its first batch 23 to 44 minutes away), past
 * the 15 minutes, so none was ever the next. A cycle there ran 28 minutes to 2.3 hours. That holds at BN1.3's speed
 * (about 2.4 times); at speed 1, ecorp's first batch after an install is about 102 minutes away, past the hour, but the
 * reach (`BATCHER_MOST_IDLE_MS`) binds first, and steps lead there.
 */
export const BATCHER_NEXT_HORIZON_MS = 60 * 60_000;
/** How much more a new target must be worth over the horizon than the one batched to move to it: a move costs. */
export const BATCHER_MOVE_GAIN = 1.25;
/**
 * The least part of the hosts' RAM the next target is prepared on, while the batches have the rest: all the batches
 * leave, if more (#237's review: n00dles' batches leave most of it idle).
 */
export const BATCHER_NEXT_RAM_SHARE = 0.2;
/**
 * The longest a move or a start may leave the brain without income (#216's review), under the 10 minutes of
 * `incomeStalled`: with nothing batched, a target is chosen only if it earns within it; while one earns, only once
 * it's prepared (#236), and only if its first batch lands within it of the batches out (#237's review). Past it, it's
 * neither moved to nor sent as the next (#274); a step within it is, on the way.
 */
export const BATCHER_MOST_IDLE_MS = 5 * 60_000;
/**
 * The run report fails a move that left the batcher this long without a hack (#236): from the last hack on the target
 * before to the first on the new one, twice what the brain allows a move, so a repeat of run #2's 25 minutes can't
 * hide inside "income stalled".
 */
export const BATCHER_MOVE_IDLE_FAILS_AFTER_MS = 2 * BATCHER_MOST_IDLE_MS;

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
 * servers rooted with money that the player can hack (`batcherTargetsOf`): the `BATCHER_TARGETS_PLANNED` best by A1's
 * batcher ceiling, the one sent, its next and the one batched now, and since #274 every one prepared now (only one
 * prepared can be moved to while one earns) and the steps. The steps are the `BATCHER_TARGETS_PLANNED` best by the
 * ceiling of those that might be the next (#278's review): a move from the one batched can reach them (a weaken at
 * their minimum within `BATCHER_MOST_IDLE_MS` of its; with nothing batched, a weaken within it, as a target chosen then
 * must earn within it), they earn within `BATCHER_NEXT_HORIZON_MS` on the next's RAM, and at twice A1's ceiling they'd
 * be worth the move and gain more than the batches lose. On a move, or with nothing batched, the steps from the one
 * chosen too. In BN1.3's exit run the 5 best were all a weaken at 3 times their minimum past the horizon, and the mid
 * targets that led to them were never weighed. Each is planned (`planBatcher`) on the hosts, and its worth is its
 * plan's income over `BATCHER_TARGET_HORIZON_MS` less the time until it earns: preparing it (core's
 * `preparationTimeMs`, from its money and security in the medium snapshot), then a weaken's time for its first batch.
 * A target is prepared on the RAM the batches of the one batched now leave (#216's review), or all of it.
 * - **Never long without income (#184's lesson, #216's review):** the one batched now (`batching`, from the batcher's
 *   health) earns at once; with nothing batched (a fresh start, a handover, a restart), another is chosen only if it
 *   earns within `BATCHER_MOST_IDLE_MS`, or with none such, the soonest to earn.
 * - **Earning through a move (#236):** while one earns (batched), another is chosen only once it's prepared (at its
 *   minimum security and maximum money in the medium snapshot), so its first batch is a weaken away and the batches out
 *   land meanwhile: within `BATCHER_MOST_IDLE_MS` of their weaken (#237's review: a weaken of over 5 minutes doesn't
 *   leave 5 minutes idle). One still to prepare, that a move could reach, is the next instead, prepared beside the
 *   batches: a move to it never stops the income while it's prepared, as it did in run #2.
 * - **The move:** of those, the worthiest; the one sent is kept unless another is worth `BATCHER_MOVE_GAIN` times it.
 * - **The next:** of the rest worth the move from the one chosen once prepared (its income over the horizon less a
 *   batch's weaken), and that a move from it could reach once prepared (a weaken at its minimum within
 *   `BATCHER_MOST_IDLE_MS` of the chosen one's; #274: before, a next past it was prepared, kept and never moved to
 *   while that one earned), those earning within `BATCHER_NEXT_HORIZON_MS` on its RAM (#274: within
 *   `BATCHER_TARGET_HORIZON_MS` before, which no weaken at 3 times the minimum of BN1's richest met) whose gain over
 *   the chosen one after that, over the hour, is more than its batches lose meanwhile on four fifths of the RAM (#278's
 *   review: nothing where they leave a fifth idle); of them, the one worth most over the hour, its income less the time
 *   until it earns. Its RAM: while the chosen one earns, what its batches leave, at least `BATCHER_NEXT_RAM_SHARE` of
 *   it (#237's review); otherwise that share alone, as the chosen one prepares on the rest (#237's re-review). The
 *   batcher prepares it beside the batches, which are planned on the rest, and once it's prepared the same test moves
 *   to it, so its RAM never sits idle. So a target worth a path from the one batched (worth the move once prepared,
 *   reachable, earning within the hour and worth its cost) gets a move or a next, a step at least: from n00dles to
 *   BN1's richest, a mid target first (#274's property test, batcher-choice.property.test.ts).
 * - **The limit that remains:** a richer target whose weaken is more than `BATCHER_MOST_IDLE_MS` past the batched one's
 *   is reached only through a chain of steps, each worth a path from the last; with no such chain, it isn't. At speed 1
 *   and hacking 1,300, alpha-ent's weaken is 6.9 minutes and clarkinc's 12.3: from n00dles, clarkinc is a chain away.
 * - **The next sent is kept** unless another is worth `BATCHER_MOVE_GAIN` times it over the hour (#236): a next dropped
 *   wastes its waves out, which hold their RAM for a weaken's time at its security. While it's still worth the move and
 *   reachable it stays a candidate, even if it no longer earns within the hour or gains enough (#278's review: hosts
 *   lost, as at 01:00 in BN1.3's exit run, 424 to 261 TB).
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
  const sentNext = current?.config.next?.target ?? null;
  const serverOf = new Map(
    mediumData.servers
      .filter((server) => typeof server?.hostname === "string")
      .map((server) => [server.hostname, server] as const),
  );
  const nowOf = (hostname: string, figures: HackingTarget) => {
    const server = serverOf.get(hostname);
    return {
      money: isNumber(server?.moneyAvailable) ? server.moneyAvailable : 0,
      security: isNumber(server?.hackDifficulty) ? server.hackDifficulty : figures.minDifficulty * 3,
    };
  };
  const weakenOf = (figures: HackingTarget) => operationTimeMs("weaken1", figures, player);
  const runOn = current?.runOn ?? null;
  let firstWhy: string | null = null;
  const plans = new Map<string, PlannedBatcher | null>();
  const planOf = (hostname: string) => {
    if (!plans.has(hostname)) {
      const plan = planBatcher(staticData, mediumData, hostname, hosts, runOn);
      if (plan.batcher === null) firstWhy ??= plan.why;
      plans.set(hostname, plan.batcher === null ? null : plan);
    }
    return plans.get(hostname) ?? null;
  };
  /** What a target's batches lose a second on four fifths of the RAM, as they do while a next is prepared (#278). */
  const lostPerSecondOf = (hostname: string, incomePerSecond: number) => {
    const rest = planBatcher(staticData, mediumData, hostname, hosts, runOn, 1 - BATCHER_NEXT_RAM_SHARE);
    return rest.batcher === null ? incomePerSecond : Math.max(0, incomePerSecond - rest.incomePerSecond);
  };
  const room = batcherRoomOf(mediumData, hosts, runOn);
  const ramGb = "why" in room ? 0 : room.ramGb;
  /**
   * The steps (#274): the `BATCHER_TARGETS_PLANNED` best by the ceiling that might be the next from `from` (with none,
   * a target chosen with nothing batched, which earns within BATCHER_MOST_IDLE_MS of none): a move reaches them (a
   * weaken at their minimum within BATCHER_MOST_IDLE_MS of its), they earn within BATCHER_NEXT_HORIZON_MS on `share`
   * of the RAM (#278's review), and at twice A1's ceiling on the RAM (plans came to 17 to 94% of it) they'd be worth
   * the move once prepared and gain more than the batches lose meanwhile. The best by the ceiling may be none of them.
   */
  const stepsFrom = (
    from: { hostname: string; incomePerSecond: number; worth: number; lostPerSecond: number } | null,
    share: number,
  ) => {
    const fromWeakenMs = from === null ? 0 : weakenOf(figuresOf(staticData, from.hostname) as HackingTarget);
    return byCeiling
      .filter(({ hostname, figures, ceiling }) => {
        if (hostname === from?.hostname) return false;
        const weakenMs = weakenOf(figures);
        if (weakenMs - fromWeakenMs > BATCHER_MOST_IDLE_MS) return false;
        const mostIncome = 2 * ceiling * ramGb;
        if (from !== null) {
          const mostWorth = mostIncome * Math.max(0, BATCHER_TARGET_HORIZON_MS - weakenMs);
          if (mostWorth < from.worth * BATCHER_MOVE_GAIN) return false;
        }
        const untilMs = preparationTimeMs(figures, player, nowOf(hostname, figures), ramGb * share) + weakenMs;
        if (!(untilMs < BATCHER_NEXT_HORIZON_MS)) return false;
        if (from === null) return true;
        const mostGain = (mostIncome - from.incomePerSecond) * (BATCHER_NEXT_HORIZON_MS - untilMs);
        return mostGain > from.lostPerSecond * untilMs;
      })
      .slice(0, BATCHER_TARGETS_PLANNED)
      .map(({ hostname }) => hostname);
  };
  // The one batched first: what its batches leave is the RAM a target is prepared on, and where the steps start.
  const batchedPlan = batching === null ? null : planOf(batching);
  const batchedPeakGb = batchedPlan?.peakRamGb ?? 0;
  const steps =
    batchedPlan === null || batching === null
      ? stepsFrom(null, BATCHER_NEXT_RAM_SHARE)
      : stepsFrom(
          {
            hostname: batching,
            incomePerSecond: batchedPlan.incomePerSecond,
            worth: batchedPlan.incomePerSecond * BATCHER_TARGET_HORIZON_MS,
            lostPerSecond: lostPerSecondOf(batching, batchedPlan.incomePerSecond),
          },
          Math.max(BATCHER_NEXT_RAM_SHARE, 1 - batchedPlan.peakRamGb / batchedPlan.ramGb),
        );
  const weigh = (hostname: string, figures: HackingTarget, plan: PlannedBatcher): Weighed => {
    const now = nowOf(hostname, figures);
    const preparingGb = Math.max(plan.ramGb - batchedPeakGb, plan.ramGb * BATCHER_NEXT_RAM_SHARE);
    const firstBatchMs = weakenOf(figures);
    const untilEarningMs =
      hostname === batching ? 0 : preparationTimeMs(figures, player, now, preparingGb) + firstBatchMs;
    return {
      state: plan.batcher,
      figures,
      now,
      ramGb: plan.ramGb,
      peakRamGb: plan.peakRamGb,
      firstBatchMs,
      prepared: isTargetPrepared(figures, now),
      // Its worth once prepared.
      preparedWorth: plan.incomePerSecond * Math.max(0, BATCHER_TARGET_HORIZON_MS - firstBatchMs),
      weighed: {
        target: hostname,
        incomePerSecond: plan.incomePerSecond,
        untilEarningMs,
        worth: plan.incomePerSecond * Math.max(0, BATCHER_TARGET_HORIZON_MS - untilEarningMs),
      },
    };
  };
  const weighedOf = new Map<string, Weighed>();
  const weighAll = (names: (string | null)[]) => {
    for (const { hostname, figures } of byCeiling) {
      if (weighedOf.has(hostname) || !names.includes(hostname)) continue;
      const plan = planOf(hostname);
      if (plan !== null) weighedOf.set(hostname, weigh(hostname, figures, plan));
    }
  };
  weighAll(
    byCeiling
      .filter(
        ({ hostname, figures }, index) =>
          index < BATCHER_TARGETS_PLANNED ||
          [batching, sent, sentNext, ...steps].includes(hostname) ||
          isTargetPrepared(figures, nowOf(hostname, figures)),
      )
      .map(({ hostname }) => hostname),
  );
  const planned = [...weighedOf.values()];
  if (planned.length === 0) return { batcher: null, why: firstWhy ?? "no target can be planned" };
  // While one earns, it or one prepared (#236); of those, the worthiest earning soon; with none such, the soonest.
  const earning = planned.find((each) => each.weighed.target === batching);
  const movable = earning === undefined ? planned : planned.filter((each) => each === earning || each.prepared);
  // Idle, a move from the one earning: the new one's weaken, less the batches out landing meanwhile (#237's review).
  const idleMs = (each: Weighed) =>
    earning === undefined || each === earning
      ? each.weighed.untilEarningMs
      : Math.max(0, each.firstBatchMs - earning.firstBatchMs);
  const soon = movable.filter((each) => idleMs(each) <= BATCHER_MOST_IDLE_MS);
  const soonest = [...planned].sort((a, b) => a.weighed.untilEarningMs - b.weighed.untilEarningMs)[0] as Weighed;
  const worthiest =
    soon.length === 0 ? soonest : ([...soon].sort((a, b) => b.weighed.worth - a.weighed.worth)[0] as Weighed);
  const kept = soon.find((each) => each.weighed.target === sent);
  // Kept while nothing is worth the move; one worth nothing gives way (nothing is less than 0).
  const chosen =
    kept !== undefined && worthiest.weighed.worth < kept.weighed.worth * BATCHER_MOVE_GAIN ? kept : worthiest;
  // The next target's RAM: what the chosen one's batches leave, at least BATCHER_NEXT_RAM_SHARE of it (#237's review),
  // while it's the one earning; otherwise (nothing batched yet, or a move to it under way) a fifth, as it has its own
  // preparation to do on the rest (#237's re-review). The batches are planned on four fifths as before: the same plan
  // as on their peak, where that is less.
  const leftShare = 1 - chosen.peakRamGb / chosen.ramGb;
  const nextShare = chosen === earning ? Math.max(BATCHER_NEXT_RAM_SHARE, leftShare) : BATCHER_NEXT_RAM_SHARE;
  const nextGb = (each: Weighed) => each.ramGb * nextShare;
  const chosenName = chosen.weighed.target;
  const lostPerSecond = lostPerSecondOf(chosenName, chosen.weighed.incomePerSecond);
  // A move now, or none batched: the steps from the one chosen too (#278's review), as the next is reached from it.
  if (chosen !== earning) {
    const from = { hostname: chosenName, ...chosen.weighed, lostPerSecond };
    weighAll(stepsFrom(from, nextShare));
  }
  const worths = byCeiling.flatMap(({ hostname }) => weighedOf.get(hostname)?.weighed ?? []);
  const untilNextEarnsMs = (each: Weighed) =>
    preparationTimeMs(each.figures, player, each.now, nextGb(each)) + each.firstBatchMs;
  // Of the rest worth the move from the chosen one once prepared and that the move can reach from it (a weaken within
  // BATCHER_MOST_IDLE_MS of its), those earning within BATCHER_NEXT_HORIZON_MS whose gain over the chosen one after
  // that, over the hour, is more than its batches lose on four fifths of the RAM meanwhile (#278's review); of them,
  // the worthiest over the hour. A gain above 0 is one within the hour: worth the move once prepared, it earns more
  // than the chosen one. The one sent is kept unless another is worth BATCHER_MOVE_GAIN times it (#236), even
  // if it no longer earns within the hour or gains (#278's review: hosts lost), its waves out.
  const nextTargetCandidates = [...weighedOf.values()]
    .filter(
      (each) =>
        each !== chosen &&
        each.preparedWorth >= chosen.weighed.worth * BATCHER_MOVE_GAIN &&
        each.firstBatchMs - chosen.firstBatchMs <= BATCHER_MOST_IDLE_MS,
    )
    .map((each) => {
      const untilMs = untilNextEarnsMs(each);
      const afterMs = Math.max(0, BATCHER_NEXT_HORIZON_MS - untilMs);
      const gain = (each.weighed.incomePerSecond - chosen.weighed.incomePerSecond) * afterMs - lostPerSecond * untilMs;
      return { each, worth: each.weighed.incomePerSecond * afterMs, gain };
    })
    .filter(({ each, gain }) => each.weighed.target === sentNext || gain > 0)
    .sort((a, b) => b.worth - a.worth);
  const keptNext = nextTargetCandidates.find(({ each }) => each.weighed.target === sentNext);
  const worthiestNext = nextTargetCandidates[0];
  const next =
    keptNext !== undefined && worthiestNext !== undefined && worthiestNext.worth < keptNext.worth * BATCHER_MOVE_GAIN
      ? keptNext.each
      : worthiestNext?.each;
  if (next === undefined) return { batcher: chosen.state, worths };
  const rest = planBatcher(staticData, mediumData, chosenName, hosts, runOn, 1 - BATCHER_NEXT_RAM_SHARE);
  if (rest.batcher === null) return { batcher: chosen.state, worths };
  const nextConfig = { target: next.weighed.target, figures: next.figures, ramGb: nextGb(next) };
  return { batcher: { ...rest.batcher, config: { ...rest.batcher.config, next: nextConfig } }, worths };
}

/** `planBatcher`'s plan, when there is one. */
type PlannedBatcher = Extract<ReturnType<typeof planBatcher>, { batcher: BatcherState }>;

/** A target `chooseBatcher` planned: its state, and how it weighs. */
interface Weighed {
  state: BatcherState;
  figures: HackingTarget;
  /** Its money and security in the medium snapshot. */
  now: { money: number; security: number };
  /** The RAM its plan is on, and its plan's peak. */
  ramGb: number;
  peakRamGb: number;
  /** A weaken's time at its minimum security: from a first batch's start to its hack. */
  firstBatchMs: number;
  /** At its minimum security and maximum money in the medium snapshot: batches can start at once (#236). */
  prepared: boolean;
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
