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
//   `preparationWave`), once the last has landed: weaken, grow and weaken, landing in that order, on the RAM free. A
//   last wave on a target at its minimum security, with room beside it for the batches, starts them at once (#206).
// - **The next target (#206):** the config's `next`, prepared the same way on at most its RAM, beside the batches.
// - **Batching:** a batch's hack lands every spacing, its weaken, grow and weaken δ apart after it. Each operation is
//   started just in time, its hold before it lands (core's `batchOrders`), on the hosts' free RAM (`placeThreads`),
//   and lands itself (../workers/batch-operation.ts). A batch's threads are planned when its first weaken goes out,
//   and its hack threads replanned when its hack does (`hackThreadsAtLaunch`), at the hacking level then; the hack goes
//   out only if the rest did and the target is within the bounds of every batch still landing (`batchBounds`). Each
//   operation's lead covers the security the largest batch still landing may leave (#206).
// - **Checked, loudly:** every landing is recorded on the landing port, cleared when it starts; each id starts with
//   this run's name, so a previous run's records are only counted (unexpected), never trusted. One before a landing
//   already recorded is out of order, one started too late is late, one never recorded is lost. Out of order, or the
//   target outside the bounds at a hack, is a desync: no more hacks or batches, and once nothing is in flight, it
//   prepares the target again.
// - **Health:** core's `BatcherHealth`, on its health port whenever it changes, and in its log every minute and at each
//   change of state or of its problem, or anything wrong.
// RAM: `exec` 1.3 + `scp` 0.6 + `getServerMoneyAvailable` and `getServerSecurityLevel` 0.1 each + `getServerMaxRam`,
// `getServerUsedRam` and `getHackingLevel` 0.05 each; ports and `asleep` are free (ram-budget.json).
import {
  BATCH_GROW_SCRIPT_NAME,
  BATCH_HACK_SCRIPT_NAME,
  BATCH_LANDING_GAP_MS,
  BATCH_LAUNCH_LEAD_MS,
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
  batchThreads,
  type HackingPlayer,
  type HostRam,
  hackSharePerThread,
  hackThreadsAtLaunch,
  hackThreadsForShare,
  isOutsideBounds,
  LandingWatch,
  type LaunchOrder,
  landingOffsetMs,
  newBatcherHealth,
  operationRamGb,
  operationScriptName,
  operationTimeMs,
  parseBatcherConfig,
  parseLandingRecord,
  placeThreads,
  preparationWave,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

/** The longest the batcher sleeps, with nothing due: its log's health line comes at least this often. */
const HEALTH_LINE_EVERY_MS = 60_000;
/** While preparing, how often it looks again: a wave in flight lands well within it. */
const PREPARING_LOOK_EVERY_MS = 1_000;

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

/** The latest landing a batcher before this one last published (#205), or 0. */
function previousLatestLandAt(ns: NS): number {
  const previous = ns.peek(BATCHER_HEALTH_PORT) as { latestLandAt?: unknown } | null;
  const latest = typeof previous === "object" && previous !== null ? previous.latestLandAt : null;
  return typeof latest === "number" && Number.isFinite(latest) ? latest : 0;
}

/** The health on its port, and in the log when `logIt`. */
function publish(ns: NS, health: BatcherHealth, logIt: boolean): void {
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
  /** What stays wrong while the hosts do: hosts it couldn't copy its scripts to. Other problems clear back to it. */
  let lastingProblem: string | null = null;
  const landings = new LandingWatch();
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
   * preparation wave waits for its own); false if they didn't all start.
   */
  const launch = (
    operation: BatchOperation,
    threads: number,
    landAt: number,
    id: string,
    target: string,
    wave?: Set<string>,
  ): boolean => {
    const placed = placeThreads(freeRam(), threads, operationRamGb(operation));
    if (placed === null) return false;
    for (const [part, { host, threads: partThreads }] of placed.entries()) {
      const partId = `${runName}.${id}.${part}`;
      const options = { threads: partThreads, temporary: true };
      if (
        ns.exec(folder + operationScriptName(operation), host, options, target, landAt, BATCHER_LANDING_PORT, partId)
      ) {
        landings.expect(partId, landAt);
        wave?.add(partId);
      } else {
        return false;
      }
    }
    return true;
  };

  const desync = () => {
    health.desyncs += 1;
    logNow = true;
    if (health.state === "batching") health.state = "recovering";
  };

  /** Every record on the landing port, checked. Ids are `<run>.<batch>.<operation>.<part>`. */
  const drainLandings = () => {
    for (;;) {
      const data = ns.readPort(BATCHER_LANDING_PORT);
      if (data === "NULL PORT DATA") return;
      const record = parseLandingRecord(data);
      if (record === null) {
        setProblem(`an unreadable landing record: ${JSON.stringify(data)}`);
        continue;
      }
      const { outOfOrder, expected } = landings.landed(record);
      if (!expected) {
        health.unexpected += 1;
        continue;
      }
      preparing.delete(record.id);
      preparingNext.delete(record.id);
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
  const pending: LaunchOrder[] = [];
  const batches = new Map<number, PlannedBatch>();
  let landing: { target: string; threads: BatchThreads; untilMs: number }[] = [];
  let wave = 0;

  /**
   * The most hack and grow threads of any batch planned or landing on `target`, which set the most security it may
   * be left with: kept from the last look, so planning many batches at once looks once.
   */
  let largest: { target: string; atMs: number; threads: BatchThreads } | null = null;
  const largestLanding = (target: string): BatchThreads => {
    if (largest?.target === target && largest.atMs === Date.now()) return largest.threads;
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
    largest = { target, atMs: Date.now(), threads };
    return threads;
  };

  /** The next batch, planned at the hacking level now: its threads, its hack's share and its orders. */
  const planNextBatch = () => {
    const { target, figures } = current();
    const player = playerNow();
    const threads = batchThreads(figures, player, hackThreadsForShare(current().hackShare, figures, player));
    // Not `threads.hack`: the game would charge hack's 0.1 GB for the name (Script/RamCalculations.ts:436-440).
    const { hack: hackCount } = threads;
    const plannedShare = hackCount * hackSharePerThread(figures, player);
    // Its leads cover the largest batch still landing on the target (#206): the plan grows with the RAM.
    return {
      batch: { target, figures, threads, plannedShare, short: false },
      orders: batchOrders(nextBatch, nextLandAt, batchHoldsMs(figures, player, threads, [largestLanding(target)])),
    };
  };

  /**
   * Starts batching: the first batch's operations all start from now, after anything still in flight lands, and its
   * hack lands no sooner than `notBeforeMs`.
   */
  const startBatching = (notBeforeMs = 0) => {
    health.state = "batching";
    logNow = true;
    setProblem(lastingProblem);
    const { figures, hackShare, spacingMs } = current();
    const player = playerNow();
    const threads = batchThreads(figures, player, hackThreadsForShare(hackShare, figures, player));
    const holds = batchHoldsMs(figures, player, threads);
    const firstLandAt = Date.now() + Math.max(...Object.values(holds));
    nextLandAt = Math.max(firstLandAt, landings.latestLandAt() + spacingMs, notBeforeMs);
  };

  /** Launches one order of a batch. */
  const launchOrder = (order: LaunchOrder) => {
    const batch = batches.get(order.batch);
    if (batch === undefined) return;
    let threads = batch.threads[order.operation];
    if (order.operation === "hack") {
      // The hack is a batch's last order out.
      batches.delete(order.batch);
      // After a desync no hack goes out; after a move (#206) the batches out still hack their own target.
      if (batch.short || health.state === "recovering") {
        health.hacksSkipped += 1;
        return;
      }
      const player = playerNow();
      landing = landing.filter((each) => each.untilMs >= Date.now());
      const sameTarget = landing.filter((each) => each.target === batch.target).map((each) => each.threads);
      const bounds = batchBounds(batch.figures, player, [batch.threads, ...sameTarget]);
      const seen = {
        money: ns.getServerMoneyAvailable(batch.target),
        security: ns.getServerSecurityLevel(batch.target),
      };
      health.seen = seen;
      if (isOutsideBounds(bounds, seen)) {
        health.outOfBounds += 1;
        health.hacksSkipped += 1;
        desync();
        return;
      }
      threads = hackThreadsAtLaunch(threads, batch.plannedShare, batch.figures, player);
      landing.push({
        target: batch.target,
        threads: batch.threads,
        untilMs: order.landAt + landingOffsetMs("weaken2"),
      });
    }
    const started = launch(order.operation, threads, order.landAt, `${order.batch}.${order.operation}`, batch.target);
    // A hack that didn't all start is skipped too: what of it started still lands, and is counted as it does.
    if (!started && order.operation === "hack") health.hacksSkipped += 1;
    if (!started && !batch.short) {
      batch.short = true;
      health.batchesShort += 1;
      logNow = true;
    }
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
    }
    if (next.next?.target !== config?.next?.target) {
      preparingNext = new Set();
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

  /** The RAM free for a preparation wave, GB: the hosts' free, less what the orders not yet out will take. */
  const freeForWaves = () => {
    let reserved = 0;
    for (const order of pending) {
      const batch = batches.get(order.batch);
      if (batch !== undefined) reserved += batch.threads[order.operation] * operationRamGb(order.operation);
    }
    return Math.max(0, batchRamGb(freeRam().map((host) => host.freeGb)) - reserved);
  };

  /**
   * Starts a preparation wave once the last has landed, or starts batching once the target is ready. A previous
   * target's batches may still be landing (#206): the wave takes the RAM they leave.
   */
  const prepare = () => {
    if (preparing.size > 0 || Date.now() < waitUntilMs) return;
    const { target, figures } = current();
    // A move back to a target its batches are still landing on (#216's review): they land first, so no wave goes out
    // among them.
    if ([...batches.values()].some((each) => each.target === target)) return;
    if (landing.some((each) => each.target === target && each.untilMs >= Date.now())) return;
    const now = { money: ns.getServerMoneyAvailable(target), security: ns.getServerSecurityLevel(target) };
    health.seen = now;
    const player = playerNow();
    // The RAM free, less what the batches out still need (a previous target's, after a move) and the next target's.
    const usableGb = Math.max(0, freeForWaves() - (current().next?.ramGb ?? 0));
    const threads = preparationWave(figures, player, now, usableGb);
    if (threads === null) {
      startBatching();
      return;
    }
    // Never `.grow` in this script: the game would charge grow's RAM for the name (Script/RamCalculations.ts:436-440).
    const { weaken1, grow: growCount, weaken2 } = threads;
    if (weaken1 + growCount === 0) {
      // None while a previous target's batches still hold the RAM (#206): it frees as they land.
      if (pending.length === 0) setProblem(`no RAM to prepare ${target}`);
      return;
    }
    // Called at the security now, so their times are the longest they'll be: all land after their time from now.
    const landAt = Date.now() + operationTimeMs("weaken1", figures, player, now.security) + BATCH_LAUNCH_LEAD_MS;
    const parts: [BatchOperation, number, number][] = [
      ["weaken1", weaken1, landAt],
      ["grow", growCount, landAt + BATCH_LANDING_GAP_MS],
      ["weaken2", weaken2, landAt + 2 * BATCH_LANDING_GAP_MS],
    ];
    let problem: string | null = lastingProblem;
    for (const [operation, operationThreads, operationLandAt] of parts) {
      const id = `p${wave}.${operation}`;
      if (operationThreads > 0 && !launch(operation, operationThreads, operationLandAt, id, target, preparing)) {
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

  /**
   * The next target (#206): a preparation wave on at most the config's RAM for it, once its last has landed, so a move
   * to it batches at once. Its operations hold RAM the batches don't plan on (the brain plans them on the rest).
   */
  const prepareNext = () => {
    const next = current().next;
    if (next === undefined || next.target === current().target || preparingNext.size > 0) return;
    const now = { money: ns.getServerMoneyAvailable(next.target), security: ns.getServerSecurityLevel(next.target) };
    const player = playerNow();
    const usableGb = Math.min(next.ramGb, freeForWaves());
    const threads = preparationWave(next.figures, player, now, usableGb);
    const nextHealth = health.next ?? { target: next.target, wavesStarted: 0, ready: false };
    health.next = nextHealth;
    nextHealth.ready = threads === null;
    if (threads === null) return;
    const { weaken1, grow: growCount, weaken2 } = threads;
    if (weaken1 + growCount === 0) return;
    const landAt = Date.now() + operationTimeMs("weaken1", next.figures, player, now.security) + BATCH_LAUNCH_LEAD_MS;
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
    const lost = landings.takeLostIds(Date.now());
    for (const id of lost) {
      preparing.delete(id);
      preparingNext.delete(id);
    }
    if (lost.length > 0) {
      health.lost += lost.length;
      logNow = true;
    }
    let wakeAt = Date.now() + PREPARING_LOOK_EVERY_MS;
    if (health.state === "preparing") {
      prepare();
      if (Date.now() < waitUntilMs) wakeAt = Math.min(wakeAt, waitUntilMs);
    }
    if (health.state === "batching") {
      // Plan each batch whose first operation is due, then launch every order due, in time order.
      if (hackSharePerThread(current().figures, playerNow()) > 0) {
        for (
          let next = planNextBatch();
          (next.orders[0] as LaunchOrder).launchAt <= Date.now();
          next = planNextBatch()
        ) {
          batches.set(nextBatch, next.batch);
          pending.push(...next.orders);
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
    while (pending.length > 0 && (pending[0] as LaunchOrder).launchAt <= Date.now()) {
      launchOrder(pending.shift() as LaunchOrder);
    }
    if (pending.length > 0) wakeAt = Math.min(wakeAt, (pending[0] as LaunchOrder).launchAt);
    if (health.state === "recovering" && pending.length === 0 && landings.inFlight() === 0) {
      health.state = "preparing";
      batches.clear();
      landing = [];
      preparing = new Set();
      logNow = true;
    }
    if (health.state !== "recovering") prepareNext();
    // Awake when a part would be lost, so it's counted then, not at the next launch.
    wakeAt = Math.min(wakeAt, landings.nextLostAtMs());
    health.batchesPending = batches.size;
    const latestLandAt = landings.latestLandAt();
    // Never before the one it waits for (#211): a batcher started while this one waits must wait for that one too.
    const latest = Math.max(latestLandAt, waitUntilMs);
    health.latestLandAt = Number.isFinite(latest) && latest > 0 ? latest : null;
    health.inFlight = landings.inFlight();
    const published = JSON.stringify({ ...health, atMs: 0 });
    const lineDue = Date.now() - lastLineAt >= HEALTH_LINE_EVERY_MS;
    if (published !== lastPublished || logNow || lineDue) {
      publish(ns, health, logNow || lineDue);
      if (logNow || lineDue) lastLineAt = Date.now();
      lastPublished = published;
      logNow = false;
    }
    const waitMs = Math.min(Math.max(0, wakeAt - Date.now()), HEALTH_LINE_EVERY_MS);
    // Woken by a landing, or a config written (the Agent writes it each round: a change is read within 2 s).
    await Promise.race([
      ns.asleep(waitMs),
      ns.nextPortWrite(BATCHER_LANDING_PORT),
      ns.nextPortWrite(BATCHER_CONFIG_PORT),
    ]);
  }
}
