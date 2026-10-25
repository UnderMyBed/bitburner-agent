// The game keeps its save in IndexedDB (src/db.ts, through `window.indexedDB`), which Node and jsdom lack. An
// in-memory implementation stands in, on both the global and jsdom's window.
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

export function installIndexedDb(window: Window & typeof globalThis): void {
  for (const target of [globalThis, window] as Record<string, unknown>[]) {
    Object.defineProperty(target, "indexedDB", { configurable: true, writable: true, value: indexedDB });
    Object.defineProperty(target, "IDBKeyRange", { configurable: true, writable: true, value: IDBKeyRange });
  }
}
