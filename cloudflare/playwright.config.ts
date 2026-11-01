import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/ui",
  outputDir: "../.work/tmp/playwright",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173", trace: "off" },
  webServer: { command: "node scripts/serve.mjs", url: "http://127.0.0.1:4173", reuseExistingServer: true, timeout: 10_000 },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 720 } } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true } }
  ]
});
