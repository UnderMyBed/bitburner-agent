// Game time is paced against real time (#96): real-time work, here a reply 100 ms late, gets real time to happen in.
// Unpaced, the clock reached ×126 and more, so 100 ms of real time was over 12 s of game time: the Agent's 5 s worker
// timeout would have fired.
import { describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { advanceUntil, closeGame, freshGame } from "../src/game.ts";
import { useE2 } from "./helpers/environment.ts";

const e2 = useE2();
const REPLY_DELAY_MS = 100;

describe("game time", () => {
  test(`a reply ${REPLY_DELAY_MS} ms late in real time arrives within 5 s of game time`, async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) =>
      socket.on("message", (message) => setTimeout(() => socket.send(String(message)), REPLY_DELAY_MS)),
    );
    const page = await freshGame(e2.browser, e2.server);
    try {
      const { port } = server.address() as { port: number };
      await page.evaluate((url) => {
        const socket = new WebSocket(url);
        const probe = { open: false, gameMsToReply: -1 };
        Object.assign(window, { probe });
        socket.onopen = () => {
          probe.open = true;
          const sentAt = Date.now();
          socket.onmessage = () => {
            probe.gameMsToReply = Date.now() - sentAt;
          };
          socket.send("ping");
        };
      }, `ws://127.0.0.1:${port}`);
      const replied = () =>
        page.evaluate(() => (window as unknown as { probe: { gameMsToReply: number } }).probe.gameMsToReply >= 0);
      await advanceUntil(page, replied, { gameTimeoutMs: 5_000, realTimeoutMs: 30_000 });
      const gameMsToReply = await page.evaluate(
        () => (window as unknown as { probe: { gameMsToReply: number } }).probe.gameMsToReply,
      );
      console.log(`A reply ${REPLY_DELAY_MS} ms late took ${gameMsToReply} ms of game time`);
      expect(gameMsToReply).toBeLessThan(5_000);
    } finally {
      await closeGame(page);
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
