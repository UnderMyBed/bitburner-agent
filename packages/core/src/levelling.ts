/**
 * Levelling (#336, planner v0's first decision, owner decision 67): once The Red Pill is installed and w0r1d_d43m0n
 * rooted, its hacking requirement (3000 × the BitNode's `WorldDaemonDifficulty`, `Server/ServerHelpers.ts:383-385`) is
 * all that's left. The rules propose three candidates and the planner takes the one whose estimated time to the level
 * is least, the formulas its model and the rates fitted online from live snapshots:
 * - **money:** batching for money as now, at its measured experience rate;
 * - **level:** levelling mode, grow or weaken loops on the server and with the operation that earn the most experience
 *   per thread-second at its minimum security, on the RAM the batcher would batch with (`levellingExpPerThreadSecond`,
 *   the formula's prediction, times the factor fitted from the measured rate in that mode);
 * - **install:** NeuroFlux Governor's levels the money buys, an install, w0r1d_d43m0n rooted again
 *   (`LEVELLING_REROOT_MS`), then levelling mode from zero experience at the new multipliers, on home's RAM alone (the
 *   cloud servers are lost, `Prestige.ts`, and bought back later: left out, cautious), after the install's own time
 *   (`LEVELLING_INSTALL_MS`).
 * Every rate scales with the level as `level + 50`: an operation's time is `5 × (2.5 × required × security + 500) /
 * (hacking + 50)` over the speed (`Hacking.ts:60-80`), so on fixed RAM the threads land that much more often, each
 * giving the same experience (`Hacking.ts:30-38`). The same scaling for the batcher's measured rate values both sides
 * alike; its hacks' rising share, and intelligence's slow rise, are left out (cautious).
 * Pure, so the brain's rule and the run report score with the same functions.
 */
import { AUGMENTATIONS } from "./augmentation-data.ts";
import { NEUROFLUX_GOVERNOR } from "./augmentations.ts";
import { growThreads, hackingExpOfLevel, hackingLevelOfExp, operationExpPerThread, threadsThatFit } from "./batcher.ts";
import { growthLogPerThread, LEVEL_LOOP_RAM_GB } from "./hack-loop.ts";
import {
  GROW_SECURITY_PER_THREAD,
  GROW_TIME_PER_HACK_TIME,
  type HackingPlayer,
  type HackingTarget,
  hackTimeSeconds,
  WEAKEN_TIME_PER_HACK_TIME,
} from "./hacking-ceiling.ts";

/** Levelling mode's operations (#336): the level loop's (`level-loop.js`) and the grow loop's (`level-grow.js`). */
export const LEVELLING_OPERATIONS = ["grow", "weaken"] as const;
export type LevellingOperation = (typeof LEVELLING_OPERATIONS)[number];

/** The candidates, in the order a tie goes: the cheapest action first. */
export const LEVELLING_CANDIDATES = ["money", "level", "install"] as const;
export type LevellingCandidate = (typeof LEVELLING_CANDIDATES)[number];

/**
 * How much shorter another candidate's estimate must be to move to it: 1.25 times, as the batcher's move to another
 * target (the brain's `BATCHER_MOVE_GAIN`). The estimates move with the measured rates (a 10-minute window) and the
 * money; a move costs (the batcher's preparation, a weaken at the levelling target's security, the install), so a lead
 * within it isn't worth one, and the choice doesn't flap.
 */
export const LEVELLING_SWITCH_GAIN = 1.25;

/**
 * An install's own time, before levelling starts again: 15 minutes, as long as A8 lets The Red Pill's install take
 * before it's a stall (the brain's `RED_PILL_INSTALL_STALLED_AFTER_MS`): A6's whole commit, NeuroFlux Governor a
 * purchase at a time, the gate's two medium snapshots and a save backup, and the restart. Cautious: the commit usually
 * takes minutes.
 */
export const LEVELLING_INSTALL_MS = 15 * 60_000;

/**
 * The time from the install to w0r1d_d43m0n rooted again, the rooted gate open again (the port openers and the money
 * for them are lost with it, `Prestige.ts`): 3.4 minutes, one live measurement, BN4's. In BN4.1 (2026-11-10) The Red
 * Pill's install was at 17:02:18; the TOR router came at 1.9 minutes, the five port openers at 3.2, the root at 3.4,
 * at hacking 2,938 (the coordinator's reading of that run's store). The experience meanwhile is left out (cautious).
 */
export const LEVELLING_REROOT_MS = 3.4 * 60_000;

/** The level's term in an operation's time: `hacking + 50` (`Hacking.ts:69-73`'s `baseSkill`). */
const LEVEL_TERM = 50;

/**
 * The hacking experience a thread of `operation` earns a second on `target` at its minimum security: a thread's
 * experience (`calculateHackingExpGain`, `Hacking.ts:30-38`, the same for a grow, a weaken or a hack that succeeds,
 * `NetscriptFunctions.ts:295`, `:373`; core's `operationExpPerThread`) over the operation's time (a grow's 3.2 hacks', a
 * weaken's 4, `Hacking.ts:83-94`). So a grow earns 1.25 times a weaken's, at the same 0.15 GB (`RamCostGenerator.ts:18`,
 * `:20`); at its maximum money it adds no security (`processSingleServerGrowth`, `Server/ServerHelpers.ts:201-212`).
 * `hackingExp` is the player's `hacking_exp` with the BitNode's `HackExpGain` folded in (0.4 in BN4). Neither needs the
 * hacking level, only root (`Hacking/netscriptCanHack.ts:49-55`). 0 for a server whose base difficulty is 0 (the game
 * gives no experience there) or unread.
 */
export function levellingExpPerThreadSecond(
  target: HackingTarget,
  player: HackingPlayer,
  hackingExp: number,
  operation: LevellingOperation = "weaken",
): number {
  if (!(typeof target.baseDifficulty === "number" && target.baseDifficulty > 0)) return 0;
  const seconds =
    (operation === "grow" ? GROW_TIME_PER_HACK_TIME : WEAKEN_TIME_PER_HACK_TIME) *
    hackTimeSeconds(
      { hackDifficulty: target.minDifficulty, requiredHackingSkill: target.requiredHackingSkill },
      player,
    );
  return seconds > 0 ? operationExpPerThread(target, hackingExp) / seconds : 0;
}

/**
 * The levelling target and its operation: of `targets` (the game's rooted servers) and the operations, the pair with
 * the most experience a thread-second (`levellingExpPerThreadSecond`), ties to the first hostname and to the grow;
 * null with none above 0. Computed, never named: in BN1 and BN4 it's joesguns (base difficulty 15, minimum 5, required
 * 10), as `7.5 / 625` beats every other server's `(3 + 0.3 × base) / (2.5 × required × minimum + 500)`, whatever the
 * level and the speed, which only scale them all; and the grow, 1.25 times the weaken on every server. A target
 * grows only where `mayGrow` says (the brain: at its minimum security, whatever its money); elsewhere, the weaken (all
 * may, absent). Below its maximum money a grow adds 0.004 security a thread used (`Server/ServerHelpers.ts:201-212`),
 * but on millions of threads one round fills it: the security rises once, a weaken round takes it back, and at its
 * maximum money a grow moves no money, so adds no security, for good. At most a flip or two, each losing a round in
 * flight (`levellingPreparationMs`).
 */
export function chooseLevellingTarget<Target extends { hostname: string; figures: HackingTarget }>(
  targets: readonly Target[],
  player: HackingPlayer,
  hackingExp: number,
  mayGrow: (target: Target) => boolean = () => true,
): (Target & { expPerThreadSecond: number; operation: LevellingOperation }) | null {
  let best: (Target & { expPerThreadSecond: number; operation: LevellingOperation }) | null = null;
  for (const target of targets) {
    for (const operation of LEVELLING_OPERATIONS) {
      if (operation === "grow" && !mayGrow(target)) continue;
      const expPerThreadSecond = levellingExpPerThreadSecond(target.figures, player, hackingExp, operation);
      if (!(expPerThreadSecond > 0)) continue;
      if (
        best === null ||
        expPerThreadSecond > best.expPerThreadSecond ||
        (expPerThreadSecond === best.expPerThreadSecond && target.hostname < best.hostname)
      ) {
        best = { ...target, expPerThreadSecond, operation };
      }
    }
  }
  return best;
}

/**
 * The time to prepare `target` for the grow loop, ms, from its starting security and money (after an install, the
 * servers made afresh, `Prestige.ts:74`, `:98`): a weaken round at its starting security (its base difficulty) to its
 * minimum (`threads` × 0.05 a thread take it there at once on any RAM levelling has), a grow round at its minimum
 * from a 25th of its maximum money (`Server/Server.ts:74-76`, BN1's ratio: elsewhere the start is a larger share,
 * so fewer threads used, and this is cautious) to its maximum, adding 0.004 security a thread it uses (core's
 * `growThreads`, `Server/ServerHelpers.ts:201-212`), then a weaken round at that security back to its minimum. Each at
 * `player`'s level and speed (`Hacking.ts:60-94`). From then on, at its maximum money, a grow adds no security.
 */
export function levellingPreparationMs(target: HackingTarget, player: HackingPlayer, threads: number): number {
  const required = target.requiredHackingSkill;
  const hackMs = (security: number) =>
    hackTimeSeconds({ hackDifficulty: security, requiredHackingSkill: required }, player) * 1000;
  const start = typeof target.baseDifficulty === "number" ? target.baseDifficulty : 3 * target.minDifficulty;
  const growthLog = growthLogPerThread(
    { serverGrowth: target.serverGrowth, hackDifficulty: target.minDifficulty },
    { mults: { hacking_grow: player.mults.hacking_grow } },
  );
  const used = Math.min(threads, growThreads(target.moneyMax / 25, target.moneyMax, target.moneyMax, growthLog));
  const raised = target.minDifficulty + GROW_SECURITY_PER_THREAD * (Number.isFinite(used) ? used : threads);
  return (
    WEAKEN_TIME_PER_HACK_TIME * hackMs(Math.max(start, target.minDifficulty)) +
    GROW_TIME_PER_HACK_TIME * hackMs(target.minDifficulty) +
    WEAKEN_TIME_PER_HACK_TIME * hackMs(Math.min(100, raised))
  );
}

/** The level loop's threads on hosts with this much RAM each, GB: each one's whole threads (`threadsThatFit`). */
export function levelLoopThreads(hostsRamGb: readonly number[]): number {
  return hostsRamGb.reduce((total, ramGb) => total + threadsThatFit(ramGb, LEVEL_LOOP_RAM_GB), 0);
}

/** An experience rate at a level, which scales with the level as `level + 50` (the module's comment). */
export interface LevellingRate {
  expPerSecond: number;
  atLevel: number;
}

/** Simpson's rule's intervals for `secondsToHackingLevel`: its error is under 1e-7 of the time. */
const INTEGRATION_STEPS = 512;

/**
 * The seconds from `exp` hacking experience to the level `required`, at `rate` scaled by `level + 50`, the level from
 * the experience as the game's `calculateSkill` has it (`PersonObjects/formulas/skill.ts:7-15`, `levelMult` the
 * player's `mults.hacking` × the BitNode's `HackingLevelMultiplier`), neither floored nor clamped to 1 (it's above 0
 * from 0 experience): optimistic by under one level's rate, 1/(level + 51) of it, at most 2% from level 1. With
 * u = ln(exp + 534.6), dt = e^u du / (κ (L(u) + 50)), integrated by Simpson's rule. 0 once reached; Infinity with no
 * rate.
 */
export function secondsToHackingLevel(exp: number, required: number, levelMult: number, rate: LevellingRate): number {
  if (hackingLevelOfExp(exp, levelMult) >= required) return 0;
  const kappa = rate.expPerSecond / (rate.atLevel + LEVEL_TERM);
  if (!(kappa > 0) || !Number.isFinite(kappa)) return Number.POSITIVE_INFINITY;
  const from = Math.log(Math.max(0, exp) + 534.6);
  const to = Math.log(hackingExpOfLevel(required, levelMult) + 534.6);
  if (!(to > from)) return 0;
  const integrand = (u: number) => Math.exp(u) / (levelMult * (32 * u - 200) + LEVEL_TERM);
  const step = (to - from) / INTEGRATION_STEPS;
  let sum = integrand(from) + integrand(to);
  for (let index = 1; index < INTEGRATION_STEPS; index++) {
    sum += (index % 2 === 1 ? 4 : 2) * integrand(from + index * step);
  }
  return (sum * step) / 3 / kappa;
}

/** NeuroFlux Governor's multipliers a level (`Augmentation/Augmentations.ts:1159-1192`): 1.01 and a donation's bit. */
export function neuroFluxMultipliers(): { hacking: number; hackingExp: number; hackingSpeed: number } {
  const { multipliers } = AUGMENTATIONS[NEUROFLUX_GOVERNOR] as { multipliers: Readonly<Record<string, number>> };
  return {
    hacking: multipliers.hacking ?? 1,
    hackingExp: multipliers.hacking_exp ?? 1,
    hackingSpeed: multipliers.hacking_speed ?? 1,
  };
}

/** What the candidates are scored on. */
export interface LevellingInputs {
  /** The player's hacking experience and level now, the level w0r1d_d43m0n needs, and the level multiplier. */
  exp: number;
  level: number;
  required: number;
  levelMult: number;
  /** (a) The measured experience rate while batching for money, at the level it was measured at; null unmeasured. */
  money: LevellingRate | null;
  /**
   * (b) The formula's rate in levelling mode on the RAM it would run on now (`levelLoopThreads` ×
   * `levellingExpPerThreadSecond`), at the level now, and the factor fitted from its measured rate (null unmeasured:
   * 1, optimistic, as the scripts' starts and the Agent's convergence lose a little). Null with no levelling target.
   */
  levelling: { predicted: LevellingRate; factor: number | null } | null;
  /**
   * (c) NeuroFlux Governor's levels the money buys (A6's count, donations included: decision 53), home's level loop
   * threads (home's RAM is kept through an install, `Prestige.ts`), and one thread's predicted rate on the levelling
   * target after it (before the levels): the grow's, after the target's preparation (`preparationMs`,
   * `levellingPreparationMs`), as the install leaves every server at its starting security and money (the servers
   * made afresh, `Prestige.ts:74`, `:98`; `Server/Server.ts:74-76`); null with no levels to buy or no levelling target.
   */
  install: { levels: number; homeThreads: number; perThread: LevellingRate; preparationMs?: number } | null;
}

/** Each candidate's estimated seconds to the level, null where it has none (unmeasured, or not on offer). */
export type LevellingEstimates = Record<LevellingCandidate, number | null>;

/**
 * The candidates' estimates (#336): (a) at its measured rate; (b) at the formula's prediction times its fitted factor;
 * (c) the install's own time, w0r1d_d43m0n's root again (`LEVELLING_REROOT_MS`, one live BN4 measurement) and the
 * target's preparation for the grow (`preparationMs`: its experience left out, cautious), then from 0 experience at the multipliers the levels give (`levelMult`, `hacking_exp` and `hacking_speed` × NeuroFlux
 * Governor's each, `neuroFluxMultipliers`), at (b)'s factor, on home's threads alone. Left out of (c): the cloud servers
 * bought back, the experience while w0r1d_d43m0n is rooted again, and the set's other augmentations A6 buys first (all
 * cautious).
 */
export function levellingEstimates(inputs: LevellingInputs): LevellingEstimates {
  const { exp, required, levelMult } = inputs;
  const money = inputs.money === null ? null : secondsToHackingLevel(exp, required, levelMult, inputs.money);
  const factor = inputs.levelling?.factor ?? 1;
  const level =
    inputs.levelling === null
      ? null
      : secondsToHackingLevel(exp, required, levelMult, {
          expPerSecond: inputs.levelling.predicted.expPerSecond * factor,
          atLevel: inputs.levelling.predicted.atLevel,
        });
  let install: number | null = null;
  const offer = inputs.install;
  if (offer !== null && offer.levels > 0 && offer.homeThreads > 0) {
    const neuroFlux = neuroFluxMultipliers();
    const rate = {
      expPerSecond:
        offer.perThread.expPerSecond *
        offer.homeThreads *
        factor *
        (neuroFlux.hackingExp * neuroFlux.hackingSpeed) ** offer.levels,
      atLevel: offer.perThread.atLevel,
    };
    install =
      (LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS + (offer.preparationMs ?? 0)) / 1000 +
      secondsToHackingLevel(0, required, levelMult * neuroFlux.hacking ** offer.levels, rate);
  }
  return { money, level, install };
}

/** The candidate whose estimate is least, ties to the cheapest action (`LEVELLING_CANDIDATES`' order); null with none. */
export function shortestLevellingCandidate(estimates: LevellingEstimates): LevellingCandidate | null {
  let best: LevellingCandidate | null = null;
  for (const candidate of LEVELLING_CANDIDATES) {
    const seconds = estimates[candidate];
    if (seconds === null || Number.isNaN(seconds)) continue;
    if (best === null || seconds < (estimates[best] as number)) best = candidate;
  }
  return best;
}

/**
 * The planner's choice (#336), from `current`: the shortest candidate once its estimate is `LEVELLING_SWITCH_GAIN`
 * times shorter than `current`'s, else `current`. With `current`'s estimate unmeasured: money (the mode a run is in as
 * the level becomes all that's left) waits for its measurement, a minute's; any other moves to the shortest.
 */
export function chooseLevelling(estimates: LevellingEstimates, current: LevellingCandidate): LevellingCandidate {
  const best = shortestLevellingCandidate(estimates);
  if (best === null || best === current) return current;
  const currentSeconds = estimates[current];
  if (currentSeconds === null) return current === "money" ? current : best;
  return (estimates[best] as number) * LEVELLING_SWITCH_GAIN < currentSeconds ? best : current;
}
