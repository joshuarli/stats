import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "v2");
const fixtures = Object.fromEntries(readdirSync(fixtureDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
  const relative = join(entry.parentPath, entry.name).slice(fixtureDir.length + 1);
  const bytes = readFileSync(join(entry.parentPath, entry.name));
  return [relative, /\.st[ab]2$/u.test(entry.name) ? bytes.toString("base64") : bytes.toString("utf8")];
}));

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" }, miniflare: { bindings: { FIXTURES: JSON.stringify(fixtures), ENVIRONMENT: "test", TEST_NOW_MS: "1793510415000" } } })],
  test: { include: ["test/**/*.test.ts"], exclude: ["test/binary/**", "test/ingest/**", "test/deployments/**", "test/cost/**", "test/cli/**", "test/observe/**", "test/observe-e2e/**", "test/agent-e2e/**", "test/node/**"], testTimeout: 30_000 }
});
