// The validation's figures (#260), synthetic: each as an issue states it, never read from a store.

/**
 * Run #3's BN1.2 (E0, main 7c741cc, 2026-11-05), from its start at 08:46 to its destroy at 20:03: 11 h 17 min. The
 * phases are #244's table ("Run report: a cycles table…", section 2b's query), each ending at an install (or the
 * destroy), so the model's are cut at the same installs.
 */
export const RUN_3_BN1_2 = {
  start: { currentNode: 1, ownedSF: { "1": 1 } },
  totalMinutes: 11 * 60 + 17,
  phases: [
    // 08:46-13:13, 4 installs (#244).
    { name: "count 0 → 17 (CyberSec, Tian Di Hui, NiteSec)", endsAtInstall: 4, minutes: 4 * 60 + 27 },
    // 13:13-17:21, 2 installs: BitRunners' donations unlocked at the second (#244, #247).
    { name: "BitRunners favour 5 → 96 → 150", endsAtInstall: 6, minutes: 4 * 60 + 8 },
    // 17:21-18:20, 2 installs: count 29 at 17:49 (#243), 30 at 18:20 (#244).
    { name: "donations to BitRunners, count 25 → 30", endsAtInstall: 8, minutes: 59 },
    // 18:20-19:42: the install at 19:42 unlocks Daedalus's donations (#244).
    { name: "Daedalus favour 0 → 150", endsAtInstall: 9, minutes: 82 },
    // 19:42-20:03: the donation, The Red Pill's install, the destroy (#244).
    { name: "donation to Daedalus, The Red Pill, destroy", endsAtInstall: null, minutes: 21 },
  ],
  /** #244: count 25 after the 17:21 install, 30 after 18:20's; #243: 29 after the 17:49 install. */
  countAfterInstall: { 6: 25, 7: 29, 8: 30 },
  /** #243: the 17:49:52 install's set ("count reached"). */
  install7Set: [
    "Embedded Netburner Module Core V2 Upgrade",
    "BitRunners Neurolink",
    "Magnetism Amplifier",
    "Neuralstimulator",
  ],
  /**
   * #247: BitRunners' rep/s, 22 at favour 4.8 (the 13:13 cycle, the 5th) and 52.7 at 96 (the 6th): divided by
   * (1 + favour/100), the hacking level × `faction_rep` × the share bonus it reflects (`reputation.ts:8-14`).
   */
  bitRunnersRate: [
    { cycle: 5, perSecond: 22, favor: 4.8 },
    { cycle: 6, perSecond: 52.7, favor: 96 },
  ],
};

/**
 * The simulator's first three cycles (#247's feasibility comment: seed 1, main 412d97b, a fresh BN1.1 start): installs
 * at about 57 min (3 installed) and about 122 min (4), none by 200 min; hacking 0 → 290 in 55 min in cycle 1,
 * 0 → 497 in 62 min in cycle 2, 0 → 616 in about 78 min in cycle 3. "Installed" is `ownedAugs`' names, as the probe
 * counted them (NeuroFlux Governor once).
 */
export const SIMULATOR_SEED_1 = {
  start: { currentNode: 1, ownedSF: {} },
  horizonMinutes: 200,
  installs: [
    { atMinutes: 57, installed: 3 },
    { atMinutes: 122, installed: 4 },
  ],
  hackingAtCycleEnd: [290, 497],
  hackingAt200Minutes: 616,
};

/** "About 15%" (#260): on the total and on each phase. */
export const TOLERANCE = 0.15;
