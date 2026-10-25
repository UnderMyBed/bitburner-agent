// The game keeps its save in IndexedDB (src/db.ts, through `window.indexedDB`), which Node and jsdom lack. An
// in-memory implementation stands in, on both the global and jsdom's window.
import { createRequire } from "node:module";
import path from "node:path";
import { realTimers } from "../clock.ts";

const require = createRequire(import.meta.url);
// The CommonJS build: its modules call the scheduler through its exports object, so it can be pointed elsewhere.
const { IDBKeyRange, indexedDB } = require("fake-indexeddb") as typeof import("fake-indexeddb");

/**
 * fake-indexeddb runs each transaction step on `globalThis.setImmediate`, looked up at call time
 * (build/cjs/lib/scheduling.js, pinned at 6.2.5). Once Node's globals are hidden (node-globals.ts) that's undefined
 * until the engine loads, which would leave IndexedDB on `setTimeout`, the virtual clock, and then the game's
 * polyfill, which a script could replace. It gets the real one. If an upgrade moves `queueTask`, this throws; if it
 * stops using it, the saves tests time out.
 */
function scheduleOnRealTime(): void {
  const scheduling = require(path.join(path.dirname(require.resolve("fake-indexeddb")), "lib/scheduling.js")) as {
    queueTask: (fn: () => void) => void;
  };
  if (typeof scheduling.queueTask !== "function")
    throw new Error("fake-indexeddb no longer has lib/scheduling.js queueTask");
  scheduling.queueTask = (fn) => {
    realTimers.setImmediate(fn);
  };
}

export function installIndexedDb(window: Window & typeof globalThis): void {
  scheduleOnRealTime();
  for (const target of [globalThis, window] as Record<string, unknown>[]) {
    Object.defineProperty(target, "indexedDB", { configurable: true, writable: true, value: indexedDB });
    Object.defineProperty(target, "IDBKeyRange", { configurable: true, writable: true, value: IDBKeyRange });
  }
}
