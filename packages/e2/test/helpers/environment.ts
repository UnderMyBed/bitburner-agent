// What every E2 test file needs: the built game served, and a browser. Each file calls useE2() at the top level.
import type { Browser } from "playwright";
import { afterAll, beforeAll } from "vitest";
import { buildInputsHash, isBuilt } from "../../src/build.ts";
import { launchBrowser } from "../../src/game.ts";
import { buildDirectory, GAME_ROOT, gameCommit } from "../../src/paths.ts";
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
    if (!isBuilt(directory, buildInputsHash(GAME_ROOT))) {
      throw new Error(`The game isn't built for E2 from these inputs (${directory}): run npm run e2:build.`);
    }
    e2.server = await serveGame(directory);
    e2.browser = await launchBrowser();
  });
  afterAll(async () => {
    // Each closed whatever happens to the other.
    try {
      await e2.browser?.close();
    } finally {
      await e2.server?.close();
    }
  });
  return e2;
}
