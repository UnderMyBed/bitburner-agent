// Node's own globals, which a browser has none of, removed before the engine loads (parity audit 4.14). A script could
// otherwise reach the file system through `process.getBuiltinModule`, read real time, or branch on `typeof process`
// and act differently than on Steam; and the game's libraries would take their Node paths.
//
// Host code imports `process` and `Buffer` from `node:` modules instead, and Node's internals get `process` from
// their module wrapper. What still read the globals: Node's bundled undici, behind `Response` and friends (handled
// here), and fake-indexeddb's scheduler (storage.ts).

/** The globals removed: Node's, none of which a browser has. */
export const NODE_GLOBALS = ["process", "Buffer", "global", "setImmediate", "clearImmediate"] as const;

/** A body read whole from its stream, as a browser does: undici's own reader uses the global `Buffer`. */
async function readBody(message: Request | Response): Promise<Uint8Array<ArrayBuffer>> {
  if (message.bodyUsed) throw new TypeError("Body is unusable: Body has already been read");
  if (!message.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = message.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    if (!(read.value instanceof Uint8Array)) throw new TypeError("Received non-Uint8Array chunk");
    chunks.push(read.value);
    length += read.value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * `Response` and `Request` bodies read through their stream. The game collects a compressed save with
 * `new Response(stream).arrayBuffer()` (SaveDataUtils.ts), and undici's `readAllBytes` would read the global `Buffer`.
 * Reaching `Response` here, before `Buffer` goes, also loads undici: Node loads it lazily, reading `Buffer` as it does.
 */
function readBodiesThroughStreams(): void {
  const methods: Record<string, (this: Request | Response) => Promise<unknown>> = {
    async arrayBuffer() {
      return (await readBody(this)).buffer;
    },
    async bytes() {
      return readBody(this);
    },
    async text() {
      return new TextDecoder().decode(await readBody(this));
    },
    async json() {
      return JSON.parse(new TextDecoder().decode(await readBody(this)));
    },
    async blob() {
      return new Blob([await readBody(this)], { type: this.headers.get("content-type") ?? "" });
    },
  };
  for (const prototype of [Response.prototype, Request.prototype]) {
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(prototype, name, { configurable: true, writable: true, value });
    }
  }
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
  readBodiesThroughStreams();
  for (const target of [globals, browser]) {
    for (const name of NODE_GLOBALS) delete target[name];
  }
  for (const name of ["setImmediate", "clearImmediate"]) {
    Object.defineProperty(globals, name, { configurable: true, get: () => browser[name] });
  }
}
