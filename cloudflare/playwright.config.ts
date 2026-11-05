import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/ui",
  outputDir: "../.work/tmp/playwright",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173", trace: "off" },
  webServer: [
    { command: "node scripts/serve.mjs", url: "http://127.0.0.1:4173", reuseExistingServer: true, timeout: 10_000 },
    {
      command: "rm -rf ../.work/tmp/playwright-node && mkdir -p ../.work/tmp/playwright-node && exec node --experimental-strip-types src/node/main.ts",
      url: "http://127.0.0.1:4175/health",
      env: { STATS_DATA_DIR: "../.work/tmp/playwright-node", STATS_LISTEN: "127.0.0.1:4175", STATS_ALLOWED_LOGINS: "playwright@example.com" },
      reuseExistingServer: true,
      timeout: 10_000
    }
  ],
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 720 } }, grepInvert: /@mobile-only/u },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true }, grep: /@mobile/u }
  ]
});
