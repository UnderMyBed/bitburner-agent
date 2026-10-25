// Player scripts are ES modules the game imports from `blob:` URLs, which Node can't import. The host captures each
// script's source when the game makes its Blob, hands out short in-memory `blob:sim/<n>` URLs, and serves them
// through a synchronous module hook, which is what the browser does with real Blob URLs. (data: URLs, as in the
// game's Jest setup, would nest each child module's encoded source inside every module that imports it.)
import { writeSync } from "node:fs";
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
  /** URL → number of imports of it in progress. Empty exactly when nothing is being imported. */
  const importing = new Map<string, number>();
  const revokeWhenDone = new Set<string>();
  URL.revokeObjectURL = (url: string) => {
    if (!url.startsWith(SCHEME)) revokeObjectURL(url);
    else if (importing.has(url)) revokeWhenDone.add(url);
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

  let onQuiescent: (() => void)[] = [];
  let previousImport: Promise<unknown> = Promise.resolve();
  const slowDown = testDelay(testHooks.importDelayMs);
  const timeoutMs = testHooks.importTimeoutMs ?? IMPORT_TIMEOUT_MS;
  return {
    async doImport(url) {
      importing.set(url, (importing.get(url) ?? 0) + 1);
      // While an import is in progress the barrier holds virtual time. A module whose top-level code awaits a timer
      // could therefore never finish (in a browser real time would pass). Fail loudly rather than hang.
      const watchdog = realTimers.setTimeout(() => {
        writeSync(
          2,
          `Script module ${url} has not loaded after ${timeoutMs} ms of real time. If its top-level code awaits a timer, it can't load while the import barrier holds virtual time.\n`,
        );
        process.exit(70);
      }, timeoutMs);
      // Imports settle in the order they were requested, whatever their real durations: when two scripts start in
      // the same instant, the first one asked for runs its main() first (and so takes the first random draws).
      const loading = slowDown().then(() => import(url));
      loading.catch(() => {}); // a failure is reported through `settled`, in its turn
      const settled = previousImport.then(
        () => loading,
        () => loading,
      );
      previousImport = settled.catch(() => {});
      try {
        return await settled;
      } finally {
        realTimers.clearTimeout(watchdog);
        const remaining = (importing.get(url) ?? 1) - 1;
        if (remaining > 0) importing.set(url, remaining);
        else {
          importing.delete(url);
          if (revokeWhenDone.delete(url)) modules.delete(url);
        }
        if (importing.size === 0) {
          const ready = onQuiescent;
          onQuiescent = [];
          for (const run of ready) run();
        }
      }
    },
    whenQuiescent(fn) {
      // Check on the macrotask itself, not when scheduling it: a module that just finished loading runs its code in
      // the microtasks before that, and may start another import (e.g. a script whose main() execs a worker).
      const check = () => {
        if (importing.size === 0 || testHooks.disableImportBarrier) fn();
        else onQuiescent.push(() => realTimers.setImmediate(check));
      };
      realTimers.setImmediate(check);
    },
  };
}

/** Real time an import may take before the host gives up. Generous: real imports take milliseconds. */
const IMPORT_TIMEOUT_MS = 30_000;

/**
 * Test hook: a real (not virtual) delay before each import, as a slow disk or busy machine would cause. It varies
 * over [min, max] in a fixed pattern (stepping by 17 ms, wrapping: e.g. 20, 37, 23, 40…), so a later import can
 * finish before an earlier one, and it never draws on the seeded randomness.
 */
function testDelay(range: [number, number] | undefined): () => Promise<void> {
  if (!range || range[1] === 0) return async () => {};
  const [min, max] = range;
  let count = 0;
  return () => new Promise((resolve) => realTimers.setTimeout(resolve, min + ((count++ * 17) % (max - min + 1))));
}
