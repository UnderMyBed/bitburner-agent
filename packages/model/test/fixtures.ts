// The validation's figures (#260), synthetic: each as an issue or the review states it, never read from a store.

/**
 * Run #3's BN1.2 (E0, main 7c741cc, 2026-11-05) per cycle: #262's review, the coordinator's table from a read-only
 * report over the store (#244's section 2b). By cycle: its length, Daedalus's count after its install, the faction
 * worked most with the reputation earned there and its average rate a second, that faction's favour after the install,
 * and the cycle's most hacking. Its own hacking and income curves are the model's input (`RUN_3_CYCLES`); these are
 * what the rules make of them.
 */
export const RUN_3_PER_CYCLE = [
  { lengthMin: 39.5, count: 3, faction: "CyberSec", reputation: 2576, rate: 1.59, favorAfter: 5.04, hacking: 358 },
  { lengthMin: 56.6, count: 5, faction: "CyberSec", reputation: 11_344, rate: 4.1, favorAfter: 22.54, hacking: 593 },
  { lengthMin: 75.6, count: 10, faction: "NiteSec", reputation: 27_335, rate: 7.33, favorAfter: 37.65, hacking: 798 },
  { lengthMin: 95.7, count: 17, faction: "NiteSec", reputation: 49_611, rate: 11.95, favorAfter: 71.88, hacking: 1061 },
  {
    lengthMin: 123.8,
    count: 21,
    faction: "BitRunners",
    reputation: 139_364,
    rate: 20.87,
    favorAfter: 96.01,
    hacking: 1357,
  },
  {
    lengthMin: 124.1,
    count: 25,
    faction: "BitRunners",
    reputation: 318_895,
    rate: 48.48,
    favorAfter: 150.38,
    hacking: 1526,
  },
  {
    lengthMin: 31.6,
    count: 29,
    faction: "The Black Hand",
    reputation: 57_191,
    rate: 37.9,
    favorAfter: 94.16,
    hacking: 2128,
  },
  {
    lengthMin: 27.5,
    count: 31,
    faction: "The Black Hand",
    reputation: 94_108,
    rate: 82.38,
    favorAfter: 105.53,
    hacking: 3310,
  },
  {
    lengthMin: 81.7,
    count: 32,
    faction: "Daedalus",
    reputation: 460_688,
    rate: 127.41,
    favorAfter: 152.95,
    hacking: 5204,
  },
  { lengthMin: 18.5, count: 36, faction: "Aevum", reputation: 96_187, rate: 106.28, favorAfter: null, hacking: 4690 },
] as const;

/** BitRunners' favour after the 4th install in run #3 (#247: "favour 4.8" at 13:13; the table's 4.76). */
export const RUN_3_BITRUNNERS_FAVOR_AFTER_4 = 4.76;

/**
 * Run #3's BN1.2 phases (#244's table), each ending at an install: 11 h 17 min from 08:46 to the destroy at 20:03.
 * Only the first two are in the model's reach (cycles 1 to 6, `RUN_3_PER_CYCLE`); the rest are reported, not tested.
 */
export const RUN_3_BN1_2 = {
  start: { currentNode: 1, ownedSF: { "1": 1 } },
  totalMinutes: 11 * 60 + 17,
  phases: [
    { name: "count 0 → 17 (CyberSec, Tian Di Hui, NiteSec)", endsAtInstall: 4, minutes: 4 * 60 + 27 },
    { name: "BitRunners favour 5 → 96 → 150", endsAtInstall: 6, minutes: 4 * 60 + 8 },
  ],
};

/**
 * The simulator's first three cycles (#247's feasibility comment: seed 1, main 412d97b, a fresh BN1.1 start): installs
 * at about 57 min (3 installed) and about 122 min (4), none by 200 min; hacking 0 → 290 in 55 min in cycle 1, 0 → 497 in
 * 62 min in cycle 2. Independent of the calibration, which is run #3's. "Installed" is `ownedAugs`' names, as the
 * probe counted them (NeuroFlux Governor once).
 */
export const SIMULATOR_SEED_1 = {
  start: { currentNode: 1, ownedSF: {} },
  horizonMinutes: 200,
  installs: [
    { atMinutes: 57, installed: 3 },
    { atMinutes: 122, installed: 4 },
  ],
  hackingAtCycleEnd: [290, 497],
};
