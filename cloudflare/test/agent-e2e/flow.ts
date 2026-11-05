import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const AGENT = process.env.STATS_AGENT_BIN ?? resolve(ROOT, "../agent/target/debug/stats");
const SCRATCH = resolve(ROOT, "../.work/tmp");

export interface AgentTarget {
  readonly origin: string;
  readonly credentials: Readonly<Record<string, string>>;
  request(url: string, init?: RequestInit): Promise<Response>;
}

async function run(binary: string, config: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(binary, ["--config", config], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  await new Promise(resolve => setTimeout(resolve, 1500));
  child.kill("SIGTERM");
  const code = await new Promise<number | null>(resolve => child.on("exit", resolve));
  return { code, stderr };
}

export async function agentDeliversABatch(target: AgentTarget): Promise<{ hostId: string; token: string }> {
  const scratch = mkdtempSync(join(SCRATCH, "agent-e2e-"));
  try {
    const { origin, credentials } = target;
    const created = await target.request(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...credentials, "Content-Type": "application/json" }, body: JSON.stringify({ name: "agent-e2e" }) });
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

    const latest = await target.request(`${origin}/api/v1/hosts/${host.hostId}/latest`, { headers: credentials });
    assert.equal(latest.status, 200);
    const body = await latest.json() as { sample: { seq: string; atMs: string; monoMs: string; cpu?: unknown; mem?: unknown } };
    assert.match(body.sample.seq, /^[0-9]+$/u);
    assert.equal(BigInt(body.sample.seq), BigInt(body.sample.monoMs) / 1000n);
    assert.ok(body.sample.cpu !== undefined && body.sample.mem !== undefined);
    const system = await target.request(`${origin}/api/v1/hosts/${host.hostId}/system`, { headers: credentials });
    assert.equal(system.status, 200);
    assert.match((await system.json() as { system: { agent: string } }).system.agent, /^[0-9]+\.[0-9]+\.[0-9]+/u);

    const retired = await target.request(`${origin}/ingest/v1/batches`, { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(retired.status, 410);
    return host;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
