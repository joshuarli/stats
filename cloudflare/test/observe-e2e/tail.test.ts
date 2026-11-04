import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { accessHeaders, createHost, HOST_NAME, ingest, SECRET_QUERY, start, until, VARS, workerTraces, ORIGIN, type Collector, type IssueSummary, type Page, type TraceDetail, type TraceSummary } from "./harness.ts";

function listing(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(String);
}

function storedText(root: string): string {
  const texts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".sqlite") && dir.includes("ObservationStore")) {
        const db = new DatabaseSync(path, { readOnly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'observe_%'").all() as { name: string }[];
        for (const { name: table } of tables) texts.push(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()));
        db.close();
      }
    }
  };
  walk(root);
  return texts.join("\n");
}

await test("real stats traffic is stored as linked traces, grouped issues, and nothing secret", async () => {
  const harness = await start("attached");
  try {
    const host = await createHost(harness);
    assert.equal((await ingest(harness, host)).status, 200);
    assert.equal((await harness.stats("/api/v1/hosts", { headers: await accessHeaders() })).status, 200);
    await harness.scheduled().catch(() => undefined);
    await until(() => workerTraces(harness), items => {
      const labels = new Set(items.map(item => item.label));
      return ["POST /ingest/v1/batches", "GET /api/v1/hosts", "POST /api/v1/admin/hosts", "scheduled */5 * * * *"].every(label => labels.has(label))
        && items.every(item => item.label !== "POST /ingest/v1/batches" || item.objectInvocations >= 1);
    }, "the requests' traces");
    await until(async () => (await harness.observe("/issues") as Page<IssueSummary>).items, items => items.some(issue => issue.operation === "deployments.poll"), "the poll failure issue");

    const traces = (await (await harness.stats("/api/observe/traces", { headers: await accessHeaders() })).json()) as Page<TraceSummary>;
    const byLabel = new Map(traces.items.map(trace => [trace.label, trace]));
    const ingestTrace = byLabel.get("POST /ingest/v1/batches");
    assert.ok(ingestTrace?.traceId, `labels: ${[...byLabel.keys()].join(", ")}`);
    assert.equal(ingestTrace.objectInvocations, 1);
    assert.ok(byLabel.has("GET /api/v1/hosts"));
    assert.ok(byLabel.has("POST /api/v1/admin/hosts"));
    const scheduled = byLabel.get("scheduled */5 * * * *");
    assert.ok(scheduled?.failed, "the scheduled run fails without analytics and is marked failed");

    const detail = (await (await harness.stats(`/api/observe/traces/${ingestTrace.traceId}`, { headers: await accessHeaders() })).json()) as TraceDetail;
    assert.equal(detail.rootPresent, true);
    assert.deepEqual(detail.invocations.map(invocation => invocation.label), ["POST /ingest/v1/batches", "Installation POST /ingest"]);

    const issues = (await (await harness.stats("/api/observe/issues", { headers: await accessHeaders() })).json()) as Page<IssueSummary>;
    const poll = issues.items.find(issue => issue.operation === "deployments.poll");
    assert.ok(poll, `issues: ${issues.items.map(issue => `${issue.operation}:${issue.name}`).join(", ")}`);
    assert.ok(poll.frame?.includes("src/deployments/collector.ts") || poll.frame?.includes("index.js"), poll.frame ?? "no frame");
    assert.ok(issues.items.some(issue => issue.operation === null && issue.name === "TypeError"), "the collector's uncaught failure is its own issue");
    assert.ok(scheduled.traceId !== null);
    const scheduledDetail = (await (await harness.stats(`/api/observe/traces/${scheduled.traceId}`, { headers: await accessHeaders() })).json()) as TraceDetail;
    assert.ok(scheduledDetail.occurrences.some(occurrence => occurrence.operation === "deployments.poll"), "the caught poll failure links to its scheduled trace");

    const before = (await workerTraces(harness)).length;
    for (let i = 0; i < 100; i++) {
      const response = await harness.stats(i % 2 === 0 ? "/api/observe/traces" : "/api/observe/health", { headers: await accessHeaders() });
      assert.equal(response.status, 200);
    }
    assert.equal((await harness.stats("/health")).status, 200);
    assert.equal((await harness.stats("/api/v1/projects", { headers: await accessHeaders() })).status, 200);
    const after = await until(() => workerTraces(harness), items => items.some(item => item.label === "GET /api/v1/projects"), "the sentinel request");
    assert.equal(after.length, before + 1, "polling the observability API stores nothing");
    assert.ok(after.every(item => !item.label.includes("/api/observe") && !item.label.includes("/health")));

    await harness.stop();
    const stored = storedText(harness.persist);
    assert.ok(stored.length > 0, `no observation store under ${harness.persist}: ${listing(harness.persist).join(", ")}`);
    assert.ok(stored.includes("POST /ingest/v1/batches") && stored.includes("deployments.poll"), "the scan reads the stored invocations and occurrences");
    for (const secret of [host.token, SECRET_QUERY, "SECRET_COOKIE", "SECRET_DEPLOY_TOKEN", "REDACTED", "cf-access-jwt-assertion", HOST_NAME]) {
      assert.ok(!stored.includes(secret), `stored telemetry contains ${secret}`);
    }
  } finally {
    await harness.dispose();
  }
});

await test("the observability API rejects unauthenticated and cross-origin requests", async () => {
  const harness = await start("attached");
  try {
    assert.equal((await harness.stats("/api/observe/traces")).status, 401);
    const fingerprint = "a".repeat(64);
    const crossOrigin = await harness.stats(`/api/observe/issues/${fingerprint}/state`, { method: "POST", headers: await accessHeaders({ Origin: "https://evil.example", "Content-Type": "application/json" }), body: JSON.stringify({ state: "resolved" }) });
    assert.equal(crossOrigin.status, 403);
    const sameOrigin = await harness.stats(`/api/observe/issues/${fingerprint}/state`, { method: "POST", headers: await accessHeaders({ Origin: ORIGIN, "Content-Type": "application/json" }), body: JSON.stringify({ state: "resolved" }) });
    assert.equal(sameOrigin.status, 404);
    assert.equal((await harness.stats("/api/observe/traces?cursor=1'%20OR%201", { headers: await accessHeaders() })).status, 400);
    assert.equal((await harness.stats("/api/observe/traces", { method: "DELETE", headers: await accessHeaders() })).status, 405);
  } finally {
    await harness.dispose();
  }
});

await test("a crashing or missing collector leaves stats responses unchanged", async () => {
  const transcript = async (collector: Collector): Promise<string[]> => {
    const harness = await start(collector);
    try {
      const host = await createHost(harness);
      const responses = [
        await ingest(harness, host),
        await ingest(harness, { ...host, token: "wrong" }),
        await harness.stats("/api/v1/hosts", { headers: await accessHeaders() }),
        await harness.stats("/api/v1/projects", { headers: await accessHeaders() }),
        await harness.stats("/health")
      ];
      const lines = await Promise.all(responses.map(async response => `${response.status} ${response.headers.get("content-type") ?? ""} ${(await response.text()).replaceAll(host.hostId, "<host>")}`));
      const outcome = await harness.scheduled().then(() => "resolved", (error: unknown) => `rejected ${String(error)}`);
      return [...lines, outcome];
    } finally {
      await harness.dispose();
    }
  };
  const attached = await transcript("attached");
  assert.deepEqual(await transcript("crashing"), attached);
  assert.deepEqual(await transcript("absent"), attached);
});

const DEPLOYMENT = "0b5b2c1e-0f0a-4c4a-9d8e-1a2b3c4d5e6f";
const DEPLOYED_VERSION = "2221f9c2-9bd2-4011-bebb-52133d498752";
const STATS_PROJECT = { id: "stats", name: "stats", worker: "stats", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [] };

await test("a polled Cloudflare deployment reaches the store as a rollout, readable only through Access", async () => {
  const atMs = Number(VARS["TEST_NOW_MS"]) - 3_600_000;
  const cloudflare = (request: Request): Response => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/deployments")) {
      return Response.json({ success: true, result: { deployments: [{ id: DEPLOYMENT, created_on: new Date(atMs).toISOString(), source: "wrangler", strategy: "percentage", versions: [{ version_id: DEPLOYED_VERSION, percentage: 100 }], annotations: { "workers/message": "e2e deploy" } }] }, result_info: { total_pages: 1 } });
    }
    if (path.endsWith(`/versions/${DEPLOYED_VERSION}`)) return Response.json({ success: true, result: { id: DEPLOYED_VERSION, annotations: { "workers/tag": "v9.9.9" } } });
    return new Response("not found", { status: 404 });
  };
  const harness = await start("attached", { PROJECTS: JSON.stringify([STATS_PROJECT]) }, cloudflare);
  try {
    await harness.scheduled().catch(() => undefined);
    const impact = await until(() => harness.observe(`/rollouts/${DEPLOYMENT}/impact`) as Promise<{ rolloutId?: string }>, value => value.rolloutId === DEPLOYMENT, "the forwarded rollout");
    assert.deepEqual(impact, {
      rolloutId: DEPLOYMENT, atMs, previousRolloutId: null, introduced: [DEPLOYED_VERSION], state: "measured", baselineMs: 0, newIssues: [], regressions: [],
      versions: [{ version: DEPLOYED_VERSION, label: "v9.9.9", introduced: true, requests: 0, failed: 0 }]
    });
    assert.equal((await harness.stats(`/api/observe/rollouts/${DEPLOYMENT}/impact`)).status, 401);
    assert.equal((await harness.stats(`/api/observe/rollouts/${DEPLOYMENT}/impact`, { headers: await accessHeaders() })).status, 200);
    const map = JSON.stringify({ version: 3, sources: ["../src/index.ts"], names: [], mappings: "AAAA" });
    const upload = async (origin: string) => harness.stats(`/api/observe/artifacts/${DEPLOYED_VERSION}/index.js`, { method: "PUT", headers: await accessHeaders({ Origin: origin, "Content-Type": "application/json" }), body: map });
    assert.equal((await upload("https://evil.example")).status, 403);
    assert.equal((await upload(ORIGIN)).status, 201);
    assert.equal((await upload(ORIGIN)).status, 200);
    assert.equal((await harness.stats(`/api/observe/artifacts/${DEPLOYED_VERSION}/index.js`, { method: "PUT", body: map })).status, 401);
    const forged = await harness.stats("/api/observe/rollouts", { method: "POST", headers: await accessHeaders({ Origin: ORIGIN, "Content-Type": "application/json" }), body: JSON.stringify({ rollouts: [], versions: [] }) });
    assert.equal(forged.status, 405);
    await harness.scheduled().catch(() => undefined);
    const issues = await harness.observe("/issues?state=open") as Page<IssueSummary>;
    assert.ok(!issues.items.some(issue => issue.operation === "deployments.forward"), "a repeated forward is an idempotent no-op, not an error");
  } finally {
    await harness.dispose();
  }
});
