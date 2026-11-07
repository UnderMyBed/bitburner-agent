// The data backup's copy of the telemetry store (#284, data-backup.ts), in a worker thread so the brain's event loop
// never waits on it: `VACUUM INTO` on a read-only connection of its own, one read transaction, so the copy is the store
// as it was at one moment however the brain writes meanwhile (WAL: its writes don't wait on a reader), and compacted.
// Then the restore check: the copy opened on its own and `PRAGMA quick_check`ed. Posts `{ ok: true }`, or
// `{ ok: false, failure }`. Plain Node runs it (type stripping): it imports nothing of the repo's.
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

/** As the brain's own connection (telemetry-store.ts): how long to wait on a lock before failing. */
const BUSY_TIMEOUT_MS = 5_000;

const { storePath, copyPath } = workerData as { storePath: string; copyPath: string };
try {
  const store = new DatabaseSync(storePath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    store.prepare("VACUUM INTO ?").run(copyPath);
  } finally {
    store.close();
  }
  const copy = new DatabaseSync(copyPath, { readOnly: true });
  let check: unknown[];
  try {
    check = copy.prepare("PRAGMA quick_check").all();
  } finally {
    copy.close();
  }
  const problems = check.map((row) => (row as { quick_check: unknown }).quick_check).filter((each) => each !== "ok");
  parentPort?.postMessage(
    problems.length === 0 && check.length > 0
      ? { ok: true }
      : { ok: false, failure: `the copy failed its check: ${JSON.stringify(problems).slice(0, 300)}` },
  );
} catch (error) {
  parentPort?.postMessage({ ok: false, failure: error instanceof Error ? error.message : String(error) });
}
