import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { accessToken } from "../access-token.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const VARS = (JSON.parse(readFileSync(join(ROOT, "wrangler.test.jsonc"), "utf8")) as { vars: Record<string, string> }).vars;
const AGENT = process.env.STATS_AGENT_BIN ?? resolve(ROOT, "../agent/target/debug/stats");
const SCRATCH = resolve(ROOT, "../.work/tmp");

async function run(binary: string, config: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(binary, ["--config", config], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  await new Promise(resolve => setTimeout(resolve, 1500));
  child.kill("SIGTERM");
  const code = await new Promise<number | null>(resolve => child.on("exit", resolve));
  return { code, stderr };
}

await test("the real agent binary delivers a binary batch that the real Worker and Durable Object store", async () => {
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [{
        name: "stats",
        modules: true,
        scriptPath: join(ROOT, ".cloudflare/output/v0/workers/default/bundle/index.js"),
        compatibilityDate: "2026-10-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { ...VARS, TEST_NOW_MS: String(Date.now()) },
        durableObjects: { INSTALLATION: { className: "Installation", useSQLite: true } }
      }]
    }),
    host: "127.0.0.1",
    port: 0
  });
  const scratch = mkdtempSync(join(SCRATCH, "agent-e2e-"));
  try {
    const origin = (await mf.ready).origin;
    const access = { "cf-access-jwt-assertion": await accessToken() };
    const created = await mf.dispatchFetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name: "agent-e2e" }) });
    assert.equal(created.status, 201);
    const host = await created.json() as { hostId: string; token: string };
    const token = join(scratch, "token");
    const config = join(scratch, "agent.json");
    writeFileSync(token, host.token);
    writeFileSync(config, JSON.stringify({ endpoint: origin, hostId: host.hostId, tokenFile: token, sampleIntervalMs: 15_000, uploadIntervalMs: 10_000, maxQueueSamples: 16, requestTimeoutMs: 5_000 }));
    chmodSync(token, 0o600);
    chmodSync(config, 0o600);

    const { code, stderr } = await run(AGENT, config);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /accepted=1 duplicates=0 rejected_by_server=0 dropped_local=0 upload_failures=0/u, stderr);

    const latest = await mf.dispatchFetch(`${origin}/api/v1/hosts/${host.hostId}/latest`, { headers: access });
    assert.equal(latest.status, 200);
    const body = await latest.json() as { sample: { seq: string; atMs: string; monoMs: string; cpu?: unknown; mem?: unknown } };
    assert.match(body.sample.seq, /^[0-9]+$/u);
    assert.equal(BigInt(body.sample.seq), BigInt(body.sample.monoMs) / 1000n);
    assert.ok(body.sample.cpu !== undefined && body.sample.mem !== undefined);
    const system = await mf.dispatchFetch(`${origin}/api/v1/hosts/${host.hostId}/system`, { headers: access });
    assert.equal(system.status, 200);
    assert.match((await system.json() as { system: { agent: string } }).system.agent, /^[0-9]+\.[0-9]+\.[0-9]+/u);

    const retired = await mf.dispatchFetch(`${origin}/ingest/v1/batches`, { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(retired.status, 410);
  } finally {
    await mf.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});
