// npm run e2's global setup: the simulator's (it makes the saves the tests load), and the run's count of retried
// fixture loads (#120, src/retried-loads.ts): a file the test files append to, judged once they've all run.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import simulatorSetup from "../../sim/test/global-setup.ts";
import { RETRIED_LOADS_FILE_VARIABLE, readRetriedLoads, retriedLoadsVerdict } from "../src/retried-loads.ts";

export default async function setup(): Promise<() => void> {
  await simulatorSetup();
  const directory = mkdtempSync(path.join(os.tmpdir(), "e2-run-"));
  const file = path.join(directory, "retried-loads.jsonl");
  // Set before the test files' workers start, which inherit it.
  process.env[RETRIED_LOADS_FILE_VARIABLE] = file;
  return () => {
    const { failed, summary } = retriedLoadsVerdict(readRetriedLoads(file));
    rmSync(directory, { recursive: true, force: true });
    if (summary === null) return;
    // Loud either way: a release run reports this line (docs/releasing.md).
    console.error(`\n${summary}\n`);
    if (failed) throw new Error(summary);
  };
}
