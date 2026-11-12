// What `join-bladeburner.js` does (#367), apart from its entry so a test can drive it with a stand-in NS: joins the
// Bladeburner division with the NS API alone, which needs BN6, BN7, SF6 or SF7 but no Singularity
// (`NetscriptFunctions/Bladeburner.ts:332-366`). The game first: already in it is done. The game logs why it refuses
// (no access, Bladeburner off in this BitNode, or a combat stat under 100); the worker says the same, plainly.
// RAM: `bladeburner.joinBladeburnerDivision` 4 GB (`Netscript/RamCostGenerator.ts:373`); `bladeburner.inBladeburner`
// costs nothing (`:335`).
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

/** Joins the Bladeburner division if the player isn't in it, and reports how it stands. */
export function bladeburnerDivisionJoin(ns: NS): EffectorReport {
  if (ns.bladeburner.inBladeburner()) return { done: true, problem: null };
  if (ns.bladeburner.joinBladeburnerDivision() && ns.bladeburner.inBladeburner()) return { done: true, problem: null };
  return {
    done: false,
    problem:
      "the game didn't take the player into the Bladeburner division: a combat stat under 100, or no Bladeburner " +
      "here (BN6, BN7, or SF6 or SF7; none in BN8)",
  };
}
