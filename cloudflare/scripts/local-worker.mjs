import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { CLOUDFLARE_ROOT, OBSERVE_OUTPUT, STATS_OUTPUT, miniflareOptions, readBuiltWorker, readTestVars, rejectAndRecord } from "../local/topology.ts";

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: node scripts/local-worker.mjs <command> [args...]  (runs the command with STATS_URL pointing at the built Worker)");
  process.exit(2);
}
const scratch = join(CLOUDFLARE_ROOT, "../.work/tmp");
mkdirSync(scratch, { recursive: true });
const persist = mkdtempSync(join(scratch, "local-worker-"));
const { ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_JWKS_JSON } = readTestVars();
const outbound = rejectAndRecord();
const mf = new Miniflare({
  ...miniflareOptions(readBuiltWorker(STATS_OUTPUT), readBuiltWorker(OBSERVE_OUTPUT), {
    text: { ENVIRONMENT: "test" },
    secrets: { ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_JWKS_JSON, TEST_NOW_MS: String(Date.now()) },
    analytics: "unbound",
    collector: { kind: "attached" },
    outbound: outbound.handler,
    persist,
    alarms: "platform"
  }),
  host: "127.0.0.1",
  port: 0
});
let code = 1;
try {
  const origin = (await mf.ready).origin;
  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, STATS_URL: origin } });
  code = await new Promise(resolve => child.on("exit", status => resolve(status ?? 1)));
} finally {
  await mf.dispose();
  rmSync(persist, { recursive: true, force: true });
}
if (outbound.requests.length > 0) {
  console.error(`local-worker: unexpected outbound requests: ${outbound.requests.join(", ")}`);
  if (code === 0) code = 1;
}
process.exit(code);
