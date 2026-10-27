// npm run brain [-- --data-dir <dir>]: runs the brain (main.ts) from the repo, and starts it again after a crash
// (restart-on-crash.ts), in this terminal. Ctrl+C stops it for good. Its arguments go to the brain as they are.
import path from "node:path";
import process from "node:process";
import { restartOnCrash } from "./restart-on-crash.ts";

const BRAIN_MAIN = path.join(import.meta.dirname, "main.ts");

const runner = restartOnCrash({
  command: process.execPath,
  args: [BRAIN_MAIN, ...process.argv.slice(2)],
  // A crash loop backs off; a run of 5 minutes or more starts the row over.
  restartDelaysMs: [5_000, 10_000, 30_000, 60_000],
  steadyRunMs: 5 * 60_000,
  log: (line) => console.log(`${new Date().toISOString()} brain runner: ${line}`),
});

// Ctrl+C, Ctrl+Break and the console closing reach the brain too, and it shuts down by itself. SIGTERM reaches only
// this process, so it's passed on.
for (const signal of ["SIGINT", "SIGBREAK", "SIGHUP"] as const) process.on(signal, () => void runner.stop());
process.on("SIGTERM", () => void runner.stop({ forward: "SIGTERM" }));

await runner.finished;
