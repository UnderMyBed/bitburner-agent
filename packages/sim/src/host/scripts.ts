// Player scripts are ES modules the game imports from `blob:` URLs, which Node can't import. The host captures each
// script's source when the game makes its Blob, hands out short in-memory `blob:sim/<n>` URLs, and serves them
// through a synchronous module hook, which is what the browser does with real Blob URLs. (data: URLs, as in the
// game's Jest setup, would nest each child module's encoded source inside every module that imports it.)
import { registerHooks } from "node:module";
import type { TestHooks } from "../protocol.ts";
import { realTimers } from "./clock.ts";

const SCHEME = "blob:sim/";

export interface ScriptLoader {
  /** What the game's `config.doImport` should be: imports a script module, counted for the barrier. */
  doImport(url: string): Promise<unknown>;
  /**
   * Runs `fn` on a real macrotask once no script module is being imported. The virtual clock yields through this
   * between timers, so virtual time never moves while a script is still compiling: script start times can't depend
   * on how long a real import takes.
   */
  whenQuiescent(fn: () => void): void;
}

export function installScriptModules(testHooks: TestHooks = {}): ScriptLoader {
  const sources = new WeakMap<Blob, string>();
  const modules = new Map<string, string>();
  let nextModule = 0;

  // The game makes script Blobs as `new Blob([code], { type: "text/javascript" })` (NetscriptJSEvaluator.ts).
  const NativeBlob = globalThis.Blob;
  globalThis.Blob = class extends NativeBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      const [code] = parts ?? [];
      if (options?.type === "text/javascript" && parts?.length === 1 && typeof code === "string") {
        sources.set(this, code);
      }
    }
  };
  // Other Blobs (e.g. a save export) keep Node's own object URLs.
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    const code = sources.get(blob);
    if (code === undefined) return createObjectURL(blob);
    const url = `${SCHEME}${++nextModule}`;
    modules.set(url, code);
    return url;
  };
  // The game revokes a script's URL right after calling import() on it (NetscriptJSEvaluator.ts), relying on browser
  // semantics: an import already started keeps its source. So an import pins its URL from the moment it's requested,
  // and a revoke takes effect only once no import of that URL is in progress.
  const importing = new Map<string, number>();
  const revoked = new Set<string>();
  URL.revokeObjectURL = (url: string) => {
    if (!url.startsWith(SCHEME)) revokeObjectURL(url);
    else if (importing.has(url)) revoked.add(url);
    else modules.delete(url);
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(SCHEME)) return { url: specifier, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(SCHEME)) return nextLoad(url, context);
      const source = modules.get(url);
      if (source === undefined) throw new Error(`Unknown or revoked script module ${url}`);
      return { format: "module", source, shortCircuit: true };
    },
  });

  let inFlight = 0;
  let waiting: (() => void)[] = [];
  let imports = 0;
  const [minDelay, maxDelay] = testHooks.importDelayMs ?? [0, 0];
  return {
    async doImport(url) {
      inFlight++;
      importing.set(url, (importing.get(url) ?? 0) + 1);
      try {
        if (maxDelay > 0) {
          // Test hook: a real (not virtual) delay that varies per import, as slow disks or busy machines would.
          const delay = minDelay + ((imports++ * 7) % (maxDelay - minDelay + 1));
          await new Promise((resolve) => realTimers.setTimeout(resolve, delay));
        }
        return await import(url);
      } finally {
        const remaining = (importing.get(url) ?? 1) - 1;
        if (remaining > 0) importing.set(url, remaining);
        else {
          importing.delete(url);
          if (revoked.delete(url)) modules.delete(url);
        }
        if (--inFlight === 0) {
          const ready = waiting;
          waiting = [];
          for (const run of ready) run();
        }
      }
    },
    whenQuiescent(fn) {
      // Check on the macrotask itself, not when scheduling it: a module that just finished loading runs its code in
      // the microtasks before that, and may start another import (e.g. a script whose main() execs a worker).
      const check = () => {
        if (inFlight === 0 || testHooks.disableImportBarrier) fn();
        else waiting.push(() => realTimers.setImmediate(check));
      };
      realTimers.setImmediate(check);
    },
  };
}
