// What every E2 test file needs: the built game served, and a browser. Each file calls useE2() at the top level.
import type { Browser } from "playwright";
import { afterAll, beforeAll } from "vitest";
import { isBuilt } from "../../src/build.ts";
import { launchBrowser } from "../../src/game.ts";
import { buildDirectory, gameCommit } from "../../src/paths.ts";
import { type GameServer, serveGame } from "../../src/server.ts";

export interface E2 {
  browser: Browser;
  server: GameServer;
}

/** The browser and server, started before the file's tests and closed after. Fails clearly if a step is missing. */
export function useE2(): E2 {
  const e2 = {} as E2;
  beforeAll(async () => {
    const directory = buildDirectory(gameCommit());
    if (!isBuilt(directory)) throw new Error(`The game isn't built for E2 (${directory}): run npm run e2:build.`);
    e2.server = await serveGame(directory);
    e2.browser = await launchBrowser();
  });
  afterAll(async () => {
    await e2.browser?.close();
    await e2.server?.close();
  });
  return e2;
}
