import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vars = JSON.parse(readFileSync(join(root, "wrangler.test.jsonc"), "utf8")).vars;
const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: node scripts/local-worker.mjs <command> [args...]  (runs the command with STATS_URL pointing at the built Worker)");
  process.exit(2);
}
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    workers: [{
      name: "stats",
      modules: true,
      scriptPath: join(root, ".cloudflare/output/v0/workers/default/bundle/index.js"),
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { ...vars, TEST_NOW_MS: String(Date.now()) },
      durableObjects: { INSTALLATION: { className: "Installation", useSQLite: true } }
    }]
  }),
  host: "127.0.0.1",
  port: 0
});
const origin = (await mf.ready).origin;
const { spawn } = await import("node:child_process");
const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, STATS_URL: origin } });
const code = await new Promise(resolve => child.on("exit", resolve));
await mf.dispose();
process.exit(code ?? 1);
