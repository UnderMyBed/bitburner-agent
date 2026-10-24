// Runs in a child process: install the DOM (unless --no-dom), load the engine bundle, report what it says.
import { installDom } from "../../src/host/dom.ts";
import { loadEngine } from "../../src/host/load-engine.ts";

if (!process.argv.includes("--no-dom")) installDom();
const engine = loadEngine();
process.stdout.write(JSON.stringify({ versionNumber: engine.versionNumber(), gameCommit: engine.gameCommit() }));
// The game starts module-level timers on import; exit explicitly instead of waiting for them.
process.exit(0);
