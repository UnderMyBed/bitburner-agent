// Bundled together with the game's source into dist/engine.cjs. Not typechecked by the repo's tsc: it imports the
// game, which builds under its own TypeScript setup. Keep it minimal; its exports must match EngineApi (../api.ts).
import { getBitNodeLevel } from "../../../../../vendor/bitburner-src/src/BitNode/BitNodeUtils";
import { CONSTANTS } from "../../../../../vendor/bitburner-src/src/Constants";
import { Engine } from "../../../../../vendor/bitburner-src/src/engine";
import { ITutorial, iTutorialEnd } from "../../../../../vendor/bitburner-src/src/InteractiveTutorial";
import { killWorkerScriptByPid } from "../../../../../vendor/bitburner-src/src/Netscript/killWorkerScript";
import { recentScripts } from "../../../../../vendor/bitburner-src/src/Netscript/RecentScripts";
import { workerScripts } from "../../../../../vendor/bitburner-src/src/Netscript/WorkerScripts";
import { config } from "../../../../../vendor/bitburner-src/src/NetscriptJSEvaluator";
import {
  createRunningScriptInstance,
  startWorkerScript,
} from "../../../../../vendor/bitburner-src/src/NetscriptWorker";
import { resolveScriptFilePath } from "../../../../../vendor/bitburner-src/src/Paths/ScriptFilePath";
import { resolveTextFilePath } from "../../../../../vendor/bitburner-src/src/Paths/TextFilePath";
import { Player } from "../../../../../vendor/bitburner-src/src/Player";
import { saveObject } from "../../../../../vendor/bitburner-src/src/SaveObject";
import { GetAllServers, GetServer } from "../../../../../vendor/bitburner-src/src/Server/AllServers";
import { Settings } from "../../../../../vendor/bitburner-src/src/Settings/Settings";
import { UIEventEmitter, UIEventType } from "../../../../../vendor/bitburner-src/src/ui/UIEventEmitter";
import { commitHash } from "../../../../../vendor/bitburner-src/src/utils/helpers/commitHash";
import { decodeSaveData } from "../../../../../vendor/bitburner-src/src/utils/SaveDataUtils";
import type { ProcessInfo, RunResult, ScriptArg, Tutorial } from "../../protocol.ts";

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

/** How the game imports player-script modules (NetscriptJSEvaluator's hook point, as its Jest tests use). */
export function setScriptImport(doImport: (url: string) => Promise<unknown>) {
  config.doImport = doImport;
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

/** What the terminal's `run` does (Terminal/commands/runScript.ts), returning the outcome instead of printing it. */
export function runScript(host: string, path: string, threads: number, args: ScriptArg[]): RunResult {
  const target = server(host);
  const scriptPath = resolveScriptFilePath(path);
  if (!scriptPath) return { pid: 0, error: `Not a script path: ${path}` };
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
  return script.logs.map((line) => (typeof line === "string" ? line : String(line)));
}

export function killScript(pid: number): boolean {
  return killWorkerScriptByPid(pid);
}
