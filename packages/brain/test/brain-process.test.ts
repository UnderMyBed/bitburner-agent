// The brain's main and the gap report's command, as processes: config and token created once, the control channel
// serving, what the Agent says stored, and the gap report's exit codes.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { TelemetryStore } from "../src/telemetry-store.ts";

const BRAIN_MAIN = path.resolve(import.meta.dirname, "../src/main.ts");
const GAPS_CLI = path.resolve(import.meta.dirname, "../src/gaps-cli.ts");

let dataDirectory: string;
let brain: ChildProcess | undefined;
beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(os.tmpdir(), "brain-"));
});
afterEach(async () => {
  if (brain && brain.exitCode === null) {
    const exited = once(brain, "exit");
    brain.kill();
    await exited;
  }
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
  });
  expect(loadOrCreateConfig(dataDirectory)).toEqual(first);
});

test.each([
  ["a short token", { token: "short" }, /token must be 64 hex digits/],
  ["the simulator's environment", { environment: "E1" }, /environment must be E0 or E2/],
  ["two ports the same", { dashboardPort: 12526 }, /the ports must be different/],
  ["no allowed origins", { allowedOrigins: [] }, /allowedOrigins must list at least one origin/],
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

async function startBrain(): Promise<{ config: BrainConfig; controlPort: number; remoteFileApiPort: number }> {
  const config: BrainConfig = {
    ...loadOrCreateConfig(dataDirectory),
    environment: "E2",
    controlPort: 0,
    remoteFileApiPort: 0,
  };
  writeFileSync(path.join(dataDirectory, CONFIG_FILE_NAME), JSON.stringify(config));
  brain = spawn(process.execPath, [BRAIN_MAIN, "--data-dir", dataDirectory], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ports = await new Promise<{ controlPort: number; remoteFileApiPort: number }>((resolve, reject) => {
    brain?.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const control = /control channel on 127\.0\.0\.1:(\d+)/.exec(output);
      const remoteFileApi = /Remote File API on 127\.0\.0\.1:(\d+)/.exec(output);
      if (control && remoteFileApi) {
        resolve({ controlPort: Number(control[1]), remoteFileApiPort: Number(remoteFileApi[1]) });
      }
    });
    brain?.once("exit", (code) => reject(new Error(`brain exited ${code}: ${output}`)));
  });
  return { config, ...ports };
}

test("the brain serves the Remote File API: a game whose definitions differ puts it on hold, recorded", async () => {
  const { remoteFileApiPort } = await startBrain();
  const game = new WebSocket(`ws://127.0.0.1:${remoteFileApiPort}`, { origin: "file://" });
  const [request] = await once(game, "message");
  const { id, method } = JSON.parse(String(request)) as { id: number; method: string };
  expect(method).toBe("getDefinitionFile");
  game.send(JSON.stringify({ jsonrpc: "2.0", id, result: "interface NS { changed(): void; }\n" }));
  const store = TelemetryStore.open(path.join(dataDirectory, STORE_FILE_NAME));
  for (let attempt = 0; attempt < 50 && store.events({ environment: "E2" }).length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(store.events({ environment: "E2" })).toMatchObject([
    { kind: "versionDrift", detail: { detail: expect.stringContaining("NetscriptDefinitions.d.ts differs") } },
  ]);
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
  expect(store.events({ environment: "E2" }).map((event) => event.kind)).toEqual(["agentConnected"]);
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
