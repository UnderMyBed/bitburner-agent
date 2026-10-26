// npm run e2: the E2 tests, which drive the built game in Playwright's Chromium (packages/e2/README.md). Not part of
// `npm test` or CI: E2 is a heavy tier, run on demand (architecture §9.3, ADR 0004). One file at a time, one browser.
import { defineConfig } from "vitest/config";
import { BROWSERS_DIRECTORY } from "./src/paths.ts";

export default defineConfig({
  test: {
    include: ["packages/e2/test/**/*.e2.test.ts"],
    // The simulator makes the saves the tests load.
    globalSetup: ["packages/sim/test/global-setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    // Read by Playwright when it's first imported: the browser e2:install downloaded.
    env: { PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIRECTORY },
  },
});
