// npm run brain -- --data-dir <dir>: the long-running brain process (architecture D1). In M2 it runs the control
// channel and stores what the Agent reports, serves the Remote File API, over which it deploys the in-game code and
// backs up the game's save, serves the dashboard, and (for Steam, on Windows) supervises the game itself.
import path from "node:path";
import process from "node:process";
import {
  ControlChannel,
  Deployer,
  REMOTE_FILE_API_MAX_FRAME_BYTES,
  startWebSocketServer,
  systemClock,
} from "@bitburner-agent/bridge";
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import { loadOrCreateConfig, resolveDataDirectory, STORE_FILE_NAME } from "./config.ts";
import { startDashboardServer } from "./dashboard/server.ts";
import { BRAIN_STARTED_EVENT_KIND, buildDashboardStatus } from "./dashboard/status.ts";
import { readInGameBuild, readPinnedDefinitions } from "./in-game-build.ts";
import { recordChannelEvents, recordEvents } from "./record-channel-events.ts";
import { brainRelease } from "./release.ts";
import { SAVE_BACKUPS_DIRECTORY_NAME, SaveBackups } from "./save-backups.ts";
import { setSupervisionPaused } from "./supervision.ts";
import { Supervisor } from "./supervisor.ts";
import { TelemetryStore } from "./telemetry-store.ts";
import { WindowsGameProcess } from "./windows-game-process.ts";

/** A log line is cut at this length: what a client sends ends up in some, and a 24/7 log must stay readable. */
const MAX_LOG_LINE_LENGTH = 500;
/** Where the brain builds the in-game code it deploys, inside its data directory. */
const INGAME_BUILD_DIRECTORY_NAME = "ingame-build";

function log(message: string): void {
  const line = `${new Date(systemClock.now()).toISOString()} brain: ${message}`;
  console.log(line.length <= MAX_LOG_LINE_LENGTH ? line : `${line.slice(0, MAX_LOG_LINE_LENGTH)}…`);
}

try {
  const dataDirectory = resolveDataDirectory(process.argv.slice(2), process.env);
  const config = loadOrCreateConfig(dataDirectory);
  const release = brainRelease();
  // Built from this checkout's sources on every start, so the brain always deploys the code it was started from.
  const buildDirectory = path.join(dataDirectory, INGAME_BUILD_DIRECTORY_NAME);
  await buildInGameBundles({ outputDirectory: buildDirectory });
  const build = readInGameBuild(buildDirectory);
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  // This run of the brain starts here, after the build: everything stored after this event is this run's, for the
  // dashboard, and the Agent gets its 60 s to reconnect from now.
  const startedAtMs = systemClock.now();
  const startedEventId = store.recordEvent(
    { environment: config.environment, release },
    { atMs: startedAtMs, kind: BRAIN_STARTED_EVENT_KIND, detail: { release } },
  );
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
  const deployer = new Deployer({
    build,
    // The port the Agent must connect to: the one listened on, which config.json's 0 (tests) leaves to the system.
    controlPort: controlServer.port,
    token: config.token,
    pinnedDefinitions: readPinnedDefinitions(),
    channel,
    clock: systemClock,
  });
  // The deployer's and the save backups' events carry the brain's release plus the deployment it deploys.
  const deployerReleaseContext = { environment: config.environment, release: `${release}+${deployer.deploymentId}` };
  const stopRecordingDeploys = recordEvents(deployer, store, deployerReleaseContext);
  const stopLoggingDeploys = deployer.subscribe((event) =>
    log(`${event.type} ${JSON.stringify({ ...event, type: undefined })}`),
  );
  // Each environment's backups in their own folder, so only Steam's (E0) are ever beside each other (§9.4).
  const saveBackups = new SaveBackups({
    dataDirectory,
    environment: config.environment,
    backupIntervalMs: config.saveBackupIntervalMinutes * 60_000,
    backupsKept: config.saveBackupsKept,
    clock: systemClock,
  });
  const stopRecordingBackups = recordEvents(saveBackups, store, deployerReleaseContext);
  const stopLoggingBackups = saveBackups.subscribe((event) =>
    log(`${event.type} ${JSON.stringify({ ...event, type: undefined })}`),
  );
  const remoteFileApiServer = await startWebSocketServer({
    port: config.remoteFileApiPort,
    allowedOrigins: config.allowedOrigins,
    // The save backups' replies are the RFA's largest frames.
    maxFrameBytes: REMOTE_FILE_API_MAX_FRAME_BYTES,
    onConnection: (connection) => {
      void deployer.accept(connection);
      saveBackups.accept(connection);
    },
    onRejectedOrigin: (origin) => channel.reportRejectedOrigin(`${origin} (Remote File API)`),
  });
  // Only Steam's game is supervised, and only on Windows: a brain for a source build (E2), or a test's, must never
  // launch or kill it.
  const supervising = config.environment === "E0" && process.platform === "win32";
  if (supervising) {
    new Supervisor({
      gameProcess: new WindowsGameProcess({ steamAppId: config.steamAppId, gameExecutable: config.gameExecutable }),
      store,
      context: deployerReleaseContext,
      clock: systemClock,
    });
  }
  const dashboardServer = await startDashboardServer({
    port: config.dashboardPort,
    status: () =>
      buildDashboardStatus({
        store,
        environment: config.environment,
        brainRelease: release,
        brainStartedAtMs: startedAtMs,
        brainStartedEventId: startedEventId,
        supervising,
        nowMs: systemClock.now(),
      }),
    setSupervisionPaused: (paused) => {
      setSupervisionPaused(store, paused);
      log(`supervision ${paused ? "paused" : "resumed"} from the dashboard`);
    },
    onError: (error) => log(`dashboard: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
  });
  log(`${release}, environment ${config.environment}, data in ${dataDirectory}`);
  log(`deploys ${deployer.deploymentId}`);
  log(`control channel on 127.0.0.1:${controlServer.port}`);
  log(`Remote File API on 127.0.0.1:${remoteFileApiServer.port}`);
  log(
    `save backups in ${path.join(dataDirectory, SAVE_BACKUPS_DIRECTORY_NAME, config.environment)}, ` +
      `every ${config.saveBackupIntervalMinutes} min, the newest ${config.saveBackupsKept} kept`,
  );
  log(`dashboard on http://127.0.0.1:${dashboardServer.port}/`);
  log(
    supervising
      ? `supervising the game: Steam app ${config.steamAppId}, ${config.gameExecutable}, checked every 30 s`
      : `not supervising the game: only Steam's (E0) is, on Windows (this is ${config.environment} on ${process.platform})`,
  );

  let stopping = false;
  const shutDown = async () => {
    if (stopping) return;
    stopping = true;
    // A deploy or backup the shutdown cuts short isn't a failed one: the next start deploys and backs up again.
    stopRecordingDeploys();
    stopLoggingDeploys();
    stopRecordingBackups();
    stopLoggingBackups();
    await dashboardServer.close();
    await remoteFileApiServer.close();
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
