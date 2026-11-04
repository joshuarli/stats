import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
  const reply = await answer(scenario, now, new Request(`https://observe${url.pathname.replace(/^\/api\/observe/u, "")}${url.search}`, { method: request.method ?? "GET", headers: { "content-type": request.headers["content-type"] ?? "" }, ...(request.method === "POST" ? { body } : {}) }));
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

server.close();
