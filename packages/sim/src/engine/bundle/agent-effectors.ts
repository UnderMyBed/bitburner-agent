// The Agent's `sim` effector backend (#145, architecture §5.6, §9.1): the simulator renders no page, so the `ui`
// effectors can't run here. These do what the page's own handlers do, with the same checks and side effects (dialogs,
// which the simulator captures as events, and routes), so the simulator can play past what its page can show. They
// never grant Source-Files, but for a destroy's own, as the BitVerse's portal does (#175). The Agent finds them on the
// page's global object; in a browser they're absent.

import {
  getAugCost,
  installAugmentations,
} from "../../../../../vendor/bitburner-src/src/Augmentation/AugmentationHelpers";
import { Augmentations } from "../../../../../vendor/bitburner-src/src/Augmentation/Augmentations";
import { AugmentationName } from "../../../../../vendor/bitburner-src/src/Augmentation/Enums";
import { getDefaultBitNodeOptions } from "../../../../../vendor/bitburner-src/src/BitNode/BitNodeUtils";
import { Companies } from "../../../../../vendor/bitburner-src/src/Company/Companies";
import { CompanyPositions } from "../../../../../vendor/bitburner-src/src/Company/CompanyPositions";
import { JobTracks } from "../../../../../vendor/bitburner-src/src/Company/data/JobTracks";
import { CompanyName } from "../../../../../vendor/bitburner-src/src/Company/Enums";
import { companyNameAsLocationName } from "../../../../../vendor/bitburner-src/src/Company/utils";
import { CONSTANTS } from "../../../../../vendor/bitburner-src/src/Constants";
import { Crimes } from "../../../../../vendor/bitburner-src/src/Crime/Crimes";
import { buyDarkwebItem } from "../../../../../vendor/bitburner-src/src/DarkWeb/DarkWeb";
import {
  CityName,
  ClassType,
  CrimeType,
  FactionWorkType,
  GymType,
  type JobField,
  type JobName,
  LocationName,
  LocationType,
} from "../../../../../vendor/bitburner-src/src/Enums";
import { FactionName } from "../../../../../vendor/bitburner-src/src/Faction/Enums";
import {
  getFactionAugmentationsFiltered,
  hasAugmentationPrereqs,
  joinFaction,
  purchaseAugmentation,
} from "../../../../../vendor/bitburner-src/src/Faction/FactionHelpers";
import { Factions } from "../../../../../vendor/bitburner-src/src/Faction/Factions";
import { Locations } from "../../../../../vendor/bitburner-src/src/Locations/Locations";
import { purchaseTorRouter } from "../../../../../vendor/bitburner-src/src/Locations/ui/TorButton";
import { startWorkerScript } from "../../../../../vendor/bitburner-src/src/NetscriptWorker";
import type { ScriptFilePath } from "../../../../../vendor/bitburner-src/src/Paths/ScriptFilePath";
import { Player } from "../../../../../vendor/bitburner-src/src/Player";
import { enterBitNode } from "../../../../../vendor/bitburner-src/src/RedPill";
import { RunningScript } from "../../../../../vendor/bitburner-src/src/Script/RunningScript";
import {
  AddToAllServers,
  createUniqueRandomIp,
  GetServer,
} from "../../../../../vendor/bitburner-src/src/Server/AllServers";
import { DarknetServer } from "../../../../../vendor/bitburner-src/src/Server/DarknetServer";
import { ServerConstants } from "../../../../../vendor/bitburner-src/src/Server/data/Constants";
import { SpecialServers } from "../../../../../vendor/bitburner-src/src/Server/data/SpecialServers";
import { safelyCreateUniqueServer } from "../../../../../vendor/bitburner-src/src/Server/ServerHelpers";
import {
  getCloudServerCost,
  getCloudServerLimit,
  purchaseRamForHomeComputer,
} from "../../../../../vendor/bitburner-src/src/Server/ServerPurchases";
import { Settings } from "../../../../../vendor/bitburner-src/src/Settings/Settings";
import { Terminal } from "../../../../../vendor/bitburner-src/src/Terminal";
import { Router } from "../../../../../vendor/bitburner-src/src/ui/GameRoot";
import { dialogBoxCreate } from "../../../../../vendor/bitburner-src/src/ui/React/DialogBox";
import { Page } from "../../../../../vendor/bitburner-src/src/ui/Router";
import { Classes, ClassWork, isClassWork } from "../../../../../vendor/bitburner-src/src/Work/ClassWork";
import { CompanyWork, isCompanyWork } from "../../../../../vendor/bitburner-src/src/Work/CompanyWork";
import { isCrimeWork } from "../../../../../vendor/bitburner-src/src/Work/CrimeWork";
import { FactionWork, isFactionWork } from "../../../../../vendor/bitburner-src/src/Work/FactionWork";
import { bitVerseFlume } from "./router.ts";

/**
 * The global the Agent looks for: core's `AGENT_SIM_EFFECTORS_GLOBAL`. This bundle is typechecked and built as the
 * game's own code (`scripts/typecheck-bundle.ts`, `bundle/build.ts`), which doesn't reach the workspace's packages, so
 * it can't import core; the effector-backends suite fails if the two drift.
 */
const AGENT_SIM_EFFECTORS_GLOBAL = "__bitburnerAgentSim";

/**
 * How long the money must last before a paid class is started (#158): core's `CLASS_MONEY_GUARD_SECONDS`, the guard
 * every backend applies. The bundle can't import core (above); the effector-backends suite builds its expected
 * problems with core's `classStartProblem`, so it fails if the two drift.
 */
const CLASS_MONEY_GUARD_SECONDS = 600;

/** "$72,000", "-$3,721", as core's class problems word money. */
const dollars = (amount: number) => `${amount < 0 ? "-" : ""}$${Math.abs(amount).toLocaleString("en-US")}`;

/** What an effector reports: done afterwards, by the game's own state, and why not if not. */
type EffectorResult = { done: boolean; problem: string | null };

const result = (done: boolean, problem: string): EffectorResult => ({ done, problem: done ? null : problem });

/** How long after an install the game starts the script named for after it (`NetscriptFunctions/Singularity.ts:210`). */
const CALLBACK_AFTER_RESET_MS = 500;

/**
 * Starts `callbackScript` on home after a reset, with 1 thread and no args, as Singularity's `runAfterReset` does
 * (`NetscriptFunctions/Singularity.ts:59-76`): only if it's there and fits home's free RAM.
 */
function runAfterReset(callbackScript: string): void {
  const home = Player.getHomeComputer();
  const script = home.scripts.get(callbackScript as ScriptFilePath);
  if (!script) return;
  const ramUsage = script.getRamUsage(home.scripts);
  if (!ramUsage) {
    Terminal.error(`Attempted to launch ${callbackScript} after reset but could not calculate ram usage.`);
    return;
  }
  if (ramUsage > home.maxRam - home.ramUsed + 0.001) {
    Terminal.error(`Attempted to launch ${callbackScript} after reset but there was not enough ram.`);
    return;
  }
  startWorkerScript(new RunningScript(script, ramUsage, []), home);
}

/**
 * What the `ui` effectors that type report while the terminal runs an action: its input is disabled (#162). A copy of
 * the in-game `TERMINAL_BUSY` (`ingame/src/page/game-page.ts`), which this bundle can't import (see
 * `AGENT_SIM_EFFECTORS_GLOBAL`); the effector-backends suite checks the wording, and fails if the two drift.
 */
const TERMINAL_BUSY = "terminal busy";

/**
 * The hostnames to `connect` to, in turn, from home to `hostname`, breadth-first as the `ui` worker's `scan` finds:
 * a copy of `ingame/src/workers/route-from-home.ts`, over the game's own links, for the same reason.
 */
function routeFromHome(hostname: string): string[] | null {
  const cameFrom = new Map<string, string | null>([["home", null]]);
  const queue = ["home"];
  for (let index = 0; index < queue.length; index++) {
    const here = queue[index] as string;
    if (here === hostname) {
      const route: string[] = [];
      for (let step: string | null = here; step !== null && step !== "home"; step = cameFrom.get(step) ?? null) {
        route.unshift(step);
      }
      return route;
    }
    for (const neighbour of GetServer(here)?.serversOnNetwork ?? []) {
      if (!cameFrom.has(neighbour)) {
        cameFrom.set(neighbour, here);
        queue.push(neighbour);
      }
    }
  }
  return null;
}

/** How often the destroy's timer looks for the BitVerse, and how long past the backdoor's end it looks (#175). */
const BITVERSE_POLL_MS = 100;
const BITVERSE_SLACK_MS = 10_000;

/**
 * What the BitVerse's portal does once a backdoor on w0r1d_d43m0n has reached it (#175;
 * `BitNode/ui/PortalModal.tsx:117-131`): `enterBitNode(false, …)` with the modal's defaults, destroying the BitNode;
 * BitNode 6's cinematic left as its Continue does (`RedPill.tsx:88-89`); then `callbackScript` 500 ms later, as
 * Singularity's `destroyW0r1dD43m0n` starts it. A timer, as the `ui` worker's page timer is: the BitVerse has killed
 * the Agent that armed it. Polls until the game is at the BitVerse, for `limitMs` at most. No guard against a second
 * one armed meanwhile, as the `ui` timer has: the Agent is dead within its backdoor's few seconds, so no second try
 * comes while one waits.
 */
function enterFromBitVerseOnceThere(nextBitNode: number, callbackScript: string, limitMs: number): void {
  const endsAtMs = Date.now() + limitMs;
  const look = () => {
    if (bitVerseFlume() !== false) {
      if (Date.now() < endsAtMs) setTimeout(look, BITVERSE_POLL_MS);
      return;
    }
    enterBitNode(false, Player.bitNodeN, nextBitNode, getDefaultBitNodeOptions());
    if (Router.page() === Page.BladeburnerCinematic) Router.toPage(Page.Terminal);
    setTimeout(() => runAfterReset(callbackScript), CALLBACK_AFTER_RESET_MS);
  };
  setTimeout(look, BITVERSE_POLL_MS);
}

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
    // The `ui` worker types `buy`, which a terminal busy with an action refuses (#162).
    if (!owned() && Terminal.action !== null) return result(false, TERMINAL_BUSY);
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
  /**
   * The work activity's effector for company work (#153), as the page does it. A job in the field there already: its
   * "Work" on the sidebar's Job page, from any city (`Locations/ui/JobRoot.tsx`). Otherwise the company's page, only in
   * its city (`Locations/ui/CompanyLocation.tsx`), and the field's job as `Company/ui/JobListings.tsx` lists it: one the
   * player qualifies for (applying climbs to the highest, `applyForJob`), or else the field's first, disabled; neither,
   * nothing to apply for. Then "Work", focused on the Work page; then the focus as the focus buttons set it. Already so:
   * nothing touched. Not named `workForCompany`, which is an NS function. The problems read as the `ui` worker's.
   * With `checkPromotion` (#155, owner decision 44) and a job in the field held, first what the Job page's listing of
   * that company offers, from any city (`Company/ui/JobListings.tsx`): a later title of the field the player qualifies
   * for, shown only if they don't qualify for its next, so applying climbs no further (`applyForJob`), and its alert.
   * The work under way goes on. `promoted`: the title before and after, as the `ui` worker reports it.
   */
  convergeCompanyWork(
    companyName: string,
    field: string,
    focus: boolean,
    checkPromotion = false,
  ): EffectorResult & { promoted: { from: string; to: string } | null } {
    const company = Object.values(CompanyName).includes(companyName as CompanyName)
      ? Companies[companyName as CompanyName]
      : undefined;
    const track = JobTracks[field as JobField] ?? [];
    const held = () => Player.jobs[companyName as CompanyName];
    const hasJobInField = () => track.some((job) => held() === job);
    const isThisWork = () =>
      isCompanyWork(Player.currentWork) && Player.currentWork.companyName === companyName && hasJobInField();
    const notConverged = `not ${focus ? "focused on" : "doing"} ${field} work at ${companyName}`;
    if (company === undefined || track.length === 0) return { ...result(false, notConverged), promoted: null };
    const before = held();
    if (checkPromotion && before !== undefined && hasJobInField()) {
      const qualified = (job: JobName | null) =>
        job !== null && company.companyPositions.has(job) && Player.isQualified(company, CompanyPositions[job]);
      const offered = track
        .slice(track.indexOf(before) + 1)
        .find((job) => qualified(job) && !qualified(CompanyPositions[job].nextPosition));
      if (offered !== undefined) {
        const applied = Player.applyForJob(company, CompanyPositions[offered]);
        if (applied.message) dialogBoxCreate(applied.message);
      }
    }
    /** The work and its focus, as the page sets them (#153). */
    const converge = (): EffectorResult => {
      if (!isThisWork()) {
        if (!hasJobInField()) {
          if (Locations[companyNameAsLocationName(company.name)]?.city !== Player.city) {
            return result(false, `no ${companyName} in the city (is the player in its city?)`);
          }
          const offered = track.filter((job) => company.companyPositions.has(job)).map((job) => CompanyPositions[job]);
          const position = offered.find((job) => Player.isQualified(company, job));
          if (position === undefined) {
            return result(
              false,
              offered.some((job) => job.isStartingJob)
                ? `not qualified for a ${field} job at ${companyName} yet`
                : `no ${field} job open to the player at ${companyName} (none offered, or not qualified yet)`,
            );
          }
          const applied = Player.applyForJob(company, position);
          if (applied.message) dialogBoxCreate(applied.message);
        }
        if (hasJobInField()) {
          Player.startWork(new CompanyWork({ singularity: false, companyName: company.name }));
          Player.startFocusing();
          Router.toPage(Page.Work);
        }
      }
      if (isThisWork() && Player.focus !== focus) {
        if (focus) {
          Player.startFocusing();
          Router.toPage(Page.Work);
        } else {
          // Leaving the Work page ends the focus (the router, as `ui/GameRoot.tsx:269-275`).
          Router.toPage(Page.Job);
        }
      }
      return result(isThisWork() && Player.focus === focus, notConverged);
    };
    const converged = converge();
    const after = held();
    // A later title of the field than before's, as core's `promotionBetween` says: not a hire, nor another field.
    const promoted =
      before !== undefined &&
      after !== undefined &&
      track.includes(before) &&
      track.indexOf(after) > track.indexOf(before)
        ? { from: before, to: after }
        : null;
    return { ...converged, promoted };
  },
  /**
   * A cloud server (#159), as `ns.cloud.purchaseServer` buys it (`NetscriptFunctions/Cloud.ts:35-93`), with the `ui`
   * worker's checks first: the player's already, done; the name taken by another server, refused (the game would buy
   * `<name>-0`); then the price, the money and the limit. The name is looked up as the worker's `ns.serverExists` does
   * (`NetscriptFunctions.ts:1051-1055`: a server off the network isn't seen), so a purchase the game renames all the
   * same is done, saying so, as the worker's. Not named `purchaseServer`, an NS function. The problems read as the
   * worker's.
   */
  buyCloudServer(hostname: string, ram: number): EffectorResult {
    const isPlayers = () => Player.purchasedServers.includes(hostname);
    const existing = GetServer(hostname);
    if (existing !== null && (existing.serversOnNetwork.length > 0 || existing instanceof DarknetServer)) {
      return result(isPlayers(), `${hostname} is the name of a server that isn't one of the player's cloud servers`);
    }
    const cost = getCloudServerCost(ram);
    if (cost === Number.POSITIVE_INFINITY) return result(false, `the game sells no ${ram} GB server in this BitNode`);
    if (Player.money < cost) return result(false, `not enough money: the ${ram} GB server costs $${Math.ceil(cost)}`);
    if (Player.purchasedServers.length >= getCloudServerLimit()) {
      return result(false, `the game's limit of ${getCloudServerLimit()} cloud servers is reached`);
    }
    const server = safelyCreateUniqueServer({
      ip: createUniqueRandomIp(),
      hostname,
      organizationName: "",
      isConnectedTo: false,
      adminRights: true,
      purchasedByPlayer: true,
      maxRam: ram,
    });
    AddToAllServers(server);
    Player.purchasedServers.push(server.hostname);
    const homeComputer = Player.getHomeComputer();
    homeComputer.serversOnNetwork.push(server.hostname);
    server.serversOnNetwork.push(homeComputer.hostname);
    Player.loseMoney(cost, "servers");
    if (server.hostname !== hostname) {
      return { done: true, problem: `bought as ${server.hostname}: a server off the network held ${hostname}` };
    }
    return result(isPlayers(), `${hostname} isn't the player's after buying it`);
  },
  /**
   * The work activity's effector for crime (#156), as the Slums page does it (`Locations/ui/SlumsLocation.tsx:24-29`:
   * the crime committed, focused, on the Work page), from any city, as the Slums is in each; then the focus as the
   * focus buttons set it (the Work page's "Do something else simultaneously" goes to the City for a crime,
   * `ui/WorkInProgressRoot.tsx:220-222`). Already so: nothing touched. Not named `commitCrime`, an NS function.
   */
  convergeCrimeWork(crimeName: string, focus: boolean): EffectorResult {
    const crime = Object.values(CrimeType).includes(crimeName as CrimeType)
      ? Crimes[crimeName as CrimeType]
      : undefined;
    const isThisWork = () => isCrimeWork(Player.currentWork) && Player.currentWork.crimeType === crimeName;
    if (crime !== undefined && !isThisWork()) {
      crime.commit();
      Router.toPage(Page.Work);
      Player.focus = true;
    }
    if (isThisWork() && Player.focus !== focus) {
      if (focus) {
        Player.startFocusing();
        Router.toPage(Page.Work);
      } else {
        // Leaving the Work page ends the focus (the router, as `ui/GameRoot.tsx:269-275`).
        Router.toPage(Page.City);
      }
    }
    return result(isThisWork() && Player.focus === focus, `not ${focus ? "focused on" : "doing"} ${crimeName}`);
  },
  /**
   * The Augmentations page's "Install Augmentations", confirmed (#164): `installAugmentations()`, as the page's handler
   * calls it (`ui/GameRoot.tsx:469-471`), only with something queued (the page disables it otherwise,
   * `Augmentation/ui/AugmentationsRoot.tsx:173`). Nothing queued is done: nothing is left to install. The install kills
   * every script, the Agent that called this too, and resets the game; `callbackScript` starts 500 ms later, as
   * Singularity's `installAugmentations(cbScript)` does it, in place of the `ui` backend's restart. Not named
   * `installAugmentations`, which is an NS function.
   */
  installQueuedAugmentations(callbackScript: string): EffectorResult {
    if (Player.queuedAugmentations.length > 0) {
      installAugmentations();
      setTimeout(() => runAfterReset(callbackScript), CALLBACK_AFTER_RESET_MS);
    }
    return result(Player.queuedAugmentations.length === 0, "augmentations are still queued after installing them");
  },
  /**
   * The work activity's effector for a class (#158), as a university's or gym's page does it
   * (`Locations/ui/UniversityLocation.tsx:27-37`, `GymLocation.tsx:26-36`: the class started, focused, on the Work page), reached
   * from the City only in its city; then the focus as the focus buttons set it (the Work page's "Do something else
   * simultaneously" goes to the location, `ui/WorkInProgressRoot.tsx:266-268`). Before starting one, the guard every
   * backend applies (core's `classStartProblem`, the same words): the city, then `CLASS_MONEY_GUARD_SECONDS` of its cost (base ×
   * the location's `costMult`, the backdoor's discount left out). The location is checked exactly, as the page can't.
   * Already so: nothing touched. Not named `universityCourse` or `gymWorkout`, NS functions.
   */
  convergeClassWork(locationName: string, classType: string, focus: boolean): EffectorResult {
    const location = Object.values(LocationName).includes(locationName as LocationName)
      ? Locations[locationName as LocationName]
      : undefined;
    const classs = Object.values(ClassType).includes(classType as ClassType)
      ? Classes[classType as ClassType]
      : undefined;
    const isGym = Object.values(GymType).includes(classType as GymType);
    const gymStat = Object.entries(GymType).find(([, value]) => value === classType)?.[0] ?? "";
    const label = `${isGym ? `${gymStat.charAt(0).toUpperCase()}${gymStat.slice(1)} training` : classType} at ${locationName}`;
    const isThisWork = () =>
      isClassWork(Player.currentWork) &&
      Player.currentWork.classType === classType &&
      Player.currentWork.location === locationName;
    const notConverged = `not ${focus ? "focused on" : "doing"} ${label}`;
    if (location === undefined || classs === undefined) return result(false, notConverged);
    if (!location.types.includes(isGym ? LocationType.Gym : LocationType.University))
      return result(false, notConverged);
    if (!isThisWork()) {
      if (location.city !== Player.city) {
        return result(
          false,
          `${locationName} is in ${location.city}, and the player is in ${Player.city} (travel there first)`,
        );
      }
      const perSecond = -classs.earnings.money * location.costMult;
      const guard = perSecond * CLASS_MONEY_GUARD_SECONDS;
      if (perSecond !== 0 && Player.money < guard) {
        return result(
          false,
          `${label} costs ${dollars(perSecond)} a second: the Agent starts it with ` +
            `${CLASS_MONEY_GUARD_SECONDS / 60} minutes of that ` +
            `(${dollars(guard)}) or more, and the player has ${dollars(Math.floor(Player.money))}`,
        );
      }
      Player.startWork(
        new ClassWork({ classType: classType as ClassType, location: location.name, singularity: false }),
      );
      Player.startFocusing();
      Router.toPage(Page.Work);
    }
    if (isThisWork() && Player.focus !== focus) {
      if (focus) {
        Player.startFocusing();
        Router.toPage(Page.Work);
      } else {
        // Leaving the Work page ends the focus (the router, as `ui/GameRoot.tsx:269-275`).
        Router.toPage(Page.Location, { location });
      }
    }
    return result(isThisWork() && Player.focus === focus, notConverged);
  },
  /**
   * A backdoor (#162) as the `ui` worker types it: the same checks and problems first (`commands/backdoor.ts`),
   * then the terminal's own commands (`Terminal.executeCommands`): `home`, `connect` along the way, `backdoor`. The
   * engine counts its action down (hacking time / 4, `Terminal/Terminal.ts:233-243`, `engine.tsx:96`) as on the page,
   * the terminal busy meanwhile; the try that finds it installed, the terminal still there, types `home`. Not named
   * `installBackdoor`, which is an NS function.
   */
  backdoorServer(hostname: string): EffectorResult {
    const server = GetServer(hostname);
    // The `ui` worker's `serverExists`: a server on the network, or the dark net's (`NetscriptFunctions.ts:1051-1055`).
    if (server === null || (server.serversOnNetwork.length === 0 && !(server instanceof DarknetServer))) {
      return result(false, `no server ${hostname}`);
    }
    const installed = () => server.backdoorInstalled;
    // Read afresh each time: the terminal's commands start and end its action.
    const action = (): { timeLeft: number } | null => Terminal.action;
    if (installed() && !server.isConnectedTo) return result(true, "");
    // In the `ui` worker's order: its refusals come first, and only the typing finds the terminal busy.
    if (installed()) {
      if (action() !== null) return result(false, TERMINAL_BUSY);
      Terminal.executeCommands("home");
      return result(!server.isConnectedTo, `the terminal is still on ${hostname}`);
    }
    if (server.purchasedByPlayer) {
      return result(false, `${hostname} is the player's own: the game backdoors only others' servers`);
    }
    if (!server.hasAdminRights) return result(false, `no root access on ${hostname} (NUKE.exe first)`);
    const required = "requiredHackingSkill" in server ? (server.requiredHackingSkill as number) : 0;
    if (required > Player.skills.hacking) {
      return result(false, `hacking level ${Player.skills.hacking}: ${hostname} needs ${required}`);
    }
    const route = routeFromHome(hostname);
    if (route === null) return result(false, `no way from home to ${hostname}`);
    if (action() !== null) return result(false, TERMINAL_BUSY);
    if (Player.currentServer !== "home") Terminal.executeCommands("home");
    for (const hop of route) {
      Terminal.executeCommands(`connect ${hop}`);
      if (Player.currentServer !== hop) return result(false, `couldn't connect to ${hop} on the way to ${hostname}`);
    }
    Terminal.executeCommands("backdoor");
    const running = action();
    if (running === null) return result(false, `the terminal didn't start the backdoor on ${hostname}`);
    // The `ui` worker's wording (`installingProblem`, `ingame/src/workers/backdoor-standing.ts`); `timeLeft` is in s.
    return result(
      false,
      `installing the backdoor on ${hostname}: about ${Math.max(1, Math.ceil(running.timeLeft))} s left`,
    );
  },
  /**
   * Destroying the BitNode (#175) as the `ui` worker does it: w0r1d_d43m0n's preconditions first, in core's words
   * (`worldDaemonProblem`, copied: this bundle can't import core; the destroy suite checks them, `brain/test/destroy-restart.test.ts`), then the
   * terminal's own commands: `home`, `connect` along the way, `backdoor`. Its action (hacking time / 4) ends at the
   * BitVerse (`Terminal/Terminal.ts:373-388`), which kills every script, the Agent that called this too; a timer then
   * enters `nextBitNode` through the portal (`enterFromBitVerseOnceThere`). Already at the BitVerse after a destroy's
   * backdoor (a save that starts there: `ui/GameRoot.tsx:160-164`), only the portal. Never done: the brain's reset
   * check says it is. Not named `destroyW0r1dD43m0n`, which is an NS function.
   */
  destroyWorldDaemon(nextBitNode: number, callbackScript: string): EffectorResult {
    const hostname = SpecialServers.WorldDaemon;
    const daemon = GetServer(hostname);
    // Not reachable before The Red Pill's install links it (`Prestige.ts:174-182`): the `ui` worker's `serverExists`.
    if (daemon === null || daemon.serversOnNetwork.length === 0) {
      return result(false, `${hostname} isn't reachable: The Red Pill isn't installed`);
    }
    const entering = `entering BitNode ${nextBitNode} from the BitVerse`;
    if (daemon.backdoorInstalled) {
      if (bitVerseFlume() !== false)
        return result(false, `${hostname} is backdoored, but the game isn't at the BitVerse`);
      enterFromBitVerseOnceThere(nextBitNode, callbackScript, BITVERSE_SLACK_MS);
      return result(false, entering);
    }
    if (!daemon.hasAdminRights) return result(false, `no root access on ${hostname} (NUKE.exe first)`);
    const required = "requiredHackingSkill" in daemon ? (daemon.requiredHackingSkill as number) : 0;
    if (required > Player.skills.hacking) {
      return result(false, `hacking level ${Player.skills.hacking}: ${hostname} needs ${required}`);
    }
    // Read afresh each time: the terminal's commands start and end its action.
    const action = (): { timeLeft: number } | null => Terminal.action;
    const route = routeFromHome(hostname);
    if (route === null) return result(false, `no way from home to ${hostname}`);
    if (action() !== null) return result(false, TERMINAL_BUSY);
    if (Player.currentServer !== "home") Terminal.executeCommands("home");
    for (const hop of route) {
      Terminal.executeCommands(`connect ${hop}`);
      if (Player.currentServer !== hop) return result(false, `couldn't connect to ${hop} on the way to ${hostname}`);
    }
    Terminal.executeCommands("backdoor");
    const running = action();
    if (running === null) return result(false, `the terminal didn't start the backdoor on ${hostname}`);
    enterFromBitVerseOnceThere(nextBitNode, callbackScript, running.timeLeft * 1000 + BITVERSE_SLACK_MS);
    // The `ui` worker's wording (`ingame/src/entries/destroy-bitnode.ts`); `timeLeft` is in s.
    return result(
      false,
      `backdooring ${hostname}: about ${Math.max(1, Math.ceil(running.timeLeft))} s left, then ${entering}`,
    );
  },
  /**
   * The faction state (#197), what the `ui` worker reads from the page and Singularity's worker from the API: each
   * joined faction's reputation and favour (`Faction/Faction.ts:17`, `:32`), in the order joined, the invitations
   * (`Player.factionInvitations`) and the queue in the game's form (`Player.queuedAugmentations`: NeuroFlux once per
   * level). Not named like an NS function.
   */
  readFactionState(): EffectorResult & {
    state: {
      joined: { name: string; reputation: number; favor: number }[];
      invitations: string[];
      queuedAugmentations: string[];
    };
  } {
    return {
      done: true,
      problem: null,
      state: {
        joined: Player.factions.map((name) => ({
          name,
          reputation: Factions[name].playerReputation,
          favor: Factions[name].favor,
        })),
        invitations: [...Player.factionInvitations],
        queuedAugmentations: Player.queuedAugmentations.map((augmentation) => augmentation.name),
      },
    };
  },
};

export type AgentSimEffectors = typeof effectors;

/** Puts the effectors on the page's global object, where the Agent looks. */
export function installAgentSimEffectors(): void {
  (globalThis as unknown as Record<string, unknown>)[AGENT_SIM_EFFECTORS_GLOBAL] = effectors;
}
