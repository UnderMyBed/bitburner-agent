// The fork baseline's scripted early game (#33, owner decisions log #25). On BN1 with SF4.3 and 8 GB of home RAM the
// fork can't run: its helper scripts don't fit. This does what a player does first, until home has the RAM the fork
// needs, then hands over to it. It's an in-game script a player could write: with SF4.3, Singularity costs only a
// few GB, so all of it fits in 8 GB (the game's own RAM check refuses to start it otherwise).

/** The least home RAM at which the fork runs unattended on BN1 with SF4.3 (the experiment on #33). */
const FORK_NEEDS_GB = 16;
/** The one server a fresh save can hack: no ports, hacking level 1. */
const TARGET = "n00dles";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.nuke(TARGET);
  while (ns.getServerMaxRam("home") < FORK_NEEDS_GB) {
    // Buy the next home RAM upgrade as soon as it's affordable; earn money in between.
    if (ns.singularity.upgradeHomeRam()) continue;
    if (ns.getServerSecurityLevel(TARGET) > ns.getServerMinSecurityLevel(TARGET) + 1) await ns.weaken(TARGET);
    else if (ns.getServerMoneyAvailable(TARGET) < ns.getServerMaxMoney(TARGET) * 0.75) await ns.grow(TARGET);
    else await ns.hack(TARGET);
  }
  // Start the fork the way a player does, once this script's RAM is free.
  ns.spawn("autopilot.js", { threads: 1, spawnDelay: 0 }, "--disable-casino");
}
