// The game's Remote File API client connects to a local server on every load (#96). The game opens the connection
// from a 2 s timer after load (src/index.tsx), with the address and port from the save's settings, so ten loads show
// the settings are loaded first every time.
import { gunzipSync } from "node:zlib";
import { Simulation } from "@bitburner-agent/sim";
import { describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { advanceUntil, closeGame, gameFromSave } from "../src/game.ts";
import { useE2 } from "./helpers/environment.ts";

const e2 = useE2();
const LOADS = 10;

/** A simulator-made save whose settings name `port` on 127.0.0.1, and its last update time. */
async function saveConnectingTo(port: number): Promise<{ save: Uint8Array; lastUpdate: number }> {
  const sim = await Simulation.start({
    fixture: { kind: "new", tutorial: "skipped" },
    epochMs: Date.UTC(2026, 0, 1),
    seed: 1,
    gameSettings: { RemoteFileApiAddress: "127.0.0.1", RemoteFileApiPort: port },
  });
  try {
    const save = await sim.save();
    const saveObject = JSON.parse(gunzipSync(save).toString("utf8")) as { data: { PlayerSave: string } };
    const { lastUpdate } = (JSON.parse(saveObject.data.PlayerSave) as { data: { lastUpdate: number } }).data;
    return { save, lastUpdate };
  } finally {
    await sim.close();
  }
}

describe("the game's Remote File API client", () => {
  test(`connects to a local server within 5 s of game time, in ${LOADS} loads of ${LOADS}`, async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    let connections = 0;
    server.on("connection", () => connections++);
    try {
      const { port } = server.address() as { port: number };
      const { save, lastUpdate } = await saveConnectingTo(port);
      const gameMsToConnect: number[] = [];
      for (let load = 1; load <= LOADS; load++) {
        const page = await gameFromSave(e2.browser, e2.server, save, { startTimeMs: lastUpdate });
        try {
          const before = connections;
          const { gameMs } = await advanceUntil(page, async () => connections > before, {
            gameTimeoutMs: 5_000,
            realTimeoutMs: 30_000,
          });
          gameMsToConnect.push(gameMs);
        } finally {
          await closeGame(page);
        }
      }
      console.log(`Game time to connect, per load: ${gameMsToConnect.join(", ")} ms`);
      expect(connections).toBe(LOADS);
      // The game opens the connection from its 2 s timer, not before.
      for (const gameMs of gameMsToConnect) expect(gameMs).toBeGreaterThanOrEqual(2_000);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
