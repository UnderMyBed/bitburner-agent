import { JSDOM } from "jsdom";

/**
 * Installs a jsdom window as the browser globals the engine expects at import time. Must run before the engine
 * bundle loads. Includes the two patches from the game's own FixJSDOMEnvironment.ts.
 */
export function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://bitburner.local/",
    pretendToBeVisual: true,
  });
  const window = dom.window as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis || key.startsWith("_")) continue;
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
  }
  for (const key of ["window", "document", "navigator"]) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
  }

  const document = dom.window.document as unknown as { adoptedStyleSheets?: unknown[] };
  if (!Array.isArray(document.adoptedStyleSheets)) document.adoptedStyleSheets = [];
  dom.window.CSSStyleSheet.prototype.replaceSync = () => {};
  return dom;
}
