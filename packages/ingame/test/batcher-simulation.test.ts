// The batcher on the real engine (#204, M4 phase A slice A7a), run directly, with no Agent or brain: a fresh start's
// no-port servers rooted, hacking exp given (hacking 50), and `batcher.js` on home against n00dles, with core's
// `batchPlan` on its hosts' RAM. n00dles because only it can be prepared in reasonable time on a fresh start's RAM:
// the other no-port servers grow 5 to 40 (n00dles 3000), and joesguns, from a fresh start's 4% of its money, took over
// 20 waves and 40 virtual minutes to reach 6% on these 84 GB (#204's build). It prepares n00dles
// from a fresh start's 4% of its money and security 15, then batches; in the 10 virtual minutes after that, every
// landing is in order and on time, nothing is lost or out of bounds, and the money earned is at least half A1's batcher
// ceiling on the same RAM (#196: the hack loop's best 10 minutes are 18.3–19.9% of it). Then another script hacks
// n00dles behind the batcher's back: it counts a desync, stops hacking, prepares again and batches in step once more.
// The simulator's clock is virtual: script starts take no time and timers fire exactly when due (packages/sim README),
// so the real page's timing is E2's to show (#205). CI runs seed 1; `BATCHER_SEEDS` (`1,2,3,4`, say) runs others.
import {
  BATCHER_SCRIPT_NAME,
  type BatcherConfig,
  type BatcherHealth,
  batcherIncomePerGigabyteSecond,
  batchPlan,
  batchRamGb,
  type HackingPlayer,
  type HackingTarget,
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
const TARGET = "n00dles";
/** n00dles (servers.ts): $70,000 x 25 at most, security 1 at least (Server.ts:76, :83), hacking 1, growth 3000. */
const FIGURES: HackingTarget = { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 };
/** The no-port servers the batcher runs on, with their RAM (servers.ts: 2^4 GB, n00dles 2^2). */
const HOSTS: [string, number][] = [
  ["foodnstuff", 16],
  ["sigma-cosmetics", 16],
  ["joesguns", 16],
  ["harakiri-sushi", 16],
  ["nectar-net", 16],
  ["hong-fang-tea", 16],
  ["n00dles", 4],
];
/**
 * The other script that hacks n00dles runs on home, made 128 GB for it, with 40 threads: 16% a hack, and 0.08
 * security, more than a batch's hack adds (its 36 threads' 0.072, say).
 */
const ROGUE_HOME_RAM_GB = 128;
const ROGUE_THREADS = 40;
/** A fresh BN1 player's multipliers, all 1, and no intelligence. */
const MULTS: HackingPlayer["mults"] = { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 };
const player = (hacking: number): HackingPlayer => ({ skills: { hacking, intelligence: 0 }, mults: MULTS });
/** Hacking exp for hacking 50 on a fresh save. */
const HACKING_EXP = 2_000;
const TEN_MINUTES_MS = 10 * 60_000;
/** Bounds on each wait, in virtual time. */
const PREPARED_WITHIN_MS = 40 * 60_000;
const DESYNC_WITHIN_MS = 20 * 60_000;

test("BATCHER_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(batcherSeeds(undefined)).toEqual([1]);
  expect(batcherSeeds("1,2, 3")).toEqual([1, 2, 3]);
  for (const odd of ["", "1,", "0", "1.5", "two", "-1"]) expect(() => batcherSeeds(odd)).toThrow(/BATCHER_SEEDS/);
});

/** The batcher's latest health line in its log. */
async function healthOf(simulation: Simulation, pid: number): Promise<BatcherHealth> {
  const line = (await simulation.logs(pid)).filter((each) => each.startsWith("batcher: {")).at(-1);
  if (line === undefined) throw new Error(`the batcher logged no health: ${(await simulation.logs(pid)).join(" | ")}`);
  return JSON.parse(line.slice("batcher: ".length)) as BatcherHealth;
}

/**
 * Advances in steps of `stepMs` until `done` holds, within `withinMs`; fails if it never does, with the batcher's
 * (`pid`) last log lines.
 */
async function advanceUntil(
  simulation: Simulation,
  pid: number,
  done: () => Promise<boolean>,
  withinMs: number,
  what: string,
  stepMs = 5_000,
): Promise<void> {
  for (let waited = 0; waited <= withinMs; waited += stepMs) {
    if (await done()) return;
    await simulation.advance(stepMs);
  }
  const lines = (await simulation.logs(pid)).slice(-5).join(" | ");
  throw new Error(`${what}: not within ${withinMs / 60_000} virtual minutes; the batcher's log ends: ${lines}`);
}

test.each(SEEDS)(
  "seed %i: prepares n00dles, batches 10 minutes in step at half the batcher ceiling or more, recovers from a desync",
  { timeout: 600_000 },
  async (seed) => {
    const simulation = await start({ ...NEW_GAME, seed });
    const { source } = await build();
    await simulation.diagnostics.gainHackingExp(HACKING_EXP);
    for (const name of [
      BATCHER_SCRIPT_NAME,
      "batch-hack.js",
      "batch-grow.js",
      "batch-weaken.js",
      "hack-loop-root.js",
    ]) {
      await simulation.writeFile("home", FOLDER + name, source(name));
    }
    // Roots every no-port server, as the hack loop's root worker does.
    expect((await simulation.run("home", `${FOLDER}hack-loop-root.js`)).error).toBeUndefined();
    await simulation.advance(1_000);

    const hacking = (await simulation.summary()).hackingLevel;
    expect(hacking).toBeGreaterThanOrEqual(45);
    // The plan on what batches can use (1.8 GB threads); the ceiling on A1's measure (1.7 GB threads), as its score.
    const plan = batchPlan(FIGURES, player(hacking), batchRamGb(HOSTS.map(([, ram]) => ram)));
    const ramGb = HOSTS.reduce((total, [, ram]) => total + usableRamGb(ram), 0);
    expect(plan).not.toBeNull();
    if (plan === null) return;
    const config: BatcherConfig = {
      target: TARGET,
      figures: FIGURES,
      player: { intelligence: 0, mults: MULTS },
      hosts: HOSTS.map(([host]) => host),
      hackShare: plan.hackShare,
      spacingMs: plan.spacingMs,
    };
    const startedAt = await simulation.now();
    const { pid, error } = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, {
      args: [JSON.stringify(config)],
    });
    expect(error).toBeUndefined();

    const batching = async () => (await healthOf(simulation, pid)).state === "batching";
    await advanceUntil(simulation, pid, batching, PREPARED_WITHIN_MS, "n00dles prepared");
    const preparedAt = await simulation.now();
    // The first batches land a weaken's time after they start: the 10 minutes start once they do.
    await advanceUntil(
      simulation,
      pid,
      async () => (await healthOf(simulation, pid)).hacksLanded > 0,
      5 * 60_000,
      "a hack",
    );
    const before = { summary: await simulation.summary(), health: await healthOf(simulation, pid) };
    await simulation.advance(TEN_MINUTES_MS);
    const after = { summary: await simulation.summary(), health: await healthOf(simulation, pid) };

    const earnedPerSecond = (after.summary.money - before.summary.money) / (TEN_MINUTES_MS / 1000);
    // The ceiling rises with the hacking level, which the batches' exp raises about evenly: the mean of the ceilings at
    // the start and the end, as A1's fold weights each snapshot's ceiling by its time.
    const ceilingAt = (level: number) => batcherIncomePerGigabyteSecond(FIGURES, player(level), 1) * ramGb;
    const ceiling = (ceilingAt(before.summary.hackingLevel) + ceilingAt(after.summary.hackingLevel)) / 2;
    console.log(
      `seed ${seed}: prepared ${((preparedAt - startedAt) / 60_000).toFixed(1)} min in; plan: share ` +
        `${(plan.hackShare * 100).toFixed(1)}%, a batch every ${plan.spacingMs} ms, $${Math.round(plan.incomePerSecond)}/s; ` +
        `hacking ${before.summary.hackingLevel} → ${after.summary.hackingLevel}; 10 minutes: ` +
        `$${Math.round(earnedPerSecond)}/s, ${((earnedPerSecond / ceiling) * 100).toFixed(1)}% of the batcher ceiling ` +
        `($${Math.round(ceiling)}/s on ${ramGb.toFixed(1)} GB); ` +
        `${after.health.batchesStarted - before.health.batchesStarted} batches, ` +
        `${after.health.hacksLanded - before.health.hacksLanded} hack parts (${after.health.hacksFailed} failed in all)`,
    );
    expect(after.health).toMatchObject({
      state: "batching",
      outOfOrder: 0,
      late: 0,
      lost: 0,
      outOfBounds: 0,
      desyncs: 0,
      batchesShort: 0,
      hacksSkipped: 0,
      problem: null,
    });
    expect(after.health.hacksLanded - before.health.hacksLanded).toBeGreaterThan(5);
    expect(earnedPerSecond / ceiling).toBeGreaterThanOrEqual(0.5);
    expect(earnedPerSecond / ceiling).toBeLessThanOrEqual(1);

    // Another script hacks n00dles, over and over: the batcher sees the target outside its bounds.
    await simulation.diagnostics.setHomeRam(ROGUE_HOME_RAM_GB);
    await simulation.writeFile(
      "home",
      "rogue.js",
      "export async function main(ns) { for (;;) await ns.hack(ns.args[0]); }",
    );
    const rogue = await simulation.run("home", "rogue.js", { threads: ROGUE_THREADS, args: [TARGET] });
    expect(rogue.error).toBeUndefined();
    await advanceUntil(
      simulation,
      pid,
      async () => (await healthOf(simulation, pid)).desyncs > 0,
      DESYNC_WITHIN_MS,
      "a desync seen",
    );
    const desynced = await healthOf(simulation, pid);
    expect(desynced.outOfBounds).toBeGreaterThan(0);
    expect(desynced.hacksSkipped).toBeGreaterThan(0);
    expect(desynced.state).not.toBe("batching");
    await simulation.kill(rogue.pid);
    // Once what's in flight has landed it prepares n00dles again (which, growing 3000, may need no wave by then), and
    // batches in step: new batches, hacks landing again, with no new desync.
    await advanceUntil(simulation, pid, batching, PREPARED_WITHIN_MS, "n00dles prepared again");
    const again = await healthOf(simulation, pid);
    await advanceUntil(
      simulation,
      pid,
      async () => (await healthOf(simulation, pid)).hacksLanded > again.hacksLanded + 3,
      TEN_MINUTES_MS,
      "hacks landing again",
    );
    const recovered = await healthOf(simulation, pid);
    expect(recovered).toMatchObject({ state: "batching", outOfOrder: 0, late: 0, lost: 0, problem: null });
    expect(recovered.desyncs).toBe(desynced.desyncs);
    expect(recovered.batchesStarted).toBeGreaterThan(desynced.batchesStarted);
    console.log(
      `seed ${seed}: a desync ${desynced.outOfBounds} time(s) out of bounds, ${desynced.hacksSkipped} hacks skipped, ` +
        `${recovered.wavesStarted - desynced.wavesStarted} preparation waves, then in step again`,
    );
  },
);
