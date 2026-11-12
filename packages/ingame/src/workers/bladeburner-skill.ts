// What `bladeburner-skill.js` does (#379), apart from its entry so a test can drive it with a stand-in NS: raises a
// Bladeburner skill to a level with the NS API alone, which needs BN6, BN7, SF6 or SF7 but no Singularity
// (`NetscriptFunctions/Bladeburner.ts:34-43`, `:236-259`). The game first: not in the division is a problem, and the
// skill at the level or over is done. Then one `upgradeSkill` for the levels short, the game's one charge for them all
// (`Bladeburner/Skill.ts:76-80`); the game refuses it with too few points, or past the skill's max (`Skill.ts:141-160`),
// and the worker says so.
// RAM (`Netscript/RamCostGenerator.ts:335`, `:361`, `:363`): `getSkillLevel` and `upgradeSkill` 4 GB each;
// `inBladeburner` nothing.
import { BLADEBURNER_SKILL_NAMES, type EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

type SkillName = Parameters<NS["bladeburner"]["upgradeSkill"]>[0];

/** Raises `skill` to `level` if it's under, and reports how it stands. */
export function bladeburnerSkillRaise(ns: NS, skill: string, level: number): EffectorReport {
  if (!(BLADEBURNER_SKILL_NAMES as readonly string[]).includes(skill) || !Number.isInteger(level) || level < 1) {
    return { done: false, problem: `no Bladeburner skill ${JSON.stringify(skill)} at level ${level} to raise` };
  }
  if (!ns.bladeburner.inBladeburner()) return { done: false, problem: "not in the Bladeburner division" };
  const name = skill as SkillName;
  const before = ns.bladeburner.getSkillLevel(name);
  if (before >= level) return { done: true, problem: null };
  if (ns.bladeburner.upgradeSkill(name, level - before) && ns.bladeburner.getSkillLevel(name) >= level) {
    return { done: true, problem: null };
  }
  return {
    done: false,
    problem: `the game didn't raise ${skill} from level ${before} to ${level}: too few skill points, or past its max`,
  };
}
