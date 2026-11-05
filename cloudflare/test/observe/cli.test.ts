import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, main } from "../../src/observe/client/cli.ts";
import { answer, buildScenario, SCENARIO_ROLLOUTS } from "../ui/observe-scenario.ts";

const now = Date.UTC(2026, 10, 4, 2, 0);
const scenario = await buildScenario(now);
const seen: { method: string; path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let failing = false;
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body = "";
  const decoder = new TextDecoder();
  for await (const chunk of request) body += decoder.decode(chunk as Uint8Array, { stream: true });
  body += decoder.decode();
  const url = new URL(request.url ?? "/", "http://observe");
  seen.push({ method: request.method ?? "GET", path: url.pathname.replace(/^\/api\/observe/u, ""), headers: request.headers, body });
  if (failing) { response.writeHead(503).end(); return; }
  const reply = await answer(scenario, now, new Request(`https://observe${url.pathname.replace(/^\/api\/observe/u, "")}${url.search}`, { method: request.method ?? "GET", headers: { "content-type": request.headers["content-type"] ?? "" }, ...(request.method === "POST" || request.method === "PUT" ? { body } : {}) }));
  response.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" });
  response.end(await reply.text());
}
const server = createServer((request, response) => { void handle(request, response); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/observe`;
const env = { OBSERVE_URL: base, OBSERVE_AUTH_COMMAND: "printf token-from-command", OBSERVE_AUTH_HEADER: "cf-access-token" };

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, env, line => out.push(line), line => err.push(line), now);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

await test("routes rank by CPU with percentiles, and every request carries the credential from the command", async () => {
  const result = await cli("routes", "--window", "24h");
  assert.equal(result.code, EXIT.ok);
  assert.match(result.out.split("\n")[1] ?? "", /^POST \/ingest\/v1\/batches/u);
  assert.match(result.out, /p95 cpu/u);
  assert.equal(seen.at(-1)?.headers["cf-access-token"], "token-from-command");
});

await test("a deployment reports its new issue, its regression, and failure rates, as text or JSON", async () => {
  const text = await cli("deployment", SCENARIO_ROLLOUTS.v14);
  assert.equal(text.code, EXIT.ok);
  assert.match(text.out, /^failed requests .+ -> .+$/mu);
  assert.match(text.out, /^new +RangeError \[installation\.request\]/mu);
  assert.match(text.out, /^regressed +TypeError/mu);
  assert.match(text.out, /^cpu +worker POST \/ingest\/v1\/batches +\d+\.\d{2} -> \d+\.\d{2} ms \([+-]\d+\.\d{2} ± \d+\.\d{2}(, beyond noise)?\) +\d+ -> \d+ calls$/mu);
  const json = await cli("deployment", SCENARIO_ROLLOUTS.v14, "--json");
  assert.equal((JSON.parse(json.out) as { newIssues: unknown[] }).newIssues.length, 1);
});

await test("the slowest traces open as a text waterfall with both stages", async () => {
  const traces = await cli("traces", "--route", "GET /api/v1/hosts/:host/history", "--slowest", "--json");
  const slowest = (JSON.parse(traces.out) as { traceId: string; wallMs: number }[]);
  assert.ok(slowest.length > 1 && slowest[0]!.wallMs >= slowest[1]!.wallMs);
  const trace = await cli("trace", slowest[0]!.traceId);
  assert.equal(trace.code, EXIT.ok);
  assert.match(trace.out, /^GET \/api\/v1\/hosts\/:host\/history +█/mu);
  assert.match(trace.out, /^ {2}Installation GET \/hosts\/:host\/history/mu);
});

await test("an issue copied from the text list opens with its stack", async () => {
  const list = await cli("issues");
  const row = list.out.split("\n").find(line => line.includes("RangeError"))!;
  const issue = await cli("issue", row.split(/ +/u)[0]!);
  assert.equal(issue.code, EXIT.ok, issue.err);
  assert.match(issue.out, /^RangeError/u);
});

await test("resolving sends the state with the API's own origin", async () => {
  const issues = JSON.parse((await cli("issues", "--json")).out) as { fingerprint: string; name: string }[];
  const target = issues.find(issue => issue.name === "RangeError")!;
  const result = await cli("resolve", target.fingerprint);
  assert.equal(result.code, EXIT.ok);
  const post = [...seen].reverse().find(request => request.method === "POST")!;
  assert.equal(post.headers["origin"], new URL(base).origin);
  assert.equal(post.body, JSON.stringify({ state: "resolved" }));
  assert.equal((await cli("reopen", target.fingerprint)).code, EXIT.ok);
});

await test("a source map registers once per version and file, and a different map is a conflict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "observe-cli-"));
  const path = join(directory, "index.js.map");
  writeFileSync(path, JSON.stringify({ version: 3, sources: ["../src/a.ts"], names: [], mappings: "AAAA" }));
  assert.equal((await cli("sourcemap", "v9.9.9", path)).out, "index.js for v9.9.9: accepted");
  assert.equal((await cli("sourcemap", "v9.9.9", path)).out, "index.js for v9.9.9: duplicate");
  const put = [...seen].reverse().find(request => request.method === "PUT")!;
  assert.equal(put.path, "/artifacts/v9.9.9/index.js");
  assert.equal(put.headers["origin"], new URL(base).origin);
  writeFileSync(path, JSON.stringify({ version: 3, sources: ["../src/b.ts"], names: [], mappings: "AAAA" }));
  assert.equal((await cli("sourcemap", "v9.9.9", path)).code, EXIT.conflict);
  rmSync(directory, { recursive: true, force: true });
});

await test("exit codes separate usage errors, missing items, and an unavailable collector", async () => {
  assert.equal((await cli()).code, EXIT.usage);
  assert.equal((await cli("trace", "not-a-trace")).code, EXIT.usage);
  assert.equal((await cli("routes", "--token", "secret")).code, EXIT.usage);
  assert.equal((await cli("trace", "f".repeat(32))).code, EXIT.notFound);
  assert.equal((await cli("issue", "a".repeat(64))).code, EXIT.notFound);
  failing = true;
  assert.equal((await cli("health")).code, EXIT.unavailable);
  failing = false;
  const unreachable = await main(["health"], { OBSERVE_URL: "http://127.0.0.1:9/api/observe" }, () => undefined, () => undefined, now);
  assert.equal(unreachable, EXIT.unavailable);
  assert.equal(await main(["health"], { OBSERVE_URL: base, OBSERVE_AUTH_COMMAND: "printf token" }, () => undefined, () => undefined, now), EXIT.usage);
});


await test("a sampled service's health, routes and traces say they are sampled", async () => {
  const sampling = { keepPerMillion: 10_000, kept: 12, observed: 1_000 };
  const route = { label: "GET /cart", requests: 12, observed: 1_000, failed: 1, cpuMs: 30, p50WallMs: 4, p95WallMs: 9, p99WallMs: 12, p50CpuMs: 1, p95CpuMs: 2 };
  const trace = { key: "k", traceId: "a".repeat(32), stage: "worker", kind: "fetch", label: "GET /cart", objectId: null, status: 200, outcome: "ok", failed: false, cpuMs: 1, wallMs: 5, atMs: now, version: null, errorCount: 0, objectInvocations: 0, objectCpuMs: 0 };
  const health = {
    newestAtMs: now, oldestAtMs: now, liveInvocations: 12, cleanupBacklog: 0, cleanupLagMs: 0, openIssues: 0, duplicate: 0, conflict: 0, expired: 0, future: 0, rejected: 0, issueCapacity: 0, evicted: 0, reasons: [],
    writes: { ingestBatches: 3, accepted: 12, ingestRows: 40, cleanupRows: 0 }, databaseBytes: 0,
    sampling: { policy: { kind: "sampled", keepPerMillion: 10_000, slowWallMs: 100, slowCpuMs: 10 }, kept: 12, sampledOut: 980, excluded: 8, untraced: 1, flushes: 3, capped: 2 }
  };
  const sampled = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://observe").pathname.replace(/^\/api\/observe/u, "");
    const body = path === "/health" ? health : path === "/explore" ? { fromMs: 0, toMs: 1, route: null, routes: [route], heatmap: { fromMs: 0, bucketMs: 1, edges: [], cells: [], failed: [], p95WallMs: [] }, sampling } : { items: [trace], next: null, sampling };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => sampled.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(sampled.address() as AddressInfo).port}/api/observe`;
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const code = await main(argv, { OBSERVE_URL: url }, line => out.push(line), () => undefined, now);
    return { code, out: out.join("\n") };
  };
  try {
    assert.match((await run("health")).out, /^sampled at 10000 per million \(slow at 100 ms wall or 10 ms cpu\): 1000 events observed, 12 kept, 980 sampled out, 8 excluded, 1 untraced, 3 flushed batches, 2 capped$/mu);
    const routes = await run("routes");
    assert.match(routes.out, /^sampled: .*12 kept of 1000 observed/u);
    assert.match(routes.out, /p50 \(sampled\).*p95 cpu \(sampled\)/u);
    assert.deepEqual((JSON.parse((await run("routes", "--json")).out) as { sampling: unknown }).sampling, sampling);
    assert.match((await run("traces")).out, /^sampled: only 12 kept of 1000 observed invocations are listed/u);
    assert.deepEqual((JSON.parse((await run("traces", "--json")).out) as { sampling: unknown }).sampling, sampling);
  } finally {
    sampled.close();
  }
});

server.close();
