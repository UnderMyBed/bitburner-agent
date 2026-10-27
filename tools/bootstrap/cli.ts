// npm run bootstrap (tools/bootstrap/bootstrap.ts): the submodule, the packages and the game's dependencies, in order.
import path from "node:path";
import { BOOTSTRAP_STEPS, bootstrap, runCommandIn } from "./bootstrap.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

process.exitCode = bootstrap(BOOTSTRAP_STEPS, runCommandIn(REPOSITORY_ROOT), (line) => console.log(line));
