import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "v1");
const fixtures = Object.fromEntries(readdirSync(fixtureDir).map(name => [name, readFileSync(join(fixtureDir, name), "utf8")]));

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" }, miniflare: { bindings: { FIXTURES: JSON.stringify(fixtures), ENVIRONMENT: "test", TEST_NOW_MS: "1793510415000" } } })],
  test: { include: ["test/**/*.test.ts"], exclude: ["test/binary/**", "test/deployments/**", "test/observe/**", "test/observe-e2e/**"], testTimeout: 30_000 }
});
