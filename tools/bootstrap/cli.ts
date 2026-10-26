// npm run bootstrap (tools/bootstrap/bootstrap.ts): the submodule, the packages and the game's dependencies, in order.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { BOOTSTRAP_STEPS, bootstrap } from "./bootstrap.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

process.exitCode = bootstrap(
  BOOTSTRAP_STEPS,
  (command, args) => {
    // npm is a .cmd script on Windows, which only a shell runs; the arguments here are fixed, never user input.
    const result = spawnSync(command, args, {
      cwd: REPOSITORY_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return result.status ?? 1;
  },
  (line) => console.log(line),
);
