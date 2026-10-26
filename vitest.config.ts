import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tools/**/*.test.ts"],
    // E2's browser tests run on demand with their own config (npm run e2, packages/e2/vitest.config.ts).
    exclude: [...configDefaults.exclude, "**/*.e2.test.ts"],
    globalSetup: ["packages/sim/test/global-setup.ts"],
    // Simulator tests fork processes that load a 16 MB engine (~1 s each); CI runners are slower than dev machines.
    testTimeout: 30_000,
  },
});
