import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT } from "../../src/cli/exit.ts";
import { authorized, fakeOrigin, runCli, sendJson, tokenEnv, type FakeOrigin, type Handler } from "./support.ts";

const ROLLOUT = "rollout-1";
const heatmap = { fromMs: 0, bucketMs: 60_000, edges: [], cells: [], failed: [], p95WallMs: [] };
const route = (n: number) => ({ label: `GET /r${n}`, requests: 10, failed: 1, cpuMs: n, p50WallMs: 1, p95WallMs: 2, p99WallMs: 3, p50CpuMs: 1, p95CpuMs: 2 });
const trace = { key: "k", traceId: "a".repeat(32), stage: "worker", kind: "fetch", label: "GET /x", objectId: null, status: 200, outcome: "ok", failed: false, cpuMs: 1, wallMs: 5, atMs: 1_700_000_000_000, version: "v1", errorCount: 0, objectInvocations: 0, objectCpuMs: 0 };
const issue = { fingerprint: "b".repeat(64), name: "Error", operation: null, frame: null, state: "open", occurrences: 3, firstAtMs: 1, lastAtMs: 2, lastVersion: null, versions: 1, firstVersion: null, firstVersionLabel: null };
const impact = { rolloutId: ROLLOUT, atMs: 1_700_000_000_000, previousRolloutId: null, introduced: ["v2"], state: "measured", baselineMs: 1, newIssues: [], regressions: [], versions: [{ version: "v2", label: null, introduced: true, requests: 10, failed: 1 }], routes: [] };

const sampling = { keepPerMillion: 10_000, kept: 12, observed: 1_000 };
const shopRoute = { ...route(1), label: "GET /products/:handle", requests: 12, observed: 1_000 };

function handler(overrides: { routes?: unknown } = {}): Handler {
  return (request, response) => {
    if (!authorized(request)) return void response.writeHead(401).end();
    const path = (request.url ?? "").split("?")[0] ?? "";
    switch (path) {
      case "/api/observe/stats/explore": return sendJson(response, { fromMs: 0, toMs: 1, route: null, routes: overrides.routes ?? [route(1), route(2)], heatmap });
      case "/api/observe/stats/traces": return sendJson(response, { items: [trace], next: "5.ab" });
      case "/api/observe/stats/issues": return sendJson(response, { items: [issue], next: null });
      case "/api/observe/nanoshop-storied/explore": return sendJson(response, { fromMs: 0, toMs: 1, route: null, routes: [shopRoute], heatmap, sampling });
      case "/api/observe/nanoshop-storied/traces": return sendJson(response, { items: [trace], next: null, sampling });
      case `/api/observe/nanoshop-storied/rollouts/${ROLLOUT}/impact`: return sendJson(response, { ...impact, sampling });
      case "/api/observe/usr-memories/explore": return sendJson(response, { fromMs: 0, toMs: 1, route: null, routes: [route(1)], heatmap });
      case `/api/observe/stats/rollouts/${ROLLOUT}/impact`: return sendJson(response, impact);
      default: return void response.writeHead(404).end();
    }
  };
}

async function withOrigin(handle: Handler, body: (origin: FakeOrigin) => Promise<void>): Promise<void> {
  const origin = await fakeOrigin(handle);
  try {
    await body(origin);
  } finally {
    await origin.close();
  }
}

const run = (origin: FakeOrigin, args: readonly string[], json = true) => runCli([...args, ...(json ? ["--json"] : []), "--origin", origin.origin], tokenEnv());

await test("observe commands read only, with GET requests to the stats observe API", async () => {
  await withOrigin(handler(), async origin => {
    for (const args of [
      ["observe", "routes", "--project", "stats", "--window", "1h"],
      ["observe", "traces", "--project", "stats", "--window", "7d", "--failed", "--route", "GET /x"],
      ["observe", "issues", "--project", "stats", "--state", "resolved"],
      ["observe", "deployment", "--project", "stats", "--deployment", ROLLOUT]
    ]) {
      const result = await run(origin, args);
      assert.equal(result.code, EXIT.ok, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }
    assert.equal(origin.seen.length, 4);
    for (const seen of origin.seen) {
      assert.equal(seen.method, "GET");
      assert.ok(seen.url.startsWith("/api/observe/stats/"), seen.url);
    }
  });
});

await test("observe has no mutating subcommands", async () => {
  await withOrigin(handler(), async origin => {
    for (const word of ["resolve", "reopen", "sourcemap"]) {
      const result = await run(origin, ["observe", word, "--project", "stats"]);
      assert.equal(result.code, EXIT.usage, word);
    }
    assert.equal(origin.seen.length, 0);
  });
});

await test("projects other than stats exit 2 not_observed without a request", async () => {
  await withOrigin(handler(), async origin => {
    for (const args of [["operations", "--project", "other"], ["routes", "--project", "other"], ["traces", "--project", "other"], ["issues", "--project", "other"], ["deployment", "--project", "other", "--deployment", ROLLOUT]]) {
      const result = await run(origin, ["observe", ...args]);
      assert.equal(result.code, EXIT.usage, args.join(" "));
      assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "not_observed");
    }
    assert.equal(origin.seen.length, 0);
  });
});

await test("window and state are validated before any request", async () => {
  await withOrigin(handler(), async origin => {
    for (const args of [["routes", "--window", "30d"], ["traces", "--window", "2h"], ["issues", "--state", "closed"], ["issues", "--introduced-in", "bad id"], ["deployment", "--deployment", "bad id"]]) {
      const result = await run(origin, ["observe", ...args.slice(0, 1), "--project", "stats", ...args.slice(1)]);
      assert.equal(result.code, EXIT.usage, args.join(" "));
    }
    assert.equal(origin.seen.length, 0);
  });
});

await test("routes window query covers exactly the requested span and text is bounded to 50 rows", async () => {
  const many = Array.from({ length: 60 }, (_, index) => route(index + 1));
  await withOrigin(handler({ routes: many }), async origin => {
    const result = await run(origin, ["observe", "routes", "--project", "stats", "--window", "1h"], false);
    assert.equal(result.code, EXIT.ok);
    assert.equal(result.stdout.split("\n").filter(line => line.startsWith("GET /r")).length, 50);
    assert.match(result.stdout, /10 more rows omitted/u);
    const query = new URL(origin.seen[0]!.url, origin.origin).searchParams;
    assert.equal(Number(query.get("to")) - Number(query.get("from")), 3_600_000);
    const json = await run(origin, ["observe", "routes", "--project", "stats", "--window", "1h"]);
    assert.equal((JSON.parse(json.stdout) as { payload: { routes: unknown[] } }).payload.routes.length, 60);
  });
});

await test("traces keep the next cursor in json", async () => {
  await withOrigin(handler(), async origin => {
    const result = await run(origin, ["observe", "traces", "--project", "stats"]);
    assert.equal((JSON.parse(result.stdout) as { payload: { traces: { next: string } } }).payload.traces.next, "5.ab");
  });
});

await test("an observe response that does not decode exits 4", async () => {
  await withOrigin((_, response) => { sendJson(response, { items: "nope", next: null }); }, async origin => {
    const result = await run(origin, ["observe", "issues", "--project", "stats"]);
    assert.equal(result.code, EXIT.transport);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "contract");
  });
});

await test("a sampled service marks every percentile as sampled in text and json, and an unsampled one is unchanged", async () => {
  await withOrigin(handler(), async origin => {
    const text = await run(origin, ["observe", "routes", "--project", "nanoshop-storied"], false);
    assert.equal(text.code, EXIT.ok, text.stderr);
    assert.match(text.stdout, /sampled: .*12 kept of 1000 observed invocations \(1\.20%; keep rate 10000 per million\)/u);
    assert.match(text.stdout, /p50 \(sampled\) +p95 \(sampled\) +p99 \(sampled\) +p95 cpu \(sampled\)/u);
    assert.match(text.stdout, /GET \/products\/:handle +12 +1000 +/u);
    const json = JSON.parse((await run(origin, ["observe", "routes", "--project", "nanoshop-storied"])).stdout) as { payload: { sampling?: unknown; routes: { observed?: number }[] } };
    assert.deepEqual(json.payload.sampling, sampling);
    assert.equal(json.payload.routes[0]?.observed, 1_000);

    const traces = await run(origin, ["observe", "traces", "--project", "nanoshop-storied"], false);
    assert.match(traces.stdout, /sampled: the listed traces come from 12 kept of 1000 observed/u);
    const impactText = await run(origin, ["observe", "deployment", "--project", "nanoshop-storied", "--deployment", ROLLOUT], false);
    assert.match(impactText.stdout, /sampled: per-route CPU comparisons come from 12 kept of 1000 observed/u);

    const plain = await run(origin, ["observe", "routes", "--project", "usr-memories"]);
    assert.equal("sampling" in (JSON.parse(plain.stdout) as { payload: object }).payload, false);
    const plainText = await run(origin, ["observe", "routes", "--project", "usr-memories"], false);
    assert.doesNotMatch(plainText.stdout, /sampled/u);
    assert.match(plainText.stdout, /requests +failed +cpu +p50 +p95 +p99 +p95 cpu/u);
  });
});

const WORK_FIELDS = ["received", "persisted", "duplicate", "rejectedInvalidSample", "rejectedTooOld", "rejectedConflict", "inputBytes", "points", "cells", "outputBytes", "cacheHit304", "cacheRebuilt", "runs", "metricRows", "hourRollups", "upstreamQueries", "expired", "backlogRemaining"];
const noLag = { count: 0, maxMs: 0, sumMs: 0 };

function windowBody(query: URLSearchParams, rows: { operations?: unknown[]; counts?: unknown[] }): unknown {
  return {
    fromMs: Number(query.get("from")), toMs: Number(query.get("to")), bucketMs: 300_000, operation: null, workloadClass: null, filterRevision: 1,
    operations: rows.operations ?? [], outcomes: [], invocations: [{ bucketAt: Number(query.get("from")), version: "v1", stage: "worker", count: 3 }],
    lag: { operations: noLag, outcomes: noLag }, ...(rows.counts === undefined ? {} : { counts: rows.counts, sampling })
  };
}

await test("observe operations totals stats's operation summaries and a sampled service's exact counts under the policy's operation names", async () => {
  const summary = (bucketAt: number, operation: string, n: number) => ({
    bucketAt, version: "v1", operation, workloadClass: "", synthetic: false, count: n, failed: n - 1, cpuMsSum: 2 * n, wallMsSum: 10 * n,
    rowsRead: 3 * n, rowsWritten: n, statements: 4 * n, lagCount: n, lagMsMax: 100 * n, lagMsSum: 50 * n, work: Object.fromEntries(WORK_FIELDS.map(field => [field, 0]))
  });
  const counted = (version: string, stage: string, route: string, operation: string, count: number) => ({ version, stage, route, operation, count, failed: 1, cpuMsSum: count, wallMsSum: 5 * count });
  const handle: Handler = (request, response) => {
    if (!authorized(request)) return void response.writeHead(401).end();
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/api/observe/stats/window") return sendJson(response, windowBody(url.searchParams, { operations: [summary(0, "host.ingest", 2), summary(300_000, "host.ingest", 3), summary(0, "collector.record", 1)] }));
    if (url.pathname === "/api/observe/nanoshop-storied/window") {
      return sendJson(response, windowBody(url.searchParams, { counts: [
        counted("v1", "worker", "POST /checkout/quotes/:ref/accept", "", 1),
        counted("v2", "worker", "POST /checkout/quotes/:ref/accept", "", 2),
        counted("v1", "object", "TenantStore.commerceCommand", "", 7),
        counted("v1", "object", "TenantStore.alarm", "", 2),
        counted("v1", "worker", "scheduled 12 * * * *", "", 1),
        counted("v1", "worker", "GET /search", "request.search", 4)
      ] }));
    }
    return void response.writeHead(404).end();
  };
  await withOrigin(handle, async origin => {
    const stats = JSON.parse((await run(origin, ["observe", "operations", "--project", "stats", "--window", "1h"])).stdout) as { project: string; windows: { fromMs: number; toMs: number }[]; payload: { source: string; operations: unknown[] } };
    assert.equal(stats.project, "stats");
    assert.equal(stats.payload.source, "summaries");
    assert.deepEqual(stats.payload.operations, [
      { operation: "host.ingest", workloadClass: "", synthetic: false, count: 5, failed: 3, cpuMsSum: 10, wallMsSum: 50, rowsRead: 15, rowsWritten: 5, statements: 20, lag: { count: 5, maxMs: 300, sumMs: 250 } },
      { operation: "collector.record", workloadClass: "", synthetic: false, count: 1, failed: 0, cpuMsSum: 2, wallMsSum: 10, rowsRead: 3, rowsWritten: 1, statements: 4, lag: { count: 1, maxMs: 100, sumMs: 50 } }
    ]);
    const query = new URL(origin.seen[0]!.url, origin.origin).searchParams;
    const [fromMs, toMs] = [Number(query.get("from")), Number(query.get("to"))];
    assert.deepEqual([toMs - fromMs, toMs % 300_000, fromMs % 300_000], [3_600_000, 0, 0]);
    assert.deepEqual(stats.windows, [{ fromMs, toMs }]);

    const shop = JSON.parse((await run(origin, ["observe", "operations", "--project", "nanoshop-storied", "--window", "1h"])).stdout) as { schema: string; payload: { source: string; operations: unknown[] } };
    assert.equal(shop.schema, "statsctl/1");
    assert.equal(shop.payload.source, "counts");
    assert.deepEqual(shop.payload.operations, [
      { operation: "store.rpc.commerceCommand", stage: "object", route: "TenantStore.commerceCommand", count: 7, failed: 1, cpuMsSum: 7, wallMsSum: 35 },
      { operation: "request.search", stage: "worker", route: "GET /search", count: 4, failed: 1, cpuMsSum: 4, wallMsSum: 20 },
      { operation: "request.checkout-accept", stage: "worker", route: "POST /checkout/quotes/:ref/accept", count: 3, failed: 2, cpuMsSum: 3, wallMsSum: 15 },
      { operation: "store.alarm", stage: "object", route: "TenantStore.alarm", count: 2, failed: 1, cpuMsSum: 2, wallMsSum: 10 },
      { operation: null, stage: "worker", route: "scheduled 12 * * * *", count: 1, failed: 1, cpuMsSum: 1, wallMsSum: 5 }
    ]);
    const text = await run(origin, ["observe", "operations", "--project", "nanoshop-storied"], false);
    assert.equal(text.code, EXIT.ok, text.stderr);
    assert.match(text.stdout, /store\.rpc\.commerceCommand +object +TenantStore\.commerceCommand +7 +1 /u);
    assert.match(text.stdout, /this service publishes no SQLite rows, statements, or lag/u);
  });
});
