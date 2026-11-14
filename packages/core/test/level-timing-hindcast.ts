// The hindcast's cases (#413), shared by level-timing.test.ts: each post-count install's reading, from the evidence.

import { type AugmentationPurchaseState, augmentationBitNodeMultipliers } from "../src/augmentations.ts";
import { favorAfterInstall } from "../src/donations.ts";
import { factionReputationPerSecond } from "../src/faction-work.ts";
import { countablesLeft, LATER_CYCLE_FACTIONS, type LaterCycles, type LevelWait } from "../src/install-timing.ts";
import { type LevelRise, laterCycleRise, levelAlong, workSecondsAlong } from "../src/level-rise.ts";
import { addsToLevelling } from "../src/levelling.ts";
import { BN4_FACTION_WORK_REP_GAIN } from "./bn4-2-fixture.ts";
import {
  BN4_2_C9,
  BN4_2_C10,
  BN4_2_C11,
  BN4_2_C12,
  BN4_2_INSTALLED_AT_COUNT,
  BN4_3_C11,
  BN4_3_C12,
  BN4_3_C13,
  BN4_3_C14,
  BN4_3_INSTALLED_AT_COUNT,
  FIRST_INSTALL,
  FIRST_SET,
  gainBetween,
  levelAt,
  type PostCountCycle,
  rampOf,
  riseAt,
  SECOND_INSTALL_BN4_2,
  SECOND_INSTALL_BN4_3,
  SECOND_SET,
} from "./bn4-postcount-fixture.ts";

export const MINUTE = 60_000;
const BN4 = augmentationBitNodeMultipliers(4, { 4: 2 });

/** The work's rate at a faction at a level: the game's hacking work, focused, int 0, the share's place `factor`. */
export const rateWith =
  (favor: number, factor: number, factionRep = 1) =>
  (level: number) =>
    factionReputationPerSecond(
      {
        skills: { hacking: level, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
        mults: { faction_rep: factionRep },
      },
      "hacking",
      {
        favor,
        sourceFile15Level: 0,
        focused: true,
        implant: false,
        factionWorkRepGain: BN4_FACTION_WORK_REP_GAIN,
        shareBonus: factor,
      },
    );

/**
 * The factor in the share's place, measured (#401's way): the cycle's mean work rate at `faction` (the run report's)
 * over the game's formula's mean along its measured level, from its first work to `toMinutes`.
 */
export function measuredFactor(
  cycle: PostCountCycle,
  favor: number,
  mean: number,
  fromMinutes: number,
  toMinutes: number,
) {
  const rate = rateWith(favor, 1);
  const n = 2000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rate(levelAt(cycle, fromMinutes + ((i + 0.5) * (toMinutes - fromMinutes)) / n));
  return mean / (sum / n);
}

/** BN4.3's faction work (the run report's): c12 The Black Hand at 23.56/s (favour 40.91), c13 BitRunners 33.05/s. */
export const BN4_3_WORK = {
  c12: { faction: "The Black Hand", reputation: 130_725, mean: 23.56, favor: 40.91 },
  c13: { faction: "BitRunners", reputation: 314_488, mean: 33.05, favor: 21.74 },
};
/** The favour each faction has in c12 and c13 (the run report's "favour" lines; NiteSec's 82.54 after c11). */
export const FAVOUR_C12: Record<string, number> = { "The Black Hand": 40.91, BitRunners: 21.74, NiteSec: 82.54 };
/** R: BN4.2's c4-c9 measured first work, 4 min each (`cycles2-BN4.2.txt`); the evidence has none after the count. */
export const R_MINUTES = 4;
/** The fallback dead time, the rate's window (`LEVEL_RAMP_FALLBACK_MS`, 10 min), where no ramp is measured. */
export const RAMP_FALLBACK_MINUTES = 10;
/** The factions joined after the count: the hacker factions and city group B (BN4.3's c12 worked Chongqing). */
export const JOINED = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners", "Tian Di Hui", "Chongqing"];

/** One post-count install's reading, as the brain would take it at its choice. */
export interface Reading {
  name: string;
  /** Minutes online from the choice to Daedalus joined (the evidence's). */
  actual: number;
  /** What happened: the brain installed (k 0). */
  rise: LevelRise;
  later: LaterCycles;
  waits: LevelWait[];
  /** The dead time used, minutes, and whence. */
  dead: { minutes: number; from: string };
  /** Each install's commit, ms: this install's, measured from its events (chosen to sent). */
  commitMs: number;
}

/**
 * The four post-count installs' commits, chosen to sent (`postcount.txt`'s events): 07:52:54 to 07:54:44 and 17:01:33 to
 * 17:03:23 in BN4.2, 15:44:32 to 15:46:23 and 18:27:34 to 18:29:24 in BN4.3: 110, 110, 111 and 110 s.
 */
export const COMMIT_SECONDS = { "BN4.2 c10": 110, "BN4.2 c11": 110, "BN4.3 c12": 111, "BN4.3 c13": 110 } as const;

/** The ramp dead time the brain prices with in `cycle` (#405): its own ramp, else the carried-in's, else the fallback. */
export function deadIn(
  cycle: PostCountCycle,
  before: PostCountCycle,
  carriedIn: { minutes: number; from: string } | null,
): { minutes: number; from: string } {
  const carried =
    riseAt(before).kappa * gainBetween(before, cycle).hackingExp * gainBetween(before, cycle).hackingSpeed;
  const ramp = rampOf(cycle, carried);
  if (ramp !== null) return { minutes: ramp, from: `${cycle.name}'s ramp` };
  return carriedIn ?? { minutes: RAMP_FALLBACK_MINUTES, from: "the fallback" };
}

/**
 * A reading at `minutes` into `cycle` (the choice's), with `installing` its set and `reputation` earned this cycle at
 * each faction: the waits at each faction worked for the hacking set (its countables left by work there, cheapest
 * first, each τ along the level's path now), and the later cycles (`countablesLeft`, the rate at the favour after the
 * install).
 */
export function readingAt({
  name,
  actual,
  cycle,
  minutes,
  installed,
  installing,
  set,
  reputation,
  favor,
  factor,
  dead,
}: {
  name: string;
  actual: number;
  cycle: PostCountCycle;
  minutes: number;
  installed: readonly string[];
  installing: readonly string[];
  set: readonly string[];
  reputation: Record<string, number>;
  favor: Record<string, number>;
  factor: number;
  dead: { minutes: number; from: string };
}): Reading {
  const state: AugmentationPurchaseState = {
    installed: Object.fromEntries(installed.map((each) => [each, 1])),
    queued: [],
    sourceFile11Level: 0,
    bitNodeMultipliers: BN4,
  };
  const rise = riseAt(cycle, minutes);
  const waits: LevelWait[] = [];
  for (const faction of JOINED) {
    const rate = rateWith(favor[faction] ?? 0, factor);
    const own = countablesLeft({ factions: [faction], bitNode: 4, state, set }).filter((each) =>
      addsToLevelling([each.augmentation]),
    );
    const next = own.map((each) => ({
      augmentation: each.augmentation,
      tauMs: workSecondsAlong(rise, rate, Math.max(0, each.reputation - (reputation[faction] ?? 0))) * 1000,
    }));
    if (next.length > 0) waits.push({ faction, next });
  }
  const after = (faction: string) => favorAfterInstall(favor[faction] ?? 0, reputation[faction] ?? 0);
  const later: LaterCycles = {
    left: countablesLeft({ factions: [...JOINED, ...LATER_CYCLE_FACTIONS], bitNode: 4, state, set }),
    rebuildMs: R_MINUTES * MINUTE,
    rise,
    deadSeconds: dead.minutes * 60,
    rateAt: (faction, level) => rateWith(after(faction), factor)(level),
    installing,
  };
  const commitMs = (COMMIT_SECONDS[name as keyof typeof COMMIT_SECONDS] ?? 110) * 1000;
  return { name, actual, rise, later, waits, dead, commitMs };
}

/** BN4.3's measured factor in c12 (The Black Hand's work from R to the choice), and c13's (BitRunners'). */
export const FACTOR_C12 = measuredFactor(BN4_3_C12, BN4_3_WORK.c12.favor, BN4_3_WORK.c12.mean, R_MINUTES, 96);
export const FACTOR_C13 = measuredFactor(BN4_3_C13, BN4_3_WORK.c13.favor, BN4_3_WORK.c13.mean, R_MINUTES, 161);

const DEAD_BN4_2_C10 = deadIn(BN4_2_C10, BN4_2_C9, null);
const DEAD_BN4_2_C11 = deadIn(BN4_2_C11, BN4_2_C10, DEAD_BN4_2_C10);
const DEAD_BN4_3_C12 = deadIn(BN4_3_C12, BN4_3_C11, null);
const DEAD_BN4_3_C13 = deadIn(BN4_3_C13, BN4_3_C12, DEAD_BN4_3_C12);

/**
 * The four post-count installs. The reputation earned at each faction at the choice: BN4.3's c12 The Black Hand's and
 * c13 BitRunners' (the run report's); BN4.2's c10-c11 faction work isn't in the evidence, so BN4.3's stand in (the same
 * sets bought, the same multipliers). Actual: minutes online from the choice to Daedalus joined: BN4.3's from the event
 * times (15:44:32 and 18:27:34 to 18:35:40, c13 online throughout: 171 and 8.1); BN4.2's from the count met (10 h 4 min online) to
 * the join (13 h 23 min), c10's 93 min to its choice and c11's about 100 online (the issue's table).
 */
export const READINGS: Reading[] = [
  readingAt({
    name: "BN4.2 c10",
    actual: 199 - 93,
    cycle: BN4_2_C10,
    minutes: 90,
    installed: BN4_2_INSTALLED_AT_COUNT,
    installing: FIRST_INSTALL,
    set: FIRST_SET,
    reputation: { [BN4_3_WORK.c12.faction]: BN4_3_WORK.c12.reputation },
    favor: FAVOUR_C12,
    factor: FACTOR_C12,
    dead: DEAD_BN4_2_C10,
  }),
  readingAt({
    name: "BN4.2 c11",
    actual: 199 - 95 - 100 + 2,
    cycle: BN4_2_C11,
    minutes: 90,
    installed: [...BN4_2_INSTALLED_AT_COUNT, ...FIRST_SET],
    installing: SECOND_INSTALL_BN4_2,
    set: SECOND_SET,
    reputation: { [BN4_3_WORK.c13.faction]: BN4_3_WORK.c13.reputation },
    favor: { ...FAVOUR_C12, "The Black Hand": favorAfterInstall(40.91, BN4_3_WORK.c12.reputation) },
    factor: FACTOR_C12,
    dead: DEAD_BN4_2_C11,
  }),
  readingAt({
    name: "BN4.3 c12",
    actual: 171,
    cycle: BN4_3_C12,
    minutes: 95,
    installed: BN4_3_INSTALLED_AT_COUNT,
    installing: FIRST_INSTALL,
    set: FIRST_SET,
    reputation: { [BN4_3_WORK.c12.faction]: BN4_3_WORK.c12.reputation },
    favor: FAVOUR_C12,
    factor: FACTOR_C12,
    dead: DEAD_BN4_3_C12,
  }),
  readingAt({
    name: "BN4.3 c13",
    actual: 8.1,
    cycle: BN4_3_C13,
    minutes: 161,
    installed: [...BN4_3_INSTALLED_AT_COUNT, ...FIRST_SET],
    installing: SECOND_INSTALL_BN4_3,
    set: SECOND_SET,
    reputation: { [BN4_3_WORK.c13.faction]: BN4_3_WORK.c13.reputation },
    favor: { ...FAVOUR_C12, "The Black Hand": favorAfterInstall(40.91, BN4_3_WORK.c12.reputation) },
    factor: FACTOR_C12,
    dead: DEAD_BN4_3_C13,
  }),
];

/**
 * The level path's hindcast (#405's, `laterCycleRise`, the dead time a ramp in the rate as #413's level timing takes
 * it): each cycle from the one before's end, at 5 and 10 min (inside the ramp) and each 15 min.
 */
export function pathRows(cycle: PostCountCycle, before: PostCountCycle, dead: { minutes: number }) {
  const rise = laterCycleRise(riseAt(before), gainBetween(before, cycle), dead.minutes * 60, true);
  return cycle.samples
    .filter(([minutes]) => minutes === 5 || minutes === 10 || (minutes > 0 && minutes % 15 === 0))
    .map(([minutes, level]) => ({ minutes, level, predicted: levelAlong(rise, minutes * 60) }));
}
export const PATHS = [
  { cycle: BN4_2_C10, before: BN4_2_C9, dead: { minutes: RAMP_FALLBACK_MINUTES } },
  { cycle: BN4_2_C11, before: BN4_2_C10, dead: DEAD_BN4_2_C10 },
  { cycle: BN4_3_C12, before: BN4_3_C11, dead: { minutes: RAMP_FALLBACK_MINUTES } },
  { cycle: BN4_3_C13, before: BN4_3_C12, dead: DEAD_BN4_3_C12 },
  { cycle: BN4_2_C12, before: BN4_2_C11, dead: DEAD_BN4_2_C11 },
  { cycle: BN4_3_C14, before: BN4_3_C13, dead: DEAD_BN4_3_C13 },
];
export { DEAD_BN4_2_C10, DEAD_BN4_2_C11, DEAD_BN4_3_C12, DEAD_BN4_3_C13 };
