// What `create-gang.js` does (#325), apart from its entry so a test can drive it with a stand-in NS: forms the gang
// with the NS API alone, which needs a gang's BitNode (BN2, or SF2 with the karma) but no Singularity
// (`NetscriptFunctions/Gang.ts:41-52`). The game first: a gang already formed with that faction is done; one formed
// with another is a problem, never fixed here (only one gang a BitNode, `Gang/helpers.ts:7-9`).
// RAM: `gang.createGang` 1 GB + `gang.getGangInformation` 2 GB (`Netscript/RamCostGenerator.ts:272`, `:276`);
// `gang.inGang` costs nothing.
import type { EffectorReport } from "@bitburner-agent/core";
import type { FactionName, NS } from "../ns.ts";

/** Forms the gang with `faction` if there's none, and reports how it stands. */
export function gangCreation(ns: NS, faction: string): EffectorReport {
  if (ns.gang.inGang()) {
    const formedWith = ns.gang.getGangInformation().faction;
    if (formedWith === faction) return { done: true, problem: null };
    return { done: false, problem: `the gang is ${formedWith}'s already: only one gang a BitNode` };
  }
  if (ns.gang.createGang(faction as FactionName)) return { done: true, problem: null };
  // The game logs why (`Gang/helpers.ts:6-26`): not a member, not BN2 without SF2 and its karma, or gangs disabled.
  return {
    done: false,
    problem: `the game formed no gang with ${faction}: not a member, or no gangs here (BN2, or SF2 with karma)`,
  };
}
