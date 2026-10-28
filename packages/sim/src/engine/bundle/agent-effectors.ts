// The Agent's `sim` effector backend (#145, architecture §5.6, §9.1): the simulator renders no page, so the `ui`
// effectors can't run here. These do what the page's own handlers do, with the same checks and side effects (dialogs,
// which the simulator captures as events, and routes), so the simulator can play past what its page can show. They
// never grant Source-Files. The Agent finds them on the page's global object; in a browser they're absent.

import { CONSTANTS } from "../../../../../vendor/bitburner-src/src/Constants";
import { buyDarkwebItem } from "../../../../../vendor/bitburner-src/src/DarkWeb/DarkWeb";
import { CityName } from "../../../../../vendor/bitburner-src/src/Enums";
import { purchaseTorRouter } from "../../../../../vendor/bitburner-src/src/Locations/ui/TorButton";
import { Player } from "../../../../../vendor/bitburner-src/src/Player";
import { ServerConstants } from "../../../../../vendor/bitburner-src/src/Server/data/Constants";
import { purchaseRamForHomeComputer } from "../../../../../vendor/bitburner-src/src/Server/ServerPurchases";
import { Settings } from "../../../../../vendor/bitburner-src/src/Settings/Settings";
import { Router } from "../../../../../vendor/bitburner-src/src/ui/GameRoot";
import { dialogBoxCreate } from "../../../../../vendor/bitburner-src/src/ui/React/DialogBox";
import { Page } from "../../../../../vendor/bitburner-src/src/ui/Router";

/**
 * The global the Agent looks for: core's `AGENT_SIM_EFFECTORS_GLOBAL`. This bundle is typechecked and built as the
 * game's own code (`scripts/typecheck-bundle.ts`, `bundle/build.ts`), which doesn't reach the workspace's packages, so
 * it can't import core; the effector-backends suite fails if the two drift.
 */
const AGENT_SIM_EFFECTORS_GLOBAL = "__bitburnerAgentSim";

/** What an effector reports: done afterwards, by the game's own state, and why not if not. */
type EffectorResult = { done: boolean; problem: string | null };

const result = (done: boolean, problem: string): EffectorResult => ({ done, problem: done ? null : problem });

/**
 * Each action's effector, as the page's handler does it. Not named like NS functions (`upgradeHomeRam`): the game
 * charges RAM for such names in the in-game code that calls these.
 */
const effectors = {
  /**
   * The TOR button (`Locations/ui/TorButton.tsx`), which the page disables without the money. The vendor is the page's:
   * the simulator has no locations.
   */
  buyTorRouter(): EffectorResult {
    if (!Player.hasTorRouter() && Player.canAfford(CONSTANTS.TorRouterCost)) purchaseTorRouter();
    return result(Player.hasTorRouter(), "the game didn't sell the TOR router (is the money there?)");
  },
  /** The terminal's `buy` (`Terminal/commands/buy.ts`), which needs the TOR router first. */
  buyDarkwebProgram(program: string): EffectorResult {
    // The brain names it as a string; the game types its programs as file paths.
    const owned = () => (Player.getHomeComputer().programs as readonly string[]).includes(program);
    if (!Player.hasTorRouter()) return result(owned(), "no TOR router to buy programs through");
    if (!owned()) buyDarkwebItem(program);
    return result(owned(), `the game didn't sell ${program} (is the money there?)`);
  },
  /** The RAM button (`Locations/ui/RamButton.tsx`), which the page disables without the money or at the most RAM. */
  buyHomeRam(fromRam: number): EffectorResult {
    const homeComputer = Player.getHomeComputer();
    const upgraded = () => homeComputer.maxRam > fromRam;
    const atMost =
      (Player.bitNodeOptions.restrictHomePCUpgrade && homeComputer.maxRam >= 128) ||
      homeComputer.maxRam >= ServerConstants.HomeComputerMaxRam;
    if (!upgraded() && !atMost && Player.canAfford(Player.getUpgradeHomeRamCost())) purchaseRamForHomeComputer();
    return result(upgraded(), "the game didn't upgrade home's RAM (is the money there?)");
  },
  /** The Travel Agency's `travel` (`Locations/ui/TravelAgencyRoot.tsx:26-34`), its alert and its route. */
  travelTo(city: string): EffectorResult {
    if (Player.city !== city && Object.values(CityName).includes(city as CityName) && Player.travel(city as CityName)) {
      if (!Settings.SuppressTravelConfirmation) dialogBoxCreate(`You are now in ${city}!`);
      Router.toPage(Page.City);
    }
    return result(Player.city === city, `not in ${city} after travelling (is the $200k ticket there?)`);
  },
};

export type AgentSimEffectors = typeof effectors;

/** Puts the effectors on the page's global object, where the Agent looks. */
export function installAgentSimEffectors(): void {
  (globalThis as unknown as Record<string, unknown>)[AGENT_SIM_EFFECTORS_GLOBAL] = effectors;
}
