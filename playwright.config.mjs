// Browser end-to-end tests: `npm run build` first, then `npm run test:e2e`.
// The server runs with paid processing switched off, and every /api request is intercepted in the
// browser (see e2e/), so these tests can never reach Meta, Baseten, or the usage store.
import { defineConfig, devices } from "@playwright/test";

const port = 3100;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.mjs",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    // Real environment variables override .env.local, so the server refuses paid work even if a
    // browser-side mock were missed.
    env: { PAID_PROCESSING_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
