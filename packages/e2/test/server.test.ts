// The static server, without a browser: these run in CI with the other unit tests.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BLANK_PAGE, fileForUrlPath, type GameServer, serveGame } from "../src/server.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "e2-server-"));
let server: GameServer;
beforeAll(async () => {
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>game</title>");
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "main.bundle.js"), "console.log(1);");
  server = await serveGame(root);
});
afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

/** The status of a GET for `urlPath` exactly as written. */
function rawStatus(urlPath: string): Promise<number | undefined> {
  const { port } = new URL(server.origin);
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: urlPath }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
}

describe("fileForUrlPath", () => {
  test("/ is index.html; other paths are files under the root; a query is ignored", () => {
    expect(fileForUrlPath(root, "/")).toBe(path.join(root, "index.html"));
    expect(fileForUrlPath(root, "/dist/main.bundle.js?x=1")).toBe(path.join(root, "dist", "main.bundle.js"));
  });

  test("nothing outside the root", () => {
    expect(fileForUrlPath(root, "/../secret.txt")).toBeNull();
    expect(fileForUrlPath(root, "/dist/%2e%2e/%2e%2e/secret.txt")).toBeNull();
    // On Windows a path can name a drive (`/C:/…`); elsewhere a leading `/` is stripped and the rest stays inside.
    if (process.platform === "win32") {
      expect(fileForUrlPath(root, `/${path.join(root, "..", "x")}`.replaceAll("\\", "/"))).toBeNull();
    }
  });
});

describe("serveGame", () => {
  test("serves on 127.0.0.1, with each file's content type", async () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await fetch(`${server.origin}/`);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain("<title>game</title>");
    const bundle = await fetch(`${server.origin}/dist/main.bundle.js`);
    expect(bundle.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  test("a blank page on the same origin, for writing a save before the game loads", async () => {
    const blank = await fetch(`${server.origin}${BLANK_PAGE}`);
    expect(blank.status).toBe(200);
    expect(await blank.text()).not.toContain("game");
  });

  test("404 for a missing file, 400 for a path outside the root or a bad escape, 405 for a POST", async () => {
    expect((await fetch(`${server.origin}/missing.js`)).status).toBe(404);
    // fetch would normalise the dots away; a raw request sends the path as written.
    expect(await rawStatus("/dist/%2e%2e/%2e%2e/x")).toBe(400);
    expect(await rawStatus("/../x")).toBe(400);
    expect((await fetch(`${server.origin}/%E0%A4%A`)).status).toBe(400);
    expect((await fetch(`${server.origin}/`, { method: "POST" })).status).toBe(405);
  });
});
