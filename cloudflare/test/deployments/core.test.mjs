import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { parseDeployment, parseVersion, DEPLOYMENT_RETENTION_MS } from "../../src/deployments/model.ts";
import { comparisonBounds, compareDeployment, DEPLOYMENT_BUCKET_MS as B } from "../../src/deployments/compare.ts";
import { collectDeployments } from "../../src/deployments/collector.ts";
import { decodeDeploymentHistory, decodeDeploymentComparison } from "../../src/deployments/decode.ts";
import { initializeDeployments, saveDeploymentPoll, readDeployments, readDeploymentSync, readVersions, purgeDeployments, rememberSettledWindow, hasSettledWindow } from "../../src/deployments/store.ts";

const H = 3_600_000, SETTLE = 45 * 60_000;
const AT = Date.UTC(2026, 10, 2, 12);
const NOW = AT + 3 * H;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const raw = (n = 2, atMs = AT, versions = [{ version_id: id(102), percentage: 100 }]) => ({ id: id(n), created_on: new Date(atMs).toISOString(), source: "api", strategy: "percentage", versions });
const deployed = parseDeployment(raw());
const previous = parseDeployment(raw(1, AT - 2 * H, [{ version_id: id(101), percentage: 100 }]));

function rows(window = "1h", beforeCpu = 10, afterCpu = 8, count = 1000) {
  const bounds = comparisonBounds(AT, window);
  const result = [];
  for (const [key, cpu] of [["before", beforeCpu], ["after", afterCpu]]) {
    for (let at = bounds[key].fromMs; at < bounds[key].toMs; at += B) {
      result.push({ metric: "worker.invocations", bucket_ms: at, value: count });
      result.push({ metric: "worker.cpuMsSum", bucket_ms: at, value: count * cpu });
    }
  }
  return result;
}
function comparison(extra = {}) {
  return compareDeployment({ deployment: deployed, deployments: [deployed, previous], rows: rows(), window: "1h", now: NOW, settleMs: SETTLE, lastSuccessAtMs: NOW, truncated: false, enabled: true, metricsSettled: true, ...extra });
}
const cpu = result => result.metrics.find(metric => metric.metric === "worker.cpu");
const errorShare = result => result.metrics.find(metric => metric.metric === "worker.errors");

function storage() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...args) {
      const before = db.prepare("SELECT total_changes() AS n").get().n;
      const data = db.prepare(query).all(...args);
      const after = db.prepare("SELECT total_changes() AS n").get().n;
      return { toArray: () => data, one: () => { assert.equal(data.length, 1); return data[0]; }, rowsWritten: after - before, [Symbol.iterator]: () => data[Symbol.iterator]() };
    },
  };
  return { db, sql, transactionSync(fn) { db.exec("BEGIN"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } } };
}
function poll(extra = {}) { return { project: "stats", worker: "stats", atMs: NOW, error: null, deployments: [deployed, previous], versions: [{ id: id(102), tag: "abc1234", message: "release" }], truncated: false, ...extra }; }
function collector(fetch, extra = {}) {
  const polls = [];
  const input = { projects: [{ id: "stats", worker: "stats" }], account: "a".repeat(32), token: "secret-must-not-leak", now: NOW, store: { async recordDeploymentPoll(value) { polls.push(value); }, async knownDeploymentVersions() { return [id(102)]; } }, fetch, ...extra };
  return { polls, run: () => collectDeployments(input) };
}
const response = (deployments, result_info) => Response.json({ success: true, result: { deployments }, ...(result_info === undefined ? {} : { result_info }) });

test("deployment parsing preserves traffic and rollback identity, not author PII", () => {
  const value = parseDeployment({ ...raw(), annotations: { "workers/message": "line one\nline two" }, author_email: "private@example.com" });
  assert.equal(value.message, "line one line two");
  assert.equal("author_email" in value, false);
  const rollback = parseDeployment(raw(3, AT + H, [{ version_id: id(101), percentage: 100 }]));
  assert.notEqual(rollback.id, previous.id);
  assert.equal(rollback.versions[0].id, previous.versions[0].id);
});
for (const [name, mutate] of [
  ["invalid timestamp", value => ({ ...value, created_on: "yesterday" })],
  ["invalid UUID", value => ({ ...value, id: "../../x" })],
  ["unknown strategy", value => ({ ...value, strategy: "random" })],
  ["incorrect allocation", value => ({ ...value, versions: [{ version_id: id(102), percentage: 50 }] })],
  ["non-finite allocation", value => ({ ...value, versions: [{ version_id: id(102), percentage: NaN }] })],
  ["duplicate versions", value => ({ ...value, versions: [{ version_id: id(102), percentage: 50 }, { version_id: id(102), percentage: 50 }] })],
  ["oversized message", value => ({ ...value, annotations: { "workers/message": "a".repeat(1001) } })],
]) test(`rejects ${name}`, () => assert.throws(() => parseDeployment(mutate(raw()))));

test("version metadata projects only id, tag and message", () => {
  assert.deepEqual(parseVersion({ id: id(102), annotations: { "workers/tag": "abc1234" }, resources: { secret: "never persist" } }, id(102)), { id: id(102), tag: "abc1234", message: null });
  assert.throws(() => parseVersion({ id: id(101) }, id(102)));
});
test("windows exclude straddling and warm-up buckets", () => {
  assert.deepEqual(comparisonBounds(AT + 1234, "1h"), { before: { fromMs: AT - H, toMs: AT }, after: { fromMs: AT + 2 * B, toMs: AT + 2 * B + H } });
});
test("CPU improvements and cost use ratios of sums", () => {
  const result = comparison();
  assert.deepEqual(result.reasons, []);
  assert.equal(cpu(result).verdict, "improved");
  assert.equal(cpu(result).before, 10);
  assert.equal(cpu(result).after, 8);
  assert.equal(cpu(result).deltaPercent, -20);
  assert.equal(result.metrics.find(metric => metric.metric === "cost").before, 0.0005);
});
test("uneven bucket counts are never averaged as ratios", () => {
  const data = rows();
  for (const row of data) if (row.bucket_ms === AT - H) row.value = row.metric === "worker.invocations" ? 1 : 100;
  const result = comparison({ rows: data });
  assert.equal(cpu(result).before, (110000 + 100) / 11001);
});
test("zero error baseline yields percentage-point change, never infinity", () => {
  const data = rows();
  const bounds = comparisonBounds(AT, "1h");
  for (let at = bounds.after.fromMs; at < bounds.after.toMs; at += B) data.push({ metric: "worker.status.5xx", bucket_ms: at, value: 10 });
  const metric = errorShare(comparison({ rows: data }));
  assert.equal(metric.before, 0); assert.equal(metric.after, 1); assert.equal(metric.delta, 1); assert.equal(metric.deltaPercent, null); assert.equal(metric.verdict, "regressed");
});
test("low event counts cannot manufacture a reliability signal", () => {
  assert.equal(errorShare(comparison({ rows: rows("1h", 10, 8, 20) })).verdict, "insufficient-data");
});
test("small CPU changes are unchanged", () => assert.equal(cpu(comparison({ rows: rows("1h", 1, 0.99) })).verdict, "unchanged"));
test("missing invocation bucket remains null, not zero", () => {
  const result = comparison({ rows: rows().filter(row => !(row.metric === "worker.invocations" && row.bucket_ms === AT - H)) });
  assert.equal(result.beforeInvocations, null);
  assert.equal(cpu(result).before, null);
  assert.ok(result.reasons.some(reason => reason.includes("missing")));
});
test("missing CPU bucket is unavailable even with complete request counts", () => {
  const result = comparison({ rows: rows().filter(row => !(row.metric === "worker.cpuMsSum" && row.bucket_ms === AT - H)) });
  assert.equal(cpu(result).verdict, "insufficient-data");
});
for (const [name, extra, pattern] of [
  ["unsettled data", { now: AT + H }, /Waiting/],
  ["disabled polling", { enabled: false }, /disabled/],
  ["truncated backfill", { truncated: true }, /truncated/],
  ["stale history", { lastSuccessAtMs: NOW - H }, /refreshed/],
  ["unknown baseline", { deployments: [deployed] }, /baseline/],
  ["expired metrics", { now: NOW + 8 * 86400000, lastSuccessAtMs: NOW + 8 * 86400000 }, /expired/],
  ["intervening rollback", { deployments: [deployed, previous, parseDeployment(raw(3, AT + 3 * B))] }, /overlaps/],
  ["split traffic", { deployment: parseDeployment(raw(2, AT, [{ version_id: id(101), percentage: 50 }, { version_id: id(102), percentage: 50 }])) }, /splits/],
]) test(`withholds verdict for ${name}`, () => { const value = comparison(extra); assert.ok(value.reasons.some(reason => pattern.test(reason))); assert.equal(cpu(value).verdict, "confounded"); });

test("deployment exactly at baseline start is allowed", () => {
  const baseline = parseDeployment(raw(1, AT - H));
  assert.deepEqual(comparison({ deployments: [baseline, deployed] }).reasons, []);
});
test("traffic mix changes suppress aggregate verdicts", () => {
  const data = rows();
  for (const row of [...data]) if (row.metric === "worker.invocations") data.push({ ...row, metric: row.bucket_ms < AT ? "route.GET /a.invocations" : "route.GET /b.invocations" });
  const result = comparison({ rows: data });
  assert.ok(result.reasons.some(reason => reason.includes("traffic mix")));
  assert.equal(cpu(result).verdict, "confounded");
});
test("24-hour windows compare like duration and wait for settlement", () => {
  const now = AT + 26 * H;
  const baseline = parseDeployment(raw(1, AT - 2 * 86400000));
  const result = comparison({ window: "24h", now, lastSuccessAtMs: now, rows: rows("24h"), deployments: [baseline, deployed] });
  assert.deepEqual(result.reasons, []);
  assert.equal(result.after.toMs - result.after.fromMs, 86400000);
  assert.equal(cpu(result).verdict, "improved");
});
test("configured-but-missing D1 cost is unavailable", () => assert.equal(comparison({ hasD1: true }).metrics.find(metric => metric.metric === "cost").verdict, "insufficient-data"));
test("R2 totals infer only absent outcomes, not absent buckets", () => {
  const data = rows();
  for (const row of [...data]) if (row.metric === "worker.invocations") data.push({ metric: "r2.bucket.ops.success", bucket_ms: row.bucket_ms, value: row.bucket_ms < AT ? 2000 : 1000 });
  let result = comparison({ rows: data, buckets: ["bucket"] });
  assert.equal(result.metrics.find(metric => metric.metric === "r2.bucket").verdict, "improved");
  result = comparison({ rows: data.filter(row => !(row.metric.startsWith("r2.") && row.bucket_ms === AT - H)), buckets: ["bucket"] });
  assert.equal(result.metrics.find(metric => metric.metric === "r2.bucket").before, null);
});
test("probe failures use failure share rather than pretending to be user latency", () => {
  const data = rows();
  for (const row of [...data]) if (row.metric === "worker.invocations") { data.push({ metric: "probe.health.up", bucket_ms: row.bucket_ms, value: row.bucket_ms < AT ? 1 : 0 }); data.push({ metric: "probe.health.ms", bucket_ms: row.bucket_ms, value: 50 }); }
  const result = comparison({ rows: data, probes: ["health"] });
  assert.equal(result.metrics.find(metric => metric.metric === "probe.health.failure").verdict, "regressed");
  assert.ok(result.warnings.some(reason => reason.includes("not user-request latency")));
});
test("deferred Durable Object updates withhold DO attribution", () => {
  const data = rows();
  for (const row of [...data]) if (row.metric === "worker.invocations") { data.push({ metric: "do.invocations", bucket_ms: row.bucket_ms, value: 1000 }); data.push({ metric: "do.cpuMsSum", bucket_ms: row.bucket_ms, value: row.bucket_ms < AT ? 10000 : 8000 }); }
  const result = comparison({ deployment: { ...deployed, deferred: true }, rows: data, hasDurableObjects: true });
  assert.equal(result.metrics.find(metric => metric.metric === "do.cpu").verdict, "confounded");
  assert.equal(cpu(result).verdict, "improved");
});

test("SQLite migration is additive and repeatable", () => {
  const state = storage(); state.sql.exec("CREATE TABLE hosts (id TEXT)"); initializeDeployments(state); initializeDeployments(state);
  assert.equal(state.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().length, 5); state.db.close();
});
test("SQLite unchanged polls only update the sync record", () => {
  const state = storage(); initializeDeployments(state); saveDeploymentPoll(state, poll());
  const before = state.db.prepare("SELECT total_changes() AS n").get().n;
  saveDeploymentPoll(state, poll({ atMs: NOW + B }));
  const after = state.db.prepare("SELECT total_changes() AS n").get().n;
  assert.equal(after - before, 1);
  assert.equal(readDeployments(state.sql, "stats", "stats", NOW).length, 2);
  assert.equal(readVersions(state.sql, "stats", "stats")[0].tag, "abc1234"); state.db.close();
});
test("SQLite failures and out-of-order polls retain last good history", () => {
  const state = storage(); initializeDeployments(state); saveDeploymentPoll(state, poll());
  saveDeploymentPoll(state, poll({ atMs: NOW + B, error: "unauthorized", deployments: [], versions: [] }));
  saveDeploymentPoll(state, poll({ atMs: NOW - B, error: "rate_limited" }));
  assert.equal(readDeploymentSync(state.sql, "stats", "stats").lastSuccessAtMs, NOW);
  assert.equal(readDeploymentSync(state.sql, "stats", "stats").error, "unauthorized");
  assert.equal(readDeployments(state.sql, "stats", "stats", NOW).length, 2); state.db.close();
});
test("SQLite scopes a renamed worker separately and retains rollbacks", () => {
  const state = storage(); initializeDeployments(state); saveDeploymentPoll(state, poll({ deployments: [deployed, previous, parseDeployment(raw(3, AT + H, previous.versions.map(version => ({ version_id: version.id, percentage: version.percentage }))))] }));
  assert.equal(readDeployments(state.sql, "stats", "stats", NOW).length, 3);
  assert.equal(readDeployments(state.sql, "stats", "new-worker", NOW).length, 0); state.db.close();
});
test("SQLite expiry also works while polling is disabled", () => {
  const state = storage(); initializeDeployments(state); saveDeploymentPoll(state, poll());
  purgeDeployments(state.sql, NOW + DEPLOYMENT_RETENTION_MS + 1);
  assert.equal(state.sql.exec("SELECT * FROM project_deployments").toArray().length, 0);
  assert.equal(readVersions(state.sql, "stats", "stats").length, 0);
  assert.equal(readDeploymentSync(state.sql, "stats", "stats"), null); state.db.close();
});
test("SQLite caps deployment history at 1,000 records", () => {
  const state = storage(); initializeDeployments(state);
  saveDeploymentPoll(state, poll({ deployments: Array.from({ length: 1001 }, (_, index) => parseDeployment(raw(index + 1, NOW - index * 1000))), versions: [] }));
  assert.equal(state.sql.exec("SELECT COUNT(*) AS n FROM project_deployments").one().n, 1000); state.db.close();
});

test("no credentials means no API calls or writes", async () => {
  const run = collector(() => { throw new Error("must not fetch"); }, { account: undefined, token: undefined }); await run.run(); assert.deepEqual(run.polls, []);
});
test("half-configured credentials report configuration without fetching", async () => {
  const run = collector(() => { throw new Error("must not fetch"); }, { token: undefined }); await run.run(); assert.equal(run.polls[0].error, "configuration");
});
test("collector pins the origin, disables redirects and strips upstream data", async () => {
  const run = collector(async (url, init) => { assert.equal(new URL(url).origin, "https://api.cloudflare.com"); assert.equal(init.redirect, "error"); assert.equal(init.method, "GET"); assert.ok(init.signal); return response([{ ...raw(), author_email: "private@example.com" }]); });
  await run.run(); assert.equal(run.polls[0].error, null); assert.equal(JSON.stringify(run.polls).includes("private@example.com"), false);
});
for (const [status, code] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"], [500, "upstream"]]) test(`collector handles HTTP ${status} without leaking bodies`, async () => {
  const run = collector(async () => new Response("secret-must-not-leak", { status })); await run.run(); assert.equal(run.polls[0].error, code); assert.equal(JSON.stringify(run.polls).includes("secret-must-not-leak"), false);
});
test("collector validates successful envelopes", async () => { const run = collector(async () => Response.json({ success: false, errors: [{ message: "secret-must-not-leak" }] })); await run.run(); assert.equal(run.polls[0].error, "invalid_response"); });
test("collector caps response bodies even without Content-Length", async () => { const run = collector(async () => new Response("x".repeat(512 * 1024 + 1))); await run.run(); assert.equal(run.polls[0].error, "invalid_response"); });
test("collector follows explicit pagination", async () => {
  const run = collector(async url => {
    const page = Number(new URL(url).searchParams.get("page"));
    return page === 1 ? response(Array.from({ length: 100 }, (_, index) => raw(index + 1, AT - index * 1000)), { total_pages: 2 }) : response([raw(101, AT - H)], { total_pages: 2 });
  });
  await run.run(); assert.equal(run.polls[0].deployments.length, 101); assert.equal(run.polls[0].truncated, false);
});
test("collector marks page-budget truncation instead of claiming complete history", async () => {
  const run = collector(async url => { const page = Number(new URL(url).searchParams.get("page")); return response(Array.from({ length: 100 }, (_, index) => raw(page * 100 + index, AT - (page * 100 + index) * 1000)), { total_pages: 4 }); });
  await run.run(); assert.equal(run.polls[0].deployments.length, 300); assert.equal(run.polls[0].truncated, true);
});
test("collector detects non-advancing pages", async () => {
  const run = collector(async () => response(Array.from({ length: 100 }, (_, index) => raw(index + 1, AT - index * 1000)), { total_pages: 5 }));
  await run.run(); assert.equal(run.polls[0].truncated, true);
});
test("optional version enrichment failure preserves history", async () => {
  const polls = [];
  const run = collector(async url => url.includes("/versions/") ? new Response("denied", { status: 403 }) : response([raw()]), { store: { async recordDeploymentPoll(value) { polls.push(value); }, async knownDeploymentVersions() { return []; } } });
  await run.run(); assert.equal(polls[0].error, null); assert.equal(polls[0].deployments.length, 1); assert.equal(polls[0].versions.length, 0);
});
test("a project failure does not stop the next project's poll", async () => {
  const run = collector(async url => url.includes("/scripts/stats/") ? new Response("denied", { status: 403 }) : response([raw()]), { projects: [{ id: "stats", worker: "stats" }, { id: "stuff", worker: "stuff" }] });
  await run.run(); assert.equal(run.polls.find(poll => poll.project === "stats").error, "unauthorized"); assert.equal(run.polls.find(poll => poll.project === "stuff").error, null);
});
test("client decoders reject identity mismatches and malformed metric values", () => {
  const history = { projectId: "stats", worker: "stats", enabled: true, sync: null, deployments: [deployed], versions: [] };
  assert.deepEqual(decodeDeploymentHistory(history, "stats"), history);
  assert.throws(() => decodeDeploymentHistory(history, "stuff"));
  assert.throws(() => decodeDeploymentHistory({ ...history, deployments: [deployed, deployed] }, "stats"));
  const value = comparison();
  assert.deepEqual(decodeDeploymentComparison(value, deployed.id, "1h"), value);
  assert.throws(() => decodeDeploymentComparison(value, id(3), "1h"));
  assert.throws(() => decodeDeploymentComparison(value, deployed.id, "24h"));
  assert.throws(() => decodeDeploymentComparison({ ...value, metrics: [{ ...value.metrics[0], after: Infinity }] }, deployed.id, "1h"));
});


test("time alone does not certify partial metrics as settled", () => {
  const value = comparison({ metricsSettled: false });
  assert.equal(cpu(value).verdict, "confounded");
  assert.ok(value.reasons.some(reason => reason.includes("No proof")));
});
test("coverage merges adjoining windows but preserves outage gaps", () => {
  const state = storage(); initializeDeployments(state);
  rememberSettledWindow(state.sql, "stats", "stats", AT - 3 * H, AT - 2 * H);
  rememberSettledWindow(state.sql, "stats", "stats", AT - 2 * H, AT - H);
  rememberSettledWindow(state.sql, "stats", "stats", AT, AT + H);
  assert.equal(hasSettledWindow(state.sql, "stats", "stats", AT - 3 * H, AT - H), true);
  assert.equal(hasSettledWindow(state.sql, "stats", "stats", AT - 3 * H, AT + H), false);
  assert.equal(hasSettledWindow(state.sql, "stats", "different-worker", AT - 3 * H, AT - H), false);
  rememberSettledWindow(state.sql, "stats", "stats", AT - H, AT);
  assert.equal(hasSettledWindow(state.sql, "stats", "stats", AT - 3 * H, AT + H), true);
  assert.equal(state.sql.exec("SELECT * FROM project_deployment_coverage").toArray().length, 1);
  const before = state.db.prepare("SELECT total_changes() AS n").get().n;
  rememberSettledWindow(state.sql, "stats", "stats", AT - H, AT);
  assert.equal(state.db.prepare("SELECT total_changes() AS n").get().n, before);
  state.db.close();
});
