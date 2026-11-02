// agent/<deploymentId>/batch-share.js: a round of share (#224), started by the batcher on one of its hosts' spare RAM
// while the player works for a faction: one `ns.share()`, which holds its threads for 10 s and raises the reputation
// faction work earns meanwhile (NetworkShare/Share.ts:8-41), then it exits and its RAM comes back (legacy's share.js).
// Its argument, the batcher's name for it, only lets copies run side by side on one host.
// RAM: `share` 2.4 (ram-budget.json; core's SHARE_RAM_GB).
import type { NS } from "../ns.ts";

export async function main(ns: NS): Promise<void> {
  await ns.share();
}
