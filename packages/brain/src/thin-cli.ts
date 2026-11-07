// npm run thin -- [--data-dir <dir>] [--environment E0] [--kept-whole-days <days>] [--dry-run] [--no-backup] [--vacuum]
// Thins the telemetry store by hand (#283, store-thinning.ts): fast and medium snapshots older than the days kept whole
// before the newest snapshot (--kept-whole-days, else config.json's `telemetryKeptWholeDays`, else 14), in the
// environment config.json names unless --environment does. It can't be undone, so before a thinning that cuts
// anything it writes a compacted copy of the store beside it, `telemetry.pre-thinning-<time>.sqlite`, unless
// --no-backup. --dry-run says what it would cut, and the bytes, and changes nothing. --vacuum then compacts the file,
// which gives the freed pages back (SQLite only reuses them): a compacted copy, swapped in. Every run is refused while
// the brain runs (its lock file names a live process, or its dashboard's port answers): it would hold the store's
// write lock longer than the brain's writes wait; --vacuum checks again just before its swap. Reads config.json
// without creating it. Exits 0 when done, 2 when it couldn't run.
import { renameSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import process from "node:process";
import { runningBrain } from "./brain-lock.ts";
import {
  type BrainConfig,
  defaultConfig,
  environmentFlag,
  existingStorePath,
  flagValue,
  isKeptWholeDays,
  readConfig,
  resolveDataDirectory,
} from "./config.ts";
import { brainRelease } from "./release.ts";
import { cutAny, DEFAULT_KEPT_WHOLE_DAYS, describeThinning, megabytes, thinStore } from "./store-thinning.ts";
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

/** A time as a file name's part: the ISO time without its colons and dots. */
const fileTime = (epochMs: number) => new Date(epochMs).toISOString().replace(/[:.]/g, "-");

/**
 * Throws if the brain runs (#297's re-review: checked at the start, and again just before `--vacuum`'s swap): its lock
 * names a live process (the brain, or its runner between a crash and the restart), or its dashboard's port answers.
 * Port 0 (tests) is the system's choice: there's no telling where a brain would answer. With no config.json, no brain
 * has run in this directory (it writes one at its start), so another directory's brain's dashboard isn't asked.
 */
async function refuseWhileTheBrainRuns(dataDirectory: string, config: BrainConfig | null): Promise<void> {
  const brain = runningBrain(dataDirectory);
  if (brain !== null) {
    throw new Error(
      `the brain is running (its lock, ${brain.path}, names process ${brain.pid}` +
        `${brain.runnerPid === null ? "" : ` and its runner ${brain.runnerPid}`}): stop it first. If it isn't, ` +
        "delete that file",
    );
  }
  if (config !== null && config.dashboardPort !== 0 && (await answers(config.dashboardPort))) {
    throw new Error(`the brain's dashboard answers on 127.0.0.1:${config.dashboardPort}: stop the brain first`);
  }
}

/**
 * A compacted copy of the store at `filePath` (#297's re-review): a stale one there first removed, and a partial one
 * (the disk full, say) removed if it fails, so nothing half written is left looking like a good copy.
 */
function compactedCopy(store: TelemetryStore, filePath: string): void {
  rmSync(filePath, { force: true });
  try {
    store.vacuumInto(filePath);
  } catch (error) {
    rmSync(filePath, { force: true });
    throw error;
  }
}

try {
  const argv = process.argv.slice(2);
  const storePath = existingStorePath(argv, process.env);
  const dataDirectory = resolveDataDirectory(argv, process.env);
  const ownConfig = readConfig(dataDirectory);
  const config = ownConfig ?? defaultConfig();
  const environment = flagValue(argv, "--environment") === undefined ? config.environment : environmentFlag(argv);
  const daysText = flagValue(argv, "--kept-whole-days");
  const keptWholeDays =
    daysText === undefined ? (config.telemetryKeptWholeDays ?? DEFAULT_KEPT_WHOLE_DAYS) : Number(daysText);
  if (!isKeptWholeDays(keptWholeDays)) throw new Error("--kept-whole-days must be a whole number of days, at least 1");
  await refuseWhileTheBrainRuns(dataDirectory, ownConfig);
  const store = TelemetryStore.open(storePath);
  let open = true;
  try {
    const options = { context: { environment, release: brainRelease() }, nowMs: Date.now(), keptWholeDays };
    const wouldCut = thinStore(store, { ...options, dryRun: true });
    if (argv.includes("--dry-run")) {
      console.log(describeThinning(wouldCut));
    } else {
      if (cutAny(wouldCut) && !argv.includes("--no-backup")) {
        const backupPath = path.join(dataDirectory, `telemetry.pre-thinning-${fileTime(options.nowMs)}.sqlite`);
        compactedCopy(store, backupPath);
        console.log(`backed up first: ${backupPath} (${megabytes(statSync(backupPath).size)})`);
      }
      console.log(describeThinning(thinStore(store, options)));
      if (argv.includes("--vacuum")) {
        // A compacted copy beside the store, swapped in once the store is closed: nothing in the system's temp folder.
        const sizeBefore = statSync(storePath).size;
        const compactedPath = `${storePath}.compacted`;
        compactedCopy(store, compactedPath);
        store.close();
        open = false;
        // A brain started since would have the store open: the swap would pull the file from under it.
        try {
          await refuseWhileTheBrainRuns(dataDirectory, ownConfig);
        } catch (error) {
          rmSync(compactedPath, { force: true });
          throw new Error(`not compacted: ${error instanceof Error ? error.message : error}`);
        }
        // Closing checkpointed and removed the old file's log; one left over must never be read into the new file.
        for (const suffix of ["-wal", "-shm"]) rmSync(`${storePath}${suffix}`, { force: true });
        renameSync(compactedPath, storePath);
        console.log(`compacted: ${megabytes(sizeBefore)} → ${megabytes(statSync(storePath).size)}`);
      }
    }
  } finally {
    if (open) store.close();
  }
} catch (error) {
  console.error(`thin: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
