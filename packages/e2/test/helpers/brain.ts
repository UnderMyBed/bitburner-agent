// A real brain for E2 tests (#97): `packages/brain/src/main.ts` as its own process, with environment E2 (so it never
// supervises Steam's game), ports of its own, a data directory the test owns, and the test page's origin allowed.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { type BrainConfig, defaultConfig, TelemetryStore } from "@bitburner-agent/brain";
import { REPOSITORY_ROOT } from "../../src/paths.ts";

const BRAIN_MAIN = path.join(REPOSITORY_ROOT, "packages/brain/src/main.ts");
/** How long a brain gets, in real time, to build the in-game code and listen. */
const START_TIMEOUT_MS = 60_000;

/**
 * Every brain this process started and hasn't seen exit. Windows doesn't end a child with its parent, so whatever ends
 * the test run (a timeout, a crash) ends these too, rather than leaving them on their ports.
 */
const liveBrains = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of liveBrains) child.kill();
});

export interface BrainPorts {
  controlPort: number;
  remoteFileApiPort: number;
  dashboardPort: number;
}

/** Three ports the system says are free now, and distinct: all three are held open while they're picked. */
export async function freeBrainPorts(): Promise<BrainPorts> {
  const servers: Server[] = [createServer(), createServer(), createServer()];
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const [controlPort, remoteFileApiPort, dashboardPort] = servers.map(
    (server) => (server.address() as { port: number }).port,
  ) as [number, number, number];
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  return { controlPort, remoteFileApiPort, dashboardPort };
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
 * The config a test brain runs with: written if `dataDirectory` has none (and kept when the brain is started again,
 * since the Agent's deployed code holds its token), and refused unless it's environment E2 on `ports`, allowing
 * `allowedOrigin`. E2 is the one thing that keeps a test brain away from the owner's game: an E0 brain on Windows
 * launches and kills Steam's Bitburner.
 */
function testBrainConfig(dataDirectory: string, ports: BrainPorts, allowedOrigin: string): void {
  const configFile = path.join(dataDirectory, "config.json");
  if (!existsSync(configFile)) {
    const config: BrainConfig = { ...defaultConfig(), environment: "E2", ...ports, allowedOrigins: [allowedOrigin] };
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  }
  const config = JSON.parse(readFileSync(configFile, "utf8")) as Partial<BrainConfig>;
  const expected = { environment: "E2", ...ports, allowedOrigins: [allowedOrigin] };
  const actual = {
    environment: config.environment,
    controlPort: config.controlPort,
    remoteFileApiPort: config.remoteFileApiPort,
    dashboardPort: config.dashboardPort,
    allowedOrigins: config.allowedOrigins,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${configFile} isn't a test brain's: ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
  }
}

/** Starts a brain with `dataDirectory` (see testBrainConfig), and waits for it to listen. */
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
  testBrainConfig(dataDirectory, ports, allowedOrigin);
  const child = spawn(process.execPath, [BRAIN_MAIN, "--data-dir", dataDirectory], {
    cwd: REPOSITORY_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveBrains.add(child);
  const log: string[] = [];
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      liveBrains.delete(child);
      resolve();
    }),
  );
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? "";
      log.push(...lines);
    });
  }
  const stop = async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  };
  let deploymentId: string;
  try {
    deploymentId = await waitForLine(child, log, /brain: deploys (\S+)/, START_TIMEOUT_MS);
    // Its last startup line: everything is listening, and it says it doesn't supervise.
    await waitForLine(child, log, /brain: not supervising the game/, START_TIMEOUT_MS);
  } catch (error) {
    // Not left running, holding its ports and store, when it didn't start as it should.
    await stop();
    throw error;
  }
  return { log, deploymentId, stop };
}

/**
 * Waits, in real time, for a line matching `pattern`; resolves with its first group. Fails if the process exits, or at
 * once if it says it's supervising the game (which config.json's E2 should make impossible).
 */
function waitForLine(child: ChildProcess, log: string[], pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => finish(new Error(`No "${pattern}" from the brain within ${timeoutMs} ms:\n${log.join("\n")}`)),
      timeoutMs,
    );
    const poll = setInterval(() => {
      const match = log.map((line) => pattern.exec(line)).find((each) => each !== null);
      if (log.some((line) => /brain: supervising the game/.test(line))) {
        finish(new Error(`A test brain is supervising the game:\n${log.join("\n")}`));
      } else if (match) finish(null, match[1] ?? "");
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
