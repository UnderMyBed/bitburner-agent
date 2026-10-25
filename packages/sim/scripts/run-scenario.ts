// npm run sim -- <scenario.json> [--seeds a..b | a,b,c] [--workers k] [--wall-limit minutes] [--max-heap MB]
//   [--json out.json]
// Runs a scenario once per seed and prints a table, with a progress line per seed per checkpoint on stderr
// (src/scenario/cli.ts). Exits 0 if every seed passed, 1 if any didn't, and 2 if it couldn't run at all. npm runs it
// from the repository root, so paths are relative to that.
import process from "node:process";
import { buildEngine } from "../src/engine/build.ts";
import { scenarioCli } from "../src/scenario/cli.ts";
import { runScenario } from "../src/scenario/run.ts";

process.exitCode = await scenarioCli(process.argv.slice(2), {
  buildEngine,
  runScenario,
  log: console.log,
  error: console.error,
});
