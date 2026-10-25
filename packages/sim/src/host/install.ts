import type { EngineApi } from "../engine/api.ts";
import { installClock, type VirtualClock } from "./clock.ts";
import { installDom } from "./dom.ts";
import { loadEngine } from "./load-engine.ts";
import { installSeededRandom } from "./random.ts";

export interface HostOptions {
  seed: number;
  epochMs: number;
}

/**
 * Sets up a simulation process in the only safe order: the browser environment, seeded randomness and the virtual
 * clock must all be in place before the engine loads, because its modules read them at load time (e.g.
 * `Engine._lastUpdate` reads Date). Call once per process.
 */
export function installHost({ seed, epochMs }: HostOptions): { clock: VirtualClock; engine: EngineApi } {
  installDom();
  installSeededRandom(seed);
  const clock = installClock(epochMs);
  const engine = loadEngine();
  return { clock, engine };
}
