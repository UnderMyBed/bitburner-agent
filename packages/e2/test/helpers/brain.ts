// A real brain for E2 tests (#97): `packages/brain/src/main.ts` as its own process, with environment E2 (so it never
// supervises Steam's game), ports of its own, a data directory the test owns, and the test page's origin allowed.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { type BrainConfig, defaultConfig, TelemetryStore } from "@bitburner-agent/brain";
import { REPOSITORY_ROOT } from "../../src/paths.ts";

const BRAIN_MAIN = path.join(REPOSITORY_ROOT, "packages/brain/src/main.ts");
/** How long a brain gets, in real time, to build the in-game code and listen. */
const START_TIMEOUT_MS = 60_000;

/** A port the system says is free now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface BrainPorts {
  controlPort: number;
  remoteFileApiPort: number;
  dashboardPort: number;
}

export async function freeBrainPorts(): Promise<BrainPorts> {
  return { controlPort: await freePort(), remoteFileApiPort: await freePort(), dashboardPort: await freePort() };
}

export interface RunningBrain {
  /** Its stdout and stderr, line by line, so far. */
  log: string[];
  /** The deployment it deploys (its "deploys <id>" line). */
  deploymentId: string;
  /** Ends the process and waits for it to exit. */
  stop(): Promise<void>;
}

/**
 * Starts a brain with `dataDirectory` (created, with a config.json for E2 on `ports`, allowing `allowedOrigin`, if it
 * has none), and waits for it to listen.
 */
export async function startBrain({
  dataDirectory,
  ports,
  allowedOrigin,
}: {
  dataDirectory: string;
  ports: BrainPorts;
  allowedOrigin: string;
}): Promise<RunningBrain> {
  mkdirSync(dataDirectory, { recursive: true });
  // Kept when the brain is started again: the Agent's deployed code holds its token.
  const configFile = path.join(dataDirectory, "config.json");
  if (!existsSync(configFile)) {
    const config: BrainConfig = { ...defaultConfig(), environment: "E2", ...ports, allowedOrigins: [allowedOrigin] };
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  }
  const child = spawn(process.execPath, [BRAIN_MAIN, "--data-dir", dataDirectory], {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? "";
      log.push(...lines);
    });
  }
  const deploymentId = await waitForLine(child, log, /brain: deploys (\S+)/, START_TIMEOUT_MS);
  // Its last startup line: everything is listening.
  await waitForLine(child, log, /brain: not supervising the game/, START_TIMEOUT_MS);
  return {
    log,
    deploymentId,
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

/** Waits, in real time, for a line matching `pattern`; resolves with its first group. Fails if the process exits. */
function waitForLine(child: ChildProcess, log: string[], pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => finish(new Error(`No "${pattern}" from the brain within ${timeoutMs} ms`)),
      timeoutMs,
    );
    const poll = setInterval(() => {
      const match = log.map((line) => pattern.exec(line)).find((each) => each !== null);
      if (match) finish(null, match[1] ?? "");
      else if (child.exitCode !== null) finish(new Error(`The brain exited (${child.exitCode}):\n${log.join("\n")}`));
    }, 50);
    function finish(error: Error | null, value = "") {
      clearTimeout(deadline);
      clearInterval(poll);
      if (error) reject(error);
      else resolve(value);
    }
  });
}

/** Reads the brain's store, read-only, while it runs: the snapshots and events it has stored for E2. */
export function readStore(dataDirectory: string) {
  const store = TelemetryStore.openReadOnly(path.join(dataDirectory, "telemetry.sqlite"));
  try {
    return { snapshots: store.snapshots({ environment: "E2" }), events: store.events({ environment: "E2" }) };
  } finally {
    store.close();
  }
}
