/**
 * The hacking programs the Agent buys (#136, M3's second slice): the TOR router, from a tech vendor (`TECH_VENDORS`),
 * then the five port openers, from the dark web, in the order the brain buys them. Shared by the in-game code and the
 * brain. The constants are plain literals, as in deploy-layout.ts.
 */

/** The item name for the TOR router, which has no file: `ns.hasTorRouter()` says whether it's owned. */
export const TOR_ROUTER = "TOR router";

/** The port openers, cheapest first: each opens one more port, so more servers can be rooted. */
export const PORT_OPENER_PROGRAMS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];

/** Home worker: buys one item through the game's page. */
export const BUY_PROGRAM_WORKER_NAME = "buy-program.js";
