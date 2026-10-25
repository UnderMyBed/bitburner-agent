import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tools/**/*.test.ts"],
    globalSetup: ["packages/sim/test/global-setup.ts"],
    // Simulator tests fork processes that load a 16 MB engine (~1 s each); CI runners are slower than dev machines.
    testTimeout: 30_000,
  },
});
