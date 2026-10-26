// A static server for the built game, on 127.0.0.1 and a port the system picks. It also serves a blank page on the
// same origin, where a fixture writes a save into the game's IndexedDB before the game itself loads.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export const BLANK_PAGE_PATH = "/__e2/blank.html";

/** The kinds of file the built game has (index.html, and dist/: webpack's output and the game's committed files). */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
};

export interface GameServer {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  close(): Promise<void>;
}

/** The file under `root` that `urlPath` names, or null if it would be outside `root`. `/` is `index.html`. */
export function fileForUrlPath(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] as string);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const file = path.resolve(root, relative);
  return file.startsWith(path.resolve(root) + path.sep) ? file : null;
}

export async function serveGame(root: string): Promise<GameServer> {
  const server = createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.url?.split("?")[0] === BLANK_PAGE_PATH) {
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"] }).end("<!doctype html><title>e2</title>");
      return;
    }
    let file: string | null = null;
    try {
      file = fileForUrlPath(root, request.url ?? "/");
    } catch {
      // A malformed escape in the path.
    }
    if (file === null) {
      response.writeHead(400).end();
      return;
    }
    try {
      const body = await readFile(file);
      const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
