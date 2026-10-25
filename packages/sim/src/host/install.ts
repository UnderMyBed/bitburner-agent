import type { EngineApi } from "../engine/api.ts";
import type { HostOptions } from "../protocol.ts";
import { installClock, type VirtualClock } from "./clock.ts";
import { installDom } from "./dom.ts";
import { captureConsole, captureDownloads } from "./events.ts";
import { loadEngine } from "./load-engine.ts";
import { pinDefaultLocale } from "./parity/locale.ts";
import { installIndexedDb } from "./parity/storage.ts";
import { installSeededRandom } from "./random.ts";
import { installScriptModules, type ScriptLoader } from "./scripts.ts";

/**
 * Sets up a simulation process in the only safe order. The browser environment (with storage, and download and
 * console capture), a pinned default locale, seeded randomness, script-module loading and the virtual clock must all
 * be in place before the engine loads, because its modules read them at load time (e.g. `Engine._lastUpdate` reads
 * Date). Call once per process.
 */
export function installHost({ seed, epochMs, testHooks }: HostOptions): {
  clock: VirtualClock;
  engine: EngineApi;
  scripts: ScriptLoader;
} {
  captureConsole();
  const { window } = installDom();
  const browser = window as unknown as Window & typeof globalThis;
  installIndexedDb(browser);
  captureDownloads(browser);
  pinDefaultLocale("en-US");
  installSeededRandom(seed);
  const scripts = installScriptModules(testHooks);
  const clock = installClock(epochMs, scripts.whenQuiescent);
  const engine = loadEngine();
  engine.setScriptImport(scripts.doImport);
  return { clock, engine, scripts };
}
