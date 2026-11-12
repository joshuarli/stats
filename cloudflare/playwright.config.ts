import { availableParallelism } from "node:os";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { defineConfig } from "@playwright/test";

const scratch = resolve(import.meta.dirname, "../.work/tmp");
mkdirSync(scratch, { recursive: true });
const run = process.env["STATS_BROWSER_RUN"] ?? mkdtempSync(join(scratch, "playwright-"));
process.env["STATS_BROWSER_RUN"] = run;
process.env["CLOUDFLARE_DEV_REGISTRY_PATH"] = join(run, "registry");

export default defineConfig({
  testDir: "./test/ui",
  outputDir: join(run, "results"),
  timeout: 30_000,
  fullyParallel: true,
  workers: Math.max(1, Math.min(availableParallelism(), 8)),
  use: { trace: "off" },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 720 } }, grepInvert: /@mobile-only/u },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true }, grep: /@mobile/u }
  ]
});
