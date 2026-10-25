import type { EngineApi } from "../engine/api.ts";
import type { HostOptions } from "../protocol.ts";
import { installClock, type VirtualClock } from "./clock.ts";
import { installDom } from "./dom.ts";
import { captureConsole, captureDownloads, gameEvent, markClockReady } from "./events.ts";
import { loadEngine } from "./load-engine.ts";
import { installSyncCompression } from "./parity/compression.ts";
import { installMachineIndependentStacks, installUncaughtErrors } from "./parity/errors.ts";
import { pinDefaultLocale } from "./parity/locale.ts";
import { goOffline } from "./parity/network.ts";
import { installIndexedDb } from "./parity/storage.ts";
import { promptAnswerer } from "./prompts.ts";
import { installSeededRandom } from "./random.ts";
import { installScriptModules, type ScriptLoader } from "./scripts.ts";

/**
 * Sets up a simulation process in the only safe order. The browser environment (with storage, the network cut off,
 * uncaught errors handled as a browser does, and download and console capture), a pinned default locale, seeded
 * randomness, script-module loading and the virtual clock must all be in place before the engine loads, because its
 * modules read them at load time (e.g. `Engine._lastUpdate` reads Date). Call once per process.
 */
export function installHost({ seed, epochMs, prompts, testHooks }: HostOptions): {
  clock: VirtualClock;
  engine: EngineApi;
  scripts: ScriptLoader;
  /** Sets what runs after every timer the clock fires (before the import barrier), e.g. the BitNode-entry watch. */
  afterEveryTimer(run: () => void): void;
} {
  installMachineIndependentStacks();
  captureConsole();
  const { window } = installDom();
  const browser = window as unknown as Window & typeof globalThis;
  installIndexedDb(browser);
  installSyncCompression();
  goOffline();
  installUncaughtErrors();
  captureDownloads(browser);
  pinDefaultLocale("en-US");
  installSeededRandom(seed);
  const scripts = installScriptModules(testHooks);
  let afterTimer = () => {};
  const clock = installClock(epochMs, (continueTick) => {
    afterTimer();
    scripts.whenQuiescent(continueTick);
  });
  markClockReady();
  // There is no `process` in a browser. The game reads this one while loading (Constants.ts isInTestEnvironment), and
  // it would change game behaviour; a test runner may have set it for this process.
  delete process.env.JEST_WORKER_ID;
  const engine = loadEngine();
  engine.installPageGlobals();
  engine.setScriptImport(scripts.doImport);
  engine.setGameEventListener(gameEvent);
  engine.setPromptAnswerer(promptAnswerer(prompts));
  return {
    clock,
    engine,
    scripts,
    afterEveryTimer: (run) => {
      afterTimer = run;
    },
  };
}
