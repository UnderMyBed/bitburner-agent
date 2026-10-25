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
 * (build/cjs/lib/scheduling.js), and would fall back to `setTimeout`, the virtual clock, once Node's globals are hidden
 * from scripts (node-globals.ts). That would leave the game's save waiting for virtual time. It gets the real one.
 */
function scheduleOnRealTime(): void {
  const scheduling = require(path.join(path.dirname(require.resolve("fake-indexeddb")), "lib/scheduling.js")) as {
    queueTask: (fn: () => void) => void;
  };
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
