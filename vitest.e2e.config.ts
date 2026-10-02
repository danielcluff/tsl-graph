import { defineConfig } from "vitest/config";

// Browser tests for the canvas (real mouse input against the editor in headless Chromium).
// `pnpm test:e2e`; needs Playwright's Chromium (`npx playwright-core install chromium`).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    globalSetup: ["tests/e2e/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
