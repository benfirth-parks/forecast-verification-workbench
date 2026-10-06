import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  use: { baseURL: "http://localhost:5179", launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined } },
  webServer: {
    command: "rm -rf .e2e-db && WORKBENCH_DB_DIR=./.e2e-db npx vite --port 5179 --strictPort",
    url: "http://localhost:5179",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
