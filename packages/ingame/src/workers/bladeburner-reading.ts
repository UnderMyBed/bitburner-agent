// What `bladeburner.js` does (#367), apart from its entry so a test can drive it with a stand-in NS: the brain's
// Bladeburner state done, then the division read, with the NS API alone (`NetscriptFunctions/Bladeburner.ts:34-43`:
// in the division, with BN6, BN7, SF6 or SF7). Not in it, it reads that (no rank), and does nothing else.
// - The faction, when the state asks: `joinBladeburnerFaction` once the rank is at 25 (core's
//   `BLADEBURNER_FACTION_RANK`, `Bladeburner/Bladeburner.ts:265-273`); a refusal, or a join asked for under 25 (a
//   stale state: the rank can fall), is a problem. Asked again with it joined is done at once, as the game has it.
// - Then the rank.
// RAM (`Netscript/RamCostGenerator.ts:335-376`): `bladeburner.getRank` and `bladeburner.joinBladeburnerFaction` 4 GB
// each; `bladeburner.inBladeburner` nothing. The brain runs it only once home's RAM beyond what it keeps holds it
// (core's `bladeburnerWorkerFits`).
import { BLADEBURNER_FACTION_RANK, type BladeburnerReading, type BladeburnerState } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

/** Does `state` (the brain's) and reads the division. */
export function bladeburnerReading(ns: NS, state: BladeburnerState): BladeburnerReading {
  const problems: string[] = [];
  if (!ns.bladeburner.inBladeburner()) return { rank: null, problems };
  if (state.joinTheFaction) {
    const rank = ns.bladeburner.getRank();
    if (rank < BLADEBURNER_FACTION_RANK) {
      problems.push(`the faction asked for at rank ${rank.toFixed(1)}, under ${BLADEBURNER_FACTION_RANK}`);
    } else if (!ns.bladeburner.joinBladeburnerFaction()) {
      problems.push(`the game didn't take the player into the Bladeburners faction at rank ${rank.toFixed(1)}`);
    }
  }
  return { rank: ns.bladeburner.getRank(), problems };
}
