import { defineConfig } from "@playwright/test";

const PORT = 3100;

/**
 * End-to-end tests against a production build with its own, freshly seeded database
 * (a tenth of the demo data, for speed). They share that database, so they run one
 * after another. The browser is the installed Google Chrome (`channel: "chrome"`);
 * `npx playwright install chromium` and dropping `channel` works too.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    locale: "en-US",
    timezoneId: "Europe/Kyiv",
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `rm -rf .e2e && npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/settings`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: { DATABASE_PATH: ".e2e/e2e.db", SEED_SCALE: "0.1" },
  },
});
