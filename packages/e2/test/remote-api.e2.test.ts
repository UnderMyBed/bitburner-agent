// The game's Remote File API client connects to a local server on every load (#96). The game opens the connection
// from a 2 s timer set when the page starts (vendor/bitburner-src/src/index.tsx:37), with the address and port from
// the save's settings. Here game time runs in real time during the load, as on Steam, so that timer races the load:
// ten loads show the settings are loaded first every time.
import { describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { advanceUntil, closeGame, gameFromSave } from "../src/game.ts";
import { useE2 } from "./helpers/environment.ts";
import { simulatorSave } from "./helpers/saves.ts";

const e2 = useE2();
const LOADS = 10;

describe("the game's Remote File API client", () => {
  test(`connects to a local server within 5 s of the game loading, in ${LOADS} loads of ${LOADS}`, async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    let connections = 0;
    server.on("connection", () => connections++);
    try {
      const { port } = server.address() as { port: number };
      const save = await simulatorSave({
        gameSettings: { RemoteFileApiAddress: "127.0.0.1", RemoteFileApiPort: port },
      });
      const gameMsAfterLoad: number[] = [];
      for (let load = 1; load <= LOADS; load++) {
        // Counted from before the load: with the clock running, the game may connect while it's still loading.
        const before = connections;
        const page = await gameFromSave(e2.browser, e2.server, save, { clockDuringLoad: "running" });
        try {
          const { gameMs } = await advanceUntil(page, async () => connections > before, {
            gameTimeoutMs: 5_000,
            realTimeoutMs: 30_000,
          });
          gameMsAfterLoad.push(gameMs);
        } finally {
          await closeGame(page);
        }
      }
      console.log(`Game time from loaded to connected, per load: ${gameMsAfterLoad.join(", ")} ms`);
      expect(connections).toBe(LOADS);
      // Once loaded, game time stands still again: only the test moves it. (Real time has to pass to show that.)
      const page = await gameFromSave(e2.browser, e2.server, save, { clockDuringLoad: "running" });
      try {
        const loadedAt = await page.evaluate(() => Date.now());
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(await page.evaluate(() => Date.now())).toBe(loadedAt);
      } finally {
        await closeGame(page);
      }
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
