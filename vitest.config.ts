import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    globalSetup: ["packages/sim/test/global-setup.ts"],
  },
});
