// npm run e2:install: downloads Playwright's Chromium headless shell, once, into .cache/e2/browsers/ (not the user's
// profile, so deleting .cache/e2 removes it). The E2 tests' Vitest config points Playwright there.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { BROWSERS_DIRECTORY } from "../src/paths.ts";

const playwrightCli = path.join(
  path.dirname(createRequire(import.meta.url).resolve("playwright/package.json")),
  "cli.js",
);
const run = spawnSync(process.execPath, [playwrightCli, "install", "--only-shell", "chromium"], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIRECTORY },
});
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
