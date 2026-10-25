// Node's own globals, which a browser has none of, hidden from the game and player scripts (parity audit 4.14). A
// script could otherwise reach the file system through `process.getBuiltinModule`, read real time, or branch on
// `typeof process` and act differently than on Steam; and the game's libraries would take their Node paths.
//
// Host code imports `process` and `Buffer` from `node:` modules instead. Node's own internals still find them (by who's
// asking), and fake-indexeddb schedules on the real setImmediate (storage.ts).

/** The globals hidden: Node's, none of which a browser has. */
export const NODE_GLOBALS = ["process", "Buffer", "global", "setImmediate", "clearImmediate"] as const;

/**
 * Whether the code reading a global is Node's own: its bundled undici, behind `Response`, `fetch` and friends, reads
 * the global `Buffer` at call time (e.g. `readAllBytes`, when the game collects a compressed save through `Response`).
 * The caller is the stack frame after the accessor's.
 */
function calledByNode(): boolean {
  const caller = new Error().stack?.split("\n")[3] ?? "";
  return /\(node:|at node:/.test(caller);
}

/**
 * Removes Node's globals from the global object and from jsdom's window. Call before the engine loads, so its
 * libraries see what they would in a browser (e.g. convert-source-map picks `atob` over `Buffer` when it loads).
 *
 * `setImmediate` and `clearImmediate` then follow the window's. The game installs a polyfill there when it loads
 * (jszip's, bundled with the Terminal's `download` command), since browsers have none, and in a browser the window is
 * the global object, so scripts see it bare too. It schedules through `window.postMessage`, a real task, as in a
 * browser (dom.ts). Until then they're undefined, as in a browser. jsdom's own task queue uses the bare name too.
 */
export function hideNodeGlobals(window: object): void {
  const globals = globalThis as Record<string, unknown>;
  const browser = window as Record<string, unknown>;
  const real = { process: globals.process, Buffer: globals.Buffer, global: globals.global };
  for (const target of [globals, browser]) {
    for (const name of NODE_GLOBALS) delete target[name];
  }
  // Node's internals still find theirs; the game, its libraries and scripts don't.
  for (const [name, value] of Object.entries(real)) {
    Object.defineProperty(globals, name, { configurable: true, get: () => (calledByNode() ? value : undefined) });
  }
  for (const name of ["setImmediate", "clearImmediate"]) {
    Object.defineProperty(globals, name, { configurable: true, get: () => browser[name] });
  }
}
