import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Timeouts only guard against hangs; no test asserts how fast anything is.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
