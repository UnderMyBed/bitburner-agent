// The Agent's `sim` effector backend (#145, architecture §5.6, §9.1): the simulator renders no page, so the `ui`
// effectors can't run here. These do what the page's own handlers do, with the same checks and side effects (dialogs,
// which the simulator captures as events, and routes), so the simulator can play past what its page can show. They
// never grant Source-Files. The Agent finds them on the page's global object; in a browser they're absent.

import { getAugCost } from "../../../../../vendor/bitburner-src/src/Augmentation/AugmentationHelpers";
import { Augmentations } from "../../../../../vendor/bitburner-src/src/Augmentation/Augmentations";
import { AugmentationName } from "../../../../../vendor/bitburner-src/src/Augmentation/Enums";
import { CONSTANTS } from "../../../../../vendor/bitburner-src/src/Constants";
import { buyDarkwebItem } from "../../../../../vendor/bitburner-src/src/DarkWeb/DarkWeb";
import { CityName, FactionWorkType } from "../../../../../vendor/bitburner-src/src/Enums";
import { FactionName } from "../../../../../vendor/bitburner-src/src/Faction/Enums";
import {
  getFactionAugmentationsFiltered,
  hasAugmentationPrereqs,
  joinFaction,
  purchaseAugmentation,
} from "../../../../../vendor/bitburner-src/src/Faction/FactionHelpers";
import { Factions } from "../../../../../vendor/bitburner-src/src/Faction/Factions";
import { purchaseTorRouter } from "../../../../../vendor/bitburner-src/src/Locations/ui/TorButton";
import { Player } from "../../../../../vendor/bitburner-src/src/Player";
import { ServerConstants } from "../../../../../vendor/bitburner-src/src/Server/data/Constants";
import { purchaseRamForHomeComputer } from "../../../../../vendor/bitburner-src/src/Server/ServerPurchases";
import { Settings } from "../../../../../vendor/bitburner-src/src/Settings/Settings";
import { Router } from "../../../../../vendor/bitburner-src/src/ui/GameRoot";
import { dialogBoxCreate } from "../../../../../vendor/bitburner-src/src/ui/React/DialogBox";
import { Page } from "../../../../../vendor/bitburner-src/src/ui/Router";
import { FactionWork, isFactionWork } from "../../../../../vendor/bitburner-src/src/Work/FactionWork";

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
  /**
   * The Factions page's "Join!" (`Faction/ui/FactionsRoot.tsx:88-94`): only for an invited faction that isn't banned.
   * Not named `joinFaction`, which is an NS function.
   */
  acceptFactionInvitation(factionName: string): EffectorResult {
    const isMember = () => Player.factions.includes(factionName as FactionName);
    const faction = Object.values(FactionName).includes(factionName as FactionName)
      ? Factions[factionName as FactionName]
      : undefined;
    if (!isMember() && faction?.alreadyInvited && !faction.isBanned) joinFaction(faction);
    return result(isMember(), `not a member of ${factionName} after joining (is there an invitation?)`);
  },
  /**
   * A faction's augmentations page's "Buy" (`Faction/ui/AugmentationsPage.tsx:137-141`, `:240-255`): only for a
   * member, an augmentation the faction sells, not owned (NeuroFlux at the level to buy next), and only while the page
   * enables it: the prerequisites, the reputation and the money. Not named `purchaseAugmentation`, which is an NS function.
   */
  buyAugmentationFrom(factionName: string, augmentationName: string, level: number): EffectorResult {
    const augmentation = Object.values(AugmentationName).includes(augmentationName as AugmentationName)
      ? Augmentations[augmentationName as AugmentationName]
      : undefined;
    const faction = Object.values(FactionName).includes(factionName as FactionName)
      ? Factions[factionName as FactionName]
      : undefined;
    /** NeuroFlux's level (the installed and the queued); for another augmentation, 1 if owned, else 0. */
    const levelNow = () => {
      if (augmentation === undefined) return 0;
      if (augmentationName === AugmentationName.NeuroFluxGovernor) return augmentation.getLevel();
      return Player.hasAugmentation(augmentation.name) ? 1 : 0;
    };
    if (levelNow() >= level) return result(true, "");
    // The page lists only what the faction sells, to a member. These problems read as core's `augmentationProblems`.
    if (
      augmentation === undefined ||
      faction === undefined ||
      !faction.isMember ||
      !getFactionAugmentationsFiltered(faction).includes(augmentation.name)
    ) {
      return result(false, `${factionName} doesn't offer ${augmentationName} (is it joined, and does it sell it?)`);
    }
    if (levelNow() + 1 !== level) {
      return result(
        false,
        `${augmentationName}'s next level is ${levelNow() + 1}, not ${level}: the levels before it come first`,
      );
    }
    const costs = getAugCost(augmentation);
    const enabled =
      hasAugmentationPrereqs(augmentation) &&
      faction.playerReputation >= costs.repCost &&
      (costs.moneyCost === 0 || Player.money >= costs.moneyCost);
    if (enabled) purchaseAugmentation(faction, augmentation);
    return result(
      levelNow() >= level,
      `can't buy ${augmentationName} from ${factionName} yet (the money, the reputation or a prerequisite?)`,
    );
  },
  /**
   * The work activity's effector (#151): faction work as the faction's page starts it (`Faction/ui/FactionRoot.tsx:59-
   * 95`: a member, where the faction offers that work and isn't the player's gang; started focused, on the Work page),
   * then the focus as the overview's "Focus" or the Work page's "Do something else simultaneously" sets it. Already so:
   * nothing touched. Not named `workForFaction`, which is an NS function.
   */
  convergeFactionWork(factionName: string, workType: string, focus: boolean): EffectorResult {
    const faction = Object.values(FactionName).includes(factionName as FactionName)
      ? Factions[factionName as FactionName]
      : undefined;
    const isThisWork = () =>
      isFactionWork(Player.currentWork) &&
      Player.currentWork.factionName === factionName &&
      Player.currentWork.factionWorkType === workType;
    if (!isThisWork() && faction?.isMember && !(Player.gang && Player.getGangName() === factionName)) {
      const info = faction.getInfo();
      const offered = {
        [FactionWorkType.hacking]: info.offerHackingWork,
        [FactionWorkType.field]: info.offerFieldWork,
        [FactionWorkType.security]: info.offerSecurityWork,
      }[workType as FactionWorkType];
      if (offered) {
        Player.startWork(
          new FactionWork({ singularity: false, faction: faction.name, factionWorkType: workType as FactionWorkType }),
        );
        Player.startFocusing();
        Router.toPage(Page.Work);
      }
    }
    if (isThisWork() && faction !== undefined && Player.focus !== focus) {
      if (focus) {
        Player.startFocusing();
        Router.toPage(Page.Work);
      } else {
        // Leaving the Work page ends the focus (the router, as `ui/GameRoot.tsx:269-275`).
        Router.toPage(Page.Faction, { faction });
      }
    }
    return result(
      isThisWork() && Player.focus === focus,
      `not ${focus ? "focused on" : "doing"} ${workType} work for ${factionName} (is it joined, and does it offer it?)`,
    );
  },
};

export type AgentSimEffectors = typeof effectors;

/** Puts the effectors on the page's global object, where the Agent looks. */
export function installAgentSimEffectors(): void {
  (globalThis as unknown as Record<string, unknown>)[AGENT_SIM_EFFECTORS_GLOBAL] = effectors;
}
