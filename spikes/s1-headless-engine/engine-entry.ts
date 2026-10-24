// Entry module bundled together with the game engine. Exposes just enough for run.mjs to boot a new game,
// start an NS script and read state. Globals (DOM, clock, RNG) must be installed before this module loads.
import { Engine } from "../../vendor/bitburner-src/src/engine";
import { Router } from "../../vendor/bitburner-src/src/ui/GameRoot";
import { Page } from "../../vendor/bitburner-src/src/ui/Router";
import { UIEventEmitter, UIEventType } from "../../vendor/bitburner-src/src/ui/UIEventEmitter";
import { Player } from "../../vendor/bitburner-src/src/Player";
import { iTutorialEnd } from "../../vendor/bitburner-src/src/InteractiveTutorial";
import { Settings } from "../../vendor/bitburner-src/src/Settings/Settings";
import { config } from "../../vendor/bitburner-src/src/NetscriptJSEvaluator";
import { startWorkerScript } from "../../vendor/bitburner-src/src/NetscriptWorker";
import { workerScripts } from "../../vendor/bitburner-src/src/Netscript/WorkerScripts";
import { RunningScript } from "../../vendor/bitburner-src/src/Script/RunningScript";
import { GetServerOrThrow, saveAllServers } from "../../vendor/bitburner-src/src/Server/AllServers";
import { getFactionsSave } from "../../vendor/bitburner-src/src/Faction/Factions";
import { saveObject } from "../../vendor/bitburner-src/src/SaveObject";
import type { SaveData } from "../../vendor/bitburner-src/src/types";
import type { ScriptFilePath } from "../../vendor/bitburner-src/src/Paths/ScriptFilePath";
type ScriptArg = string | number | boolean;

/** In the webpack build lodash sees an AMD `define` and also sets the global `_`; player scripts rely on it. */
export { default as lodash } from "lodash";

/** Replaces the UI router (normally installed by the GameRoot React component). */
function installHeadlessRouter(): void {
  let page = Page.Terminal;
  Router.page = () => page;
  Router.allowRouting = () => {};
  Router.hidingMessages = () => true;
  Router.toPage = (p: Page) => {
    page = p;
  };
  Router.back = () => {};
}

/** Boots through the game's own Engine.load: a new game when saveData is undefined, otherwise the real
 *  load path (migration, offline progress, restarting saved scripts). */
export async function boot(doImport: (typeof config)["doImport"], saveData?: Uint8Array): Promise<void> {
  installHeadlessRouter();
  config.doImport = doImport;
  await Engine.load(saveData as SaveData | undefined);
  // GameRoot emits this once the main UI mounts; it starts the saved scripts and autoexec.
  UIEventEmitter.emit(UIEventType.MainUILoaded);
  // IndexedDB autosave isn't available headless; the harness takes its own snapshots.
  // Set after load, because loading a save replaces Settings.
  Settings.AutosaveInterval = 0;
  Settings.SuppressAutosaveDisabledWarnings = true;
}

/** The game's own save serialisation (gzip bytes, same format as a Steam .json.gz save). */
export async function saveBytes(): Promise<Uint8Array> {
  return (await saveObject.getSaveData()) as Uint8Array;
}

/** What the tutorial's "Skip" button calls. A new game starts the tutorial, and while it runs finished
 *  scripts are never cleaned up (killWorkerScript returns early), so their RAM is never freed. */
export function skipTutorial(): void {
  iTutorialEnd();
}

export function writeScript(hostname: string, filename: string, code: string): void {
  GetServerOrThrow(hostname).writeToScriptFile(filename as ScriptFilePath, code);
}

export function runScript(hostname: string, filename: string, code: string, threads: number): number {
  writeScript(hostname, filename, code);
  return runScriptWithArgs(hostname, filename, threads, []);
}

export function runScriptWithArgs(hostname: string, filename: string, threads: number, args: ScriptArg[]): number {
  const server = GetServerOrThrow(hostname);
  const script = server.scripts.get(filename as ScriptFilePath);
  if (!script) throw new Error(`no script ${filename}`);
  const ram = script.getRamUsage(server.scripts);
  if (!ram) throw new Error(`cannot compute RAM for ${filename}`);
  const rs = new RunningScript(script, ram, args);
  rs.threads = threads as RunningScript["threads"];
  return startWorkerScript(rs, server);
}

export function listScripts() {
  return [...workerScripts.values()].map((ws) => ({
    pid: ws.pid,
    file: ws.name,
    started: ws.env.runningFn,
    delay: ws.delay !== null,
    logs: ws.scriptRef.logs.slice(-2).map(String),
  }));
}

export function setHomeRam(gb: number): void {
  Player.getHomeComputer().maxRam = gb;
}

export function scriptLogs(pid: number): string[] {
  return workerScripts.get(pid)?.scriptRef.logs.map(String) ?? [];
}

export function summary() {
  const n00dles = GetServerOrThrow("n00dles");
  return {
    playtimeMs: Player.totalPlaytime,
    money: Player.money,
    hacking: Player.skills.hacking,
    hackingExp: Player.exp.hacking,
    n00dles: { money: n00dles.moneyAvailable, security: n00dles.hackDifficulty },
    scripts: workerScripts.size,
    homeUsedRam: Player.getHomeComputer().ramUsed,
  };
}

/** Deterministic dump of the main mutable game state, for replay comparison. */
export function stateDump(): string {
  return JSON.stringify({ player: Player, servers: saveAllServers(), factions: getFactionsSave() });
}
