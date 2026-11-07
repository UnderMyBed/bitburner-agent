// npm run campaign -- [--data-dir <dir>] [--environment E0]
// The campaign report (#290): clear time, cycles and installs per BitNode, per release, over the whole store
// (campaign-report.ts). Read-only, so safe while the brain runs. Exits 0 with the report, 2 when it couldn't run: no
// store, or no slow snapshot in it showing a BitNode.
import process from "node:process";
import { campaignReport } from "./campaign-report.ts";
import { environmentFlag, existingStorePath } from "./config.ts";
import { TelemetryStore } from "./telemetry-store.ts";

try {
  const argv = process.argv.slice(2);
  const storePath = existingStorePath(argv, process.env);
  const environment = environmentFlag(argv);
  const store = TelemetryStore.openReadOnly(storePath);
  try {
    console.log(campaignReport(store, { environment }));
  } finally {
    store.close();
  }
} catch (error) {
  console.error(`campaign: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
