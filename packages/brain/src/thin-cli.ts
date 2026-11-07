// npm run thin -- [--data-dir <dir>] [--environment E0] [--kept-whole-days <days>] [--vacuum]
// Thins the telemetry store as the brain's start does (#283, store-thinning.ts), by config.json's
// `telemetryKeptWholeDays` unless --kept-whole-days says, and the environment config.json names unless --environment
// does. --vacuum then compacts the file, which gives the freed pages back (the brain only reuses them): it rewrites
// the whole file, so it's refused while the brain's dashboard answers. Exits 0 when done, 2 when it couldn't run.
import { statSync } from "node:fs";
import { connect } from "node:net";
import process from "node:process";
import {
  environmentFlag,
  existingStorePath,
  flagValue,
  isKeptWholeDays,
  keptWholeDaysOf,
  loadOrCreateConfig,
  resolveDataDirectory,
} from "./config.ts";
import { brainRelease } from "./release.ts";
import { describeThinning, thinStore } from "./store-thinning.ts";
import { TelemetryStore } from "./telemetry-store.ts";

/** How long a connection to the dashboard may take before nothing's taken to answer there. */
const ANSWER_WITHIN_MS = 1_000;

/** Whether something answers on 127.0.0.1:`port`: a brain running, with the store open. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: ANSWER_WITHIN_MS });
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

try {
  const argv = process.argv.slice(2);
  const storePath = existingStorePath(argv, process.env);
  const config = loadOrCreateConfig(resolveDataDirectory(argv, process.env));
  const environment = flagValue(argv, "--environment") === undefined ? config.environment : environmentFlag(argv);
  const daysText = flagValue(argv, "--kept-whole-days");
  const keptWholeDays = daysText === undefined ? keptWholeDaysOf(config) : Number(daysText);
  if (!isKeptWholeDays(keptWholeDays)) throw new Error("--kept-whole-days must be a whole number of days, at least 1");
  const vacuum = argv.includes("--vacuum");
  // Port 0 (tests) is the system's choice: there's no telling where a brain would answer.
  if (vacuum && config.dashboardPort !== 0 && (await answers(config.dashboardPort))) {
    throw new Error(
      `the brain's dashboard answers on 127.0.0.1:${config.dashboardPort}: stop the brain before --vacuum, which ` +
        "rewrites the whole file",
    );
  }
  const store = TelemetryStore.open(storePath);
  try {
    const context = { environment, release: brainRelease() };
    console.log(describeThinning(thinStore(store, { context, nowMs: Date.now(), keptWholeDays })));
    if (vacuum) {
      const sizeBefore = statSync(storePath).size;
      store.vacuum();
      console.log(`compacted: ${megabytes(sizeBefore)} → ${megabytes(statSync(storePath).size)}`);
    }
  } finally {
    store.close();
  }
} catch (error) {
  console.error(`thin: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
