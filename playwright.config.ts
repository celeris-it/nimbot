import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/panel",
  testMatch: "**/*.e2e.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3199",
    browserName: "chromium",
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/panel/fixture.mjs",
    url: "http://127.0.0.1:3199/login",
    reuseExistingServer: false,
  },
});
