// agent/<deploymentId>/batcher.js: the batcher (#204, M4 phase A slice A7a), a reflex (architecture §5.5). Its config
// (core's `BatcherConfig`): the target and its figures, the player's multipliers, the hosts, the share a batch hacks
// and the spacing between batches, chosen by the brain from core's `batchPlan` (#205), and the next target to prepare
// (#206). It never decides strategy; it times and launches, and checks what lands. Design: #204.
// - **Its config, hot (#205):** with no argument, as the Agent's `batcher-deploy.js` starts it, it re-reads its config
//   from its config port every loop, where the Agent writes the desired state's (architecture §5.5): a new share,
//   spacing or player applies from the next batch; new hosts get the operation scripts. A new target (#206) is a move:
//   the batches out keep theirs and land, hacks and all, while the new one is prepared beside them (at once if it was
//   the next target, prepared already). With none there yet, or one it can't read, it says so and waits. Given its
//   config as its argument (#204's tests), it keeps that one.
// - **After another batcher (#205):** it waits for the latest landing the one before it last published, so its first
//   operations don't find the hosts' RAM still held, and publishes that time as its own until it's past, so one
//   started while it waits waits too (#211).
// - **Preparing:** while the target isn't at its minimum security and maximum money, a wave at a time (core's
//   `preparationWave`), once the last has landed: weaken, grow and weaken, landing in that order, on the room beside
//   the most it holds until the wave lands (`roomForWave`, #236). A last wave on a target at its minimum security, with
//   room beside it for the batches, starts them at once (#206).
// - **Starting to batch (#236):** the first batch waits only for what's in flight on its own target, never another's
//   (a dropped next target's long weaken held run #2's moves for 11 and 9 minutes). While it waits for its own, or no
//   batch fits the RAM, a problem says why ("no batch on … fits the RAM yet: …"): never a silent `batching`.
// - **The next target (#206):** the config's `next`, prepared the same way on at most its RAM, beside the batches.
// - **Batching:** a batch's hack lands every spacing, its weaken, grow and weaken δ apart after it. Each operation is
//   started just in time, its hold before it lands (core's `batchOrders`), on the hosts' free RAM (`placeThreads`),
//   and lands itself (../workers/batch-operation.ts). A batch's threads are planned when its first weaken goes out,
//   and its hack threads replanned when its hack does (`hackThreadsAtLaunch`), at the hacking level then; the hack goes
//   out only if the rest did and the target is within the bounds of every batch still landing (`batchBounds`). Each
//   operation's lead covers the security the largest batch still landing may leave (#206).
// - **Fitted to the RAM (#232):** a batch is planned only as large as the hosts' RAM holds beside all else it will
//   hold at once (core's `largestBatchThatFits`: the parts in flight, the orders of the batches planned, the share
//   threads), counted a thread short on each host (`batchRamGb`): fewer hack threads, or none that time, never short of
//   the RAM it counts. A new plan, or batches planned at a lower hacking level, may hold more than the plan's peak for
//   a while.
// - **Waiting for RAM that frees late (#246):** an operation that finds no room at its time waits for it, tried again
//   every `BATCH_RAM_WAIT_LOOK_MS` (alone, when the time wakes it), while core's `mayStillStart` allows: up to
//   `BATCH_RAM_WAIT_MS` past its time (half the fixed lead), and a grow or weaken only with time to land on it. Its
//   batch's RAM may free late: a landing's call ends on a timer (NetscriptHelpers.tsx:419-432), its RAM freed as its
//   script is torn down after (killWorkerScript.ts:124), and on a busy page that timer fires late while the batcher,
//   woken by an earlier landing's record, starts orders fitted to that RAM. Past the wait, the batch is short. Its
//   health keeps the last few waits and shorts, each with what held the RAM (core's `ramHeldOf`): at a wait's first
//   look, as a short gave up.
// - **Checked, loudly:** every landing is recorded on the landing port, cleared when it starts; each id starts with
//   this run's name, so a previous run's records are only counted (unexpected), never trusted. One before a landing
//   already recorded on its target is out of order (#236: a move's batches land among another target's), one started
//   too late is late, one never recorded is lost. Out of order, or the target outside the bounds at a hack, is a
//   desync: no more hacks or batches, and once nothing is in flight, it prepares the target again.
// - **The money after each grow (#234):** once all of a batch's grow parts have landed, and nothing has landed on its
//   target since but its own weaken2, it looks at the target's money (core's `GrowLandingWatch`): one below the
//   maximum is counted (`moneyLooksBelowFull`), a grow short of the hack before it, so the batches would drift toward
//   the bounds' floor. A grow it can't look at so is counted (`growsNotLooked`, #235's review), and so are those that
//   land while it recovers from a desync, whose money isn't the grow's doing.
// - **Sharing (#224):** while its config asks (the brain's switch on, faction work going on) and it's batching, once the
//   batches' orders due and the waves are out, a round of `batch-share.js` (one `ns.share()`, 10 s) on its hosts' free
//   RAM less the config's reserve for the batches and the next target, and on home's above what it keeps for the Agent,
//   to at most 80% of their RAM in use (core's `shareRound`), and never the RAM the batches planned will hold over its
//   10 s (#232): a round at most every 5 s, looking again soon after one finds no room. None while a last preparation
//   wave still lands, nor until the batches planned meanwhile, whose leads it lengthens, have landed (#226's review);
//   none for a minute after a batch came up short (legacy daemon.js shares only with every batch scheduled). No wave
//   starts while share threads still hold RAM (10 s at most), so a move or a desync's preparation has all of it. A
//   batch trimmed that the share's threads on its hosts made smaller is counted apart, the share's (#232's review).
// - **Health:** core's `BatcherHealth`, on its health port whenever it changes, and in its log every minute and at each
//   change of state or of its problem, or anything wrong.
// - **On the page's monotonic clock (#251):** every schedule, wait, landing and duration is timed on
//   `performance.now()` (../clock.ts), as are the landings it hands its operations and the latest it publishes for
//   the next batcher: a step in the PC's clock (run #3's +2.7 s gave 1,615 desyncs) moves none of them. The stamps
//   the brain reads are the wall clock's (`Date.now()`), each marked so: its health's time, each wait's and short's,
//   the last hack's landing, and the times its problems name.
// RAM (unchanged by sharing: `exec` and `scp` were already counted): `exec` 1.3 + `scp` 0.6 +
// `getServerMoneyAvailable` and `getServerSecurityLevel` 0.1 each + `getServerMaxRam`, `getServerUsedRam` and
// `getHackingLevel` 0.05 each; ports and `asleep` are free (ram-budget.json).
import {
  BATCH_GROW_SCRIPT_NAME,
  BATCH_HACK_SCRIPT_NAME,
  BATCH_LANDING_GAP_MS,
  BATCH_LAUNCH_LEAD_MS,
  BATCH_RAM_RELEASE_MS,
  BATCH_RAM_WAIT_LOOK_MS,
  BATCH_WEAKEN_SCRIPT_NAME,
  BATCHER_CONFIG_PORT,
  BATCHER_HEALTH_PORT,
  BATCHER_LANDING_PORT,
  type BatcherConfig,
  type BatcherHealth,
  type BatchOperation,
  type BatchThreads,
  batchBounds,
  batchHoldsMs,
  batchOrders,
  batchPeakRamGb,
  batchRamGb,
  batchRamHolds,
  batchThreads,
  fitBatch,
  GrowLandingWatch,
  type HackingPlayer,
  type HostRam,
  hackSharePerThread,
  hackThreadsAtLaunch,
  hackThreadsForShare,
  hackWaitsForItsBatch,
  isOutsideBounds,
  isTargetPrepared,
  LandingWatch,
  type LaunchOrder,
  landingOffsetMs,
  mayStillStart,
  mostRamHeldGb,
  newBatcherHealth,
  operationRamGb,
  operationScriptName,
  operationTimeMs,
  parseBatcherConfig,
  parseLandingRecord,
  placeThreads,
  preparationWave,
  type RamHeld,
  type RamHold,
  ramHeldOf,
  recordGrowsNotLooked,
  recordHackLanded,
  recordMoneyLook,
  recordRamWait,
  recordShort,
  SHARE_RAM_GB,
  SHARE_ROUND_MS,
  SHARE_SCRIPT_NAME,
  SHARE_TIME_MS,
  type SharingHealth,
  shareBonus,
  shareRamByHost,
  shareRamHolds,
  shareReleasedAt,
  shareRound,
} from "@bitburner-agent/core";
import { monotonicMs, wallClockMsOf } from "../clock.ts";
import type { NS } from "../ns.ts";

/** The longest the batcher sleeps, with nothing due: its log's health line comes at least this often. */
const HEALTH_LINE_EVERY_MS = 60_000;
/** While preparing, how often it looks again: a wave in flight lands well within it. */
const PREPARING_LOOK_EVERY_MS = 1_000;
/**
 * A share thread counts as running this long after it's started (#224): its call's 10 s. It ends a moment later (its
 * start's lag), and the next round can't take its RAM before: so the count never adds a round to the one it replaces.
 */
const SHARE_HELD_MS = SHARE_TIME_MS;
/** A look for share room that found none looks again this soon: a round's threads end, and free their RAM, at once. */
const SHARE_LOOK_AGAIN_MS = 100;
/** No round this long after a batch came up short of RAM (#226's review): the batches come first. */
const SHARE_AFTER_SHORT_MS = 60_000;
/** No batch fitting for a minute after the last is a problem (#237's review); before the first, at once (#236). */
const WAITING_PROBLEM_AFTER_MS = 60_000;
/** A next target with no room for a wave this long is a problem (#236): the brain moves to it only once it's ready. */
const NEXT_WITHOUT_ROOM_PROBLEM_AFTER_MS = 60_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  if (ns.args.length === 0) {
    await runBatcher(ns, () => configFromPort(ns));
    return;
  }
  let parsed: ReturnType<typeof parseBatcherConfig>;
  try {
    parsed = parseBatcherConfig(JSON.parse(String(ns.args[0])));
  } catch {
    parsed = { ok: false, reason: "its argument isn't JSON" };
  }
  if (!parsed.ok) {
    // A stamp the brain reads: the wall clock (#251).
    const health = newBatcherHealth("", "", Date.now());
    health.problem = `can't run: ${parsed.reason}`;
    publish(ns, health, true);
    return;
  }
  const fixed = parsed.config;
  await runBatcher(ns, () => ({ ok: true, config: fixed }));
}

/** The config on its port (#205), parsed, or null with none there. */
function configFromPort(ns: NS): ReturnType<typeof parseBatcherConfig> | null {
  const data = ns.peek(BATCHER_CONFIG_PORT);
  return data === "NULL PORT DATA" ? null : parseBatcherConfig(data);
}

/**
 * The latest landing a batcher before this one last published (#205), on the monotonic clock, or 0. One from a batcher
 * before #251 is the wall clock's, far nearer `Date.now()` than `performance.now()` (a page's age): read as such, it's
 * as far off as it was, a step since and all, not some 56 years.
 */
function previousLatestLandAt(ns: NS): number {
  const previous = ns.peek(BATCHER_HEALTH_PORT) as { latestLandAt?: unknown } | null;
  const latest = typeof previous === "object" && previous !== null ? previous.latestLandAt : null;
  if (typeof latest !== "number" || !Number.isFinite(latest)) return 0;
  const onWallClock = Math.abs(latest - Date.now()) < Math.abs(latest - monotonicMs());
  return onWallClock ? latest - Date.now() + monotonicMs() : latest;
}

/** The health on its port, and in the log when `logIt`. */
function publish(ns: NS, health: BatcherHealth, logIt: boolean): void {
  // A stamp the brain reads: the wall clock (#251).
  health.atMs = Date.now();
  ns.clearPort(BATCHER_HEALTH_PORT);
  ns.writePort(BATCHER_HEALTH_PORT, { ...health });
  if (logIt) ns.print(`batcher: ${JSON.stringify(health)}`);
}

/**
 * A batch planned: its target and figures (a new config's target lets it finish), its threads, the share its hack was
 * planned to take, and whether an operation didn't fit.
 */
interface PlannedBatch {
  target: string;
  figures: BatcherConfig["figures"];
  threads: BatchThreads;
  plannedShare: number;
  short: boolean;
}

/** Problems the config gives, which clear once it reads. */
const NO_CONFIG = "no config on its port yet";
const UNREADABLE_CONFIG = "its config can't be read";

async function runBatcher(ns: NS, readConfig: () => ReturnType<typeof parseBatcherConfig> | null): Promise<void> {
  // This run's name: a previous batcher's operations, still landing, write ids that can't match its own.
  const runName = Math.floor(Math.random() * 2 ** 40).toString(36);
  const waitUntilMs = previousLatestLandAt(ns);
  // A stamp the brain reads: the wall clock (#251).
  const health = newBatcherHealth("", runName, Date.now());
  ns.clearPort(BATCHER_LANDING_PORT);
  let logNow = true;
  /** Sets the problem, logging it when it changes; null clears it. */
  const setProblem = (problem: string | null) => {
    if (health.problem !== problem) logNow = true;
    health.problem = problem;
  };
  const folder = ns.getScriptName().slice(0, ns.getScriptName().lastIndexOf("/") + 1);
  const files = [BATCH_HACK_SCRIPT_NAME, BATCH_GROW_SCRIPT_NAME, BATCH_WEAKEN_SCRIPT_NAME].map((name) => folder + name);
  let config: BatcherConfig | null = null;
  /** The config read last: only called once one has been. */
  const current = () => config as BatcherConfig;
  let hosts: string[] = [];
  /** The hosts the share script (#224) couldn't be copied to: copied apart, so a host without it still batches. */
  let unsharedHosts = new Set<string>();
  /** What stays wrong while the hosts do: hosts it couldn't copy its scripts to. Other problems clear back to it. */
  let lastingProblem: string | null = null;
  const landings = new LandingWatch();
  /** Each batch's grow, until all its parts have landed and the target's money is looked at (#234). */
  const growLandings = new GrowLandingWatch();
  /**
   * Each operation's part started and not yet recorded (#232): its host, RAM and landing, which hold that RAM until
   * then. With the share threads, the RAM of the batcher's own on its hosts; the rest of what's used there isn't.
   */
  const parts = new Map<string, { host: string; gb: number; landAt: number; target: string }>();
  /**
   * The parts of the target's preparation wave, and of the next target's (#206), not yet recorded: the next wave of
   * each starts once its last has landed, whatever else is in flight.
   */
  let preparing = new Set<string>();
  let preparingNext = new Set<string>();
  let nextWave = 0;
  const playerNow = (): HackingPlayer => ({
    skills: { hacking: ns.getHackingLevel(), intelligence: current().player.intelligence },
    mults: current().player.mults,
  });
  const freeRam = (): HostRam[] =>
    hosts.map((host) => ({ host, freeGb: ns.getServerMaxRam(host) - ns.getServerUsedRam(host) }));

  /**
   * Starts an operation's threads on the free RAM, landing at `landAt`, each part's id added to `wave` when given (a
   * preparation wave waits for its own; a batch's grow is looked at once its own have landed, #234). Whether they all
   * started; if not, the host whose `exec` failed, or null when the hosts hadn't the room and none started (#246).
   */
  const launch = (
    operation: BatchOperation,
    threads: number,
    landAt: number,
    id: string,
    target: string,
    wave?: Set<string>,
  ): { started: boolean; failedOn: string | null } => {
    const placed = placeThreads(freeRam(), threads, operationRamGb(operation));
    if (placed === null) return { started: false, failedOn: null };
    for (const [part, { host, threads: partThreads }] of placed.entries()) {
      const partId = `${runName}.${id}.${part}`;
      const options = { threads: partThreads, temporary: true };
      if (
        ns.exec(folder + operationScriptName(operation), host, options, target, landAt, BATCHER_LANDING_PORT, partId)
      ) {
        landings.expect(partId, landAt, target);
        parts.set(partId, { host, gb: partThreads * operationRamGb(operation), landAt, target });
        wave?.add(partId);
      } else {
        return { started: false, failedOn: host };
      }
    }
    return { started: true, failedOn: null };
  };

  const desync = () => {
    health.desyncs += 1;
    logNow = true;
    if (health.state === "batching") health.state = "recovering";
  };

  /**
   * The RAM of its operations whose records it drained in this wake, by host, and the latest of their landings (#246's
   * review): woken by a late landing's record, it acts before that landing's script is torn down, so its RAM is still
   * held. Null with none drained.
   */
  let drainedGbByHost = new Map<string, number>();
  let landingLagMs: number | null = null;

  /** Every record on the landing port, checked. Ids are `<run>.<batch>.<operation>.<part>`. */
  const drainLandings = () => {
    drainedGbByHost = new Map();
    landingLagMs = null;
    for (;;) {
      const data = ns.readPort(BATCHER_LANDING_PORT);
      if (data === "NULL PORT DATA") {
        // Each order waiting for room (#246's review): a landing late while it waits is RAM freed late.
        for (const held of waitingForRam.values()) {
          if (held !== null && landingLagMs !== null) {
            held.landingLagMs = Math.max(held.landingLagMs ?? landingLagMs, landingLagMs);
          }
        }
        // Woken by each record as it's written, so these are all that have landed (#234). No new NS call: no more RAM.
        const { due, notLooked } = growLandings.takeDue();
        // While it recovers from a desync (#235's review), the money isn't the grows' doing: not looked at.
        const recovering = health.state === "recovering";
        recordGrowsNotLooked(health, notLooked + (recovering ? due.length : 0));
        if (!recovering) {
          for (const { target, moneyMax } of due) {
            recordMoneyLook(health, target, ns.getServerMoneyAvailable(target), moneyMax);
          }
        }
        return;
      }
      const record = parseLandingRecord(data);
      if (record === null) {
        setProblem(`an unreadable landing record: ${JSON.stringify(data)}`);
        continue;
      }
      const { outOfOrder, expected } = landings.landed(record);
      if (!expected) {
        health.unexpected += 1;
        // Another run's record, or a part's lost and late (#235's review): it may have landed on any target, when
        // it says, and never after now (#251: a batcher's before #251 says it on the wall clock, far ahead of this).
        const landedBy = Math.min(Math.max(record.landAt, record.landedAt), monotonicMs());
        if (!record.skipped) growLandings.landed(record.id, landedBy, null);
        continue;
      }
      preparing.delete(record.id);
      preparingNext.delete(record.id);
      const drainedPart = parts.get(record.id);
      const landedOn = drainedPart?.target ?? null;
      // A skipped one (a late hack) never ran its call: no landing's lag (#246's verification).
      if (drainedPart !== undefined && !record.skipped) {
        drainedGbByHost.set(drainedPart.host, (drainedGbByHost.get(drainedPart.host) ?? 0) + drainedPart.gb);
        // Never under 0: a landing recorded a fraction of a ms before its time is on time.
        landingLagMs = Math.max(landingLagMs ?? 0, record.landedAt - record.landAt, 0);
      }
      parts.delete(record.id);
      if (!record.skipped) growLandings.landed(record.id, record.landAt, landedOn);
      const isHack = record.id.split(".")[2] === "hack";
      if (record.late) {
        health.late += 1;
        logNow = true;
      }
      if (isHack && record.skipped) health.hacksSkipped += 1;
      if (record.slackMs !== undefined) {
        health.leastSlackMs = Math.min(health.leastSlackMs ?? Number.POSITIVE_INFINITY, record.slackMs);
      }
      if (isHack && !record.skipped) {
        // A stamp the brain reads (the run report's moves, #236): its landing on the wall clock (#251).
        recordHackLanded(health, landedOn ?? "", wallClockMsOf(record.landAt));
        health.hacksLanded += 1;
        health.moneyHacked += record.result;
        if (record.result === 0) health.hacksFailed += 1;
      }
      if (outOfOrder) {
        health.outOfOrder += 1;
        desync();
      }
    }
  };

  // Batching: the next batch's number and its hack's landing; the orders due, earliest first; each batch planned whose
  // hack hasn't gone out; and the batches whose hacks have, until their last landing, for the bounds.
  let nextBatch = 0;
  let nextLandAt = 0;
  /**
   * Batches planned since it last started batching, and when it planned the last; and the problem it gave while it
   * waited for one (#236): never a silent `batching` with no batch.
   */
  let batchesSinceStart = 0;
  let lastBatchPlannedAt = 0;
  let waitingProblem: string | null = null;
  const pending: LaunchOrder[] = [];
  /**
   * The orders due that found no room and wait for it (#246), until they start or their wait is over, each with what
   * held the RAM at its first look; or null, a hack held while another of its batch's orders waits (#246's
   * verification), before it has looked at the RAM itself.
   */
  const waitingForRam = new Map<LaunchOrder, RamHeld | null>();
  const batches = new Map<number, PlannedBatch>();
  let landing: { target: string; threads: BatchThreads; untilMs: number }[] = [];
  /** No share round before this (#226's review): a batch came up short, or batches planned beside a wave still land. */
  let sharingHeldOffUntil = 0;
  /**
   * Whether a last preparation wave (its `landing` entry, the only one with no hack) still lands, on `target` or any:
   * batches planned meanwhile lead by its grow's security, so they hold more RAM than the plan's peak.
   */
  const waveLanding = (target?: string) =>
    landing.some(
      ({ target: each, threads: { hack: hackCount }, untilMs }) =>
        hackCount === 0 && untilMs >= monotonicMs() && (target === undefined || each === target),
    );
  let wave = 0;

  /**
   * The most hack and grow threads of any batch planned or landing on `target`, which set the most security it may
   * be left with: kept from the last look, so planning many batches at once looks once (within the same whole ms: the
   * monotonic clock reads fractions, #251).
   */
  let largest: { target: string; atMs: number; threads: BatchThreads } | null = null;
  const largestLanding = (target: string): BatchThreads => {
    if (largest?.target === target && largest.atMs === Math.floor(monotonicMs())) return largest.threads;
    let mostHack = 0;
    let mostGrow = 0;
    for (const each of [...batches.values(), ...landing]) {
      if (each.target !== target) continue;
      // Destructured: the game would charge hack's and grow's RAM for `.hack` and `.grow`.
      const { hack: hackCount, grow: growCount } = each.threads;
      mostHack = Math.max(mostHack, hackCount);
      mostGrow = Math.max(mostGrow, growCount);
    }
    const threads: BatchThreads = { hack: mostHack, weaken1: 0, grow: mostGrow, weaken2: 0 };
    largest = { target, atMs: Math.floor(monotonicMs()), threads };
    return threads;
  };

  /**
   * The next batch, planned at the hacking level now, with the config's share's hack threads or `hackThreads`, its
   * hack landing at `landAt` (the next's by default): its threads, its hack's share and its orders.
   */
  const planNextBatch = (hackThreads?: number, landAt = nextLandAt) => {
    const { target, figures } = current();
    const player = playerNow();
    const threads = batchThreads(
      figures,
      player,
      hackThreads ?? hackThreadsForShare(current().hackShare, figures, player),
    );
    // Not `threads.hack`: the game would charge hack's 0.1 GB for the name (Script/RamCalculations.ts:436-440).
    const { hack: hackCount } = threads;
    const plannedShare = hackCount * hackSharePerThread(figures, player);
    // Its leads cover the largest batch still landing on the target (#206): the plan grows with the RAM.
    return {
      batch: { target, figures, threads, plannedShare, short: false },
      threads,
      orders: batchOrders(nextBatch, landAt, batchHoldsMs(figures, player, threads, [largestLanding(target)])),
    };
  };

  /**
   * The RAM of the batches not yet planned whose first operation is due before `untilMs` (#232's review), at the
   * plan's size, from their starts: a round of share leaves it them, as it leaves the batches planned theirs.
   */
  const upcomingRam = (untilMs: number): RamHold[] => {
    const upcoming: RamHold[] = [];
    for (let landAt = nextLandAt; ; landAt += current().spacingMs) {
      const { threads, orders } = planNextBatch(undefined, landAt);
      if ((orders[0] as LaunchOrder).launchAt >= untilMs) return upcoming;
      upcoming.push(...batchRamHolds(threads, orders, monotonicMs()));
    }
  };

  /**
   * The RAM the batches can count on (#232): core's `batchRamGb` of each host's RAM less what isn't the batcher's own
   * there (the batcher itself, anyone else's scripts), so every operation within it finds whole threads' room.
   */
  const capacityGb = () => {
    const now = monotonicMs();
    // Its share threads too, until their scripts end (#232's review): `getServerUsedRam` counts them till then.
    const batcherOwnGb = shareRamByHost(sharingParts, now);
    for (const { host, gb } of parts.values()) batcherOwnGb.set(host, (batcherOwnGb.get(host) ?? 0) + gb);
    return batchRamGb(
      hosts.map((host) => {
        const othersGb = Math.max(0, ns.getServerUsedRam(host) - (batcherOwnGb.get(host) ?? 0));
        return ns.getServerMaxRam(host) - othersGb;
      }),
    );
  };

  /**
   * The RAM held from now on, on the hosts (#232), as `capacityGb` counts them (#232's review: a part on a host no
   * longer the batches' isn't): each part in flight until its landing's release (one past it, not yet recorded, now),
   * and the orders of the batches planned, from their starts; the share threads' are `shareRamHeld`'s.
   */
  const heldRam = (): RamHold[] => {
    const now = monotonicMs();
    const held: RamHold[] = [];
    for (const { host, gb, landAt } of parts.values()) {
      if (!hosts.includes(host)) continue;
      held.push({ gb, fromMs: now, untilMs: Math.max(landAt + BATCH_RAM_RELEASE_MS, now + 1) });
    }
    // The orders waiting for room (#246) too, from now.
    for (const order of [...pending, ...waitingForRam.keys()]) {
      const batch = batches.get(order.batch);
      if (batch !== undefined) held.push(...batchRamHolds(batch.threads, [order], now));
    }
    return held;
  };

  /**
   * The share threads' RAM on the hosts (#224), until their scripts end, a moment after their call (core's
   * `shareReleasedAt`, #232's review).
   */
  const shareRamHeld = (): RamHold[] => shareRamHolds(sharingParts, hosts, monotonicMs());

  /**
   * Starts batching: the first batch's operations all start from now, after what's still in flight on its target lands
   * (#236: never another target's, a dropped next target's long weaken, say), and its hack lands no sooner than
   * `notBeforeMs`.
   */
  const startBatching = (notBeforeMs = 0) => {
    health.state = "batching";
    logNow = true;
    setProblem(lastingProblem);
    batchesSinceStart = 0;
    const { target, figures, hackShare, spacingMs } = current();
    const player = playerNow();
    const threads = batchThreads(figures, player, hackThreadsForShare(hackShare, figures, player));
    const holds = batchHoldsMs(figures, player, threads);
    const firstLandAt = monotonicMs() + Math.max(...Object.values(holds));
    const ownLandingsAt = landings.latestLandAt(target) + spacingMs;
    nextLandAt = Math.max(firstLandAt, ownLandingsAt, notBeforeMs);
    // Its own operations in flight push the first batch back (a move back, a dropped next chosen): said (#237's
    // review).
    if (ownLandingsAt > Math.max(firstLandAt, notBeforeMs) && health.problem === lastingProblem) {
      // A time the brain reads: on the wall clock (#251).
      const lastAt = new Date(Math.round(wallClockMsOf(ownLandingsAt - spacingMs))).toISOString();
      waitingProblem = `its first batch on ${target} waits for its operations in flight there, the last at ${lastAt}`;
      setProblem(waitingProblem);
    }
  };

  /**
   * Why no batch on the target fits yet (#236), as it is now: the targets of the operations in flight that hold the RAM
   * (a target before a move, a next target's waves), the share threads', and the next of them to land, which frees
   * some (#237's review: the one it waits for, not the last of every target's).
   */
  const noBatchFitsYetProblem = () => {
    const holders = new Set<string>();
    let nextLandAtOfHeld = Number.POSITIVE_INFINITY;
    const now = monotonicMs();
    for (const { host, target, landAt } of parts.values()) {
      if (!hosts.includes(host)) continue;
      holders.add(target);
      if (landAt >= now) nextLandAtOfHeld = Math.min(nextLandAtOfHeld, landAt);
    }
    const held = [
      ...(holders.size > 0 ? [`its operations on ${[...holders].sort().join(", ")}`] : []),
      ...(shareRamHeld().length > 0 ? ["its share threads"] : []),
    ];
    // A time the brain reads: on the wall clock (#251).
    const until = Number.isFinite(nextLandAtOfHeld)
      ? `, the next of them landing at ${new Date(Math.round(wallClockMsOf(nextLandAtOfHeld))).toISOString()}`
      : "";
    return (
      `no batch on ${current().target} fits the RAM yet: it's held by ${held.join(" and ") || "scripts not its own"}` +
      until
    );
  };

  /**
   * What holds the hosts' RAM now (#246), beside the batcher's operations in flight (core's `ramHeldOf`): its own past
   * their landing, those drained in this wake, scripts not its own (with home a host, the batcher's and the Agent's
   * too), its share threads; and how late this wake's landings were.
   */
  const ramHeldNow = (): RamHeld => {
    const now = monotonicMs();
    const sharingGbByHost = shareRamByHost(sharingParts, now);
    const byHost = hosts.map((host) => {
      let inFlightGb = 0;
      let pastLandingGb = 0;
      for (const part of parts.values()) {
        if (part.host !== host) continue;
        inFlightGb += part.gb;
        if (part.landAt + BATCH_RAM_RELEASE_MS <= now) pastLandingGb += part.gb;
      }
      const usedGb = ns.getServerUsedRam(host);
      return {
        freeGb: ns.getServerMaxRam(host) - usedGb,
        usedGb,
        inFlightGb,
        pastLandingGb,
        sharingGb: sharingGbByHost.get(host) ?? 0,
        drainedGb: drainedGbByHost.get(host) ?? 0,
      };
    });
    return ramHeldOf(byHost, landingLagMs);
  };

  /**
   * The time a grow or weaken would have to spare if it started now (#246's review): its landing, less now and its
   * time at the target's security now, as its script reckons (../workers/batch-operation.ts). Null for a hack, whose
   * script skips itself when late.
   */
  const slackIfStartedNow = (order: LaunchOrder, batch: PlannedBatch): number | null =>
    order.operation === "hack"
      ? null
      : order.landAt -
        monotonicMs() -
        operationTimeMs(order.operation, batch.figures, playerNow(), ns.getServerSecurityLevel(batch.target));

  /** A batch short of RAM (#246): counted, kept with what held the RAM, and no share for a while after. */
  const markShort = (
    order: LaunchOrder,
    batch: PlannedBatch,
    threads: number,
    failedOn: string | null,
    held: RamHeld,
    slackMs: number | null,
  ) => {
    batch.short = true;
    const waitedMs = Math.max(0, monotonicMs() - order.launchAt);
    recordShort(health, {
      // A stamp the brain reads (the run report lists each short): the wall clock (#251).
      atMs: Date.now(),
      target: batch.target,
      operation: order.operation,
      threads,
      waitedMs,
      slackMs,
      failedOn,
      ...held,
    });
    logNow = true;
    // No share for a while (#226's review): whatever took the RAM, the batches have it first.
    sharingHeldOffUntil = Math.max(sharingHeldOffUntil, monotonicMs() + SHARE_AFTER_SHORT_MS);
  };

  /**
   * Launches one order of a batch: false while it waits for room (#246), to be tried again. One the hosts haven't the
   * room for waits while core's `mayStillStart` allows, asked again before each retry, so none starts once it can no
   * longer land on time (#246's review). Past that, the batch is short.
   */
  const launchOrder = (order: LaunchOrder): boolean => {
    const firstLook = waitingForRam.get(order);
    // Out of the line on every way out but a wait, which puts it back.
    waitingForRam.delete(order);
    const batch = batches.get(order.batch);
    if (batch === undefined) {
      // Its batch's hack went out before it (#253): counted, never dropped silently (#246's verification).
      health.ordersDropped = (health.ordersDropped ?? 0) + 1;
      logNow = true;
      return true;
    }
    let threads = batch.threads[order.operation];
    const isHack = order.operation === "hack";
    const waitedMs = () => Math.max(0, monotonicMs() - order.launchAt);
    if (isHack) {
      // Never out, nor skipped, while another of its batch's orders waits for room (#246's review): it waits with it,
      // or the batch is short. Out or skipped, it would take the batch off the books, and the waiting order with it.
      if (hackWaitsForItsBatch(order, waitingForRam.keys())) {
        if (mayStillStart(waitedMs(), null)) {
          // Held for its batch, not for RAM (#246's verification): counted apart, once.
          if (firstLook === undefined) health.hacksHeldForBatch = (health.hacksHeldForBatch ?? 0) + 1;
          waitingForRam.set(order, firstLook ?? null);
          return false;
        }
        batches.delete(order.batch);
        health.hacksSkipped += 1;
        markShort(order, batch, threads, null, ramHeldNow(), null);
        return true;
      }
      // After a desync no hack goes out; after a move (#206) the batches out still hack their own target. The hack is a
      // batch's last order out.
      if (batch.short || health.state === "recovering") {
        batches.delete(order.batch);
        health.hacksSkipped += 1;
        return true;
      }
      const player = playerNow();
      landing = landing.filter((each) => each.untilMs >= monotonicMs());
      const sameTarget = landing.filter((each) => each.target === batch.target).map((each) => each.threads);
      const bounds = batchBounds(batch.figures, player, [batch.threads, ...sameTarget]);
      const seen = {
        money: ns.getServerMoneyAvailable(batch.target),
        security: ns.getServerSecurityLevel(batch.target),
      };
      health.seen = seen;
      if (isOutsideBounds(bounds, seen)) {
        batches.delete(order.batch);
        health.outOfBounds += 1;
        health.hacksSkipped += 1;
        desync();
        return true;
      }
      threads = hackThreadsAtLaunch(threads, batch.plannedShare, batch.figures, player);
    }
    // A retry only while it can still land on time (#246's review): asked before it starts, so a wait never starts one
    // that can't; a first look that finds no room always waits, and its first retry may give up.
    const slackMs = firstLook === undefined ? null : slackIfStartedNow(order, batch);
    const mayStart = firstLook === undefined || mayStillStart(waitedMs(), slackMs);
    // A grow's parts (#234): its money is looked at once they've all landed.
    const growParts = order.operation === "grow" ? new Set<string>() : undefined;
    const { started, failedOn } = mayStart
      ? launch(order.operation, threads, order.landAt, `${order.batch}.${order.operation}`, batch.target, growParts)
      : { started: false, failedOn: null };
    // None started for want of room: tried again soon. One held for its batch looks at the RAM now.
    if (!started && mayStart && failedOn === null) {
      if (firstLook === undefined) retryWaitingAt = Math.max(retryWaitingAt, monotonicMs() + BATCH_RAM_WAIT_LOOK_MS);
      waitingForRam.set(order, firstLook ?? ramHeldNow());
      return false;
    }
    // A wait for RAM, with what held it and the time it had to spare (#246's verification): not one held for its batch.
    if (started && firstLook !== undefined && firstLook !== null) {
      recordRamWait(health, {
        // A stamp the brain reads (the run report lists each wait): the wall clock (#251).
        atMs: Date.now(),
        target: batch.target,
        operation: order.operation,
        threads,
        waitedMs: waitedMs(),
        slackMs,
        ...firstLook,
      });
    }
    if (isHack) {
      batches.delete(order.batch);
      landing.push({
        target: batch.target,
        threads: batch.threads,
        untilMs: order.landAt + landingOffsetMs("weaken2"),
      });
    }
    if (started && growParts !== undefined) {
      growLandings.started(String(order.batch), batch.target, batch.figures.moneyMax, order.landAt, growParts);
    }
    // A hack that didn't all start is skipped too: what of it started still lands, and is counted as it does.
    if (!started && isHack) health.hacksSkipped += 1;
    if (!started && !batch.short) markShort(order, batch, threads, failedOn, ramHeldNow(), slackMs);
    return true;
  };

  /** When the orders waiting for room (#246) are next tried again. */
  let retryWaitingAt = 0;
  /**
   * The orders waiting for room tried again (#246), earliest first, once `BATCH_RAM_WAIT_LOOK_MS` has passed since the
   * last try: those that start or give up leave the line. Whatever woke it, a landing's record or the time, so records
   * coming more often than that never keep them from their try, nor from giving up.
   */
  const retryWaitingOrdersIfDue = (whateverTheTime = false) => {
    if (waitingForRam.size === 0 || (!whateverTheTime && monotonicMs() < retryWaitingAt)) return;
    retryWaitingAt = monotonicMs() + BATCH_RAM_WAIT_LOOK_MS;
    const inLine = [...waitingForRam.keys()].sort((a, b) => a.launchAt - b.launchAt || a.landAt - b.landAt);
    for (const order of inLine) launchOrder(order);
  };

  /**
   * A config read: new hosts get the operation scripts; a new target lets what's in flight land, as after a desync (a
   * batch's own operations keep its target), then is prepared; the rest applies from the next batch.
   */
  const applyConfig = (next: BatcherConfig) => {
    if (config !== null && JSON.stringify(config) === JSON.stringify(next)) return;
    if (config === null || JSON.stringify(config.hosts) !== JSON.stringify(next.hosts)) {
      hosts = next.hosts.filter((host) => host === "home" || ns.scp(files, host, "home"));
      const uncopied = next.hosts.filter((host) => !hosts.includes(host));
      lastingProblem = uncopied.length > 0 ? `can't copy its scripts to ${uncopied.join(", ")}` : null;
      setProblem(lastingProblem);
      unsharedHosts = new Set(
        hosts.filter((host) => host !== "home" && !ns.scp(folder + SHARE_SCRIPT_NAME, host, "home")),
      );
    }
    const newTarget =
      config !== null &&
      (config.target !== next.target || JSON.stringify(config.figures) !== JSON.stringify(next.figures));
    if (newTarget) {
      // A move (#206): the batches out keep their target and land, hacks and all, while the new one is prepared beside
      // them; the next target's waves in flight, if it's that one, are its own now.
      preparing = config?.next?.target === next.target ? preparingNext : new Set();
      preparingNext = new Set();
      if (health.state === "batching") health.state = "preparing";
      if (waitingProblem !== null && health.problem === waitingProblem) setProblem(lastingProblem);
      waitingProblem = null;
      // A move under way until the new target's first hack (#237's review), in its health (#237's re-review).
      health.targetChangedSinceHack = true;
    }
    if (next.next?.target !== config?.next?.target) {
      preparingNext = new Set();
      recordNextTargetRoomForWave(true);
      health.next = next.next === undefined ? null : { target: next.next.target, wavesStarted: 0, ready: false };
    }
    logNow = true;
    config = next;
    health.target = next.target;
  };

  /** Reads the config: applied if it's new, its problem shown while there's none or it can't be read. */
  const readAndApplyConfig = () => {
    const read = readConfig();
    if (read?.ok) {
      applyConfig(read.config);
      if (health.problem === NO_CONFIG || health.problem?.startsWith(UNREADABLE_CONFIG)) setProblem(lastingProblem);
    } else {
      setProblem(read === null ? NO_CONFIG : `${UNREADABLE_CONFIG}: ${read.reason}`);
    }
  };

  /**
   * The RAM a preparation wave landing at `landAt` may take, GB (#236): the RAM the batches can count on, less the most
   * the batcher holds until the wave has landed (its parts in flight, the orders of the batches planned, its share
   * threads: #232's holds), and no more than is free now. Not every pending order's RAM summed, as before: they hold it
   * at different times, and with batches planned a weaken ahead the sum left a next target none of its RAM.
   */
  const roomForWave = (landAt: number) => {
    const now = monotonicMs();
    const untilMs = landAt + 2 * BATCH_LANDING_GAP_MS + BATCH_RAM_RELEASE_MS;
    const besideGb = capacityGb() - mostRamHeldGb([...heldRam(), ...shareRamHeld()], now, untilMs);
    return Math.max(0, Math.min(besideGb, batchRamGb(freeRam().map((host) => host.freeGb))));
  };

  /**
   * Starts a preparation wave once the last has landed, or starts batching once the target is ready. A previous
   * target's batches may still be landing (#206): the wave takes the RAM they leave.
   */
  const prepare = () => {
    // Nor while share threads may still hold RAM (#224): a wave takes the RAM free, all of it once they've ended.
    if (preparing.size > 0 || monotonicMs() < waitUntilMs || monotonicMs() < sharingHeldUntil()) return;
    const { target, figures } = current();
    // A move back to a target its batches are still landing on (#216's review): they land first, so no wave goes out
    // among them.
    if ([...batches.values()].some((each) => each.target === target)) return;
    if (landing.some((each) => each.target === target && each.untilMs >= monotonicMs())) return;
    const now = { money: ns.getServerMoneyAvailable(target), security: ns.getServerSecurityLevel(target) };
    health.seen = now;
    const player = playerNow();
    // Called at the security now, so their times are the longest they'll be: all land after their time from now.
    const landAt = monotonicMs() + operationTimeMs("weaken1", figures, player, now.security) + BATCH_LAUNCH_LEAD_MS;
    // The room, less the next target's: the batches out (a previous target's, after a move) keep what they need.
    const usableGb = isTargetPrepared(figures, now)
      ? 0
      : Math.max(0, roomForWave(landAt) - (current().next?.ramGb ?? 0));
    const threads = preparationWave(figures, player, now, usableGb);
    if (threads === null) {
      startBatching();
      return;
    }
    // Never `.grow` in this script: the game would charge grow's RAM for the name (Script/RamCalculations.ts:436-440).
    const { weaken1, grow: growCount, weaken2 } = threads;
    if (weaken1 + growCount === 0) {
      // None while a previous target's batches still hold the RAM (#206): it frees as they land.
      if (pending.length + waitingForRam.size === 0) setProblem(`no RAM to prepare ${target}`);
      return;
    }
    const parts: [BatchOperation, number, number][] = [
      ["weaken1", weaken1, landAt],
      ["grow", growCount, landAt + BATCH_LANDING_GAP_MS],
      ["weaken2", weaken2, landAt + 2 * BATCH_LANDING_GAP_MS],
    ];
    let problem: string | null = lastingProblem;
    for (const [operation, operationThreads, operationLandAt] of parts) {
      const id = `p${wave}.${operation}`;
      if (
        operationThreads > 0 &&
        !launch(operation, operationThreads, operationLandAt, id, target, preparing).started
      ) {
        problem = `a preparation ${operation} of ${operationThreads} threads wouldn't start`;
      }
    }
    setProblem(problem);
    wave += 1;
    health.wavesStarted += 1;
    // The last wave, all started, on a target at its minimum security (#206): batches start now, their operations'
    // times as they'll be, their hacks out once the wave has landed, so the first lands a hack's time after it, not a
    // weaken's. A fresh start's n00dles, at its minimum, needs only grow.
    const whole = preparationWave(figures, player, now, Number.POSITIVE_INFINITY) ?? { weaken1: -1, grow: -1 };
    const { weaken1: wholeWeaken1, grow: wholeGrow } = whole;
    const last = wholeWeaken1 === weaken1 && wholeGrow === growCount;
    // Only where the batches' peak fits beside the wave: otherwise they'd be short until it lands.
    const batchThreadsNow = batchThreads(figures, player, hackThreadsForShare(current().hackShare, figures, player));
    const peakGb = batchPeakRamGb(batchThreadsNow, batchHoldsMs(figures, player, batchThreadsNow), current().spacingMs);
    const room = batchRamGb(freeRam().map((host) => host.freeGb)) >= peakGb;
    if (problem === lastingProblem && last && room && now.security <= figures.minDifficulty + 1e-9) {
      const wavesLastAt = landAt + 2 * BATCH_LANDING_GAP_MS;
      // The wave counts among the batches landing until it has (#216's review): its grow raises the security until its
      // weaken2 lands, so the batches' leads (`largestLanding`) cover it.
      landing.push({ target, threads: { hack: 0, weaken1, grow: growCount, weaken2 }, untilMs: wavesLastAt });
      // A second to spare: a hack's lead grows with the security its batch may leave (`launchLeadMs`).
      startBatching(wavesLastAt + operationTimeMs("hack", figures, player) + BATCH_LAUNCH_LEAD_MS + 1_000);
    }
  };

  /** Since when the next target has had no room for a wave (#236), or null; and the problem saying so, once shown. */
  let nextWithoutRoomSince: number | null = null;
  let nextWithoutRoomProblem: string | null = null;
  /** Whether the next target found room for a wave, or needs none: a minute without is said, never silent (#236). */
  const recordNextTargetRoomForWave = (found: boolean, target = "") => {
    if (found) {
      nextWithoutRoomSince = null;
      if (nextWithoutRoomProblem !== null && health.problem === nextWithoutRoomProblem) setProblem(lastingProblem);
      nextWithoutRoomProblem = null;
      return;
    }
    nextWithoutRoomSince ??= monotonicMs();
    if (
      monotonicMs() - nextWithoutRoomSince >= NEXT_WITHOUT_ROOM_PROBLEM_AFTER_MS &&
      health.problem === lastingProblem
    ) {
      nextWithoutRoomProblem = `no RAM to prepare ${target} next beside the batches for a minute`;
      setProblem(nextWithoutRoomProblem);
    }
  };

  /**
   * The next target (#206): a preparation wave on at most the config's RAM for it, once its last has landed, so a move
   * to it batches at once. Its operations hold RAM the batches don't plan on (the brain plans them on the rest).
   */
  const prepareNext = () => {
    const next = current().next;
    if (next === undefined || next.target === current().target || preparingNext.size > 0) return;
    const now = { money: ns.getServerMoneyAvailable(next.target), security: ns.getServerSecurityLevel(next.target) };
    const player = playerNow();
    const landAt =
      monotonicMs() + operationTimeMs("weaken1", next.figures, player, now.security) + BATCH_LAUNCH_LEAD_MS;
    // On at most its RAM, of the room beside what the batches hold until it lands (#236).
    const usableGb = isTargetPrepared(next.figures, now) ? 0 : Math.min(next.ramGb, roomForWave(landAt));
    const threads = preparationWave(next.figures, player, now, usableGb);
    const nextHealth = health.next ?? { target: next.target, wavesStarted: 0, ready: false };
    health.next = nextHealth;
    nextHealth.ready = threads === null;
    if (threads === null) {
      recordNextTargetRoomForWave(true);
      return;
    }
    const { weaken1, grow: growCount, weaken2 } = threads;
    recordNextTargetRoomForWave(weaken1 + growCount > 0, next.target);
    if (weaken1 + growCount === 0) return;
    const parts: [BatchOperation, number, number][] = [
      ["weaken1", weaken1, landAt],
      ["grow", growCount, landAt + BATCH_LANDING_GAP_MS],
      ["weaken2", weaken2, landAt + 2 * BATCH_LANDING_GAP_MS],
    ];
    for (const [operation, operationThreads, operationLandAt] of parts) {
      // A part that won't start waits for the next wave: the RAM was the batches'.
      if (operationThreads > 0) {
        launch(operation, operationThreads, operationLandAt, `n${nextWave}.${operation}`, next.target, preparingNext);
      }
    }
    nextWave += 1;
    nextHealth.wavesStarted += 1;
  };

  // Sharing (#224): each part of a round started, the next look, the rounds started, and the room the last look found.
  let sharingParts: { host: string; threads: number; cores: number; endsAt: number }[] = [];
  let nextSharingLookAt = 0;
  let sharingRounds = 0;
  let sharingRoomGb = 0;
  /** The problem its last round gave (a part that wouldn't start), until a round without one; or null. */
  let sharingProblem: string | null = null;
  /** When the share threads started last may have ended and freed their RAM, or 0 with none. */
  const sharingHeldUntil = () => sharingParts.reduce((latest, part) => Math.max(latest, shareReleasedAt(part)), 0);

  /**
   * A round of share (#224): only while batching, with its config's `sharing`, at most every `SHARE_ROUND_MS`, on the
   * hosts' free RAM less the config's reserve and home's kept RAM, to at most 80% of their RAM (core's `shareRound`).
   * Called once the batches' orders due and the waves are out, so they come first.
   */
  const shareSpareRam = () => {
    const now = monotonicMs();
    sharingParts = sharingParts.filter((part) => shareReleasedAt(part) > now);
    const { sharing } = current();
    if (sharing === undefined || health.state !== "batching" || now < sharingHeldOffUntil || waveLanding()) {
      sharingRoomGb = 0;
      return;
    }
    if (now < nextSharingLookAt) return;
    // Its hosts, and home beside them (#226's review): after an install, home is most of the RAM.
    const sharingHosts = hosts.includes("home") ? hosts : [...hosts, "home"];
    const use = sharingHosts.map((host) => ({
      host,
      maxGb: ns.getServerMaxRam(host),
      usedGb: ns.getServerUsedRam(host),
      batches: hosts.includes(host),
    }));
    // Never the RAM the batches will hold over its threads' time and release (#232): those planned, and those due
    // meanwhile at the plan's size (#232's review), else trimmed for its threads. A round takes at most the room beside
    // the most held then, whatever the brain's reserve leaves.
    const roundEndsAt = now + SHARE_HELD_MS + BATCH_RAM_RELEASE_MS;
    const heldThen = mostRamHeldGb([...heldRam(), ...shareRamHeld(), ...upcomingRam(roundEndsAt)], now, roundEndsAt);
    const roomBesideGb = Math.max(0, capacityGb() - heldThen);
    const hostsFreeGb = use.reduce(
      (total, each) => total + (each.batches ? Math.max(0, each.maxGb - each.usedGb) : 0),
      0,
    );
    const round = shareRound(use, Math.max(sharing.reserveGb, hostsFreeGb - roomBesideGb), sharing.homeKeptGb);
    sharingRoomGb = round.roomGb;
    let started = 0;
    let failed: string | null = null;
    for (const [part, { host, threads }] of round.placed.entries()) {
      const options = { threads, temporary: true };
      if (unsharedHosts.has(host)) {
        failed ??= `can't copy its share script to ${host}`;
      } else if (ns.exec(folder + SHARE_SCRIPT_NAME, host, options, `${runName}.s${sharingRounds}.${part}`)) {
        sharingParts.push({ host, threads, cores: sharing.cores[host] ?? 1, endsAt: now + SHARE_HELD_MS });
        started += threads;
      } else {
        failed ??= `a share of ${threads} threads on ${host} wouldn't start`;
      }
    }
    // Said until a round without one: then the problem goes back to what lasts.
    if (failed !== null) setProblem(failed);
    else if (round.placed.length > 0 && sharingProblem !== null && health.problem === sharingProblem) {
      setProblem(lastingProblem);
    }
    if (round.placed.length > 0) sharingProblem = failed;
    if (started > 0) sharingRounds += 1;
    nextSharingLookAt = now + (started > 0 ? SHARE_ROUND_MS : SHARE_LOOK_AGAIN_MS);
  };

  /** The sharing in its health: null while it neither shares nor is asked to. */
  const sharingHealth = (): SharingHealth | null => {
    const now = monotonicMs();
    const running = sharingParts.filter((part) => part.endsAt > now);
    const wanted = config?.sharing !== undefined;
    if (!wanted && running.length === 0) return null;
    const threads = running.reduce((sum, part) => sum + part.threads, 0);
    // Of them, on its hosts (#230): only these can take a batch's RAM; home's share beside them can't.
    const threadsOnHosts = running.reduce((sum, part) => sum + (hosts.includes(part.host) ? part.threads : 0), 0);
    return {
      wanted,
      threads,
      ramGb: threads * SHARE_RAM_GB,
      hostsRamGb: threadsOnHosts * SHARE_RAM_GB,
      bonus: shareBonus(running, current().player.intelligence),
      roomGb: sharingRoomGb,
    };
  };

  let lastLineAt = 0;
  let lastPublished = "";
  for (;;) {
    readAndApplyConfig();
    if (config === null) {
      publish(ns, health, logNow);
      logNow = false;
      await ns.asleep(PREPARING_LOOK_EVERY_MS);
      continue;
    }
    drainLandings();
    const lost = landings.takeLostIds(monotonicMs());
    for (const id of lost) {
      preparing.delete(id);
      preparingNext.delete(id);
      parts.delete(id);
      growLandings.lost(id);
    }
    if (lost.length > 0) {
      health.lost += lost.length;
      logNow = true;
    }
    let wakeAt = monotonicMs() + PREPARING_LOOK_EVERY_MS;
    if (health.state === "preparing") {
      prepare();
      if (monotonicMs() < waitUntilMs) wakeAt = Math.min(wakeAt, waitUntilMs);
    }
    if (health.state === "batching") {
      // Plan each batch whose first operation is due, then launch every order due, in time order.
      if (hackSharePerThread(current().figures, playerNow()) > 0) {
        for (
          let next = planNextBatch();
          (next.orders[0] as LaunchOrder).launchAt <= monotonicMs();
          next = planNextBatch()
        ) {
          // Fitted to the RAM as it will be held (#232): the batches planned before a new plan, or at a lower hacking
          // level, may hold more than the plan's peak. Fewer hack threads, or none this time: never short.
          const { hack: plannedHack } = next.threads;
          // The share's doing (#232's review) when, without its threads on the hosts, it would be larger: they took
          // RAM a batch needed, as a short beside them shows (`share starved batches`).
          const shareHeld = shareRamHeld();
          const held = [...heldRam(), ...shareHeld];
          const {
            batch: fitted,
            trimmed,
            trimmedBySharing,
          } = fitBatch(plannedHack, planNextBatch, held, shareHeld, capacityGb(), monotonicMs());
          if (trimmed) health.batchesTrimmed = (health.batchesTrimmed ?? 0) + 1;
          if (trimmedBySharing) health.batchesTrimmedBySharing = (health.batchesTrimmedBySharing ?? 0) + 1;
          if (fitted === null) {
            // None yet since it started batching (#236), or none for a minute since the last (#237's review): it says
            // what holds the RAM and the next of it to land, as it is when the wait is first said (each wait anew, so
            // the run report lists each once); not a gap among batches in step, or a new plan's.
            const waiting = batchesSinceStart === 0 || monotonicMs() - lastBatchPlannedAt >= WAITING_PROBLEM_AFTER_MS;
            if (waiting && health.problem === lastingProblem) {
              waitingProblem = noBatchFitsYetProblem();
              setProblem(waitingProblem);
            }
            nextLandAt += current().spacingMs;
            continue;
          }
          if (waitingProblem !== null && health.problem === waitingProblem) setProblem(lastingProblem);
          waitingProblem = null;
          batchesSinceStart += 1;
          lastBatchPlannedAt = monotonicMs();
          batches.set(nextBatch, fitted.batch);
          pending.push(...fitted.orders);
          // Planned while a last preparation wave lands, its leads cover the wave's grow, longer than the plan's: no
          // share until it has landed (#226's review), the reserve being the plan's peak.
          if (waveLanding(fitted.batch.target)) {
            sharingHeldOffUntil = Math.max(sharingHeldOffUntil, nextLandAt + landingOffsetMs("weaken2"));
          }
          health.batchesStarted += 1;
          nextBatch += 1;
          nextLandAt += current().spacingMs;
        }
        wakeAt = (planNextBatch().orders[0] as LaunchOrder).launchAt;
      } else {
        setProblem(`a hack of ${current().target} takes nothing at this hacking level`);
      }
    }
    // The batches planned go out in every state, a previous target's too after a move (#206).
    pending.sort((a, b) => a.launchAt - b.launchAt || a.landAt - b.landAt);
    // Those waiting for room first (#246), on every wake of the whole loop, before those due can take their RAM (#246's
    // verification); one that finds no room joins the line.
    retryWaitingOrdersIfDue(true);
    while (pending.length > 0 && (pending[0] as LaunchOrder).launchAt <= monotonicMs()) {
      launchOrder(pending.shift() as LaunchOrder);
    }
    if (pending.length > 0) wakeAt = Math.min(wakeAt, (pending[0] as LaunchOrder).launchAt);
    const ordersLeft = pending.length + waitingForRam.size;
    if (health.state === "recovering" && ordersLeft === 0 && landings.inFlight() === 0) {
      health.state = "preparing";
      batches.clear();
      landing = [];
      preparing = new Set();
      logNow = true;
    }
    if (health.state !== "recovering") prepareNext();
    shareSpareRam();
    health.sharing = sharingHealth();
    if (health.sharing?.wanted && health.state === "batching") {
      wakeAt = Math.min(wakeAt, Math.max(nextSharingLookAt, sharingHeldOffUntil));
    }
    // Awake as share threads end (#224): its health's count falls then, and a wave waiting for them goes out.
    // And as their scripts end (#232's review): their RAM is the batcher's own until then.
    for (const part of sharingParts) {
      wakeAt = Math.min(wakeAt, part.endsAt > monotonicMs() ? part.endsAt : shareReleasedAt(part));
    }
    // Awake when a part would be lost, so it's counted then, not at the next launch.
    wakeAt = Math.min(wakeAt, landings.nextLostAtMs());
    health.batchesPending = batches.size;
    const latestLandAt = landings.latestLandAt();
    // Never before the one it waits for (#211): a batcher started while this one waits must wait for that one too. On
    // the monotonic clock (#251): only the next batcher, on the same page, reads it.
    const latest = Math.max(latestLandAt, waitUntilMs);
    health.latestLandAt = Number.isFinite(latest) && latest > 0 ? latest : null;
    health.inFlight = landings.inFlight();
    const published = JSON.stringify({ ...health, atMs: 0 });
    const lineDue = monotonicMs() - lastLineAt >= HEALTH_LINE_EVERY_MS;
    if (published !== lastPublished || logNow || lineDue) {
      publish(ns, health, logNow || lineDue);
      if (logNow || lineDue) lastLineAt = monotonicMs();
      lastPublished = published;
      logNow = false;
    }
    const fullWakeAt = monotonicMs() + Math.min(Math.max(0, wakeAt - monotonicMs()), HEALTH_LINE_EVERY_MS);
    // Woken by a landing, or a config written (the Agent writes it each round: a change is read within 2 s). Meanwhile,
    // with orders waiting for room (#246), at each try due those alone are tried again (#246's review: not the whole
    // loop, on a busy page), until one leaves the line.
    for (;;) {
      const lookAt = waitingForRam.size > 0 ? Math.min(fullWakeAt, retryWaitingAt) : fullWakeAt;
      const timedOut = await Promise.race([
        ns.asleep(Math.max(0, lookAt - monotonicMs())).then(() => true),
        ns.nextPortWrite(BATCHER_LANDING_PORT).then(() => false),
        ns.nextPortWrite(BATCHER_CONFIG_PORT).then(() => false),
      ]);
      if (!timedOut) break;
      const inLineBefore = waitingForRam.size;
      retryWaitingOrdersIfDue();
      if (monotonicMs() >= fullWakeAt || waitingForRam.size < inLineBefore || waitingForRam.size === 0) break;
    }
  }
}
