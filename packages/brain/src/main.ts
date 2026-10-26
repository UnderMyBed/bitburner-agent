// npm run brain -- --data-dir <dir>: the long-running brain process (architecture D1). In M2 it runs the control
// channel and stores what the Agent reports; the Remote File API, dashboard and supervisor join it in later tasks.
import path from "node:path";
import process from "node:process";
import { ControlChannel, startWebSocketServer, systemClock } from "@bitburner-agent/bridge";
import { loadOrCreateConfig, resolveDataDirectory, STORE_FILE_NAME } from "./config.ts";
import { recordChannelEvents } from "./record-channel-events.ts";
import { brainRelease } from "./release.ts";
import { TelemetryStore } from "./telemetry-store.ts";

const log = (message: string) => console.log(`${new Date().toISOString()} brain: ${message}`);

try {
  const dataDirectory = resolveDataDirectory(process.argv.slice(2), process.env);
  const config = loadOrCreateConfig(dataDirectory);
  const release = brainRelease();
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  const channel = new ControlChannel({ token: config.token, clock: systemClock });
  recordChannelEvents(channel, store, { environment: config.environment, brainRelease: release });
  channel.subscribe((event) => {
    if (event.type !== "snapshotReceived") log(`${event.type} ${JSON.stringify({ ...event, type: undefined })}`);
  });
  const controlServer = await startWebSocketServer({
    port: config.controlPort,
    allowedOrigins: config.allowedOrigins,
    onConnection: (connection) => channel.accept(connection),
    onRejectedOrigin: (origin) => channel.reportRejectedOrigin(origin),
  });
  log(`${release}, environment ${config.environment}, data in ${dataDirectory}`);
  log(`control channel on 127.0.0.1:${controlServer.port}`);

  const shutDown = async () => {
    await controlServer.close();
    store.close();
    log("stopped");
    process.exit(0);
  };
  process.once("SIGINT", shutDown);
  process.once("SIGTERM", shutDown);
} catch (error) {
  console.error(`brain: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
