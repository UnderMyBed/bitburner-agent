import type { EngineApi } from "../engine/api.ts";
import type { HostOptions } from "../protocol.ts";
import { installClock, type VirtualClock } from "./clock.ts";
import { installDom } from "./dom.ts";
import { captureConsole, captureDownloads, gameEvent, markClockReady } from "./events.ts";
import { loadEngine } from "./load-engine.ts";
import { installSyncCompression } from "./parity/compression.ts";
import { installMachineIndependentStacks, installUncaughtErrors } from "./parity/errors.ts";
import { pinDefaultLocale } from "./parity/locale.ts";
import { installNetwork, type SimulatedNetwork } from "./parity/network.ts";
import { hideNodeGlobals } from "./parity/node-globals.ts";
import { installIndexedDb } from "./parity/storage.ts";
import { promptAnswerer } from "./prompts.ts";
import { installSeededRandom } from "./random.ts";
import { installScriptModules, type ScriptLoader } from "./scripts.ts";

/**
 * Sets up a simulation process in the only safe order. The browser environment (with storage, uncaught errors handled
 * as a browser does, and download and console capture), a pinned default locale, seeded randomness, script-module
 * loading, the virtual clock and the network (cut off, apart from sockets to the parent) must all be in place before
 * the engine loads, because its modules read them at load time (e.g. `Engine._lastUpdate` reads Date). Call once per
 * process.
 */
export function installHost({ seed, epochMs, prompts, network, testHooks }: HostOptions): {
  clock: VirtualClock;
  engine: EngineApi;
  scripts: ScriptLoader;
  network: SimulatedNetwork;
  /** Sets what runs after every timer the clock fires, once its microtasks have run: e.g. the BitNode-entry watch. */
  afterEveryTimer(run: () => void): void;
} {
  installMachineIndependentStacks();
  captureConsole();
  const { window } = installDom();
  const browser = window as unknown as Window & typeof globalThis;
  installIndexedDb(browser);
  installSyncCompression();
  installUncaughtErrors();
  captureDownloads(browser);
  pinDefaultLocale("en-US");
  installSeededRandom(seed);
  const scripts = installScriptModules(testHooks);
  let afterTimer = () => {};
  const clock = installClock(epochMs, (continueTick) =>
    // Once nothing is importing, the timer's microtasks have run too (a script's code after an `await`).
    scripts.whenQuiescent(() => {
      afterTimer();
      continueTick();
    }),
  );
  markClockReady();
  // Sockets run on the virtual clock, so the network comes after it.
  const simulatedNetwork = installNetwork(clock, network?.listenUrls ?? []);
  // Before the engine loads, so its libraries see no Node and take their browser paths, as on Steam (e.g.
  // convert-source-map picks atob over Buffer when it loads). That also keeps a test runner's JEST_WORKER_ID from the
  // game (Constants.ts isInTestEnvironment reads `globalThis.process?.env`). Host code has its own references, taken
  // when its modules loaded (`node:` imports, `realTimers`).
  hideNodeGlobals(window);
  const engine = loadEngine();
  engine.installPageGlobals();
  engine.setScriptImport(scripts.doImport);
  engine.setGameEventListener(gameEvent);
  engine.setPromptAnswerer(promptAnswerer(prompts));
  // As the page script does when it loads (index.tsx:37): the RFA client connects 2 s later, with the settings then.
  engine.startRemoteFileApi();
  return {
    clock,
    engine,
    scripts,
    network: simulatedNetwork,
    afterEveryTimer: (run) => {
      afterTimer = run;
    },
  };
}
