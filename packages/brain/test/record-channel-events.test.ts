import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Clock, type Connection, ControlChannel } from "@bitburner-agent/bridge";
import { CONTROL_PROTOCOL_VERSION, encodeControlMessage } from "@bitburner-agent/core";
import { afterEach, expect, test } from "vitest";
import { recordChannelEvents } from "../src/record-channel-events.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const TOKEN = "a".repeat(64);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const fixedClock: Clock = { now: () => 1_000, setTimeout: () => 0, clearTimeout: () => {} };

/** A connection the test drives by hand. */
function connectionFromTest() {
  const messageListeners: ((text: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const connection: Connection = {
    send: () => {},
    close: () => {
      for (const listener of closeListeners) listener();
    },
    onMessage: (listener) => messageListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
  };
  return {
    connection,
    receive: (text: string) => {
      for (const listener of messageListeners) listener(text);
    },
    drop: () => connection.close(1006, ""),
  };
}

test("each row's release is the brain's plus the connected Agent's deployment, or none while no Agent is", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "record-"));
  directories.push(directory);
  const store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  const channel = new ControlChannel({ token: TOKEN, clock: fixedClock });
  recordChannelEvents(channel, store, { environment: "E2", brainRelease: "v0.2.0" });

  const page = connectionFromTest();
  channel.accept(page.connection);
  page.receive(
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "hello",
      token: TOKEN,
      deploymentId: "deployment-a",
      agentSessionId: "session-1",
      game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
    }),
  );
  page.drop();
  channel.reportRejectedOrigin("https://example.com");

  expect(store.events({ environment: "E2" }).map(({ kind, release }) => [kind, release])).toEqual([
    ["agentConnected", "v0.2.0+deployment-a"],
    ["agentDisconnected", "v0.2.0+deployment-a"],
    ["connectionRejected", "v0.2.0+none"],
  ]);
  store.close();
});
