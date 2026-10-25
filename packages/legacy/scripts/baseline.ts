// npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--wall-limit minutes]
//   [--max-heap MB] [--json out.json]
// The fork baseline's CLI (src/cli.ts, docs/sim/baselines.md), with progress lines on stderr. Exits 0 if every seed
// reached 12 virtual hours, 1 if any didn't, and 2 if it couldn't run at all.
import path from "node:path";
import process from "node:process";
import { buildEngine, commitId, rigId, runScenario } from "@bitburner-agent/sim";
import { baselineCli } from "../src/cli.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

process.exitCode = await baselineCli(process.argv.slice(2), {
  buildEngine,
  runScenario,
  commit: () => commitId(REPO_ROOT),
  rig: rigId,
  now: () => new Date(),
  node: process.version,
  // npm runs this from the workspace; paths are relative to where npm was run, as the bench's --out is.
  cwd: process.env.INIT_CWD ?? process.cwd(),
  log: console.log,
  error: console.error,
});
