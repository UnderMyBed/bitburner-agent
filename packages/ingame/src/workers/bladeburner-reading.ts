// What `bladeburner.js` does (#367, #375), apart from its entry so a test can drive it with a stand-in NS: the brain's
// Bladeburner state done, then the division read, with the NS API alone (`NetscriptFunctions/Bladeburner.ts:34-43`:
// in the division, with BN6, BN7, SF6 or SF7). Not in it, it reads that (no rank), and does nothing else.
// - The faction, when the state asks: `joinBladeburnerFaction` once the rank is at 25 (core's
//   `BLADEBURNER_FACTION_RANK`, `Bladeburner/Bladeburner.ts:265-273`); a refusal, or a join asked for under 25 (a
//   stale state: the rank can fall), is a problem. Asked again with it joined is done at once, as the game has it.
// - The action (B2, #375), when the state names one: a contract's or operation's level held (auto-level off, else the
//   game sets it to its max after each attempt, `Bladeburner.ts:1006-1008`; a level over its max is a stale state, a
//   problem), then the action started unless it's the one under way (starting it again would lose its progress,
//   `Bladeburner.ts:186-188`; changing the level doesn't). Starting one stops the player's other work
//   (`Bladeburner.ts:178-180`): the brain holds its own meanwhile. The game refusing it (its count under 1) is a
//   problem. None named: the game's action is left as it is.
// - Then the rank; and in the division (B2), the stamina and its max, the bonus time, the action it found under way and
//   the one after, and each contract's and operation's level, max level, count and the game's estimate's range there;
//   and (B3, #379) the skill points unspent and each skill's level. The brain's intents buy the skills
//   (`upgradeBladeburnerSkill`, ./bladeburner-skill.ts), not this worker.
// - The Black Ops (B5, #392): the next in the game's order (core's `BLADEBURNER_BLACK_OPS`), the first whose count is 1
//   (`NetscriptFunctions/Bladeburner.ts:182-183`: 0 once done), and the game's estimate's range for it; none once all
//   21 are done. The state's action runs it as any (`Black Operations`, no level): the game stops it after its one
//   attempt (`Bladeburner.ts:1083`). Both calls the worker makes already, so no RAM is added.
// RAM (`Netscript/RamCostGenerator.ts:334-376`): 4 GB each for `getRank`, `joinBladeburnerFaction`, `getStamina`,
// `getActionEstimatedSuccessChance`, `getActionCountRemaining`, `getActionMaxLevel`, `getActionCurrentLevel`,
// `startAction`, `setActionLevel`, `setActionAutolevel`, `getSkillPoints` and `getSkillLevel`; 1 GB for
// `getCurrentAction`; nothing for `inBladeburner` and `getBonusTime`. The brain runs it only once home's RAM beyond what it keeps holds it (core's
// `bladeburnerWorkerFits`).
import {
  BLACK_OPERATIONS,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_FACTION_RANK,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_SKILL_NAMES,
  type BladeburnerActionOrder,
  type BladeburnerReading,
  type BladeburnerState,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

type ActionType = Parameters<NS["bladeburner"]["startAction"]>[0];
type ActionName = Parameters<NS["bladeburner"]["startAction"]>[1];
type SkillName = Parameters<NS["bladeburner"]["getSkillLevel"]>[0];

/** The action under way, as type and name, or null idle. */
function currentOf(ns: NS): { type: string; name: string } | null {
  const action = ns.bladeburner.getCurrentAction();
  return action === null ? null : { type: action.type, name: action.name };
}

/** Holds the order's level and starts it unless under way: the problems, if any. */
function runOrder(ns: NS, order: BladeburnerActionOrder, found: { type: string; name: string } | null): string[] {
  const type = order.type as ActionType;
  const name = order.name as ActionName;
  if (order.level !== null) {
    const maxLevel = ns.bladeburner.getActionMaxLevel(type, name);
    if (order.level > maxLevel) {
      return [`${order.name} asked for at level ${order.level}, over its max ${maxLevel}`];
    }
    ns.bladeburner.setActionAutolevel(type, name, false);
    if (ns.bladeburner.getActionCurrentLevel(type, name) !== order.level) {
      ns.bladeburner.setActionLevel(type, name, order.level);
    }
  }
  if (found?.type === order.type && found.name === order.name) return [];
  // A Black Op done since the brain asked (its count 0, `NetscriptFunctions/Bladeburner.ts:182-183`): a state that
  // outlived its one attempt, nothing to start (#392).
  if (order.type === BLACK_OPERATIONS && ns.bladeburner.getActionCountRemaining(type, name) < 1) return [];
  if (ns.bladeburner.startAction(type, name)) return [];
  // A Black Op's refusal: the rank under its own, or not the next (`Actions/BlackOperation.ts:44-49`).
  const why =
    order.type === BLACK_OPERATIONS
      ? "the rank under its own, or not the next"
      : "its count under 1, or the action unknown";
  return [`the game didn't start ${order.name} (${order.type}): ${why}`];
}

/** The next Black Op in order and the game's range for it, or null with all 21 done (#392). */
function nextBlackOpOf(ns: NS): { name: string; chance: [number, number] } | null {
  const type = BLACK_OPERATIONS as ActionType;
  for (const { name } of BLADEBURNER_BLACK_OPS) {
    if (ns.bladeburner.getActionCountRemaining(type, name as ActionName) < 1) continue;
    const [low, high] = ns.bladeburner.getActionEstimatedSuccessChance(type, name as ActionName);
    return { name, chance: [low, high] };
  }
  return null;
}

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
  const found = currentOf(ns);
  if (state.action != null) problems.push(...runOrder(ns, state.action, found));
  const [stamina, maxStamina] = ns.bladeburner.getStamina();
  return {
    rank: ns.bladeburner.getRank(),
    problems,
    stamina,
    maxStamina,
    bonusSeconds: ns.bladeburner.getBonusTime() / 1000,
    found,
    current: currentOf(ns),
    actions: BLADEBURNER_LEVELLED_ACTIONS.map(({ type, name }) => {
      const [low, high] = ns.bladeburner.getActionEstimatedSuccessChance(type as ActionType, name as ActionName);
      return {
        type,
        name,
        level: ns.bladeburner.getActionCurrentLevel(type as ActionType, name as ActionName),
        maxLevel: ns.bladeburner.getActionMaxLevel(type as ActionType, name as ActionName),
        count: ns.bladeburner.getActionCountRemaining(type as ActionType, name as ActionName),
        chance: [low, high],
      };
    }),
    skillPoints: ns.bladeburner.getSkillPoints(),
    skillLevels: Object.fromEntries(
      BLADEBURNER_SKILL_NAMES.map((name) => [name, ns.bladeburner.getSkillLevel(name as SkillName)]),
    ),
    blackOp: nextBlackOpOf(ns),
  };
}
