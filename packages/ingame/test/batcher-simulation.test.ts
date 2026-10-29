// The batcher on the real engine (#204, M4 phase A slice A7a), run directly, with no Agent or brain: a fresh start's
// no-port servers rooted, hacking exp given (hacking about 55), and `batcher.js` on home with core's `batchPlan` on its
// hosts' RAM, the seven no-port servers. Two cases:
// - **n00dles** (needs hacking 1, growth 3000): it prepares it from a fresh start's 4% of its money, then batches for
//   10 virtual minutes; then another script hacks n00dles behind its back, and it counts a desync, stops hacking,
//   prepares again and batches in step once more. Only n00dles can be prepared in reasonable time on a fresh start's
//   RAM: the other no-port servers grow 5 to 40, and joesguns took over 20 waves and 40 virtual minutes to reach 6% of
//   its money on these 84 GB (#204's build).
// - **harakiri-sushi** (needs hacking 40; A1's best target here): prepared by a first batcher on a home made 8 TB for
//   it, which is then killed with its operations in flight; a second batches it on the same hosts for 10 minutes,
//   ignoring the first one's records (#208's review, finding 4). The preparation's exp takes hacking to about 121, so
//   the level hardly moves in the 10 minutes: the grow margin under a fast-rising level (finding 5) is core's
//   rising-level test (batcher.test.ts, `hackThreadsAtLaunch`).
// In each 10 minutes, nothing lands out of order, late or lost, and nothing is short or out of bounds. **The score is
// A1's measure** (#196): money earned against the batcher ceiling of the best rooted target on the hosts' RAM
// (core's `batcherIncomePerGigabyteSecond` x A1's `usableRamGb`), at the hacking level every 10 s, as A1's fold weights
// each medium snapshot's; the hack loop's best 10 minutes are 18.3–19.9% of it. The ceiling of the target batched alone
// is printed beside it. The simulator's clock is virtual: script starts take no time and timers fire exactly when due
// (packages/sim README), so the real page's timing is E2's to show (#205). CI runs seed 1; `BATCHER_SEEDS`
// (`1,2,3,4`, say) runs others.
import {
  BATCH_LAUNCH_LEAD_MS,
  BATCHER_HEALTH_PORT,
  BATCHER_SCRIPT_NAME,
  type BatcherConfig,
  type BatcherHealth,
  batcherIncomePerGigabyteSecond,
  batchPlan,
  batchRamGb,
  type HackingPlayer,
  type HackingTarget,
  operationTimeMs,
  usableRamGb,
} from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { expect, test } from "vitest";
import { NEW_GAME, useInGameBuild, useSimulations } from "./helpers/simulation.ts";

/** `BATCHER_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function batcherSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`BATCHER_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const start = useSimulations();
const build = useInGameBuild();
const SEEDS = batcherSeeds(process.env.BATCHER_SEEDS);

const FOLDER = "agent/a7a-test/";
/** The no-port servers, all rooted: the batcher's hosts, with their RAM (servers.ts: 2^4 GB, n00dles 2^2). */
const HOSTS: [string, number][] = [
  ["foodnstuff", 16],
  ["sigma-cosmetics", 16],
  ["joesguns", 16],
  ["harakiri-sushi", 16],
  ["nectar-net", 16],
  ["hong-fang-tea", 16],
  ["n00dles", 4],
];
/** The RAM the score is on, A1's measure of the hosts' (1.7 GB threads); the plan gets `batchRamGb` (1.8 GB). */
const SCORE_RAM_GB = HOSTS.reduce((total, [, ram]) => total + usableRamGb(ram), 0);
/**
 * The other script that hacks n00dles runs on home, made 128 GB for it, with 40 threads: 16% a hack, and 0.08
 * security, more than a batch's hack adds (its 36 threads' 0.072, say).
 */
const ROGUE_HOME_RAM_GB = 128;
const ROGUE_THREADS = 40;
/** Home, for the first batcher that prepares harakiri-sushi from 4% of its money in a wave or two. */
const PREPARING_HOME_RAM_GB = 8_192;
/** A fresh BN1 player's multipliers, all 1, and no intelligence. */
const MULTS: HackingPlayer["mults"] = { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 };
const player = (hacking: number): HackingPlayer => ({ skills: { hacking, intelligence: 0 }, mults: MULTS });
/** Hacking exp for hacking 50 or more on a fresh save. */
const HACKING_EXP = 2_000;
const TEN_MINUTES_MS = 10 * 60_000;
/** A1's medium snapshots come every 10 s: the ceiling is taken as often. */
const SAMPLE_EVERY_MS = 10_000;
/** Bounds on each wait, in virtual time. */
const PREPARED_WITHIN_MS = 40 * 60_000;
const DESYNC_WITHIN_MS = 20 * 60_000;
/**
 * The least score, of A1's measure, over 10 minutes. Seeds 1 to 8 gave 32.1–32.9% on n00dles and 32.0–52.3% on
 * harakiri-sushi (a hack chance of about 80%, over 19 hacks) at #208's review fixes; this is 6 points under the worst,
 * so an engine bump can move it a little without failing, and it's still above the hack loop's best 10 minutes
 * (18.3–19.9%). #206 is held to twice that.
 */
const LEAST_SCORE = 0.26;

test("BATCHER_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(batcherSeeds(undefined)).toEqual([1]);
  expect(batcherSeeds("1,2, 3")).toEqual([1, 2, 3]);
  for (const odd of ["", "1,", "0", "1.5", "two", "-1"]) expect(() => batcherSeeds(odd)).toThrow(/BATCHER_SEEDS/);
});

/** Logs a port's first entry, leaving it there. */
const PEEK_PORT = "export async function main(ns) { ns.print(JSON.stringify(ns.peek(ns.args[0]))); }";
/** Logs every rooted no-port server's figures, as the static snapshot has them, from the game itself. */
const FIGURES = `export async function main(ns) {
  const figures = {};
  for (const host of ns.args) {
    figures[host] = {
      moneyMax: ns.getServerMaxMoney(host),
      minDifficulty: ns.getServerMinSecurityLevel(host),
      requiredHackingSkill: ns.getServerRequiredHackingLevel(host),
      serverGrowth: ns.getServerGrowth(host),
    };
  }
  ns.print(JSON.stringify(figures));
}`;

/** The last line a script printed that's JSON: an object, or a quoted string. */
async function printed(simulation: Simulation, pid: number): Promise<string> {
  const line = (await simulation.logs(pid)).filter((each) => /^[{"n]/.test(each)).at(-1);
  if (line === undefined) throw new Error(`script ${pid} printed nothing: ${(await simulation.logs(pid)).join(" | ")}`);
  return line;
}

/** The batcher's health, from its port. */
async function healthOf(simulation: Simulation): Promise<BatcherHealth> {
  const { pid } = await simulation.run("home", "peek-port.js", { args: [BATCHER_HEALTH_PORT] });
  await simulation.advance(1);
  return JSON.parse(await printed(simulation, pid)) as BatcherHealth;
}

/** Advances in steps of `stepMs` until `done` holds, within `withinMs`; fails if it never does, with the health. */
async function advanceUntil(
  simulation: Simulation,
  done: (health: BatcherHealth) => boolean,
  withinMs: number,
  what: string,
  stepMs = 5_000,
): Promise<void> {
  for (let waited = 0; waited <= withinMs; waited += stepMs) {
    if (done(await healthOf(simulation))) return;
    await simulation.advance(stepMs);
  }
  const health = JSON.stringify(await healthOf(simulation));
  throw new Error(`${what}: not within ${withinMs / 60_000} virtual minutes; the batcher's health: ${health}`);
}

/** A fresh start, the scripts on home, the no-port servers rooted, hacking exp given; and the servers' figures. */
async function freshGame(seed: number): Promise<{ simulation: Simulation; figures: Record<string, HackingTarget> }> {
  const simulation = await start({ ...NEW_GAME, seed });
  const { source } = await build();
  await simulation.diagnostics.gainHackingExp(HACKING_EXP);
  for (const name of [BATCHER_SCRIPT_NAME, "batch-hack.js", "batch-grow.js", "batch-weaken.js", "hack-loop-root.js"]) {
    await simulation.writeFile("home", FOLDER + name, source(name));
  }
  await simulation.writeFile("home", "peek-port.js", PEEK_PORT);
  await simulation.writeFile("home", "figures.js", FIGURES);
  // Roots every no-port server, as the hack loop's root worker does.
  expect((await simulation.run("home", `${FOLDER}hack-loop-root.js`)).error).toBeUndefined();
  await simulation.advance(1_000);
  const { pid } = await simulation.run("home", "figures.js", { args: HOSTS.map(([host]) => host) });
  await simulation.advance(1);
  return { simulation, figures: JSON.parse(await printed(simulation, pid)) as Record<string, HackingTarget> };
}

/** A batcher config on the hosts, core's plan at the hacking level now. */
async function plannedConfig(simulation: Simulation, target: string, figures: HackingTarget): Promise<BatcherConfig> {
  const hacking = (await simulation.summary()).hackingLevel;
  const plan = batchPlan(figures, player(hacking), batchRamGb(HOSTS.map(([, ram]) => ram)));
  if (plan === null) throw new Error(`no plan for ${target} at hacking ${hacking}`);
  return {
    target,
    figures,
    player: { intelligence: 0, mults: MULTS },
    hosts: HOSTS.map(([host]) => host),
    hackShare: plan.hackShare,
    spacingMs: plan.spacingMs,
  };
}

/**
 * 10 minutes of batching, scored: money earned against the batcher ceiling on the hosts' RAM, of the best rooted
 * target (A1's measure) and of the target alone, each taken at the hacking level every 10 s. Also the most batches
 * planned whose hacks hadn't gone out, seen at any sample.
 */
async function scoredTenMinutes(
  simulation: Simulation,
  target: string,
  figures: Record<string, HackingTarget>,
): Promise<{ score: number; ofTarget: number; best: string; levels: string; mostPending: number }> {
  let ceiling = 0;
  let targetCeiling = 0;
  const bestCount = new Map<string, number>();
  let mostPending = 0;
  const first = await simulation.summary();
  let level = first.hackingLevel;
  for (let elapsed = 0; elapsed < TEN_MINUTES_MS; elapsed += SAMPLE_EVERY_MS) {
    const perGigabyteSecond = Object.entries(figures).map(
      ([host, each]) => [host, batcherIncomePerGigabyteSecond(each, player(level), 1)] as const,
    );
    const [best, bestRate] = perGigabyteSecond.reduce((most, each) => (each[1] > most[1] ? each : most));
    bestCount.set(best, (bestCount.get(best) ?? 0) + 1);
    ceiling += bestRate * SCORE_RAM_GB * (SAMPLE_EVERY_MS / 1000);
    targetCeiling +=
      batcherIncomePerGigabyteSecond(figures[target] as HackingTarget, player(level), 1) *
      SCORE_RAM_GB *
      (SAMPLE_EVERY_MS / 1000);
    await simulation.advance(SAMPLE_EVERY_MS);
    level = (await simulation.summary()).hackingLevel;
    mostPending = Math.max(mostPending, (await healthOf(simulation)).batchesPending);
  }
  const earned = (await simulation.summary()).money - first.money;
  const best = [...bestCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return {
    score: earned / ceiling,
    ofTarget: earned / targetCeiling,
    best,
    levels: `${first.hackingLevel} → ${level}`,
    mostPending,
  };
}

/** The most batches pending at once in step: those whose first weaken has gone out within a weaken's time, and one. */
function pendingAtMost(config: BatcherConfig, hacking: number): number {
  return Math.ceil((operationTimeMs("weaken1", config.figures, player(hacking)) + 1_000) / config.spacingMs) + 1;
}

const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

/** Health in step: nothing out of order, late, lost, short, skipped or out of bounds; no desync, no problem. */
const IN_STEP = {
  state: "batching",
  outOfOrder: 0,
  late: 0,
  lost: 0,
  outOfBounds: 0,
  desyncs: 0,
  batchesShort: 0,
  hacksSkipped: 0,
  problem: null,
};

test.each(SEEDS)(
  "seed %i: prepares n00dles, batches 10 minutes in step, scored on A1's measure, and recovers from a desync",
  { timeout: 600_000 },
  async (seed) => {
    const { simulation, figures } = await freshGame(seed);
    const config = await plannedConfig(simulation, "n00dles", figures.n00dles as HackingTarget);
    const startedAt = await simulation.now();
    const { error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
    expect(error).toBeUndefined();
    await advanceUntil(simulation, (health) => health.state === "batching", PREPARED_WITHIN_MS, "n00dles prepared");
    const preparedAt = await simulation.now();
    // The first batches land a weaken's time after they start: the 10 minutes start once they do.
    await advanceUntil(simulation, (health) => health.hacksLanded > 0, 5 * 60_000, "a hack");
    const before = await healthOf(simulation);
    const scored = await scoredTenMinutes(simulation, "n00dles", figures);
    const after = await healthOf(simulation);
    console.log(
      `seed ${seed}, n00dles: prepared ${((preparedAt - startedAt) / 60_000).toFixed(1)} min in; plan: share ` +
        `${percent(config.hackShare)}, a batch every ${config.spacingMs} ms; hacking ${scored.levels}; 10 minutes: ` +
        `${percent(scored.score)} of the batcher ceiling (A1's measure, best target ${scored.best}), ` +
        `${percent(scored.ofTarget)} of n00dles' alone; ${after.batchesStarted - before.batchesStarted} batches, ` +
        `${after.hacksLanded - before.hacksLanded} hack parts`,
    );
    expect(after).toMatchObject(IN_STEP);
    // Script starts take no virtual time here, so every operation had its whole lead to spare (#211).
    expect(after.leastSlackMs).toBeGreaterThanOrEqual(BATCH_LAUNCH_LEAD_MS - 1);
    expect(after.hacksLanded - before.hacksLanded).toBeGreaterThan(5);
    expect(scored.score).toBeGreaterThanOrEqual(LEAST_SCORE);
    expect(scored.ofTarget).toBeLessThanOrEqual(1);
    // Every batch planned leaves the books once its hack goes out.
    expect(scored.mostPending).toBeLessThanOrEqual(pendingAtMost(config, 50));

    // Another script hacks n00dles, over and over: the batcher sees the target outside its bounds.
    await simulation.diagnostics.setHomeRam(ROGUE_HOME_RAM_GB);
    await simulation.writeFile(
      "home",
      "rogue.js",
      "export async function main(ns) { for (;;) await ns.hack(ns.args[0]); }",
    );
    const rogue = await simulation.run("home", "rogue.js", { threads: ROGUE_THREADS, args: ["n00dles"] });
    expect(rogue.error).toBeUndefined();
    await advanceUntil(simulation, (health) => health.desyncs > 0, DESYNC_WITHIN_MS, "a desync seen");
    const desynced = await healthOf(simulation);
    expect(desynced.outOfBounds).toBeGreaterThan(0);
    expect(desynced.hacksSkipped).toBeGreaterThan(0);
    expect(desynced.state).not.toBe("batching");
    await simulation.kill(rogue.pid);
    // Once what's in flight has landed it prepares n00dles again (which, growing 3000, may need no wave by then), and
    // batches in step: new batches, hacks landing again, with no new desync.
    await advanceUntil(simulation, (health) => health.state === "batching", PREPARED_WITHIN_MS, "prepared again");
    const again = await healthOf(simulation);
    await advanceUntil(
      simulation,
      (health) => health.hacksLanded > again.hacksLanded + 3,
      TEN_MINUTES_MS,
      "hacks landing again",
    );
    const recovered = await healthOf(simulation);
    expect(recovered).toMatchObject({ state: "batching", outOfOrder: 0, late: 0, lost: 0, problem: null });
    expect(recovered.desyncs).toBe(desynced.desyncs);
    // The batches pending when it desynced had their hacks skipped while it recovered, never sent.
    expect(recovered.hacksSkipped).toBeGreaterThan(desynced.hacksSkipped);
    expect(recovered.batchesStarted).toBeGreaterThan(desynced.batchesStarted);
    console.log(
      `seed ${seed}, n00dles: a desync ${desynced.outOfBounds} time(s) out of bounds, ${desynced.hacksSkipped} hacks ` +
        `skipped, ${recovered.wavesStarted - desynced.wavesStarted} preparation waves, then in step again`,
    );
  },
);

test.each(SEEDS)(
  "seed %i: harakiri-sushi (needs 40), A1's best target, batched 10 minutes in step after a restart",
  { timeout: 600_000 },
  async (seed) => {
    const { simulation, figures } = await freshGame(seed);
    const harakiri = figures["harakiri-sushi"] as HackingTarget;
    expect(harakiri.requiredHackingSkill).toBeGreaterThan(1);
    // A first batcher prepares it on a home made 8 TB for it, and is killed once it batches, its operations in flight.
    await simulation.diagnostics.setHomeRam(PREPARING_HOME_RAM_GB);
    const preparing: BatcherConfig = {
      ...(await plannedConfig(simulation, "harakiri-sushi", harakiri)),
      hosts: ["home"],
    };
    const first = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(preparing)] });
    expect(first.error).toBeUndefined();
    await advanceUntil(simulation, (health) => health.state === "batching", PREPARED_WITHIN_MS, "harakiri prepared");
    await simulation.advance(1_000);
    expect((await healthOf(simulation)).inFlight).toBeGreaterThan(0);
    await simulation.kill(first.pid);

    const config = await plannedConfig(simulation, "harakiri-sushi", harakiri);
    const second = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
    expect(second.error).toBeUndefined();
    await advanceUntil(simulation, (health) => health.hacksLanded > 0, 10 * 60_000, "a hack");
    const before = await healthOf(simulation);
    const scored = await scoredTenMinutes(simulation, "harakiri-sushi", figures);
    const after = await healthOf(simulation);
    console.log(
      `seed ${seed}, harakiri-sushi: plan: share ${percent(config.hackShare)}, a batch every ${config.spacingMs} ms; ` +
        `hacking ${scored.levels}; 10 minutes: ${percent(scored.score)} of the batcher ceiling (A1's measure, best ` +
        `target ${scored.best}), ${percent(scored.ofTarget)} of harakiri-sushi's alone; ` +
        `${after.batchesStarted - before.batchesStarted} batches, ${after.hacksLanded - before.hacksLanded} hack parts ` +
        `(${after.hacksFailed - before.hacksFailed} failed); ${after.unexpected} records of the first batcher ignored`,
    );
    // The first batcher's records, landing after it was killed, were counted and never trusted.
    expect(after.unexpected).toBeGreaterThan(0);
    expect(after).toMatchObject(IN_STEP);
    // Script starts take no virtual time here, so every operation had its whole lead to spare (#211).
    expect(after.leastSlackMs).toBeGreaterThanOrEqual(BATCH_LAUNCH_LEAD_MS - 1);
    expect(after.hacksLanded - before.hacksLanded).toBeGreaterThan(5);
    expect(scored.score).toBeGreaterThanOrEqual(LEAST_SCORE);
    expect(scored.ofTarget).toBeLessThanOrEqual(1);
    expect(scored.mostPending).toBeLessThanOrEqual(pendingAtMost(config, 50));
  },
);
