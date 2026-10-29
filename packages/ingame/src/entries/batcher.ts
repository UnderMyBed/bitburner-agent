// agent/<deploymentId>/batcher.js: the batcher (#204, M4 phase A slice A7a), a reflex (architecture §5.5). Its one
// argument is its config as JSON (core's `BatcherConfig`): the target and its figures, the player's multipliers, the
// hosts, the share a batch hacks and the spacing between batches, chosen by the brain from core's `batchPlan` (A7c).
// It never decides strategy; it times and launches, and checks what lands. Design: #204.
// - **Its config, hot (#205):** with no argument, as the Agent's `batcher-deploy.js` starts it, it re-reads its config
//   from its config port every loop, where the Agent writes the desired state's (architecture §5.5): a new share,
//   spacing or player applies from the next batch; new hosts get the operation scripts; a new target lets what's in
//   flight land, as after a desync, then prepares it. With none there yet, or one it can't read, it says so and waits.
//   Given its config as its argument (#204's tests), it keeps that one.
// - **After another batcher (#205):** it waits for the latest landing the one before it last published, so its first
//   operations don't find the hosts' RAM still held.
// - **Preparing:** while the target isn't at its minimum security and maximum money, a wave at a time (core's
//   `preparationWave`): weaken, grow and weaken, landing in that order, on the RAM free.
// - **Batching:** a batch's hack lands every spacing, its weaken, grow and weaken δ apart after it. Each operation is
//   started just in time, its hold before it lands (core's `batchOrders`), on the hosts' free RAM (`placeThreads`),
//   and lands itself (../workers/batch-operation.ts). A batch's threads are planned when its first weaken goes out,
//   and its hack threads replanned when its hack does (`hackThreadsAtLaunch`), at the hacking level then; the hack goes
//   out only if the rest did and the target is within the bounds of every batch still landing (`batchBounds`).
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
  const playerNow = (): HackingPlayer => ({
    skills: { hacking: ns.getHackingLevel(), intelligence: current().player.intelligence },
    mults: current().player.mults,
  });
  const freeRam = (): HostRam[] =>
    hosts.map((host) => ({ host, freeGb: ns.getServerMaxRam(host) - ns.getServerUsedRam(host) }));

  /** Starts an operation's threads on the free RAM, landing at `landAt`; false if they didn't all start. */
  const launch = (operation: BatchOperation, threads: number, landAt: number, id: string, target: string): boolean => {
    const placed = placeThreads(freeRam(), threads, operationRamGb(operation));
    if (placed === null) return false;
    for (const [part, { host, threads: partThreads }] of placed.entries()) {
      const partId = `${runName}.${id}.${part}`;
      const options = { threads: partThreads, temporary: true };
      if (
        ns.exec(folder + operationScriptName(operation), host, options, target, landAt, BATCHER_LANDING_PORT, partId)
      ) {
        landings.expect(partId, landAt);
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
      const isHack = record.id.split(".")[2] === "hack";
      if (record.late) {
        health.late += 1;
        logNow = true;
      }
      if (isHack && record.skipped) health.hacksSkipped += 1;
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
  let landing: { threads: BatchThreads; untilMs: number }[] = [];
  let wave = 0;

  /** The next batch, planned at the hacking level now: its threads, its hack's share and its orders. */
  const planNextBatch = () => {
    const { target, figures } = current();
    const player = playerNow();
    const threads = batchThreads(figures, player, hackThreadsForShare(current().hackShare, figures, player));
    // Not `threads.hack`: the game would charge hack's 0.1 GB for the name (Script/RamCalculations.ts:436-440).
    const { hack: hackCount } = threads;
    const plannedShare = hackCount * hackSharePerThread(figures, player);
    return {
      batch: { target, figures, threads, plannedShare, short: false },
      orders: batchOrders(nextBatch, nextLandAt, batchHoldsMs(figures, player, threads)),
    };
  };

  /** Starts batching: the first batch's operations all start from now, after anything still in flight lands. */
  const startBatching = () => {
    health.state = "batching";
    logNow = true;
    setProblem(lastingProblem);
    const { figures, hackShare, spacingMs } = current();
    const player = playerNow();
    const threads = batchThreads(figures, player, hackThreadsForShare(hackShare, figures, player));
    const holds = batchHoldsMs(figures, player, threads);
    const firstLandAt = Date.now() + Math.max(...Object.values(holds));
    nextLandAt = Math.max(firstLandAt, landings.latestLandAt() + spacingMs);
  };

  /** Launches one order of a batch. */
  const launchOrder = (order: LaunchOrder) => {
    const batch = batches.get(order.batch);
    if (batch === undefined) return;
    let threads = batch.threads[order.operation];
    if (order.operation === "hack") {
      // The hack is a batch's last order out.
      batches.delete(order.batch);
      if (batch.short || health.state !== "batching") {
        health.hacksSkipped += 1;
        return;
      }
      const player = playerNow();
      landing = landing.filter((each) => each.untilMs >= Date.now());
      const bounds = batchBounds(batch.figures, player, [batch.threads, ...landing.map((each) => each.threads)]);
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
      landing.push({ threads: batch.threads, untilMs: order.landAt + landingOffsetMs("weaken2") });
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
    if (newTarget && health.state === "batching") health.state = "recovering";
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

  /** Starts a preparation wave if nothing is in flight, or starts batching once the target is ready. */
  const prepare = () => {
    if (landings.inFlight() > 0 || Date.now() < waitUntilMs) return;
    const { target, figures } = current();
    const now = { money: ns.getServerMoneyAvailable(target), security: ns.getServerSecurityLevel(target) };
    health.seen = now;
    const player = playerNow();
    const usableGb = batchRamGb(freeRam().map((host) => host.freeGb));
    const threads = preparationWave(figures, player, now, usableGb);
    if (threads === null) {
      startBatching();
      return;
    }
    // Never `.grow` in this script: the game would charge grow's RAM for the name (Script/RamCalculations.ts:436-440).
    const { weaken1, grow: growCount, weaken2 } = threads;
    if (weaken1 + growCount === 0) {
      setProblem(`no RAM to prepare ${target}`);
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
      if (operationThreads > 0 && !launch(operation, operationThreads, operationLandAt, id, target)) {
        problem = `a preparation ${operation} of ${operationThreads} threads wouldn't start`;
      }
    }
    setProblem(problem);
    wave += 1;
    health.wavesStarted += 1;
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
    const lost = landings.takeLost(Date.now());
    if (lost > 0) {
      health.lost += lost;
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
    if (health.state !== "preparing") {
      pending.sort((a, b) => a.launchAt - b.launchAt || a.landAt - b.landAt);
      while (pending.length > 0 && (pending[0] as LaunchOrder).launchAt <= Date.now()) {
        launchOrder(pending.shift() as LaunchOrder);
      }
      if (pending.length > 0) wakeAt = Math.min(wakeAt, (pending[0] as LaunchOrder).launchAt);
      if (health.state === "recovering" && pending.length === 0 && landings.inFlight() === 0) {
        health.state = "preparing";
        batches.clear();
        landing = [];
        logNow = true;
      }
    }
    // Awake when a part would be lost, so it's counted then, not at the next launch.
    wakeAt = Math.min(wakeAt, landings.nextLostAtMs());
    health.batchesPending = batches.size;
    const latestLandAt = landings.latestLandAt();
    health.latestLandAt = Number.isFinite(latestLandAt) ? latestLandAt : null;
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
