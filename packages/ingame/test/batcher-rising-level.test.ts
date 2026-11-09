// The batcher on the real engine under a fast-rising hacking level (#315), run directly, with no Agent or brain. On
// the live run of 2026-11-08 clarkinc (needing 1,041) was batched from hacking 1,176, and once its batches landed
// their own exp took the level up 40 levels in a hack's 62 s. The game takes a hack's share at the level as it lands
// (NetscriptHelpers.tsx:561-568), so each hack, sized at the level as it went out, took up to 1.26x its share, the
// grows (sized for 1.1x) fell short batch after batch, and the money drifted out of the bounds: a desync, and 8.5
// minutes without a hack.
// Here the same shape on a fresh start: harakiri-sushi (needs 40) prepared by a first batcher, which is then killed;
// a second batches it from home made 4 PB, on core's `batchPlan` at the level then (about 146), and the batches'
// own exp takes the level past 340 within 6 minutes (the rise is printed). Each hack sized for the level forecast at
// its landing (core's `LevelForecast`), every grow leaves the target full, with no desync. The control arm runs the
// same with a config without the forecast's multipliers, its hacks sized at the level as they go out, as every
// batcher's before #315: its grows leave the money down to 32-40% and it desyncs out of bounds, on seeds 1 to 4
// (#315's review). CI runs seed 1; `BATCHER_SEEDS` (`1,2,3`, say) runs others.
import {
  BATCHER_HEALTH_PORT,
  BATCHER_SCRIPT_NAME,
  type BatcherConfig,
  type BatcherHealth,
  batchPlan,
  batchRamGb,
  type HackingPlayer,
  type HackingTarget,
} from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { expect, test } from "vitest";
import { NEW_GAME, useInGameBuild, useSimulations } from "./helpers/simulation.ts";

const start = useSimulations();
const build = useInGameBuild();
const SEEDS = (process.env.BATCHER_SEEDS ?? "1").split(",").map((each) => Number(each.trim()));

const FOLDER = "agent/a7a-test/";
const TARGET = "harakiri-sushi";
/**
 * Home, the batches' only host: 4 PB, so a batch every 80 ms with a share of about three quarters. The more RAM, the
 * steeper the batches' own exp raises the level: on 1 PB the control arm desynced with its least look at 92%, on 4 PB
 * at 39% (seeds 1 to 3, #315's review).
 */
const HOME_GB = 2 ** 22;
/** A fresh BN1 player's multipliers, all 1, and no intelligence. */
const MULTS: HackingPlayer["mults"] = { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 };
const player = (hacking: number): HackingPlayer => ({ skills: { hacking, intelligence: 0 }, mults: MULTS });
/** Hacking exp for hacking 50 on a fresh save. */
const HACKING_EXP = 2_000;
const PREPARED_WITHIN_MS = 20 * 60_000;
const BATCHED_MS = 6 * 60_000;
/** The rise the batches' own exp must give for the case to stand: before #315 this much broke the grows. */
const LEAST_RISE = 100;

const PEEK_PORT = "export async function main(ns) { ns.print(JSON.stringify(ns.peek(ns.args[0]))); }";
const FIGURES = `export async function main(ns) {
  const host = ns.args[0];
  ns.print(JSON.stringify({
    moneyMax: ns.getServerMaxMoney(host),
    minDifficulty: ns.getServerMinSecurityLevel(host),
    requiredHackingSkill: ns.getServerRequiredHackingLevel(host),
    serverGrowth: ns.getServerGrowth(host),
  }));
}`;

/** The last line a script printed that's JSON. */
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

/**
 * The scenario, on `seed`: harakiri-sushi prepared by a first batcher, then batched by a second from home for
 * `BATCHED_MS`, its config with the level forecast's multipliers (`forecasting`) or without, as an older brain's
 * (its hacks sized at the level as they go out, as every batcher's before #315).
 */
async function risingLevel(seed: number, forecasting: boolean) {
  const simulation = await start({ ...NEW_GAME, seed });
  const { source } = await build();
  await simulation.diagnostics.gainHackingExp(HACKING_EXP);
  for (const name of [BATCHER_SCRIPT_NAME, "batch-hack.js", "batch-grow.js", "batch-weaken.js", "hack-loop-root.js"]) {
    await simulation.writeFile("home", FOLDER + name, source(name));
  }
  await simulation.writeFile("home", "peek-port.js", PEEK_PORT);
  await simulation.writeFile("home", "figures.js", FIGURES);
  expect((await simulation.run("home", `${FOLDER}hack-loop-root.js`)).error).toBeUndefined();
  await simulation.advance(1_000);
  const { pid } = await simulation.run("home", "figures.js", { args: [TARGET] });
  await simulation.advance(1);
  const figures = JSON.parse(await printed(simulation, pid)) as HackingTarget;
  await simulation.diagnostics.setHomeRam(HOME_GB);
  /** A config on home, core's plan at the hacking level now. */
  const configNow = async (): Promise<BatcherConfig> => {
    const hacking = (await simulation.summary()).hackingLevel;
    const plan = batchPlan(figures, player(hacking), batchRamGb([HOME_GB]));
    if (plan === null) throw new Error(`no plan for ${TARGET} at hacking ${hacking}`);
    return {
      target: TARGET,
      figures,
      player: { intelligence: 0, mults: forecasting ? { ...MULTS, hacking: 1, hacking_exp: 1 } : MULTS },
      hosts: ["home"],
      hackShare: plan.hackShare,
      spacingMs: plan.spacingMs,
    };
  };
  // A first batcher prepares it, and is killed once it batches; its operations land meanwhile.
  const first = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, {
    args: [JSON.stringify(await configNow())],
  });
  expect(first.error).toBeUndefined();
  for (let waited = 0; (await healthOf(simulation)).state !== "batching"; waited += 15_000) {
    if (waited > PREPARED_WITHIN_MS) throw new Error(`${TARGET} not prepared within 20 virtual minutes`);
    await simulation.advance(15_000);
  }
  await simulation.kill(first.pid);
  await simulation.advance(5 * 60_000);
  const config = await configNow();
  const startLevel = (await simulation.summary()).hackingLevel;
  const second = await simulation.run("home", FOLDER + BATCHER_SCRIPT_NAME, { args: [JSON.stringify(config)] });
  expect(second.error).toBeUndefined();
  await simulation.advance(BATCHED_MS);
  const health = await healthOf(simulation);
  const endLevel = (await simulation.summary()).hackingLevel;
  console.log(
    `seed ${seed}, ${TARGET}, ${forecasting ? "forecast" : "sized at the level now"}: share ` +
      `${(config.hackShare * 100).toFixed(1)}%, a batch every ${config.spacingMs} ms; hacking ${startLevel} → ` +
      `${endLevel} in ${BATCHED_MS / 60_000} minutes; ${health.hacksLanded} hacks, ${health.hacksTrimmedForLevel} sent ` +
      `smaller for the level at their landing (up to +${health.mostLevelRise}); ${health.moneyLooks} looks after a ` +
      `grow, ${health.moneyLooksBelowFull} below full (least ${health.leastMoneyAfterGrow}); ${health.desyncs} desyncs`,
  );
  return { health, config, figures, rise: endLevel - startLevel };
}

test.each(SEEDS)(
  "seed %i: a level the batches' own exp raises fast: every grow leaves the target full, and no desync",
  { timeout: 600_000 },
  async (seed) => {
    const { health, config, figures, rise } = await risingLevel(seed, true);
    expect(rise).toBeGreaterThan(LEAST_RISE);
    expect(health).toMatchObject({
      state: "batching",
      desyncs: 0,
      outOfBounds: 0,
      outOfOrder: 0,
      late: 0,
      lost: 0,
      hacksSkipped: 0,
      moneyLooksBelowFull: 0,
      leastMoneyAfterGrow: 1,
      problem: null,
    });
    expect(health.hacksLanded).toBeGreaterThan(1_000);
    expect(health.moneyLooks).toBeGreaterThan(1_000);
    // The forecast did the work: hacks sent smaller for a level dozens of levels above the one they went out at.
    expect(health.hacksTrimmedForLevel).toBeGreaterThan(100);
    expect(health.mostLevelRise).toBeGreaterThan(20);
    // And no smaller than that: each hack still takes about the plan's share, the chance aside (a forecast that ran
    // ahead of the level, its parts never ended, would shrink them to a thread).
    const takenPerHack = health.moneyHacked / health.hacksLanded / figures.moneyMax;
    expect(takenPerHack).toBeGreaterThan(0.5 * config.hackShare);
  },
);

test.each(SEEDS)(
  "seed %i, the control: the same, its hacks sized at the level as they go out, leaves grows short",
  { timeout: 600_000 },
  async (seed) => {
    const { health, rise } = await risingLevel(seed, false);
    expect(rise).toBeGreaterThan(LEAST_RISE);
    // Each hack took more than its grow put back: the money below full after its grows, far below, and out of the
    // bounds, a desync, as on clarkinc on 2026-11-08.
    expect(health.moneyLooksBelowFull).toBeGreaterThan(0);
    expect(health.leastMoneyAfterGrow).toBeLessThan(0.75);
    expect(health.outOfBounds).toBeGreaterThan(0);
    expect(health.hacksTrimmedForLevel).toBe(0);
    expect(health.problem).toContain("no mults.hacking");
  },
);
