import { JSDOM } from "jsdom";
import { realTimers } from "./clock.ts";

/** Browser APIs the game uses through `window.` as well as bare: they must resolve to the same (virtual) objects. */
/**
 * A fixed user agent, like the Steam (Electron) build's. The game hashes `navigator.userAgent` into the saved
 * `Player.identifier`, and jsdom's default includes the host OS, so a default UA would make saves differ by machine.
 */
export const STEAM_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) bitburner/3.0.1 Chrome/146.0.0.0 Electron/41.4.0 Safari/537.36";

const SHARED_WITH_GLOBAL = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
  "performance",
  "crypto",
];

/**
 * `window.postMessage` as a browser has it, for messages to the page itself. jsdom's leaves the event's `source` and
 * `origin` unset (browser/Window.js), and the game's setImmediate polyfill (jszip's) ignores messages whose `source`
 * isn't the window, so its callbacks would never run. The message is delivered on a later real task, as in a browser.
 */
function installPostMessage(window: Window & typeof globalThis): void {
  window.postMessage = function postMessage(...args: unknown[]) {
    if (args.length < 2) throw new TypeError("'postMessage' requires 2 arguments: 'message' and 'targetOrigin'");
    const [message, targetOrigin] = args;
    const origin = window.location.origin;
    if (targetOrigin !== "*" && targetOrigin !== "/" && new URL(String(targetOrigin)).origin !== origin) return;
    realTimers.setImmediate(() => {
      window.dispatchEvent(new window.MessageEvent("message", { data: message, origin, source: window }));
    });
  } as typeof window.postMessage;
}

/**
 * Installs a jsdom window as the browser globals the engine expects at import time. Must run before the engine
 * bundle loads. Includes the two patches from the game's own FixJSDOMEnvironment.ts.
 */
export function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    // Any http(s) origin works; it gives jsdom a working localStorage. No query string, so the game's
    // `?noScripts` check (NetscriptWorker.ts) stays off.
    url: "https://bitburner.local/",
    // jsdom's way to set navigator.userAgent. The page has no subresources, so nothing is ever fetched.
    resources: { userAgent: STEAM_USER_AGENT },
  });
  const window = dom.window as unknown as Record<string, unknown>;

  // Copy jsdom's globals that Node lacks. Where Node already has a standard API (Blob, URL, Event, crypto,
  // performance…) Node's is kept: it behaves as the browser's does, and the harness patches these objects later.
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis || key.startsWith("_")) continue;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
  }
  // Always jsdom's: Node 25+ defines its own localStorage, and the browser objects must be jsdom's.
  for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage"]) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
  }

  // The game calls `window.setTimeout` (engine loop, ns.sleep) as well as bare `setTimeout`. Make window's timers,
  // Date, performance and crypto follow the globals at call time, so the virtual clock and seeded randomness
  // installed later cover both access paths.
  for (const key of SHARED_WITH_GLOBAL) {
    Object.defineProperty(window, key, {
      configurable: true,
      get: () => (globalThis as Record<string, unknown>)[key],
      set: (value: unknown) => {
        (globalThis as Record<string, unknown>)[key] = value;
      },
    });
  }
  // Animation frames on the global timers too (jsdom's own run on real time). ~60 fps, like a browser.
  window.requestAnimationFrame = (callback: (time: number) => void) =>
    setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle);
  globalThis.requestAnimationFrame = window.requestAnimationFrame as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame as typeof cancelAnimationFrame;

  installPostMessage(dom.window as unknown as Window & typeof globalThis);

  const document = dom.window.document as unknown as { adoptedStyleSheets?: unknown[] };
  if (!Array.isArray(document.adoptedStyleSheets)) document.adoptedStyleSheets = [];
  dom.window.CSSStyleSheet.prototype.replaceSync = () => {};
  return dom;
}
