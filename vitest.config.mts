import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path("./src"),
      // `server-only` throws outside React Server Components; tests import server modules directly.
      "server-only": path("./node_modules/server-only/empty.js"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    env: {
      // Each test file gets its own fresh in-memory database with a small seed.
      DATABASE_PATH: ":memory:",
      SEED_SCALE: "0.01",
      MOCK_NOW: "2026-10-13T12:00:00.000Z",
    },
  },
});
