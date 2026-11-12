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
//   the one after, and each contract's and operation's level, max level, count and the game's estimate's range there.
// RAM (`Netscript/RamCostGenerator.ts:334-376`): 4 GB each for `getRank`, `joinBladeburnerFaction`, `getStamina`,
// `getActionEstimatedSuccessChance`, `getActionCountRemaining`, `getActionMaxLevel`, `getActionCurrentLevel`,
// `startAction`, `setActionLevel` and `setActionAutolevel`; 1 GB for `getCurrentAction`; nothing for `inBladeburner`
// and `getBonusTime`. The brain runs it only once home's RAM beyond what it keeps holds it (core's
// `bladeburnerWorkerFits`).
import {
  BLADEBURNER_FACTION_RANK,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionOrder,
  type BladeburnerReading,
  type BladeburnerState,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

type ActionType = Parameters<NS["bladeburner"]["startAction"]>[0];
type ActionName = Parameters<NS["bladeburner"]["startAction"]>[1];

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
  return ns.bladeburner.startAction(type, name)
    ? []
    : [`the game didn't start ${order.name} (${order.type}): its count under 1, or the action unknown`];
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
  };
}
