import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { accessToken } from "../access-token.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const STATS_BUNDLE = join(ROOT, ".cloudflare/output/v0/workers/default/bundle/index.js");
const OBSERVE_BUNDLE = join(ROOT, "observe-worker/.cloudflare/output/v0/workers/default/bundle/index.js");
const WRANGLER_TEST = readFileSync(join(ROOT, "wrangler.test.jsonc"), "utf8");
const VARS = (JSON.parse(WRANGLER_TEST) as { vars: Record<string, string> }).vars;
const BATCH = JSON.parse(readFileSync(join(ROOT, "../fixtures/v1/batch-full.json"), "utf8")) as Record<string, unknown>;
const ORIGIN = "https://stats.example";
const HOST_NAME = "host-name-QXZ";
const SECRET_QUERY = "SECRET_IN_QUERY_7d1f";
const COMPAT = { compatibilityDate: "2026-10-30", compatibilityFlags: ["nodejs_compat"] };
const CRASHING_CONSUMER = "export default { tail() { throw new Error('collector down'); }, fetch() { throw new Error('collector down'); } };";

type StatsInit = NonNullable<Parameters<Miniflare["dispatchFetch"]>[1]>;
type Response = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;
type Collector = "attached" | "crashing" | "absent";

interface Harness {
  readonly mf: Miniflare;
  readonly persist: string;
  stats(path: string, init?: StatsInit): Promise<Response>;
  observe(path: string): Promise<unknown>;
  scheduled(): Promise<unknown>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

async function start(collector: Collector): Promise<Harness> {
  const persist = mkdtempSync(join(tmpdir(), "observe-e2e-"));
  const statsWorker = {
    name: "stats",
    modules: true,
    scriptPath: STATS_BUNDLE,
    ...COMPAT,
    bindings: { ...VARS, DEPLOYMENTS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", DEPLOYMENTS_API_TOKEN: "SECRET_DEPLOY_TOKEN" },
    durableObjects: { INSTALLATION: { className: "Installation", useSQLite: true } },
    outboundService: () => new Response("upstream unavailable", { status: 503 }),
    ...(collector === "absent" ? {} : { serviceBindings: { OBSERVE: "stats-observe" }, tails: ["stats-observe"] })
  };
  const observeWorker = collector === "crashing"
    ? { name: "stats-observe", modules: true, script: CRASHING_CONSUMER, ...COMPAT }
    : { name: "stats-observe", modules: true, scriptPath: OBSERVE_BUNDLE, ...COMPAT, durableObjects: { STORE: { className: "ObservationStore", useSQLite: true } } };
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({ workers: collector === "absent" ? [statsWorker] : [statsWorker, observeWorker] }),
    resourcePersistencePath: persist
  });
  const stats = await mf.getWorker("stats");
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await mf.dispose();
  };
  return {
    mf,
    persist,
    stats: async (path, init) => mf.dispatchFetch(`${ORIGIN}${path}`, init),
    observe: async path => (await (await mf.getWorker("stats-observe")).fetch(`https://observe${path}`)).json(),
    scheduled: async () => stats.scheduled({ cron: "*/5 * * * *", scheduledTime: new Date(Number(VARS["TEST_NOW_MS"])) }),
    stop,
    dispose: async () => { await stop(); rmSync(persist, { recursive: true, force: true }); }
  };
}

async function accessHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { "cf-access-jwt-assertion": await accessToken(), ...extra };
}

async function createHost(harness: Harness): Promise<{ hostId: string; token: string }> {
  const response = await harness.stats("/api/v1/admin/hosts", { method: "POST", headers: await accessHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ name: HOST_NAME }) });
  assert.equal(response.status, 201);
  return await response.json() as { hostId: string; token: string };
}

async function ingest(harness: Harness, host: { hostId: string; token: string }): Promise<Response> {
  return harness.stats(`/ingest/v1/batches?token=${SECRET_QUERY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json", Cookie: "CF_Authorization=SECRET_COOKIE" },
    body: JSON.stringify({ ...BATCH, hostId: host.hostId })
  });
}

interface Page<T> { readonly items: readonly T[]; readonly next: string | null }
interface TraceSummary { readonly traceId: string | null; readonly label: string; readonly status: number | null; readonly failed: boolean; readonly objectInvocations: number }
interface TraceDetail { readonly rootPresent: boolean; readonly invocations: readonly { readonly stage: string; readonly label: string }[]; readonly occurrences: readonly { readonly operation: string | null; readonly name: string }[] }
interface IssueSummary { readonly fingerprint: string; readonly name: string; readonly operation: string | null; readonly frame: string | null; readonly occurrences: number }
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 2000)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function workerTraces(harness: Harness): Promise<readonly TraceSummary[]> {
  const page = await harness.observe("/traces?limit=100") as Page<TraceSummary>;
  assert.equal(page.next, null);
  return page.items;
}

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
