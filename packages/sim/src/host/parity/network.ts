/**
 * The simulator is offline: network I/O would make runs depend on the outside world. `fetch` (which `ns.wget` uses,
 * NetscriptFunctions.ts) fails as a browser's does with no connection. The other ways a script could reach the
 * network refuse outright. Node provides `fetch` and `WebSocket` and jsdom `XMLHttpRequest`, so all are replaced, on
 * the global object and on `window`. Call once, before the engine loads.
 */
export function goOffline(): void {
  const offline = {
    fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    XMLHttpRequest: refuse("XMLHttpRequest"),
    WebSocket: refuse("WebSocket"),
    EventSource: refuse("EventSource"),
  };
  Object.assign(globalThis, offline);
  Object.assign(window, offline);
}

function refuse(name: string) {
  return class {
    constructor() {
      throw new TypeError(`${name}: the simulator has no network`);
    }
  };
}
