// The brain's main and the gap report's command, as processes: config and token created once, the control channel
// serving, what the Agent says stored, and the gap report's exit codes.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CONTROL_PROTOCOL_VERSION, encodeControlMessage } from "@bitburner-agent/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { BRAIN_LOCK_FILE_NAME, isAlive, runningBrain, writeBrainLock } from "../src/brain-lock.ts";
import {
  type BrainConfig,
  CONFIG_FILE_NAME,
  DEFAULT_DATA_DIRECTORY,
  dataBackupSettings,
  loadOrCreateConfig,
  readConfig,
  resolveDataDirectory,
  STORE_FILE_NAME,
} from "../src/config.ts";
import { DATA_BACKUP_EVENT_KINDS } from "../src/data-backup.ts";
import { readSupervisionSwitch } from "../src/supervision.ts";
import { isThinnedReading, TelemetryStore } from "../src/telemetry-store.ts";

const BRAIN_MAIN = path.resolve(import.meta.dirname, "../src/main.ts");
const BRAIN_START = path.resolve(import.meta.dirname, "../src/start.ts");
const GAPS_CLI = path.resolve(import.meta.dirname, "../src/gaps-cli.ts");

let dataDirectory: string;
let brain: ChildProcess | undefined;
beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(os.tmpdir(), "brain-"));
});
afterEach(async () => {
  await stopBrain();
  brain = undefined;
  rmSync(dataDirectory, { recursive: true, force: true });
});

// Never by starting a brain without a data directory: that brain would run in the repository's own .data/, and a
// config it creates there is E0, which on Windows launches Steam's game.
test("without a data directory, the brain's is the repository's .data/ (gitignored)", () => {
  expect(resolveDataDirectory([], {})).toBe(DEFAULT_DATA_DIRECTORY);
  expect(DEFAULT_DATA_DIRECTORY).toBe(path.resolve(import.meta.dirname, "../../../.data"));
  const ignored = execFileSync("git", ["check-ignore", ".data/telemetry.sqlite"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
  });
  expect(ignored.trim()).toBe(".data/telemetry.sqlite");
});

test("the config and its token are created once, and kept", () => {
  const first = loadOrCreateConfig(dataDirectory);
  expect(first.token).toMatch(/^[0-9a-f]{64}$/);
  expect(first).toMatchObject({
    environment: "E0",
    controlPort: 12526,
    remoteFileApiPort: 12525,
    dashboardPort: 12527,
    saveBackupIntervalMinutes: 30,
    saveBackupsKept: 96,
    steamAppId: 1812820,
    gameExecutable: "bitburner.exe",
  });
  // Thinning at the start is the owner's to opt into (#283's review): never written, so off. The data backup's
  // settings (#284) aren't written either: absent, they're the defaults.
  expect(first).not.toHaveProperty("telemetryKeptWholeDays");
  expect(Object.keys(first).filter((key) => key.startsWith("dataBackup"))).toEqual([]);
  expect(loadOrCreateConfig(dataDirectory)).toEqual(first);
});

test("readConfig reads a config.json, and never creates one (npm run thin, #283's review)", () => {
  expect(readConfig(dataDirectory)).toBeNull();
  expect(existsSync(path.join(dataDirectory, CONFIG_FILE_NAME))).toBe(false);
  const created = loadOrCreateConfig(dataDirectory);
  writeFileSync(path.join(dataDirectory, CONFIG_FILE_NAME), JSON.stringify({ ...created, telemetryKeptWholeDays: 3 }));
  expect(readConfig(dataDirectory)).toEqual({ ...created, telemetryKeptWholeDays: 3 });
  writeFileSync(path.join(dataDirectory, CONFIG_FILE_NAME), JSON.stringify({ ...created, telemetryKeptWholeDays: 0 }));
  expect(() => readConfig(dataDirectory)).toThrow(/telemetryKeptWholeDays must be a whole number/);
});

test.each([
  ["a short token", { token: "short" }, /token must be 64 hex digits/],
  ["the simulator's environment", { environment: "E1" }, /environment must be E0 or E2/],
  ["two ports the same", { dashboardPort: 12526 }, /the ports must be different/],
  ["no allowed origins", { allowedOrigins: [] }, /allowedOrigins must list at least one origin/],
  ["no backup interval", { saveBackupIntervalMinutes: undefined }, /saveBackupIntervalMinutes must be a number/],
  ["a zero backup interval", { saveBackupIntervalMinutes: 0 }, /above 0 and at most 35791 \(the default is 30\)/],
  ["an interval a timer can't wait", { saveBackupIntervalMinutes: 35792 }, /above 0 and at most 35791/],
  ["no backups-kept count", { saveBackupsKept: undefined }, /saveBackupsKept must be a whole number/],
  ["no Steam app ID", { steamAppId: undefined }, /steamAppId must be a Steam app ID/],
  ["a Steam app ID of 0", { steamAppId: 0 }, /steamAppId must be a Steam app ID, a whole number of at least 1/],
  ["a game executable with a folder", { gameExecutable: "C:\\Games\\bitburner.exe" }, /gameExecutable must be/],
  ["a game executable that isn't an .exe", { gameExecutable: "bitburner" }, /gameExecutable must be/],
  ["no backups kept", { saveBackupsKept: 0 }, /saveBackupsKept must be a whole number, at least 1/],
  ["a fraction of a backup kept", { saveBackupsKept: 2.5 }, /saveBackupsKept must be a whole number, at least 1/],
  [
    "no days kept whole",
    { telemetryKeptWholeDays: 0 },
    /telemetryKeptWholeDays must be a whole number of days, at least 1, or absent or null for no thinning at the start/,
  ],
  ["a fraction of a day kept whole", { telemetryKeptWholeDays: 1.5 }, /telemetryKeptWholeDays must be a whole number/],
  ["days kept whole as text", { telemetryKeptWholeDays: "14" }, /telemetryKeptWholeDays must be a whole number/],
  [
    "data backups kept below 0",
    { dataBackupsKept: -1 },
    /dataBackupsKept must be a whole number, 0 for no data backups \(the default is 2\)/,
  ],
  ["a fraction of a data backup kept", { dataBackupsKept: 1.5 }, /dataBackupsKept must be a whole number/],
  [
    "a zero data backup interval",
    { dataBackupIntervalHours: 0 },
    /dataBackupIntervalHours must be a number of hours, at least 1 and at most 596 \(the default is 24\)/,
  ],
  ["a data backup interval a timer can't wait", { dataBackupIntervalHours: 597 }, /dataBackupIntervalHours must be/],
  ["a data backup interval under an hour", { dataBackupIntervalHours: 0.5 }, /dataBackupIntervalHours must be/],
  ["a data backup interval as text", { dataBackupIntervalHours: "24" }, /dataBackupIntervalHours must be/],
  ["an empty data backup folder", { dataBackupDirectory: " " }, /dataBackupDirectory must be a folder/],
  ["a data backup folder that isn't text", { dataBackupDirectory: 5 }, /dataBackupDirectory must be a folder/],
])("a config with %s is refused, saying what's wrong", (_description, changes, expected) => {
  const config = loadOrCreateConfig(dataDirectory);
  writeFileSync(path.join(dataDirectory, CONFIG_FILE_NAME), JSON.stringify({ ...config, ...changes }));
  expect(() => loadOrCreateConfig(dataDirectory)).toThrow(expected);
});

test("the data backup's settings (#284): absent, 2 kept, every 24 h, in the data directory's backups/; 0 kept is off", () => {
  const config = loadOrCreateConfig(dataDirectory);
  expect(dataBackupSettings(config, dataDirectory)).toEqual({
    backupsKept: 2,
    intervalHours: 24,
    directory: path.join(dataDirectory, "backups"),
  });
  const elsewhere = path.join(os.tmpdir(), "elsewhere");
  for (const [dataBackupDirectory, directory] of [
    ["kept", path.join(dataDirectory, "kept")],
    [elsewhere, elsewhere],
  ]) {
    writeFileSync(
      path.join(dataDirectory, CONFIG_FILE_NAME),
      JSON.stringify({ ...config, dataBackupsKept: 0, dataBackupIntervalHours: 1.5, dataBackupDirectory }),
    );
    expect(dataBackupSettings(loadOrCreateConfig(dataDirectory), dataDirectory)).toEqual({
      backupsKept: 0,
      intervalHours: 1.5,
      directory,
    });
  }
});

test("a config that isn't JSON, or isn't an object, is refused with its path", () => {
  loadOrCreateConfig(dataDirectory);
  const configPath = path.join(dataDirectory, CONFIG_FILE_NAME);
  writeFileSync(configPath, "{ trailing comma, }");
  expect(() => loadOrCreateConfig(dataDirectory)).toThrow(`${configPath}: not valid JSON`);
  writeFileSync(configPath, "null");
  expect(() => loadOrCreateConfig(dataDirectory)).toThrow(`${configPath}: must be a JSON object`);
});

test("the environment variable gives the data directory; the flag beats it", () => {
  expect(resolveDataDirectory([], { BITBURNER_AGENT_DATA_DIR: "from-env", INIT_CWD: dataDirectory })).toBe(
    path.join(dataDirectory, "from-env"),
  );
  expect(
    resolveDataDirectory(["--data-dir", "from-flag"], {
      BITBURNER_AGENT_DATA_DIR: "from-env",
      INIT_CWD: dataDirectory,
    }),
  ).toBe(path.join(dataDirectory, "from-flag"));
});

test("a given but empty data directory is refused, never taken as .data/", () => {
  expect(() => resolveDataDirectory(["--data-dir", ""], {})).toThrow(/is empty/);
  expect(() => resolveDataDirectory(["--data-dir", ""], { BITBURNER_AGENT_DATA_DIR: "elsewhere" })).toThrow(/is empty/);
  expect(() => resolveDataDirectory([], { BITBURNER_AGENT_DATA_DIR: " " })).toThrow(/is empty/);
});

test("under a test runner, no data directory is refused: a test's brain never uses .data/", () => {
  expect(() => resolveDataDirectory([], { VITEST: "true" })).toThrow(/must be given its own data directory/);
  // This test runs under Vitest: so does any brain it would start.
  expect(process.env.VITEST).toBeTruthy();
});

test("a flag without a value is an error, never taken from elsewhere", () => {
  expect(() => resolveDataDirectory(["--data-dir"], { BITBURNER_AGENT_DATA_DIR: "elsewhere" })).toThrow(
    /--data-dir needs a value/,
  );
  expect(() => resolveDataDirectory(["--data-dir", "--since", "x"], {})).toThrow(/--data-dir needs a value/);
  expect(resolveDataDirectory(["--data-dir", "data"], { INIT_CWD: dataDirectory })).toBe(
    path.join(dataDirectory, "data"),
  );
});

/**
 * The events after the brain's own `brainStarted` (E2: the test brain's environment), but its data backups (#284): the
 * one at its start comes when its worker is done, at no set time.
 */
const eventsSinceStart = (store: TelemetryStore) =>
  store
    .events({ environment: "E2" })
    .filter((event) => event.kind !== "brainStarted" && !DATA_BACKUP_EVENT_KINDS.includes(event.kind));

interface StartedBrain {
  config: BrainConfig;
  controlPort: number;
  remoteFileApiPort: number;
  dashboardPort: number;
  /** What it has logged so far. */
  output: () => string;
}

async function startBrain(changes: Partial<BrainConfig> = {}): Promise<StartedBrain> {
  const config: BrainConfig = {
    ...loadOrCreateConfig(dataDirectory),
    environment: "E2",
    controlPort: 0,
    remoteFileApiPort: 0,
    dashboardPort: 0,
    ...changes,
  };
  writeFileSync(path.join(dataDirectory, CONFIG_FILE_NAME), JSON.stringify(config));
  brain = spawn(process.execPath, [BRAIN_MAIN, "--data-dir", dataDirectory], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ports = await new Promise<Omit<StartedBrain, "config" | "output">>((resolve, reject) => {
    brain?.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const control = /control channel on 127\.0\.0\.1:(\d+)/.exec(output);
      const remoteFileApi = /Remote File API on 127\.0\.0\.1:(\d+)/.exec(output);
      const dashboard = /dashboard on http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (control && remoteFileApi && dashboard) {
        resolve({
          controlPort: Number(control[1]),
          remoteFileApiPort: Number(remoteFileApi[1]),
          dashboardPort: Number(dashboard[1]),
        });
      }
    });
    brain?.once("exit", (code) => reject(new Error(`brain exited ${code}: ${output}`)));
  });
  return { config, ...ports, output: () => output };
}

async function stopBrain(): Promise<void> {
  if (!brain || brain.exitCode !== null) return;
  const exited = once(brain, "exit");
  brain.kill();
  await exited;
}

/** A request to the dashboard, as its own page makes it (Host and, for a POST, Origin). */
function askDashboard(
  port: number,
  method: "GET" | "POST",
  urlPath: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: method === "POST" ? { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" } : {},
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("the brain serves the dashboard; the pause switch is stored and survives a restart", async () => {
  const first = await startBrain();
  const status = JSON.parse((await askDashboard(first.dashboardPort, "GET", "/api/status")).body) as {
    environment: string;
    supervision: { paused: boolean };
  };
  // An E2 brain (as every test runs) never supervises: it must never touch the owner's Steam game.
  expect(status).toMatchObject({ environment: "E2", supervision: { state: "off", paused: false } });
  // The brain recorded its start, which the dashboard counts "this run" from.
  const startedStore = TelemetryStore.openReadOnly(path.join(dataDirectory, STORE_FILE_NAME));
  expect(startedStore.events({ environment: "E2" }).map((event) => event.kind)).toContain("brainStarted");
  startedStore.close();
  expect((await askDashboard(first.dashboardPort, "POST", "/api/supervision", '{"paused":true}')).status).toBe(200);
  await stopBrain();
  const second = await startBrain();
  const afterRestart = JSON.parse(
    (await askDashboard(second.dashboardPort, "GET", "/api/status")).body,
  ) as typeof status;
  expect(afterRestart.supervision).toMatchObject({ paused: true });
  // What the supervisor (#94) reads.
  const store = TelemetryStore.openReadOnly(path.join(dataDirectory, STORE_FILE_NAME));
  expect(readSupervisionSwitch(store)).toEqual({ paused: true, gaveUpAtMs: null });
  store.close();
});

test("the brain serves the Remote File API: a game whose definitions differ puts it on hold, recorded", async () => {
  const { remoteFileApiPort } = await startBrain();
  const game = new WebSocket(`ws://127.0.0.1:${remoteFileApiPort}`, { origin: "file://" });
  const [request] = await once(game, "message");
  const { id, method } = JSON.parse(String(request)) as { id: number; method: string };
  expect(method).toBe("getDefinitionFile");
  game.send(JSON.stringify({ jsonrpc: "2.0", id, result: "interface NS { changed(): void; }\n" }));
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  for (let attempt = 0; attempt < 50 && eventsSinceStart(store).length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(eventsSinceStart(store)).toMatchObject([
    { kind: "versionDrift", detail: { detail: expect.stringContaining("NetscriptDefinitions.d.ts differs") } },
  ]);
  store.close();
  game.close();
});

test("on a Remote File API connection the brain backs up the game's save under its environment, recorded", async () => {
  const { remoteFileApiPort } = await startBrain();
  const save = gzipSync('{"ctor":"BitburnerSaveObject","data":{"PlayerSave":"{}"}}');
  const game = new WebSocket(`ws://127.0.0.1:${remoteFileApiPort}`, { origin: "file://" });
  // Answers as the Steam game: the save as gzip bytes, one character per byte; nothing else is answered.
  game.on("message", (frame) => {
    const { id, method } = JSON.parse(String(frame)) as { id: number; method: string };
    if (method !== "getSaveFile") return;
    game.send(
      JSON.stringify({ jsonrpc: "2.0", id, result: { identifier: "x", binary: true, save: save.toString("latin1") } }),
    );
  });
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  for (let attempt = 0; attempt < 50 && eventsSinceStart(store).length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const [event] = eventsSinceStart(store);
  if (!event) throw new Error("no saveBackup event was recorded");
  expect(event).toMatchObject({ kind: "saveBackup", detail: { sizeBytes: save.length } });
  const file = (event.detail as { file: string }).file;
  expect(file).toMatch(/^saves\/E2\/[^/]+\.json\.gz$/);
  expect(readFileSync(path.join(dataDirectory, file)).equals(save)).toBe(true);
  store.close();
  game.close();
});

test("the brain serves the control channel and stores what the Agent reports", async () => {
  const { config, controlPort } = await startBrain();
  const agent = new WebSocket(`ws://127.0.0.1:${controlPort}`, { origin: "file://" });
  await once(agent, "open");
  agent.send(
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "hello",
      token: config.token,
      deploymentId: "deployment-a",
      agentSessionId: "session-1",
      game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
    }),
  );
  expect(JSON.parse(String((await once(agent, "message"))[0]))).toEqual({ protocolVersion: 1, type: "welcome" });
  agent.send(
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "snapshot",
      agentSessionId: "session-1",
      tier: "fast",
      sequenceNumber: 1,
      gameTimeMs: 1_000,
      data: { money: 7 },
    }),
  );
  // Written synchronously on arrival; poll briefly for the frame to cross.
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  for (let attempt = 0; attempt < 50 && store.snapshots({ environment: "E2" }).length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(store.snapshots({ environment: "E2" })).toMatchObject([
    { tier: "fast", sequenceNumber: 1, data: { money: 7 }, release: expect.stringMatching(/\+deployment-a$/) },
  ]);
  expect(eventsSinceStart(store).map((event) => event.kind)).toEqual(["agentConnected"]);
  store.close();
  agent.close();
});

function runGaps(args: string[]): { exitCode: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [GAPS_CLI, "--data-dir", dataDirectory, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { exitCode: 0, output };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { exitCode: failed.status, output: failed.stdout + failed.stderr };
  }
}

/** E2's (the test brain's): two minutes of fast snapshots 40 days ago, and the newest 20 days ago. */
function oldFastSnapshots() {
  const DAY = 24 * 60 * 60_000;
  const oldMs = Math.floor((Date.now() - 40 * DAY) / 60_000) * 60_000;
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  let sequenceNumber = 0;
  for (const [offsetMs, tier] of [
    ...Array.from({ length: 60 }, (_, index) => [index * 2_000, "fast"] as const),
    [20 * DAY, "fast"] as const,
  ]) {
    store.recordSnapshot(
      { environment: "E2", release: "r" },
      {
        agentSessionId: "s",
        tier,
        sequenceNumber: ++sequenceNumber,
        gameTimeMs: 0,
        receivedAtMs: oldMs + offsetMs,
        missedBefore: 0,
        data: { degradedTiers: [], pageHeapUsedBytes: null, game: { homeProcesses: [] } },
      },
    );
  }
  store.close();
}
/** The kinds of the brain's events (with its data backups' reasons), and whether any fast snapshot is thinned. */
function storeNow() {
  const store = TelemetryStore.openReadOnly(path.join(dataDirectory, STORE_FILE_NAME));
  const kinds = store
    .events({ environment: "E2" })
    .map((event) =>
      DATA_BACKUP_EVENT_KINDS.includes(event.kind)
        ? `${event.kind} (${(event.detail as { reason: string }).reason})`
        : event.kind,
    );
  const thinned = store.snapshots({ environment: "E2" }).some((snapshot) => isThinnedReading(snapshot.data));
  store.close();
  return { kinds, thinned };
}

test("the brain's start thins nothing unless config.json opts in (#283's review), and says so; null is off too", async () => {
  oldFastSnapshots();
  const { output } = await startBrain({ telemetryKeptWholeDays: null, dataBackupsKept: 0 });
  expect(output()).toContain(
    " brain: store thinning at start: off (telemetryKeptWholeDays isn't set in config.json; npm run thin thins by hand)",
  );
  expect(storeNow()).toEqual({ kinds: ["brainStarted"], thinned: false });
});

test("opted in, the brain thins its store's old data as it starts (#283), after a data backup (#284), before its start", async () => {
  // The cutoff is 14 days before the newest snapshot, 20 days ago: the two minutes 40 days ago are thinned.
  oldFastSnapshots();
  const { output } = await startBrain({ telemetryKeptWholeDays: 14 });
  expect(output()).toMatch(
    / brain: data backup backups\/\S+ \(before the start's thinning\): [\s\S]* brain: store thinned before .*: 58 fast and 0 medium snapshots cut to their times/,
  );
  // That backup is enough: the start's own isn't due until a day after it.
  expect(storeNow()).toEqual({ kinds: ["dataBackup (thinning)", "storeThinned", "brainStarted"], thinned: true });
  const [backup] = readdirSync(path.join(dataDirectory, "backups"));
  // The whole store, from before the thinning.
  const copy = TelemetryStore.openReadOnly(path.join(dataDirectory, "backups", backup as string, STORE_FILE_NAME));
  expect(copy.snapshots({ environment: "E2" }).some((snapshot) => isThinnedReading(snapshot.data))).toBe(false);
  expect(copy.snapshots({ environment: "E2" })).toHaveLength(61);
  copy.close();
});

test("opted in with data backups off, the brain's start thins nothing (#284): logged, recorded and the dashboard's alert", async () => {
  oldFastSnapshots();
  const { output, dashboardPort } = await startBrain({ telemetryKeptWholeDays: 14, dataBackupsKept: 0 });
  expect(output()).toContain(
    " brain: store thinning FAILED, the store left as it was: no data backup holds what it would cut (#284): data " +
      "backups are off (config.json's dataBackupsKept is 0)",
  );
  expect(output()).toContain(" brain: data backups: off (config.json's dataBackupsKept is 0)");
  expect(storeNow()).toEqual({ kinds: ["storeThinningFailed", "brainStarted"], thinned: false });
  const status = JSON.parse((await askDashboard(dashboardPort, "GET", "/api/status")).body) as {
    alerts: { name: string }[];
  };
  expect(status.alerts.map((alert) => alert.name)).toContain("storeThinningFailed");
});

test("the brain backs its data directory up at its start (#284): logged, recorded, and the copy opens", async () => {
  const { output } = await startBrain();
  expect(output()).toContain(
    ` brain: data backups in ${path.join(dataDirectory, "backups")}, every 24 h from the newest, the newest 2 kept`,
  );
  for (let attempt = 0; attempt < 100 && !/ brain: data backup backups\//.test(output()); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(output()).toMatch(
    / brain: data backup backups\/\S+ \(at the brain's start\): the store [\d.]+ MB, 0 save backups, in /,
  );
  const [backup, ...others] = readdirSync(path.join(dataDirectory, "backups"));
  expect(others).toEqual([]);
  expect(readdirSync(path.join(dataDirectory, "backups", backup as string)).sort()).toEqual([
    "backup.json",
    CONFIG_FILE_NAME,
    STORE_FILE_NAME,
  ]);
  const copy = TelemetryStore.openReadOnly(path.join(dataDirectory, "backups", backup as string, STORE_FILE_NAME));
  expect(copy.events({ environment: "E2" }).map((event) => event.kind)).toEqual(["brainStarted"]);
  copy.close();
  expect(storeNow().kinds).toEqual(["brainStarted", "dataBackup (start)"]);
});

test("a data backup that fails is logged, and the dashboard's dataBackupFailed alert; the brain plays on (#284)", async () => {
  writeFileSync(path.join(dataDirectory, "not a folder"), "");
  const { output, dashboardPort } = await startBrain({ dataBackupDirectory: "not a folder" });
  for (let attempt = 0; attempt < 100 && !/data backup FAILED/.test(output()); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(output()).toMatch(/ brain: data backup FAILED \(at the brain's start\): .*not a folder/);
  const status = JSON.parse((await askDashboard(dashboardPort, "GET", "/api/status")).body) as {
    alerts: { name: string; detail: string }[];
  };
  expect(status.alerts).toContainEqual(
    expect.objectContaining({
      name: "dataBackupFailed",
      detail: expect.stringContaining("the data directory's backup failed:"),
    }),
  );
  expect(storeNow().kinds).toEqual(["brainStarted", "dataBackupFailed (start)"]);
});

test("the brain holds its lock file while it runs (#283's review); stopped or killed, it's running no more", async () => {
  expect(runningBrain(dataDirectory)).toBeNull();
  await startBrain();
  const lock = runningBrain(dataDirectory);
  // Run as a test runs it, with no runner (start.ts) above it.
  expect(lock).toEqual({ pid: brain?.pid, runnerPid: null, path: path.join(dataDirectory, BRAIN_LOCK_FILE_NAME) });
  // A signal it handles removes the lock as it exits; on Windows a kill leaves it, naming a dead process.
  await stopBrain();
  brain = undefined;
  expect(runningBrain(dataDirectory)).toBeNull();
});

test("a brain that crashes under npm run brain's runner leaves its lock, which the runner keeps counting (#297's re-review)", async () => {
  // Its control port taken: the brain starts, claims its lock, fails to listen and exits 1; the runner waits 5 s.
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
  const config: BrainConfig = {
    ...loadOrCreateConfig(dataDirectory),
    environment: "E2",
    controlPort: (taken.address() as { port: number }).port,
    remoteFileApiPort: 0,
    dashboardPort: 0,
  };
  writeFileSync(path.join(dataDirectory, CONFIG_FILE_NAME), JSON.stringify(config));
  const runner = spawn(process.execPath, [BRAIN_START, "--data-dir", dataDirectory], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let output = "";
    await new Promise<void>((resolve, reject) => {
      runner.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (/brain runner: the brain exited \(code 1\); restarting in 5 s/.test(output)) resolve();
      });
      runner.once("exit", (code) => reject(new Error(`runner exited ${code}: ${output}`)));
    });
    // Between the crash and the restart: the brain's process is gone, its runner's alive, and the lock still counts.
    const lock = runningBrain(dataDirectory);
    expect(lock).toMatchObject({ runnerPid: runner.pid, path: path.join(dataDirectory, BRAIN_LOCK_FILE_NAME) });
    expect(isAlive(lock?.pid as number)).toBe(false);
  } finally {
    // Within the runner's 5 s wait, so no brain is left behind.
    const exited = once(runner, "exit");
    runner.kill();
    await exited;
    taken.close();
  }
});

test("a lock the brain can't write doesn't stop it starting (#297's re-review): logged", async () => {
  mkdirSync(path.join(dataDirectory, BRAIN_LOCK_FILE_NAME));
  const { output } = await startBrain();
  expect(output()).toMatch(
    / brain: brain lock: couldn't write .*brain\.lock .*: npm run thin can tell this brain runs by its dashboard's port alone/,
  );
  // And a config.json with no telemetryKeptWholeDays at all (startBrain's): off.
  expect(output()).toContain(" brain: store thinning at start: off ");
});

test("another brain's live lock is left as it is (#297's re-review): the second brain doesn't take it", async () => {
  // This test's own process stands for a first brain, running.
  writeBrainLock(dataDirectory, { pid: process.pid, runnerPid: null });
  const { output } = await startBrain();
  expect(output()).toContain(` brain: brain lock: another brain's process ${process.pid} holds `);
  expect(runningBrain(dataDirectory)).toMatchObject({ pid: process.pid });
});

test("the gap report's command: 0 with no gaps, 1 with gaps, 2 when it can't run", () => {
  expect(runGaps(["--since", "2026-10-26T00:00:00Z"]).exitCode).toBe(2);
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  const sinceMs = Date.parse("2026-10-26T00:00:00Z");
  for (let second = 0; second <= 60; second += 2) {
    if (second > 20 && second < 30) continue;
    store.recordSnapshot(
      { environment: "E0", release: "r" },
      {
        agentSessionId: "s",
        tier: "fast",
        sequenceNumber: second + 1,
        gameTimeMs: 0,
        receivedAtMs: sinceMs + second * 1000,
        missedBefore: 0,
        data: null,
      },
    );
  }
  store.close();
  const window = ["--since", "2026-10-26T00:00:00Z"];
  const withGap = runGaps([...window, "--until", "2026-10-26T00:01:00Z"]);
  expect(withGap.exitCode).toBe(1);
  expect(withGap.output).toContain("gap: 2026-10-26T00:00:20.000Z to 2026-10-26T00:00:30.000Z (10.0 s)");
  const clean = runGaps([...window, "--until", "2026-10-26T00:00:20Z"]);
  expect(clean.exitCode).toBe(0);
  expect(clean.output).toContain("No gaps.");
  expect(runGaps([...window, "--threshold-seconds", "0"]).exitCode).toBe(2);
  // A window that checks nothing must never pass as "no gaps".
  expect(runGaps(["--since", "2026-10-26T00:01:00Z", "--until", "2026-10-26T00:00:00Z"]).exitCode).toBe(2);
  expect(runGaps(["--since", "2999-01-01T00:00:00Z"]).exitCode).toBe(2);
  // A time without Z or an offset would be read as local time: refused.
  expect(runGaps(["--since", "2026-10-26T00:00:00", "--until", "2026-10-26T00:00:20Z"]).exitCode).toBe(2);
});

test("the gap report's command prints the page heap over the window; it doesn't change the exit code", () => {
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  const sinceMs = Date.parse("2026-10-26T00:00:00Z");
  const megabyte = 1024 * 1024;
  for (const [environment, second, pageHeapUsedBytes] of [
    ["E0", 0, 100 * megabyte],
    ["E0", 2, null],
    ["E0", 4, 80 * megabyte],
    ["E0", 6, 150.5 * megabyte],
    ["E0", 8, 120 * megabyte],
    ["E0", 30, 500 * megabyte],
    ["E2", 1, 7 * megabyte],
  ] as const) {
    store.recordSnapshot(
      { environment, release: "r" },
      {
        agentSessionId: "s",
        tier: "fast",
        sequenceNumber: second + 1,
        gameTimeMs: 0,
        receivedAtMs: sinceMs + second * 1000,
        missedBefore: 0,
        data: { degradedTiers: [], pageHeapUsedBytes, game: null },
      },
    );
  }
  store.close();
  const reported = runGaps(["--since", "2026-10-26T00:00:00Z", "--until", "2026-10-26T00:00:10Z"]);
  expect(reported.exitCode).toBe(0);
  expect(reported.output).toContain(
    "  page heap: first 100.0 MB, last 120.0 MB, lowest 80.0 MB, highest 150.5 MB (4 snapshots reported it)",
  );
  const withGap = runGaps(["--since", "2026-10-26T00:00:00Z", "--until", "2026-10-26T00:00:30Z"]);
  expect(withGap.exitCode).toBe(1);
  expect(withGap.output).toContain("highest 500.0 MB (5 snapshots reported it)");
  const notReported = runGaps(["--since", "2026-10-26T00:00:01Z", "--until", "2026-10-26T00:00:03Z"]);
  expect(notReported.exitCode).toBe(0);
  expect(notReported.output).toContain("  page heap: not reported");
  const otherEnvironment = runGaps([
    "--environment",
    "E2",
    "--since",
    "2026-10-26T00:00:00Z",
    "--until",
    "2026-10-26T00:00:02Z",
  ]);
  expect(otherEnvironment.output).toContain("lowest 7.0 MB, highest 7.0 MB (1 snapshot reported it)");
});

test("the brain stores its faction work's choice (#203): main.ts records the controller's events", async () => {
  const { config, controlPort } = await startBrain();
  const agent = new WebSocket(`ws://127.0.0.1:${controlPort}`, { origin: "file://" });
  await once(agent, "open");
  const send = (message: Record<string, unknown>) =>
    agent.send(encodeControlMessage({ protocolVersion: CONTROL_PROTOCOL_VERSION, ...message } as never));
  send({
    type: "hello",
    token: config.token,
    deploymentId: "deployment-a",
    agentSessionId: "session-1",
    game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
  });
  await once(agent, "message");
  const snapshot = (tier: string, sequenceNumber: number, data: unknown) =>
    send({ type: "snapshot", agentSessionId: "session-1", tier, sequenceNumber, gameTimeMs: 1_000, data });
  snapshot("medium", 1, {
    player: {
      skills: { hacking: 55, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      mults: { faction_rep: 1 },
      factions: ["CyberSec"],
    },
    hasTorRouter: false,
    programs: [],
    servers: [],
  });
  snapshot("slow", 2, {
    resetInfo: { lastAugReset: 0, lastNodeReset: 0, currentNode: 1, ownedAugs: {}, ownedSF: {}, bitNodeOptions: {} },
    purchasedServers: [],
    factions: {
      backend: "ui",
      state: { joined: [{ name: "CyberSec", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  });
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  const chosen = () => eventsSinceStart(store).filter((event) => event.kind === "factionWorkChosen");
  for (let attempt = 0; attempt < 100 && chosen().length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(chosen()).toMatchObject([
    {
      detail: { faction: "CyberSec", workType: "hacking", augmentation: "Neurotrainer I" },
      release: expect.stringMatching(/\+/),
    },
  ]);
  store.close();
  agent.close();
});
