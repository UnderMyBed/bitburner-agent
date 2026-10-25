// Bundled together with the game's source into dist/engine.cjs. Not typechecked by the repo's tsc: it imports the
// game, which builds under its own TypeScript setup. Keep it minimal; its exports must match EngineApi (../api.ts).
import { getBitNodeLevel } from "../../../../../vendor/bitburner-src/src/BitNode/BitNodeUtils";
import { CONSTANTS } from "../../../../../vendor/bitburner-src/src/Constants";
import { Engine } from "../../../../../vendor/bitburner-src/src/engine";
import { ITutorial, iTutorialEnd } from "../../../../../vendor/bitburner-src/src/InteractiveTutorial";
import { workerScripts } from "../../../../../vendor/bitburner-src/src/Netscript/WorkerScripts";
import { Player } from "../../../../../vendor/bitburner-src/src/Player";
import { saveObject } from "../../../../../vendor/bitburner-src/src/SaveObject";
import { GetAllServers } from "../../../../../vendor/bitburner-src/src/Server/AllServers";
import { Settings } from "../../../../../vendor/bitburner-src/src/Settings/Settings";
import { UIEventEmitter, UIEventType } from "../../../../../vendor/bitburner-src/src/ui/UIEventEmitter";
import { commitHash } from "../../../../../vendor/bitburner-src/src/utils/helpers/commitHash";
import { decodeSaveData } from "../../../../../vendor/bitburner-src/src/utils/SaveDataUtils";
import type { Tutorial } from "../../protocol.ts";

export function versionNumber() {
  return CONSTANTS.VersionNumber;
}

export function gameCommit() {
  return commitHash();
}

export function engineLastUpdate() {
  return Engine._lastUpdate;
}

export function dateNow() {
  return Date.now();
}

export function performanceNow() {
  return performance.now();
}

/** The game's own new-game path, then what the UI does once it has mounted. */
export async function bootNewGame(tutorial: Tutorial) {
  await Engine.load(undefined); // no save data: a new game; ends by starting the engine loop
  UIEventEmitter.emit(UIEventType.MainUILoaded); // GameRoot emits this on mount: starts saved scripts and autoexec
  // There is no IndexedDB to autosave into; the harness takes its own snapshots.
  Settings.AutosaveInterval = 0;
  Settings.SuppressAutosaveDisabledWarnings = true;
  if (tutorial === "skipped") iTutorialEnd(); // what the tutorial's Skip button calls
}

export function gameSummary() {
  const home = Player.getHomeComputer();
  return {
    playtimeMs: Player.totalPlaytime,
    bitNodeN: Player.bitNodeN,
    bitNodeLevel: getBitNodeLevel(), // the game's own: capped at 3 except in BN12
    sourceFiles: Object.fromEntries(Player.sourceFiles),
    money: Player.money,
    hackingLevel: Player.skills.hacking,
    hackingExp: Player.exp.hacking,
    homeRamUsed: home.ramUsed,
    homeRamMax: home.maxRam,
    scripts: workerScripts.size,
    augsInstalled: Player.augmentations.length,
    augsQueued: Player.queuedAugmentations.length,
  };
}

/** The game's own save, as JSON text. */
export async function saveJson() {
  return decodeSaveData(await saveObject.getSaveData());
}

export function gameDiagnostics() {
  return {
    tutorialRunning: ITutorial.isRunning,
    autosaveInterval: Settings.AutosaveInterval,
    contracts: GetAllServers()
      .flatMap((server) => server.contracts.map((contract) => `${server.hostname}:${contract.fn}`))
      .sort(),
  };
}
