// Bundled together with the game's source into dist/engine.cjs. It imports the game, so it's typechecked the game's way
// (tsconfig.bundle.json, README "Typecheck boundary"), not by the repo's tsc. Keep it minimal; its exports must match
// EngineApi (../api.ts), which the typecheck checks at the end of this file.

import { AugmentationName } from "../../../../../vendor/bitburner-src/src/Augmentation/Enums";
import { PlayerOwnedAugmentation } from "../../../../../vendor/bitburner-src/src/Augmentation/PlayerOwnedAugmentation";
import { getBitNodeMultipliers } from "../../../../../vendor/bitburner-src/src/BitNode/BitNode";
import { currentNodeMults } from "../../../../../vendor/bitburner-src/src/BitNode/BitNodeMultipliers";
import {
  getBitNodeLevel,
  getDefaultBitNodeOptions,
} from "../../../../../vendor/bitburner-src/src/BitNode/BitNodeUtils";
import { CONSTANTS } from "../../../../../vendor/bitburner-src/src/Constants";
import { save as saveToIndexedDb } from "../../../../../vendor/bitburner-src/src/db";
import { Engine } from "../../../../../vendor/bitburner-src/src/engine";
import { FactionName } from "../../../../../vendor/bitburner-src/src/Faction/Enums";
import { joinFaction } from "../../../../../vendor/bitburner-src/src/Faction/FactionHelpers";
import { Factions } from "../../../../../vendor/bitburner-src/src/Faction/Factions";
import { ITutorial, iTutorialEnd } from "../../../../../vendor/bitburner-src/src/InteractiveTutorial";
import { killWorkerScriptByPid } from "../../../../../vendor/bitburner-src/src/Netscript/killWorkerScript";
import { recentScripts } from "../../../../../vendor/bitburner-src/src/Netscript/RecentScripts";
import { workerScripts } from "../../../../../vendor/bitburner-src/src/Netscript/WorkerScripts";
import { config } from "../../../../../vendor/bitburner-src/src/NetscriptJSEvaluator";
import {
  createRunningScriptInstance,
  startWorkerScript,
} from "../../../../../vendor/bitburner-src/src/NetscriptWorker";
import { isLegacyScript, resolveScriptFilePath } from "../../../../../vendor/bitburner-src/src/Paths/ScriptFilePath";
import { resolveTextFilePath } from "../../../../../vendor/bitburner-src/src/Paths/TextFilePath";
import { Player } from "../../../../../vendor/bitburner-src/src/Player";
import { enterBitNode } from "../../../../../vendor/bitburner-src/src/RedPill";
import { newRemoteFileApiConnection } from "../../../../../vendor/bitburner-src/src/RemoteFileAPI/RemoteFileAPI";
import { saveObject } from "../../../../../vendor/bitburner-src/src/SaveObject";
import type { ScriptModule, ScriptURL } from "../../../../../vendor/bitburner-src/src/Script/LoadedModule";
import { GetAllServers, GetServer } from "../../../../../vendor/bitburner-src/src/Server/AllServers";
import { BaseServer } from "../../../../../vendor/bitburner-src/src/Server/BaseServer";
import { SpecialServers } from "../../../../../vendor/bitburner-src/src/Server/data/SpecialServers";
import { Settings } from "../../../../../vendor/bitburner-src/src/Settings/Settings";
import { isPositiveInteger, type SaveData } from "../../../../../vendor/bitburner-src/src/types";
import type { SimplePage } from "../../../../../vendor/bitburner-src/src/ui/Enums";
import { Router } from "../../../../../vendor/bitburner-src/src/ui/GameRoot";
import { isSimplePage, Page } from "../../../../../vendor/bitburner-src/src/ui/Router";
import { UIEventEmitter, UIEventType } from "../../../../../vendor/bitburner-src/src/ui/UIEventEmitter";
import { commitHash } from "../../../../../vendor/bitburner-src/src/utils/helpers/commitHash";
import { decodeSaveData } from "../../../../../vendor/bitburner-src/src/utils/SaveDataUtils";
import type { GameEvent, GameSettingsOverride, ProcessInfo, RunResult, ScriptArg, Tutorial } from "../../protocol.ts";
import type { EngineApi } from "../api.ts";
import { answerPrompts, captureUi, installPageGlobals } from "./page.ts";
import { bitVerseFlume, mountRouter, routerPages } from "./router.ts";

export { answerPrompts as setPromptAnswerer, installPageGlobals };

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
  afterUiMount();
  if (tutorial === "skipped") iTutorialEnd(); // what the tutorial's Skip button calls
}

/**
 * The game's own load path for a save (migration, offline progress), then what the UI does once it has mounted. The
 * browser's IndexedDB would already hold this save, and the pre-v3 migration reads it from there, so it's stored first.
 */
export async function bootSave(saveData: SaveData) {
  await saveToIndexedDb(saveData);
  await Engine.load(saveData);
  afterUiMount();
}

/**
 * A new game, then BitNode `n` entered with the given Source-Files, as b1t_flum3.exe does: through the game's own
 * `enterBitNode` (RedPill.tsx), which resets the game for the new BitNode without granting a Source-File. The game's
 * own tests set up the same way (test/jest/Utilities.ts). A player entering a BitNode has long finished the tutorial.
 * The UI is already up when a player flumes, so this happens after the new game's mount.
 */
export async function bootBitNode(n: number, sourceFiles: Record<string, number>) {
  await bootNewGame("skipped");
  for (const [bitNode, level] of Object.entries(sourceFiles)) Player.sourceFiles.set(Number(bitNode), level);
  enterBitNodeChecked(true, n);
  leaveCinematic();
}

/**
 * The game's `enterBitNode`. If its prestige fails, the game goes into recovery mode and shows the Recovery page
 * (RedPill.tsx); a simulation can't use that state, so this fails instead.
 */
function enterBitNodeChecked(isFlume: boolean, n: number) {
  enterBitNode(isFlume, Player.bitNodeN, n, getDefaultBitNodeOptions());
  if (Router.page() === Page.Recovery) {
    // The game keeps the error to itself (RecoveryRoot.tsx); its recovery page would show it.
    throw new Error(`Entering BitNode ${n} failed: the game went into recovery mode`);
  }
}

/**
 * Entering BitNode 6 shows the Bladeburner cinematic, which only its Continue button leaves (BladeburnerCinematic.tsx
 * onDone), and which hides messages. A fixture starts as a player who has clicked it.
 */
function leaveCinematic() {
  if (Router.page() === Page.BladeburnerCinematic) Router.toPage(Page.Terminal);
}

/**
 * What the BitVerse portal does after a real destroy (PortalModal.tsx, with flume false): the current BitNode's
 * Source-File goes up a level, then BitNode `n` starts. Test-only.
 */
export function destroyBitNode(n: number) {
  enterBitNodeChecked(false, n);
}
/**
 * What the BitVerse's portal does when a player picks BitNode `n` there (PortalModal.tsx): enter it, destroying the
 * current BitNode unless the BitVerse was reached by flume. Then leave BitNode 6's cinematic, as a player clicking
 * Continue would. Throws if the game isn't at the BitVerse.
 */
export function enterFromBitVerse(n: number) {
  const flume = bitVerseFlume();
  if (flume === null) throw new Error(`Not at the BitVerse: can't enter BitNode ${n} from page ${Router.page()}`);
  enterBitNodeChecked(flume, n);
  leaveCinematic();
}

interface Watched {
  reset: number;
  bitNode: number;
  /** All Source-File levels, as `JSON.stringify` of the map: only a destroy changes them. */
  sourceFiles: string;
  /** The level of the current BitNode's own Source-File. */
  ownLevel: number;
  daemon: unknown;
}
let watched: Watched | null = null;

function snapshot(): Watched {
  return {
    reset: Player.lastNodeReset,
    bitNode: Player.bitNodeN,
    sourceFiles: JSON.stringify([...Player.sourceFiles]),
    ownLevel: Player.sourceFileLvl(Player.bitNodeN),
    daemon: GetServer(SpecialServers.WorldDaemon),
  };
}

/**
 * Watches for the game entering a BitNode, however it happened (a Singularity call, the BitVerse portal, b1t_flum3).
 * - **That it happened:** every entry stamps `Player.lastNodeReset` with the current time (prestigeSourceFile), and a
 *   destroy changes the Source-Files. Only two flumes into the same BitNode in one virtual ms would go unseen.
 * - **Destroy or flume:** a destroy gives the left BitNode's Source-File a level (RedPill.tsx giveSourceFile), unless
 *   it was already at its cap (3; SF12 has none). At the cap the two leave the same state, and only then does this
 *   fall back on w0r1d_d43m0n: every destroy backdoors it first. The entry replaces every server, so the previous one
 *   is kept to look at.
 * The first call only takes a baseline.
 */
export function bitNodeEntry(): { from: number; to: number; destroyed: boolean } | null {
  const now = snapshot();
  const before = watched;
  watched = now;
  if (
    before === null ||
    (now.reset === before.reset && now.bitNode === before.bitNode && now.sourceFiles === before.sourceFiles)
  ) {
    return null;
  }
  const levelAfter = Player.sourceFileLvl(before.bitNode);
  const capped = before.bitNode !== 12 && before.ownLevel >= 3;
  const backdoored = (before.daemon as { backdoorInstalled?: boolean } | null)?.backdoorInstalled === true;
  const destroyed = levelAfter > before.ownLevel || (capped && backdoored);
  return { from: before.bitNode, to: now.bitNode, destroyed };
}

/** Whether a script with this filename is running (on any server), has recently finished, or neither. */
export function scriptState(filename: string): "running" | "finished" | "unknown" {
  for (const ws of workerScripts.values()) if (ws.name === filename) return "running";
  return recentScripts.some((r) => r.runningScript.filename === filename) ? "finished" : "unknown";
}
/** Sets home's RAM, in GB: a harness edit for test and benchmark scenarios, not something a player can do. */
export function setHomeRam(gb: number) {
  Player.getHomeComputer().maxRam = gb;
}

/** Sets the player's money: a harness edit for test scenarios, not something a player can do. */
export function setMoney(money: number) {
  Player.money = money;
}

/**
 * Makes the player a member of `faction` (the game's own `joinFaction`, which bans its enemies) with this reputation: a
 * harness edit for test scenarios, not something a player can do. An unknown faction throws.
 */
export function joinFactionWithReputation(faction: string, reputation: number) {
  if (!Object.values(FactionName).includes(faction as FactionName)) throw new RangeError(`no faction ${faction}`);
  joinFaction(Factions[faction as FactionName]);
  Factions[faction as FactionName].playerReputation = reputation;
}

/**
 * Gives the player `augmentation`, installed, as if bought and installed in an earlier run: a harness edit for test
 * scenarios, not something a player can do. Unknown or already installed, it throws.
 */
export function giveInstalledAugmentation(augmentation: string) {
  if (!Object.values(AugmentationName).includes(augmentation as AugmentationName)) {
    throw new RangeError(`no augmentation ${augmentation}`);
  }
  if (Player.augmentations.some((owned) => owned.name === augmentation)) {
    throw new RangeError(`${augmentation} is installed already`);
  }
  Player.augmentations.push(new PlayerOwnedAugmentation(augmentation as AugmentationName));
}

/**
 * Queues `augmentation`, unpaid, as if bought and not yet installed: a harness edit for test scenarios (#164), not
 * something a player can do. The game's own `queueAugmentation`, as a purchase calls it (`Faction/FactionHelpers.tsx:119`).
 * Unknown, or owned already (installed or queued; NeuroFlux Governor may be queued again), it throws.
 */
export function queueAugmentation(augmentation: string) {
  if (!Object.values(AugmentationName).includes(augmentation as AugmentationName)) {
    throw new RangeError(`no augmentation ${augmentation}`);
  }
  if (augmentation !== AugmentationName.NeuroFluxGovernor && Player.hasAugmentation(augmentation as AugmentationName)) {
    throw new RangeError(`${augmentation} is owned already`);
  }
  Player.queueAugmentation(augmentation as AugmentationName);
}

/** The page the game's Router is on. */
export function page(): string {
  return Router.page();
}

export function bitNodeMultipliers(n: number, level: number): Record<string, number> {
  return { ...getBitNodeMultipliers(n, level) };
}

let report: (event: GameEvent) => void = () => {};

/** Who hears the game's UI events (page.ts) and arrivals at the BitVerse (router.ts). Call before booting. */
export function setGameEventListener(listener: (event: GameEvent) => void) {
  report = listener;
  captureUi(listener);
}

function afterUiMount() {
  mountRouter((reached) => report({ type: "bitverseReached", ...reached })); // GameRoot's first render
  UIEventEmitter.emit(UIEventType.MainUILoaded); // GameRoot emits this on mount: starts saved scripts and autoexec
  // Autosave would serialise the whole game every virtual minute; the harness takes its own snapshots instead.
  Settings.AutosaveInterval = 0;
  Settings.SuppressAutosaveDisabledWarnings = true;
}

/** The game's own save: gzip bytes, as the Steam build writes them. */
export async function saveBytes() {
  // getSaveData gzips only if CompressionStream exists (SaveDataUtils.ts canUseBinaryFormat); the host provides one.
  const data = await saveObject.getSaveData();
  if (typeof data === "string") throw new Error("The game saved base64 text, not gzip: CompressionStream is missing");
  return data;
}

/**
 * The highest RAM home has had in use, and the most scripts it has run at once, since the game booted: each its own
 * high. Taken as each changes, so a script that starts and exits within one timer counts:
 * - RAM in use changes only through `updateRamUsed` (script starts and kills, `ns.ramOverride`, sharing);
 * - scripts are added and removed only through `workerScripts`' `set` and `delete` (NetscriptWorker.ts:141,
 *   killWorkerScript.ts:126).
 * Both are only observed: the game behaves as before.
 */
const homePeakSoFar = { ramUsed: 0, scripts: 0 };
let scriptsOnHome = 0;
const updateRamUsed = BaseServer.prototype.updateRamUsed;
BaseServer.prototype.updateRamUsed = function (this: BaseServer, ram: number) {
  updateRamUsed.call(this, ram);
  if (this.hostname === SpecialServers.Home) homePeakSoFar.ramUsed = Math.max(homePeakSoFar.ramUsed, this.ramUsed);
};
const addWorkerScript = workerScripts.set.bind(workerScripts);
workerScripts.set = (pid, workerScript) => {
  const isNew = !workerScripts.has(pid);
  addWorkerScript(pid, workerScript);
  if (isNew && workerScript.hostname === SpecialServers.Home) {
    scriptsOnHome += 1;
    homePeakSoFar.scripts = Math.max(homePeakSoFar.scripts, scriptsOnHome);
  }
  return workerScripts;
};
const removeWorkerScript = workerScripts.delete.bind(workerScripts);
workerScripts.delete = (pid) => {
  const workerScript = workerScripts.get(pid);
  const removed = removeWorkerScript(pid);
  if (removed && workerScript?.hostname === SpecialServers.Home) scriptsOnHome -= 1;
  return removed;
};

export function homePeak() {
  return { ...homePeakSoFar };
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

export { routerPages };

/** The game's own save, as JSON text. */
export async function saveJson() {
  return decodeSaveData(await saveObject.getSaveData());
}

export function gameDiagnostics() {
  return {
    tutorialRunning: ITutorial.isRunning,
    autosaveInterval: Settings.AutosaveInterval,
    page: Router.page(),
    focus: Player.focus,
    exploits: [...Player.exploits],
    bitNodeMultipliers: { ...currentNodeMults },
    testEnvironment: CONSTANTS.isInTestEnvironment,
    contracts: GetAllServers()
      .flatMap((server) => server.contracts.map((contract) => `${server.hostname}:${contract.fn}`))
      .sort(),
  };
}

/** Navigates as game code does (`Router.toPage`). Test-only: simple pages, and the BitVerse. */
export function toPage(page: string, flume: boolean) {
  if (page === Page.BitVerse) return Router.toPage(Page.BitVerse, { flume, quick: true });
  if (!isSimplePage(page as Page)) throw new Error(`Not a page diagnostics can open: ${page}`);
  Router.toPage(page as SimplePage);
}

/** `Router.back()`, as the UI's Back buttons call it. Test-only. */
export function routerBack() {
  Router.back();
}

/** How the game imports player-script modules (NetscriptJSEvaluator's hook point, as its Jest tests use). */
export function setScriptImport(doImport: (url: string) => Promise<unknown>) {
  // The host imports the module the game made, so what it resolves with is that module's namespace: a ScriptModule.
  config.doImport = (url: ScriptURL) => doImport(url) as Promise<ScriptModule>;
}

/** As the page script does when it loads (index.tsx:37): the RFA client connects in 2 s, with the settings then. */
export function startRemoteFileApi() {
  setTimeout(newRemoteFileApiConnection, 2000);
}

/** Sets game settings as a player would in the options pages (RemoteAPIPage.tsx, AutoexecInput.tsx). */
export function applyGameSettings(settings: GameSettingsOverride) {
  Object.assign(Settings, settings);
}

function server(host: string) {
  const found = GetServer(host);
  if (!found) throw new Error(`No server named ${host}`);
  return found;
}

export function writeFile(host: string, path: string, content: string) {
  const file = resolveScriptFilePath(path) ?? resolveTextFilePath(path);
  if (!file) throw new Error(`Not a script or text file path: ${path}`);
  server(host).writeToContentFile(file, content);
}

/**
 * The game's own RAM calculator, as `run` and the Remote File API's `calculateRam` call it, with that handler's own
 * errors (MessageHandlers.ts:191-217), plus the calculator's reason for an invalid script (`ramCalculationError`).
 */
export function staticRamUsage(host: string, path: string): number {
  const target = server(host);
  const scriptPath = resolveScriptFilePath(path);
  if (!scriptPath) throw new Error(`File is not a script. Filename: ${path}`);
  const script = target.scripts.get(scriptPath);
  if (!script) throw new Error(`File does not exist. Filename: ${path}`);
  const ramUsage = script.getRamUsage(target.scripts);
  if (!ramUsage) {
    throw new Error(
      `Cannot calculate RAM usage of an invalid script. Filename: ${path}. Reason: ${script.ramCalculationError}`,
    );
  }
  return ramUsage;
}

/** What the terminal's `run` does (Terminal/commands/runScript.ts), returning the outcome instead of printing it. */
export function runScript(host: string, path: string, threads: number, args: ScriptArg[]): RunResult {
  const target = server(host);
  const scriptPath = resolveScriptFilePath(path);
  if (!scriptPath) return { pid: 0, error: `Not a script path: ${path}` };
  // The terminal's own checks and messages.
  if (isLegacyScript(scriptPath)) return { pid: 0, error: "Running .script files is unsupported." };
  if (!isPositiveInteger(threads)) {
    return {
      pid: 0,
      error: "Invalid number of threads specified. Number of threads must be an integer greater than 0",
    };
  }
  const runOptions = { threads, temporary: false, ramOverride: undefined, preventDuplicates: false };
  const result = createRunningScriptInstance(target, scriptPath, runOptions, args);
  if (!result.success) return { pid: 0, error: result.message };
  result.runningScript.threads = threads;
  const pid = startWorkerScript(result.runningScript, target);
  return pid ? { pid } : { pid: 0, error: "Failed to start script" };
}

export function ps(host: string): ProcessInfo[] {
  return [...server(host).runningScriptMap.values()]
    .flatMap((byPid) => [...byPid.values()])
    .map(({ pid, filename, threads, args }) => ({ pid, filename, threads, args }))
    .sort((a, b) => a.pid - b.pid);
}

export function scriptLogs(pid: number): string[] {
  const script =
    workerScripts.get(pid)?.scriptRef ?? recentScripts.find((r) => r.runningScript.pid === pid)?.runningScript;
  if (!script) throw new Error(`No running or recent script with pid ${pid}`);
  // Log lines are strings, except from ns.printRaw/tprintRaw, which log React elements; those don't read as text.
  return script.logs.map((line) => (typeof line === "string" ? line : String(line)));
}

export function killScript(pid: number): boolean {
  return killWorkerScriptByPid(pid);
}

// The typecheck checks this module's exports against EngineApi, the interface our code uses (assertEngineApi checks
// at runtime that none is missing or extra).
null as unknown as typeof import("./entry.ts") satisfies EngineApi;
