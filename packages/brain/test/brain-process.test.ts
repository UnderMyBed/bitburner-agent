// The brain's main and the gap report's command, as processes: config and token created once, the control channel
// serving, what the Agent says stored, and the gap report's exit codes.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CONTROL_PROTOCOL_VERSION, encodeControlMessage } from "@bitburner-agent/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  type BrainConfig,
  CONFIG_FILE_NAME,
  loadOrCreateConfig,
  resolveDataDirectory,
  STORE_FILE_NAME,
} from "../src/config.ts";
import { readSupervisionSwitch } from "../src/supervision.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const BRAIN_MAIN = path.resolve(import.meta.dirname, "../src/main.ts");
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

test("without a data directory the brain refuses to start, and says how to give one", () => {
  const run = () =>
    execFileSync(process.execPath, [BRAIN_MAIN], {
      env: { ...process.env, BITBURNER_AGENT_DATA_DIR: "" },
      encoding: "utf8",
      stdio: "pipe",
    });
  expect(run).toThrow(/needs a data directory: pass --data-dir <dir> or set BITBURNER_AGENT_DATA_DIR/);
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
  expect(loadOrCreateConfig(dataDirectory)).toEqual(first);
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
  ["a game executable with a folder", { gameExecutable: "C:\\Games\\bitburner.exe" }, /gameExecutable must be/],
  ["a game executable that isn't an .exe", { gameExecutable: "bitburner" }, /gameExecutable must be/],
  ["no backups kept", { saveBackupsKept: 0 }, /saveBackupsKept must be a whole number, at least 1/],
  ["a fraction of a backup kept", { saveBackupsKept: 2.5 }, /saveBackupsKept must be a whole number, at least 1/],
])("a config with %s is refused, saying what's wrong", (_description, changes, expected) => {
  const config = loadOrCreateConfig(dataDirectory);
  writeFileSync(path.join(dataDirectory, CONFIG_FILE_NAME), JSON.stringify({ ...config, ...changes }));
  expect(() => loadOrCreateConfig(dataDirectory)).toThrow(expected);
});

test("a config that isn't JSON, or isn't an object, is refused with its path", () => {
  loadOrCreateConfig(dataDirectory);
  const configPath = path.join(dataDirectory, CONFIG_FILE_NAME);
  writeFileSync(configPath, "{ trailing comma, }");
  expect(() => loadOrCreateConfig(dataDirectory)).toThrow(`${configPath}: not valid JSON`);
  writeFileSync(configPath, "null");
  expect(() => loadOrCreateConfig(dataDirectory)).toThrow(`${configPath}: must be a JSON object`);
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

/** The events after the brain's own `brainStarted` (E2: the test brain's environment). */
const eventsSinceStart = (store: TelemetryStore) =>
  store.events({ environment: "E2" }).filter((event) => event.kind !== "brainStarted");

interface StartedBrain {
  config: BrainConfig;
  controlPort: number;
  remoteFileApiPort: number;
  dashboardPort: number;
}

async function startBrain(): Promise<StartedBrain> {
  const config: BrainConfig = {
    ...loadOrCreateConfig(dataDirectory),
    environment: "E2",
    controlPort: 0,
    remoteFileApiPort: 0,
    dashboardPort: 0,
  };
  writeFileSync(path.join(dataDirectory, CONFIG_FILE_NAME), JSON.stringify(config));
  brain = spawn(process.execPath, [BRAIN_MAIN, "--data-dir", dataDirectory], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ports = await new Promise<Omit<StartedBrain, "config">>((resolve, reject) => {
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
  return { config, ...ports };
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
  expect(status).toMatchObject({ environment: "E2", supervision: { paused: false } });
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
