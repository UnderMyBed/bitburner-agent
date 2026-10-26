// npm run brain -- --data-dir <dir>: the long-running brain process (architecture D1). In M2 it runs the control
// channel and stores what the Agent reports; the Remote File API, dashboard and supervisor join it in later tasks.
import path from "node:path";
import process from "node:process";
import { ControlChannel, startWebSocketServer, systemClock } from "@bitburner-agent/bridge";
import { loadOrCreateConfig, resolveDataDirectory, STORE_FILE_NAME } from "./config.ts";
import { recordChannelEvents } from "./record-channel-events.ts";
import { brainRelease } from "./release.ts";
import { TelemetryStore } from "./telemetry-store.ts";

/** A log line is cut at this length: what a client sends ends up in some, and a 24/7 log must stay readable. */
const MAX_LOG_LINE_LENGTH = 500;

function log(message: string): void {
  const line = `${new Date(systemClock.now()).toISOString()} brain: ${message}`;
  console.log(line.length <= MAX_LOG_LINE_LENGTH ? line : `${line.slice(0, MAX_LOG_LINE_LENGTH)}…`);
}

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

  let stopping = false;
  const shutDown = async () => {
    if (stopping) return;
    stopping = true;
    await controlServer.close();
    store.close();
    log("stopped");
    process.exit(0);
  };
  // SIGBREAK is Ctrl+Break on Windows; SIGHUP its console closing. The store is safe either way (WAL).
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(signal, shutDown);
} catch (error) {
  console.error(`brain: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
