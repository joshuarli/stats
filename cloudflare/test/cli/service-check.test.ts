import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { fakeOrigin, runCli, sendJson, type Handler } from "./support.ts";

const HOST_A = `h_${"a".repeat(32)}`;
const HOST_B = `h_${"b".repeat(32)}`;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
}

interface Fixture {
  readonly origin: string;
  readonly seen: Seen[];
  service: Record<string, unknown>;
  probeStatus: number;
  history: Record<string, unknown>;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  let service: Record<string, unknown> = {};
  let probeStatus = 200;
  let history: Record<string, unknown> = { projectId: "web", worker: "web", enabled: true, sync: null, versions: [], deployments: [], markers: [] };
  const seen: Seen[] = [];
  const handler: Handler = (request, response) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(probeStatus, { "content-type": "text/plain" });
      response.end(probeStatus >= 200 && probeStatus < 300 ? "ok" : "bad");
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/services/web") return sendJson(response, service);
    if (request.method === "GET" && request.url === "/api/v1/services/web/deployments") return sendJson(response, history);
    sendJson(response, { error: { code: "not_found", message: "missing" } }, 404);
  };
  const server = await fakeOrigin(handler);
  return {
    origin: server.origin,
    seen,
    get service() { return service; },
    set service(value) { service = value; },
    get probeStatus() { return probeStatus; },
    set probeStatus(value) { probeStatus = value; },
    get history() { return history; },
    set history(value) { history = value; },
    close: () => server.close()
  };
}

const deployment = {
  id: "11111111-1111-4111-8111-111111111111",
  atMs: 1_700_000_100_000,
  source: "marker",
  message: "release",
  versions: [{ id: "1.2.3", percentage: 100 }],
  deferred: false
};

const marked = {
  projectId: "web",
  worker: "web",
  enabled: true,
  sync: null,
  versions: [],
  deployments: [deployment],
  markers: [{ deploymentId: deployment.id, markerId: "v-1.2.3", hostIds: [HOST_A] }]
};

await test("service check reports an up probe, the latest marker, and sends no credential", async () => {
  const target = await fixture();
  target.service = { name: "web", hostIds: [HOST_A, HOST_B], healthUrl: `${target.origin}/health`, unit: "web.service", createdAtMs: 1_700_000_000_000 };
  target.history = marked;
  try {
    const run = await runCli(["service", "check", "--service", "web", "--origin", target.origin, "--json"], {});
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const payload = (JSON.parse(run.stdout) as { payload: { probe: { state: string; status: number }; latest: { version: string; markerId: string }; healthUrl: string; hostIds: string[] } }).payload;
    assert.equal(payload.probe.state, "up");
    assert.equal(payload.probe.status, 200);
    assert.equal(payload.latest.version, "1.2.3");
    assert.equal(payload.latest.markerId, "v-1.2.3");
    assert.equal(payload.healthUrl, `${target.origin}/health`);
    assert.deepEqual(payload.hostIds, [HOST_A, HOST_B]);

    const api = target.seen.filter(item => item.url.startsWith("/api/v1/"));
    const probe = target.seen.filter(item => item.url === "/health");
    assert.equal(api.length, 2);
    assert.ok(api.every(item => item.headers["cf-access-token"] === undefined && item.headers["authorization"] === undefined));
    assert.equal(probe.length, 1);
    assert.equal(probe[0]?.headers["cf-access-token"], undefined);

    const text = await runCli(["service", "check", "--service", "web", "--origin", target.origin], {});
    assert.equal(text.code, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /probe: up, status 200/u);
    assert.match(text.stdout, /latest marker: 1\.2\.3/u);
  } finally {
    await target.close();
  }
});

await test("service check reports a failing probe as regressed", async () => {
  const target = await fixture();
  target.service = { name: "web", hostIds: [HOST_A], healthUrl: `${target.origin}/health`, unit: null, createdAtMs: 1_700_000_000_000 };
  target.history = marked;
  target.probeStatus = 503;
  try {
    const run = await runCli(["service", "check", "--service", "web", "--origin", target.origin, "--json"], {});
    assert.equal(run.code, 7, run.stdout + run.stderr);
    const payload = (JSON.parse(run.stdout) as { payload: { probe: { state: string; status: number; detail: string } } }).payload;
    assert.equal(payload.probe.state, "down");
    assert.equal(payload.probe.status, 503);
    assert.match(payload.probe.detail, /failing status/u);
  } finally {
    await target.close();
  }
});

await test("service check treats a missing health URL, a missing marker, and an unreachable URL as pending", async () => {
  const unconfigured = await fixture();
  unconfigured.service = { name: "web", hostIds: [HOST_A], healthUrl: null, unit: null, createdAtMs: 1_700_000_000_000 };
  unconfigured.history = marked;
  try {
    const run = await runCli(["service", "check", "--service", "web", "--origin", unconfigured.origin, "--json"], {});
    assert.equal(run.code, 5, run.stdout + run.stderr);
    const payload = (JSON.parse(run.stdout) as { payload: { probe: { state: string; detail: string } } }).payload;
    assert.equal(payload.probe.state, "unavailable");
    assert.match(payload.probe.detail, /no health URL/u);
    assert.equal(unconfigured.seen.some(item => item.url === "/health"), false);
  } finally {
    await unconfigured.close();
  }

  const unmarked = await fixture();
  unmarked.service = { name: "web", hostIds: [HOST_A], healthUrl: `${unmarked.origin}/health`, unit: null, createdAtMs: 1_700_000_000_000 };
  try {
    const run = await runCli(["service", "check", "--service", "web", "--origin", unmarked.origin, "--json"], {});
    assert.equal(run.code, 5, run.stdout + run.stderr);
    const payload = (JSON.parse(run.stdout) as { payload: { latest: unknown; probe: { state: string } } }).payload;
    assert.equal(payload.latest, null);
    assert.equal(payload.probe.state, "up");
  } finally {
    await unmarked.close();
  }

  const unreachable = await fixture();
  unreachable.service = { name: "web", hostIds: [HOST_A], healthUrl: "http://127.0.0.1:1/health", unit: null, createdAtMs: 1_700_000_000_000 };
  unreachable.history = marked;
  try {
    const run = await runCli(["service", "check", "--service", "web", "--origin", unreachable.origin, "--json"], {});
    assert.equal(run.code, 5, run.stdout + run.stderr);
    const payload = (JSON.parse(run.stdout) as { payload: { probe: { state: string; status: number | null } } }).payload;
    assert.equal(payload.probe.state, "unavailable");
    assert.equal(payload.probe.status, null);
  } finally {
    await unreachable.close();
  }
});
