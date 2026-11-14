/**
 * Levelling (#336, planner v0's first decision, owner decision 67): once The Red Pill is installed and w0r1d_d43m0n
 * rooted, its hacking requirement (3000 × the BitNode's `WorldDaemonDifficulty`, `Server/ServerHelpers.ts:383-385`) is
 * all that's left. The rules propose three candidates and the planner takes the one whose estimated time to the level
 * is least, the formulas its model and the rates fitted online from live snapshots:
 * - **money:** batching for money as now, at its measured experience rate;
 * - **level:** levelling mode, grow or weaken loops on the server and with the operation that earn the most experience
 *   per thread-second at its minimum security, on the RAM the batcher would batch with (`levellingExpPerThreadSecond`,
 *   the formula's prediction, times the factor fitted from the measured rate in that mode);
 * - **install:** NeuroFlux Governor's levels the money buys and (#355) the set A6 would buy that adds to levelling
 *   (the gang's shop's in BN2, which sells no NeuroFlux Governor), an install, w0r1d_d43m0n rooted again (`LEVELLING_REROOT_MS`), then levelling mode from
 *   zero experience at the new multipliers, on home's RAM alone (the cloud servers are lost, `Prestige.ts`, and bought
 *   back later: left out, cautious), after the install's own time (`LEVELLING_INSTALL_MS`);
 * - **batch** (#380): batching for the money M the set and NeuroFlux Governor's levels cost beyond the money now, at
 *   the batcher's measured income, then buying them, the install, and levelling as (c) from the install's start
 *   (`batchThenInstallPlan`): M the least total of the levels' ladder (core's `neuroFluxLadder`).
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
export const LEVELLING_CANDIDATES = ["money", "level", "install", "batch"] as const;
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

/** The three multipliers levelling's time reads (`secondsToHackingLevel`, `levellingExpPerThreadSecond`). */
export interface LevellingMultipliers {
  hacking: number;
  hackingExp: number;
  hackingSpeed: number;
}

/**
 * The multipliers an install gives levelling (#355): NeuroFlux Governor's to the power of `levels`
 * (`neuroFluxMultipliers`), times each of `augmentations`' (the set A6 would buy, by the game's names; its
 * multipliers `AUGMENTATIONS`', `Augmentation/Augmentations.ts`; an unknown name throws). An install applies each
 * queued augmentation's by product (`applyAugmentation`, `Augmentation/AugmentationHelpers.ts:39-50`;
 * `mergeMultipliers`, `PersonObjects/Multipliers.ts:71-79`), no BitNode scaling them. Only the three levelling's time
 * reads: the level's (`hacking`, `PersonObjects/formulas/skill.ts:13`), the experience's (`hacking_exp`,
 * `Hacking.ts:37`) and the speed's (`hacking_speed`, `Hacking.ts:60-80`); a grow or weaken always lands, so the
 * chance's is moot. Their `hacking_grow` would fill the target in fewer threads after the install, less security
 * raised to weaken back: left out of the preparation (cautious).
 */
export function levellingInstallMultipliers(
  levels: number,
  augmentations: readonly string[] = [],
): LevellingMultipliers {
  const neuroFlux = neuroFluxMultipliers();
  const product = {
    hacking: neuroFlux.hacking ** levels,
    hackingExp: neuroFlux.hackingExp ** levels,
    hackingSpeed: neuroFlux.hackingSpeed ** levels,
  };
  for (const name of augmentations) {
    if (!Object.hasOwn(AUGMENTATIONS, name)) throw new RangeError(`no augmentation ${JSON.stringify(name)}`);
    const { multipliers } = AUGMENTATIONS[name] as { multipliers: Readonly<Record<string, number>> };
    product.hacking *= multipliers.hacking ?? 1;
    product.hackingExp *= multipliers.hacking_exp ?? 1;
    product.hackingSpeed *= multipliers.hacking_speed ?? 1;
  }
  return product;
}

/**
 * Whether `augmentations` add to levelling (#355): one of the three multipliers (`levellingInstallMultipliers`) above
 * 1. An install of none of them, and no NeuroFlux Governor level, would only lose the experience.
 */
export function addsToLevelling(augmentations: readonly string[]): boolean {
  const product = levellingInstallMultipliers(0, augmentations);
  return product.hacking > 1 || product.hackingExp > 1 || product.hackingSpeed > 1;
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
   * (c) NeuroFlux Governor's levels the money buys (A6's count, donations included: decision 53), and (#355)
   * `augmentations`, the set A6 would buy first (absent, none); home's level loop
   * threads (home's RAM is kept through an install, `Prestige.ts`), and one thread's predicted rate on the levelling
   * target after it (before the levels and the set): the grow's, after the target's preparation (`preparationMs`,
   * `levellingPreparationMs`), as the install leaves every server at its starting security and money (the servers
   * made afresh, `Prestige.ts:74`, `:98`; `Server/Server.ts:74-76`); null with nothing to install for or no levelling
   * target.
   */
  install: {
    levels: number;
    augmentations?: readonly string[];
    homeThreads: number;
    perThread: LevellingRate;
    preparationMs?: number;
  } | null;
  /** (d) (#380): batching for the money, then the set and the levels and an install; absent or null, none. */
  batch?: LevellingBatchOffer | null;
}

/**
 * (d)'s offer (#380): what the batching would buy and how fast it earns, and the install's figures as (c)'s.
 * - `money`: the money now; `incomePerSecond`: the batcher's measured income (the brain's levelling rule takes the hack
 *   loop's, `HackLoopIncome`, cloud-servers.ts, once the batcher has run its whole window), null unmeasured.
 * - `ladder`: entry k the money the set (`augmentations`, A6's at any money that adds to levelling) and k NeuroFlux
 *   Governor levels after it cost, donations included (core's `neuroFluxLadder`); rising.
 * - `homeThreads`, `perThread`: as (c)'s. `preparationMs`: the target's preparation at the set alone's level and speed
 *   (more levels only shorten it: cautious by a fraction of its own few minutes, 186 s on BN4.2's figures).
 */
export interface LevellingBatchOffer {
  money: number;
  incomePerSecond: number | null;
  ladder: readonly number[];
  augmentations?: readonly string[];
  homeThreads: number;
  perThread: LevellingRate;
  preparationMs?: number;
  /**
   * The longest the batching may take (#382's review), seconds: the BitNode's time so far, #336's bar for a hopeless
   * estimate (the run report's, `world-daemon-report.ts`: the whole path to here took that long). Past it, (d)'s
   * estimate is dominated by what it leaves out (later installs, the income's rise), so a count batching longer isn't
   * weighed. Absent or null, no bound.
   */
  batchingBoundSeconds?: number | null;
}

/** (d)'s best plan (#380): its estimate, the levels to buy after the set, M, and the batching's part of the time. */
export interface LevellingBatchPlan {
  seconds: number;
  levels: number;
  money: number;
  batchingSeconds: number;
}

/** Each candidate's estimated seconds to the level, null where it has none (unmeasured, or not on offer). */
export type LevellingEstimates = Record<LevellingCandidate, number | null>;

/**
 * The seconds from an install's commit to the level (#336, #355): the install's own time, w0r1d_d43m0n's root again
 * and the target's preparation, then from 0 experience at the multipliers `levels` and `augmentations` give
 * (`levellingInstallMultipliers`), at `factor` (b)'s, on home's threads alone. Since #410 it's D from m too: the time
 * after The Red Pill's install at the multipliers it would leave (`redPillInstallTiming`, the destroy estimate's D).
 */
export function levellingSecondsAfterInstall(
  levels: number,
  augmentations: readonly string[],
  offer: { homeThreads: number; perThread: LevellingRate; preparationMs?: number },
  factor: number,
  required: number,
  levelMult: number,
): number {
  const gain = levellingInstallMultipliers(Math.max(0, levels), augmentations);
  const rate = {
    expPerSecond: offer.perThread.expPerSecond * offer.homeThreads * factor * gain.hackingExp * gain.hackingSpeed,
    atLevel: offer.perThread.atLevel,
  };
  return (
    (LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS + (offer.preparationMs ?? 0)) / 1000 +
    secondsToHackingLevel(0, required, levelMult * gain.hacking, rate)
  );
}

/**
 * (d)'s plan (#380), or null with none: of the ladder's counts k whose money M_k is beyond the money now (the money in
 * hand buys (c)'s install), the least of (M_k − money) / income (the batching; the income held constant, cautious, as
 * it rises with the level) + `levellingSecondsAfterInstall` at the set and k levels. On offer with an income measured above 0,
 * home's threads, and k above 0 or the set adding to levelling (`addsToLevelling`).
 * The search ends at the first k whose batching alone, with the install's fixed time, is past the best total: M_k
 * rises with k (each level costs more than none, `neuroFluxLadder`), so every later k's batching is longer still,
 * and its time after the install is at least 0. So the least is found exactly, whatever the shape of the time after
 * the install; it takes about log(best × income / first price) / log(2.17) steps past the best k, each level costing
 * about 2.17 times the one before it (×1.14 a level, `NEUROFLUX_LEVEL_GROWTH`; ×1.9 a purchase,
 * `Augmentation/AugmentationHelpers.ts:29-31`, `Constants.ts:41`). Left out, as (c)'s: the cloud servers bought back,
 * the experience while w0r1d_d43m0n is rooted again (cautious), and later installs (toward (d)); and (d)'s own: the
 * experience batching earns, which the install resets (`PersonObjects/Player/PlayerObjectGeneralMethods.ts:80-102`,
 * `Prestige.ts:44`: so none counted, exact); the money cloud servers and home RAM may take while batching toward M,
 * nothing held back for it (toward (d): bounded purchases, which raise the income); and the share's trade-off with
 * the income (#342's placeholder).
 */
export function batchThenInstallPlan(inputs: LevellingInputs): LevellingBatchPlan | null {
  const offer = inputs.batch ?? null;
  if (offer === null || offer.homeThreads <= 0) return null;
  const income = offer.incomePerSecond;
  if (income === null || !(income > 0) || !Number.isFinite(income)) return null;
  const augmentations = offer.augmentations ?? [];
  const setAdds = addsToLevelling(augmentations);
  const factor = inputs.levelling?.factor ?? 1;
  const fixedSeconds = (LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS + (offer.preparationMs ?? 0)) / 1000;
  let best: LevellingBatchPlan | null = null;
  for (let levels = 0; levels < offer.ladder.length; levels++) {
    const money = offer.ladder[levels] as number;
    if (!(money > offer.money) || (levels === 0 && !setAdds)) continue;
    const batchingSeconds = (money - offer.money) / income;
    // Past #336's hopeless bar (#382's review): this count and every later one, as the batching rises with k.
    if (offer.batchingBoundSeconds != null && batchingSeconds > offer.batchingBoundSeconds) break;
    if (!(batchingSeconds + fixedSeconds < (best?.seconds ?? Number.POSITIVE_INFINITY))) break;
    const seconds =
      batchingSeconds +
      levellingSecondsAfterInstall(levels, augmentations, offer, factor, inputs.required, inputs.levelMult);
    if (best === null || seconds < best.seconds) best = { seconds, levels, money, batchingSeconds };
  }
  return best;
}

/**
 * The candidates' estimates (#336): (a) at its measured rate; (b) at the formula's prediction times its fitted factor;
 * (c) the install's own time, w0r1d_d43m0n's root again (`LEVELLING_REROOT_MS`, one live BN4 measurement) and the
 * target's preparation for the grow (`preparationMs`: its experience left out, cautious), then from 0 experience at the
 * multipliers the levels and the set give (`levelMult`, `hacking_exp` and `hacking_speed` × theirs,
 * `levellingInstallMultipliers`), at (b)'s factor, on home's threads alone. On offer with a level to buy or a set that
 * adds to levelling (`addsToLevelling`, #355), and home's threads. Left out of (c): the cloud servers bought back, the
 * experience while w0r1d_d43m0n is rooted again (both cautious); and later installs on both sides: the option to wait
 * for a larger set, and the cost to later sets of the install's reset of the factions' reputation and the money
 * (`Prestige.ts`), which bias toward (c). Where every estimate is hopeless any set that adds wins, so it installs
 * greedily; the cadence is #357's.
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
  const augmentations = offer?.augmentations ?? [];
  if (offer !== null && (offer.levels > 0 || addsToLevelling(augmentations)) && offer.homeThreads > 0) {
    install = levellingSecondsAfterInstall(offer.levels, augmentations, offer, factor, required, levelMult);
  }
  return { money, level, install, batch: batchThenInstallPlan(inputs)?.seconds ?? null };
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
 * From (d) (#380), once (c) is no longer than (d) the money in hand is (d)'s M or better: its plan's next step, the
 * install, with no hysteresis, but only while (d) has an estimate and the install is the shortest of all (#382's
 * review: a (d) gone null, its income unmeasured, is no plan to finish, and an install no shorter than another isn't
 * worth a reset); otherwise from (d) as from any mode.
 */
export function chooseLevelling(estimates: LevellingEstimates, current: LevellingCandidate): LevellingCandidate {
  const best = shortestLevellingCandidate(estimates);
  if (
    current === "batch" &&
    estimates.install !== null &&
    estimates.batch !== null &&
    estimates.install <= estimates.batch &&
    best === "install"
  ) {
    return "install";
  }
  if (best === null || best === current) return current;
  const currentSeconds = estimates[current];
  if (currentSeconds === null) return current === "money" ? current : best;
  return (estimates[best] as number) * LEVELLING_SWITCH_GAIN < currentSeconds ? best : current;
}

/**
 * The standard error of a rate measured over `samples` (#410, #406's margin: the error of a difference propagated from
 * the measured rates'): each interval's rate, weighted by its length, about their mean (the window's rate, the total
 * over the span); its variance over the effective count of intervals ((Σ Δt)² / Σ Δt²) less one. Null with fewer
 * than two intervals; 0 where every interval's rate is the same.
 */
export function rateStandardError(samples: readonly { atMs: number; value: number }[]): number | null {
  const intervals: { ms: number; rate: number }[] = [];
  for (let index = 1; index < samples.length; index++) {
    const before = samples[index - 1] as { atMs: number; value: number };
    const after = samples[index] as { atMs: number; value: number };
    const ms = after.atMs - before.atMs;
    if (ms > 0) intervals.push({ ms, rate: ((after.value - before.value) / ms) * 1000 });
  }
  if (intervals.length < 2) return null;
  const total = intervals.reduce((sum, each) => sum + each.ms, 0);
  const mean = intervals.reduce((sum, each) => sum + each.rate * each.ms, 0) / total;
  const variance = intervals.reduce((sum, each) => sum + each.ms * (each.rate - mean) ** 2, 0) / total;
  const effective = total ** 2 / intervals.reduce((sum, each) => sum + each.ms ** 2, 0);
  return effective > 1 ? Math.sqrt(variance / (effective - 1)) : null;
}

/** What an install buys of the levelling set (#410): NeuroFlux Governor's levels and the set's augmentations. */
export interface RedPillPurchase {
  levels: number;
  augmentations: readonly string[];
}

/**
 * The Red Pill's install as the planner weighs it (#410).
 * - `money`: the money now; `redPillMoney` The Red Pill's own donation, paid first at its commit (its price is 0 once
 *   reached; a donation, `Faction/formulas/donation.ts:12-14`), so outside the ladder.
 * - `incomePerSecond`, `incomeError`: the batcher's measured income and its standard error (`rateStandardError`);
 *   `batchingExp`, `batchingExpError`: batching's measured experience rate, at its level, and its error. Null unmeasured.
 * - `now`: what the commit at the money now buys (A6's counts at its budget).
 * - `ladder`, `augmentations`: A6's set at any money (by donation where a seller takes them) and each count of
 *   NeuroFlux Governor's levels after it, priced as the commit buys them (core's `neuroFluxLadder`, (d)'s, #380): the
 *   wait's purchases.
 * - `afterInstall`: (d)'s offer after The Red Pill's install with a purchase: what's left of the set, and the ladder
 *   from the levels it leaves, every reputation reset (`Faction/Faction.ts:77-85`); A6's.
 * - `homeThreads`, `perThread`, `preparationMs`: levelling mode after an install, from the snapshots now: home's RAM
 *   is kept (`Prestige.ts:78-80`, its programs alone reset), the cloud servers lost (`Prestige.ts:72-74`).
 */
export interface RedPillInstallOffer {
  money: number;
  redPillMoney: number;
  incomePerSecond: number | null;
  incomeError?: number | null;
  batchingExp: LevellingRate | null;
  batchingExpError?: number | null;
  now: RedPillPurchase;
  ladder: readonly number[];
  augmentations: readonly string[];
  afterInstall: (purchase: RedPillPurchase) => { ladder: readonly number[]; augmentations: readonly string[] };
  homeThreads: number;
  perThread: LevellingRate;
  preparationMs: (purchase: RedPillPurchase) => number;
  /** The BitNode's time so far, seconds: the batching's bound (#382's review); null, none. */
  batchingBoundSeconds?: number | null;
  required: number;
  levelMult: number;
}

/** D after The Red Pill's install (#410): levelling's least candidate then, and its seconds (Infinity with none). */
export interface RedPillLevelling {
  seconds: number;
  candidate: LevellingCandidate | null;
}

/** The choice (#410): install now, or batch first; each side, the difference's measured error, and why. */
export interface RedPillInstallTiming {
  choice: "now" | "wait";
  /** D now: after an install at the money now, levelling's least candidate then. */
  now: RedPillLevelling;
  /** The best wait: batching to the ladder's `money` for `levels` and the set, then the install; null with none. */
  wait: (RedPillLevelling & { batchingSeconds: number; levels: number; money: number }) | null;
  /** The measured error of wait − now (#406's margin), propagated from the income's and the experience rate's. */
  marginSeconds: number;
  why: string;
}

/**
 * D after The Red Pill's install with `purchase` (#410): its commit (`LEVELLING_INSTALL_MS`), w0r1d_d43m0n rooted
 * again (`LEVELLING_REROOT_MS`) and the target's preparation, then levelling's own least candidate from 0 experience
 * at the multipliers it leaves (`levellingEstimates`: (a) batching at its measured experience rate, (b) levelling mode
 * at the formula's rate on home's RAM, its factor unmeasured, 1, (d) batching at the income for what's left of the set
 * and NeuroFlux Governor's levels, then an install; (c) none, the money reset,
 * `PersonObjects/Player/PlayerObjectGeneralMethods.ts:102`). This is D from m: `calculateSkill`
 * (`PersonObjects/formulas/skill.ts:7-15`) at the multipliers the install leaves.
 */
export function redPillLevelling(
  offer: RedPillInstallOffer,
  purchase: RedPillPurchase,
  incomePerSecond: number | null = offer.incomePerSecond,
  batchingExp: LevellingRate | null = offer.batchingExp,
): RedPillLevelling {
  const gain = levellingInstallMultipliers(purchase.levels, purchase.augmentations);
  const levelMult = offer.levelMult * gain.hacking;
  const scale = gain.hackingExp * gain.hackingSpeed;
  const perThread = { expPerSecond: offer.perThread.expPerSecond * scale, atLevel: offer.perThread.atLevel };
  const preparationMs = offer.preparationMs(purchase);
  const after = offer.afterInstall(purchase);
  const estimates = levellingEstimates({
    exp: 0,
    level: hackingLevelOfExp(0, levelMult),
    required: offer.required,
    levelMult,
    money:
      batchingExp === null ? null : { expPerSecond: batchingExp.expPerSecond * scale, atLevel: batchingExp.atLevel },
    levelling: {
      predicted: { expPerSecond: perThread.expPerSecond * offer.homeThreads, atLevel: perThread.atLevel },
      factor: null,
    },
    install: null,
    batch: {
      money: 0,
      incomePerSecond,
      ladder: after.ladder,
      augmentations: after.augmentations,
      homeThreads: offer.homeThreads,
      perThread,
      preparationMs,
      batchingBoundSeconds: offer.batchingBoundSeconds ?? null,
    },
  });
  const candidate = shortestLevellingCandidate(estimates);
  const seconds = candidate === null ? null : estimates[candidate];
  return {
    seconds:
      seconds === null
        ? Number.POSITIVE_INFINITY
        : (LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS + preparationMs) / 1000 + seconds,
    candidate,
  };
}

/**
 * The Red Pill's install (#410): now, or first batching to the money for more of the levelling set and NeuroFlux
 * Governor's levels. Both sides priced alike: D after the install is levelling's own least candidate at the state it
 * leaves (`redPillLevelling`); the wait's, the batching at the measured income ((M − the money after The Red Pill's
 * donation) / income) plus D after the install with the set and the levels, the least over the ladder's counts beyond
 * the money, each count's batching within the BitNode's time so far (the search ends at the first whose batching
 * alone, with the install's fixed time, is past the best, as M rises with the count). The install is irreversible, the
 * batching not, so by #406's margin rule it goes now only where it beats the best wait by more than the measured error
 * of their difference: propagated from the income's and the experience rate's standard errors (each rate moved by its
 * error at the wait's purchase, the difference's changes added in quadrature); none measured, 0, so it only breaks a
 * tie, and a tie waits. No income, or no wait within the bound: now (the rules' install, as before). Left out: the
 * income's rise with the level while batching (cautious, toward now), the experience the batching earns, which the
 * install resets (exact: none counted), and buying part of the set (the wait's set is A6's at any money).
 */
export function redPillInstallTiming(offer: RedPillInstallOffer): RedPillInstallTiming {
  const income = offer.incomePerSecond;
  const fixedSeconds = (LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS) / 1000;
  const now = redPillLevelling(offer, offer.now);
  const available = offer.money - offer.redPillMoney;
  const setAdds = addsToLevelling(offer.augmentations);
  let wait: RedPillInstallTiming["wait"] = null;
  if (income !== null && income > 0 && Number.isFinite(income)) {
    for (let levels = 0; levels < offer.ladder.length; levels++) {
      const money = offer.ladder[levels] as number;
      if (!(money > available) || (levels === 0 && !setAdds)) continue;
      const batchingSeconds = (money - available) / income;
      if (offer.batchingBoundSeconds != null && batchingSeconds > offer.batchingBoundSeconds) break;
      if (!(batchingSeconds + fixedSeconds < (wait?.seconds ?? Number.POSITIVE_INFINITY))) break;
      const d = redPillLevelling(offer, { levels, augmentations: offer.augmentations });
      const seconds = batchingSeconds + d.seconds;
      if (wait === null || seconds < wait.seconds) {
        wait = { seconds, candidate: d.candidate, batchingSeconds, levels, money };
      }
    }
  }
  if (wait === null || !Number.isFinite(wait.seconds) || income === null) {
    return {
      choice: "now",
      now,
      wait: null,
      marginSeconds: 0,
      why:
        income === null || !(income > 0)
          ? "no income measured to batch with"
          : "no more of the levelling set within the BitNode's time so far of batching",
    };
  }
  // The difference's error (#406): each rate moved by its standard error, both sides at the wait's purchase.
  const best = wait;
  const difference = (perSecond: number, exp: LevellingRate | null) =>
    (best.money - available) / perSecond +
    redPillLevelling(offer, { levels: best.levels, augmentations: offer.augmentations }, perSecond, exp).seconds -
    redPillLevelling(offer, offer.now, perSecond, exp).seconds;
  const base = wait.seconds - now.seconds;
  const incomeError = offer.incomeError ?? 0;
  const exp = offer.batchingExp;
  const expError = offer.batchingExpError ?? 0;
  const moved = (value: number) => (Number.isFinite(value) ? value - base : 0);
  const byIncome = incomeError > 0 ? moved(difference(income + incomeError, exp)) : 0;
  const byExp =
    expError > 0 && exp !== null
      ? moved(difference(income, { expPerSecond: exp.expPerSecond + expError, atLevel: exp.atLevel }))
      : 0;
  const marginSeconds = Math.hypot(byIncome, byExp);
  const installNow = Number.isFinite(now.seconds) && base > marginSeconds;
  return {
    choice: installNow ? "now" : "wait",
    now,
    wait,
    marginSeconds,
    why: installNow
      ? "the install now beats the wait by more than their difference's measured error (#406)"
      : "the wait no longer than the install now, within their difference's measured error (#406): a tie waits",
  };
}
