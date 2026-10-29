// agent/<deploymentId>/batcher.js: the batcher (#204, M4 phase A slice A7a), a reflex (architecture §5.5). Its one
// argument is its config as JSON (core's `BatcherConfig`): the target and its figures, the player's multipliers, the
// hosts, the share a batch hacks and the spacing between batches, chosen by the brain from core's `batchPlan` (A7c).
// It never decides strategy; it times and launches, and checks what lands. Design: #204.
// - **Preparing:** while the target isn't at its minimum security and maximum money, a wave at a time (core's
//   `preparationWave`): weaken, grow and weaken, landing in that order, on the RAM free.
// - **Batching:** a batch's hack lands every spacing, its weaken, grow and weaken δ apart after it. Each operation is
//   started just in time, its hold before it lands (core's `batchOrders`), on the hosts' free RAM (`placeThreads`),
//   and lands itself (../workers/batch-operation.ts). A batch's threads are fixed when its first weaken goes out, at
//   the hacking level then; its hack goes out only if the rest did and the target is within the bounds
//   (`batchBounds`).
// - **Checked, loudly:** every landing is recorded on the landing port; one before a landing already recorded is out
//   of order, one started too late is late, one never recorded is lost. Out of order, or the target outside the bounds
//   at a hack, is a desync: no more hacks or batches, and once nothing is in flight, it prepares the target again.
// - **Health:** core's `BatcherHealth`, on its health port whenever it changes, and in its log every minute and at each
//   change of state or anything wrong.
// RAM: `exec` 1.3 + `scp` 0.6 + `getServerMoneyAvailable` and `getServerSecurityLevel` 0.1 each + `getServerMaxRam`,
// `getServerUsedRam` and `getHackingLevel` 0.05 each; ports and `asleep` are free (ram-budget.json).
import {
  BATCH_GROW_SCRIPT_NAME,
  BATCH_HACK_SCRIPT_NAME,
  BATCH_LANDING_GAP_MS,
  BATCH_LAUNCH_LEAD_MS,
  BATCH_WEAKEN_SCRIPT_NAME,
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
  hackThreadsForShare,
  LandingWatch,
  type LaunchOrder,
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
  let parsed: ReturnType<typeof parseBatcherConfig>;
  try {
    parsed = parseBatcherConfig(JSON.parse(String(ns.args[0])));
  } catch {
    parsed = { ok: false, reason: "its argument isn't JSON" };
  }
  if (!parsed.ok) {
    const health = newBatcherHealth("", Date.now());
    health.problem = `can't run: ${parsed.reason}`;
    publish(ns, health, true);
    return;
  }
  await runBatcher(ns, parsed.config);
}

/** The health on its port, and in the log when `logIt`. */
function publish(ns: NS, health: BatcherHealth, logIt: boolean): void {
  health.atMs = Date.now();
  ns.clearPort(BATCHER_HEALTH_PORT);
  ns.writePort(BATCHER_HEALTH_PORT, { ...health });
  if (logIt) ns.print(`batcher: ${JSON.stringify(health)}`);
}

async function runBatcher(ns: NS, config: BatcherConfig): Promise<void> {
  const { target, figures } = config;
  const health = newBatcherHealth(target, Date.now());
  const folder = ns.getScriptName().slice(0, ns.getScriptName().lastIndexOf("/") + 1);
  const files = [BATCH_HACK_SCRIPT_NAME, BATCH_GROW_SCRIPT_NAME, BATCH_WEAKEN_SCRIPT_NAME].map((name) => folder + name);
  const hosts = config.hosts.filter((host) => host === "home" || ns.scp(files, host, "home"));
  if (hosts.length < config.hosts.length) {
    health.problem = `can't copy its scripts to ${config.hosts.filter((host) => !hosts.includes(host)).join(", ")}`;
  }
  const landings = new LandingWatch();
  const playerNow = (): HackingPlayer => ({
    skills: { hacking: ns.getHackingLevel(), intelligence: config.player.intelligence },
    mults: config.player.mults,
  });
  const freeRam = (): HostRam[] =>
    hosts.map((host) => ({ host, freeGb: ns.getServerMaxRam(host) - ns.getServerUsedRam(host) }));

  /** Starts an operation's threads on the free RAM, landing at `landAt`; false if they didn't all start. */
  const launch = (operation: BatchOperation, threads: number, landAt: number, id: string): boolean => {
    const placed = placeThreads(freeRam(), threads, operationRamGb(operation));
    if (placed === null) return false;
    for (const [part, { host, threads: partThreads }] of placed.entries()) {
      const partId = `${id}.${part}`;
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

  let logNow = true;
  const desync = () => {
    health.desyncs += 1;
    logNow = true;
    if (health.state === "batching") health.state = "recovering";
  };

  /** Every record on the landing port, checked. */
  const drainLandings = () => {
    for (;;) {
      const data = ns.readPort(BATCHER_LANDING_PORT);
      if (data === "NULL PORT DATA") return;
      const record = parseLandingRecord(data);
      if (record === null) {
        health.problem = `an unreadable landing record: ${JSON.stringify(data)}`;
        logNow = true;
        continue;
      }
      const { outOfOrder } = landings.landed(record);
      if (record.late) {
        health.late += 1;
        logNow = true;
      }
      if (record.id.split(".")[1] === "hack" && !record.late) {
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

  // Batching: the next batch's number and its hack's landing; the orders due, earliest first; each batch's threads.
  let nextBatch = 0;
  let nextLandAt = 0;
  const pending: LaunchOrder[] = [];
  const batches = new Map<number, { threads: BatchThreads; short: boolean }>();
  let wave = 0;

  /** The next batch, planned at the hacking level now: its threads and orders. */
  const planNextBatch = () => {
    const player = playerNow();
    const threads = batchThreads(figures, player, hackThreadsForShare(config.hackShare, figures, player));
    return { threads, orders: batchOrders(nextBatch, nextLandAt, batchHoldsMs(figures, player, threads)) };
  };

  /** Starts batching: the first batch's operations all start from now, after anything still in flight lands. */
  const startBatching = () => {
    health.state = "batching";
    logNow = true;
    const player = playerNow();
    const threads = batchThreads(figures, player, hackThreadsForShare(config.hackShare, figures, player));
    const holds = batchHoldsMs(figures, player, threads);
    const firstLandAt = Date.now() + Math.max(...Object.values(holds));
    nextLandAt = Math.max(firstLandAt, landings.latestLandAt() + config.spacingMs);
  };

  /** Launches one order of a batch. */
  const launchOrder = (order: LaunchOrder) => {
    const batch = batches.get(order.batch);
    if (batch === undefined) return;
    if (order.operation === "hack") {
      // The hack is a batch's last order out.
      batches.delete(order.batch);
      if (batch.short || health.state !== "batching") {
        health.hacksSkipped += 1;
        return;
      }
      const bounds = batchBounds(figures, playerNow(), batch.threads);
      const money = ns.getServerMoneyAvailable(target);
      const security = ns.getServerSecurityLevel(target);
      health.seen = { money, security };
      if (money < bounds.moneyFloor || security > bounds.securityCeiling) {
        health.outOfBounds += 1;
        health.hacksSkipped += 1;
        desync();
        return;
      }
    }
    const started = launch(
      order.operation,
      batch.threads[order.operation],
      order.landAt,
      `${order.batch}.${order.operation}`,
    );
    if (!started && !batch.short) {
      batch.short = true;
      health.batchesShort += 1;
      logNow = true;
    }
  };

  /** Starts a preparation wave if nothing is in flight; whether the target is ready (or a wave was started). */
  const prepare = () => {
    if (landings.inFlight() > 0) return;
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
      const problem = `no RAM to prepare ${target}`;
      if (health.problem !== problem) logNow = true;
      health.problem = problem;
      return;
    }
    // Called at the security now, so their times are the longest they'll be: all land after their time from now.
    const landAt = Date.now() + operationTimeMs("weaken1", figures, player, now.security) + BATCH_LAUNCH_LEAD_MS;
    const parts: [BatchOperation, number, number][] = [
      ["weaken1", weaken1, landAt],
      ["grow", growCount, landAt + BATCH_LANDING_GAP_MS],
      ["weaken2", weaken2, landAt + 2 * BATCH_LANDING_GAP_MS],
    ];
    for (const [operation, operationThreads, operationLandAt] of parts) {
      if (operationThreads > 0 && !launch(operation, operationThreads, operationLandAt, `p${wave}.${operation}`)) {
        health.problem = `a preparation ${operation} of ${operationThreads} threads wouldn't start`;
        logNow = true;
      }
    }
    wave += 1;
    health.wavesStarted += 1;
  };

  let lastLineAt = 0;
  let lastPublished = "";
  for (;;) {
    drainLandings();
    const lost = landings.takeLost(Date.now());
    if (lost > 0) {
      health.lost += lost;
      logNow = true;
    }
    let wakeAt = Date.now() + PREPARING_LOOK_EVERY_MS;
    if (health.state === "preparing") {
      prepare();
    }
    if (health.state === "batching") {
      // Plan each batch whose first operation is due, then launch every order due, in time order.
      if (hackSharePerThread(figures, playerNow()) > 0) {
        for (
          let next = planNextBatch();
          (next.orders[0] as LaunchOrder).launchAt <= Date.now();
          next = planNextBatch()
        ) {
          batches.set(nextBatch, { threads: next.threads, short: false });
          pending.push(...next.orders);
          health.batchesStarted += 1;
          nextBatch += 1;
          nextLandAt += config.spacingMs;
        }
        wakeAt = (planNextBatch().orders[0] as LaunchOrder).launchAt;
      } else if (health.problem === null) {
        health.problem = `a hack of ${target} takes nothing at this hacking level`;
        logNow = true;
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
        logNow = true;
      }
    }
    const published = JSON.stringify({ ...health, atMs: 0 });
    const lineDue = Date.now() - lastLineAt >= HEALTH_LINE_EVERY_MS;
    if (published !== lastPublished || logNow || lineDue) {
      publish(ns, health, logNow || lineDue);
      if (logNow || lineDue) lastLineAt = Date.now();
      lastPublished = published;
      logNow = false;
    }
    const waitMs = Math.min(Math.max(0, wakeAt - Date.now()), HEALTH_LINE_EVERY_MS);
    await Promise.race([ns.asleep(waitMs), ns.nextPortWrite(BATCHER_LANDING_PORT)]);
  }
}
