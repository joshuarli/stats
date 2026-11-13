import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { parseDeployment, parseVersion, DEPLOYMENT_RETENTION_MS, type DeploymentPoll } from "../../src/deployments/model.ts";
import { comparisonBounds, compareDeployment, DEPLOYMENT_BUCKET_MS as B, type ComparisonWindow, type DeploymentComparison, type MetricRow } from "../../src/deployments/compare.ts";
import { collectDeployments, type DeploymentFetch } from "../../src/cloudflare/deployments/collector.ts";
import { decodeDeploymentHistory, decodeDeploymentComparison } from "../../src/deployments/decode.ts";
import type { SqlDatabase, SqlValue } from "../../src/core/sql.ts";
import { nodeSqlScopes } from "../../src/node/sql.ts";
import { initializeDeployments, saveDeploymentPoll, readDeployments, readDeploymentSync, readVersions, readVersionIds, purgeDeployments, rememberSettledWindow, hasSettledWindow } from "../../src/deployments/store.ts";

const H = 3_600_000, SETTLE = 45 * 60_000;
const AT = Date.UTC(2026, 10, 2, 12);
const NOW = AT + 3 * H;
type MutableRow = { -readonly [K in keyof MetricRow]: MetricRow[K] };
type Raw = ReturnType<typeof raw>;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const raw = (n = 2, atMs = AT, versions: { version_id: string; percentage: number }[] = [{ version_id: id(102), percentage: 100 }]) => ({ id: id(n), created_on: new Date(atMs).toISOString(), source: "api", strategy: "percentage", versions });
const deployed = parseDeployment(raw());
const previous = parseDeployment(raw(1, AT - 2 * H, [{ version_id: id(101), percentage: 100 }]));

function rows(window: ComparisonWindow = "1h", beforeCpu = 10, afterCpu = 8, count = 1000): MutableRow[] {
  const bounds = comparisonBounds(AT, window);
  const result: MutableRow[] = [];
  const windows = [["before", beforeCpu], ["after", afterCpu]] as const;
  for (const [key, cpu] of windows) {
    for (let at = bounds[key].fromMs; at < bounds[key].toMs; at += B) {
      result.push({ metric: "worker.invocations", bucket_ms: at, value: count });
      result.push({ metric: "worker.cpuMsSum", bucket_ms: at, value: count * cpu });
    }
  }
  return result;
}
type ComparisonInput = Parameters<typeof compareDeployment>[0];
function comparison(extra: Partial<ComparisonInput> = {}): DeploymentComparison {
  return compareDeployment({ deployment: deployed, deployments: [deployed, previous], rows: rows(), window: "1h", now: NOW, settleMs: SETTLE, lastSuccessAtMs: NOW, truncated: false, enabled: true, metricsSettled: true, ...extra });
}
const cpu = (result: DeploymentComparison) => result.metrics.find(metric => metric.metric === "worker.cpu")!;
const errorShare = (result: DeploymentComparison) => result.metrics.find(metric => metric.metric === "worker.errors")!;
const metricOf = (result: DeploymentComparison, name: string) => result.metrics.find(metric => metric.metric === name)!;
const changes = (db: DatabaseSync): number => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number | bigint }).n);

type TestStorage = { db: DatabaseSync; sql: SqlDatabase };
function storage(): TestStorage {
  const db = new DatabaseSync(":memory:");
  return { db, sql: nodeSqlScopes(db).open() };
}
function poll(extra: Partial<DeploymentPoll> = {}): DeploymentPoll { return { project: "stats", worker: "stats", atMs: NOW, error: null, deployments: [deployed, previous], versions: [{ id: id(102), tag: "abc1234", message: "release" }], truncated: false, ...extra }; }
type CollectorInput = Parameters<typeof collectDeployments>[0];
function collector(fetch: DeploymentFetch, extra: { [K in keyof CollectorInput]?: CollectorInput[K] | undefined } = {}) {
  const polls: DeploymentPoll[] = [];
  const input = { projects: [{ id: "stats", worker: "stats" }], account: "a".repeat(32), token: "secret-must-not-leak", now: NOW, store: { async recordDeploymentPoll(value: DeploymentPoll) { polls.push(value); }, async knownDeploymentVersions() { return [id(102)]; } }, fetch, ...extra } as CollectorInput;
  return { polls, run: () => collectDeployments(input) };
}
const response = (deployments: unknown[], result_info?: unknown) => Response.json({ success: true, result: { deployments }, ...(result_info === undefined ? {} : { result_info }) });

await test("deployment parsing preserves traffic and rollback identity, not author PII", () => {
  const value = parseDeployment({ ...raw(), annotations: { "workers/message": "line one\nline two" }, author_email: "private@example.com" });
  assert.equal(value.message, "line one line two");
  assert.equal("author_email" in value, false);
  const rollback = parseDeployment(raw(3, AT + H, [{ version_id: id(101), percentage: 100 }]));
  assert.notEqual(rollback.id, previous.id);
  assert.equal(rollback.versions[0]!.id, previous.versions[0]!.id);
});
const invalidDeployments: [string, (value: Raw) => unknown][] = [
  ["invalid timestamp", value => ({ ...value, created_on: "yesterday" })],
  ["invalid UUID", value => ({ ...value, id: "../../x" })],
  ["unknown strategy", value => ({ ...value, strategy: "random" })],
  ["incorrect allocation", value => ({ ...value, versions: [{ version_id: id(102), percentage: 50 }] })],
  ["non-finite allocation", value => ({ ...value, versions: [{ version_id: id(102), percentage: NaN }] })],
  ["duplicate versions", value => ({ ...value, versions: [{ version_id: id(102), percentage: 50 }, { version_id: id(102), percentage: 50 }] })],
  ["oversized message", value => ({ ...value, annotations: { "workers/message": "a".repeat(1001) } })],
 ];
for (const [name, mutate] of invalidDeployments) await test(`rejects ${name}`, () => assert.throws(() => parseDeployment(mutate(raw()))));

await test("version metadata projects only id, tag and message", () => {
  assert.deepEqual(parseVersion({ id: id(102), annotations: { "workers/tag": "abc1234" }, resources: { secret: "never persist" } }, id(102)), { id: id(102), tag: "abc1234", message: null });
  assert.throws(() => parseVersion({ id: id(101) }, id(102)));
});
await test("windows exclude straddling and warm-up buckets", () => {
  assert.deepEqual(comparisonBounds(AT + 1234, "1h"), { before: { fromMs: AT - H, toMs: AT }, after: { fromMs: AT + 2 * B, toMs: AT + 2 * B + H } });
  assert.deepEqual(comparisonBounds(AT + 1234, "6h"), { before: { fromMs: AT - 6 * H, toMs: AT }, after: { fromMs: AT + 2 * B, toMs: AT + 2 * B + 6 * H } });
});
await test("CPU improvements and cost use ratios of sums", () => {
  const result = comparison();
  assert.deepEqual(result.reasons, []);
  assert.equal(cpu(result).verdict, "improved");
  assert.equal(cpu(result).before, 10);
  assert.equal(cpu(result).after, 8);
  assert.equal(cpu(result).deltaPercent, -20);
  assert.equal(result.metrics.find(metric => metric.metric === "cost")!.before, 0.0005);
});
await test("uneven bucket counts are never averaged as ratios", () => {
  const data = rows();
  for (const row of data) if (row.bucket_ms === AT - H) row.value = row.metric === "worker.invocations" ? 1 : 100;
  const result = comparison({ rows: data });
  assert.equal(cpu(result).before, (110000 + 100) / 11001);
});
await test("zero error baseline yields percentage-point change, never infinity", () => {
  const data = rows();
  const bounds = comparisonBounds(AT, "1h");
  for (let at = bounds.after.fromMs; at < bounds.after.toMs; at += B) data.push({ metric: "worker.status.5xx", bucket_ms: at, value: 10 });
  const metric = errorShare(comparison({ rows: data }));
  assert.equal(metric.before, 0); assert.equal(metric.after, 1); assert.equal(metric.delta, 1); assert.equal(metric.deltaPercent, null); assert.equal(metric.verdict, "regressed");
});
await test("low event counts cannot manufacture a reliability signal", () => {
  assert.equal(errorShare(comparison({ rows: rows("1h", 10, 8, 20) })).verdict, "insufficient-data");
});
await test("small CPU changes are unchanged", () => assert.equal(cpu(comparison({ rows: rows("1h", 1, 0.99) })).verdict, "unchanged"));
const idle = (row: MetricRow): boolean => row.bucket_ms === AT - H && (row.metric === "worker.invocations" || row.metric === "worker.cpuMsSum");
await test("an absent bucket in an unproven window remains null, not zero", () => {
  const result = comparison({ rows: rows().filter(row => !idle(row)), metricsSettled: false });
  assert.equal(result.beforeInvocations, null);
  assert.equal(cpu(result).before, null);
  assert.ok(result.reasons.some(reason => reason.includes("missing")));
});
await test("an absent bucket in a collected, settled window is an idle bucket", () => {
  const result = comparison({ rows: rows().filter(row => !idle(row)) });
  assert.equal(result.beforeInvocations, 11_000);
  assert.equal(cpu(result).before, 10);
  assert.equal(cpu(result).verdict, "improved");
  assert.deepEqual(result.reasons, []);
});
const withheld: [string, Partial<ComparisonInput>, RegExp][] = [
  ["unsettled data", { now: AT + H }, /Waiting/],
  ["disabled polling", { enabled: false }, /disabled/],
  ["truncated backfill", { truncated: true }, /truncated/],
  ["stale history", { lastSuccessAtMs: NOW - H }, /refreshed/],
  ["unknown baseline", { deployments: [deployed] }, /baseline/],
  ["expired metrics", { now: NOW + 8 * 86400000, lastSuccessAtMs: NOW + 8 * 86400000 }, /expired/],
  ["intervening rollback", { deployments: [deployed, previous, parseDeployment(raw(3, AT + 3 * B))] }, /overlaps/],
  ["split traffic", { deployment: parseDeployment(raw(2, AT, [{ version_id: id(101), percentage: 50 }, { version_id: id(102), percentage: 50 }])) }, /splits/],
 ];
for (const [name, extra, pattern] of withheld) await test(`withholds verdict for ${name}`, () => { const value = comparison(extra); assert.ok(value.reasons.some(reason => pattern.test(reason))); assert.equal(cpu(value).verdict, "confounded"); });

await test("deployment exactly at baseline start is allowed", () => {
  const baseline = parseDeployment(raw(1, AT - H));
  assert.deepEqual(comparison({ deployments: [baseline, deployed] }).reasons, []);
});
await test("traffic mix changes suppress aggregate verdicts", () => {
  const data = rows();
  for (const row of data.slice()) if (row.metric === "worker.invocations") data.push({ ...row, metric: row.bucket_ms < AT ? "route.GET /a.invocations" : "route.GET /b.invocations" });
  const result = comparison({ rows: data });
  assert.ok(result.reasons.some(reason => reason.includes("traffic mix")));
  assert.equal(cpu(result).verdict, "confounded");
});
await test("24-hour windows compare like duration and wait for settlement", () => {
  const now = AT + 26 * H;
  const baseline = parseDeployment(raw(1, AT - 2 * 86400000));
  const result = comparison({ window: "24h", now, lastSuccessAtMs: now, rows: rows("24h"), deployments: [baseline, deployed] });
  assert.deepEqual(result.reasons, []);
  assert.equal(result.after.toMs - result.after.fromMs, 86400000);
  assert.equal(cpu(result).verdict, "improved");
});
await test("configured D1 without rows is unavailable until the window is proven collected", () => {
  assert.equal(metricOf(comparison({ hasD1: true, metricsSettled: false }), "cost").before, null);
  assert.equal(metricOf(comparison({ hasD1: true }), "cost").before, metricOf(comparison(), "cost").before);
});
await test("R2 absent buckets are idle only in proven windows", () => {
  const data = rows();
  for (const row of data.slice()) if (row.metric === "worker.invocations") data.push({ metric: "r2.bucket.ops.success", bucket_ms: row.bucket_ms, value: row.bucket_ms < AT ? 2000 : 1000 });
  let result = comparison({ rows: data, buckets: ["bucket"] });
  assert.equal(metricOf(result, "r2.bucket").verdict, "improved");
  const sparse = data.filter(row => !(row.metric.startsWith("r2.") && row.bucket_ms === AT - H));
  assert.equal(metricOf(comparison({ rows: sparse, buckets: ["bucket"], metricsSettled: false }), "r2.bucket").before, null);
  assert.equal(metricOf(comparison({ rows: sparse, buckets: ["bucket"] }), "r2.bucket").before, 22_000 / 12_000);
});
await test("an absent probe sample counts as neither up nor down, and too few samples leave the window unknown", () => {
  const data = rows();
  const before = data.filter(row => row.metric === "worker.invocations" && row.bucket_ms < AT).map(row => row.bucket_ms).sort((a, b) => a - b);
  for (const row of data.slice()) if (row.metric === "worker.invocations" && row.bucket_ms !== before[0]) { data.push({ metric: "probe.health.up", bucket_ms: row.bucket_ms, value: row.bucket_ms === before[1] ? 0 : 1 }); data.push({ metric: "probe.health.ms", bucket_ms: row.bucket_ms, value: row.bucket_ms === before[1] ? 160 : 50 }); }
  const result = comparison({ rows: data, probes: ["health"] });
  assert.ok(Math.abs((metricOf(result, "probe.health.failure").before ?? 0) - 100 / 11) < 1e-9);
  assert.ok(Math.abs((metricOf(result, "probe.health.ms").before ?? 0) - 60) < 1e-9);
  const sparse = data.filter(row => !(row.metric.startsWith("probe.") && before.slice(0, 4).includes(row.bucket_ms)));
  assert.equal(metricOf(comparison({ rows: sparse, probes: ["health"] }), "probe.health.failure").before, null);
  assert.equal(metricOf(comparison({ rows: sparse, probes: ["health"] }), "probe.health.ms").before, null);
});
await test("probe failures use failure share rather than pretending to be user latency", () => {
  const data = rows();
  for (const row of data.slice()) if (row.metric === "worker.invocations") { data.push({ metric: "probe.health.up", bucket_ms: row.bucket_ms, value: row.bucket_ms < AT ? 1 : 0 }); data.push({ metric: "probe.health.ms", bucket_ms: row.bucket_ms, value: 50 }); }
  const result = comparison({ rows: data, probes: ["health"] });
  assert.equal(metricOf(result, "probe.health.failure").verdict, "regressed");
  assert.ok(result.warnings.some(reason => reason.includes("not user-request latency")));
});
await test("deferred Durable Object updates withhold DO attribution", () => {
  const data = rows();
  for (const row of data.slice()) if (row.metric === "worker.invocations") { data.push({ metric: "do.invocations", bucket_ms: row.bucket_ms, value: 1000 }); data.push({ metric: "do.cpuMsSum", bucket_ms: row.bucket_ms, value: row.bucket_ms < AT ? 10000 : 8000 }); }
  const result = comparison({ deployment: { ...deployed, deferred: true }, rows: data, hasDurableObjects: true });
  assert.equal(metricOf(result, "do.cpu").verdict, "confounded");
  assert.equal(cpu(result).verdict, "improved");
});

await test("SQLite migration is additive and repeatable", () => {
  const state = storage(); state.sql.run("CREATE TABLE hosts (id TEXT)"); initializeDeployments(state.sql); initializeDeployments(state.sql);
  assert.equal(state.sql.rows("SELECT name FROM sqlite_master WHERE type = 'table'").length, 5); state.db.close();
});
await test("SQLite unchanged polls only update the sync record", () => {
  const state = storage(); initializeDeployments(state.sql); saveDeploymentPoll(state.sql, poll());
  const before = changes(state.db);
  saveDeploymentPoll(state.sql, poll({ atMs: NOW + B }));
  const after = changes(state.db);
  assert.equal(after - before, 1);
  assert.equal(readDeployments(state.sql, "stats", "stats", NOW).length, 2);
  assert.equal(readVersions(state.sql, "stats", "stats")[0]!.tag, "abc1234"); state.db.close();
});
await test("SQLite failures and out-of-order polls retain last good history", () => {
  const state = storage(); initializeDeployments(state.sql); saveDeploymentPoll(state.sql, poll());
  saveDeploymentPoll(state.sql, poll({ atMs: NOW + B, error: "unauthorized", deployments: [], versions: [] }));
  saveDeploymentPoll(state.sql, poll({ atMs: NOW - B, error: "rate_limited" }));
  assert.equal(readDeploymentSync(state.sql, "stats", "stats")!.lastSuccessAtMs, NOW);
  assert.equal(readDeploymentSync(state.sql, "stats", "stats")!.error, "unauthorized");
  assert.equal(readDeployments(state.sql, "stats", "stats", NOW).length, 2); state.db.close();
});
await test("SQLite scopes a renamed worker separately and retains rollbacks", () => {
  const state = storage(); initializeDeployments(state.sql); saveDeploymentPoll(state.sql, poll({ deployments: [deployed, previous, parseDeployment(raw(3, AT + H, previous.versions.map(version => ({ version_id: version.id, percentage: version.percentage }))))] }));
  assert.equal(readDeployments(state.sql, "stats", "stats", NOW).length, 3);
  assert.equal(readDeployments(state.sql, "stats", "new-worker", NOW).length, 0); state.db.close();
});
await test("SQLite expiry also works while polling is disabled", () => {
  const state = storage(); initializeDeployments(state.sql); saveDeploymentPoll(state.sql, poll());
  purgeDeployments(state.sql, NOW + DEPLOYMENT_RETENTION_MS + 1);
  assert.equal(state.sql.rows("SELECT * FROM project_deployments").length, 0);
  assert.equal(readVersions(state.sql, "stats", "stats").length, 0);
  assert.equal(readDeploymentSync(state.sql, "stats", "stats"), null); state.db.close();
});
await test("SQLite caps deployment history at 1,000 records", () => {
  const state = storage(); initializeDeployments(state.sql);
  saveDeploymentPoll(state.sql, poll({ deployments: Array.from({ length: 1001 }, (_, index) => parseDeployment(raw(index + 1, NOW - index * 1000))), versions: [] }));
  assert.equal(state.sql.rows<{ n: number }>("SELECT COUNT(*) AS n FROM project_deployments")[0]!.n, 1000); state.db.close();
});

await test("no credentials means no API calls or writes", async () => {
  const run = collector(() => { throw new Error("must not fetch"); }, { account: undefined, token: undefined }); await run.run(); assert.deepEqual(run.polls, []);
});
await test("half-configured credentials report configuration without fetching", async () => {
  const run = collector(() => { throw new Error("must not fetch"); }, { token: undefined }); await run.run(); assert.equal(run.polls[0]!.error, "configuration");
});
await test("collector pins the origin, never follows redirects and strips upstream data", async () => {
  const run = collector(async (url, init) => { assert.equal(new URL(url).origin, "https://api.cloudflare.com"); assert.equal(init.redirect, "manual"); assert.equal(init.method, "GET"); assert.ok(init.signal); return response([{ ...raw(), author_email: "private@example.com" }]); });
  await run.run(); assert.equal(run.polls[0]!.error, null); assert.equal(JSON.stringify(run.polls).includes("private@example.com"), false);
});
const failures: [number, string][] = [[302, "upstream"], [401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"], [500, "upstream"]];
for (const [status, code] of failures) await test(`collector handles HTTP ${status} without leaking bodies`, async () => {
  const run = collector(async () => new Response("secret-must-not-leak", { status })); await run.run(); assert.equal(run.polls[0]!.error, code); assert.equal(JSON.stringify(run.polls).includes("secret-must-not-leak"), false);
});
await test("collector records a worker the account does not have as not deployed", async () => { const run = collector(async url => url.includes("/deployments") ? Response.json({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }] }, { status: 404 }) : response([])); await run.run(); assert.equal(run.polls.length, 1); assert.equal(run.polls[0]!.error, "not_deployed"); assert.deepEqual(run.polls[0]!.deployments, []); });
await test("collector validates successful envelopes", async () => { const run = collector(async () => Response.json({ success: false, errors: [{ message: "secret-must-not-leak" }] })); await run.run(); assert.equal(run.polls[0]!.error, "invalid_response"); });
await test("collector caps response bodies even without Content-Length", async () => { const run = collector(async () => new Response("x".repeat(512 * 1024 + 1))); await run.run(); assert.equal(run.polls[0]!.error, "invalid_response"); });
await test("collector follows explicit pagination", async () => {
  const run = collector(async url => {
    const page = Number(new URL(url).searchParams.get("page"));
    return page === 1 ? response(Array.from({ length: 100 }, (_, index) => raw(index + 1, AT - index * 1000)), { total_pages: 2 }) : response([raw(101, AT - H)], { total_pages: 2 });
  });
  await run.run(); assert.equal(run.polls[0]!.deployments.length, 101); assert.equal(run.polls[0]!.truncated, false);
});
await test("collector marks page-budget truncation instead of claiming complete history", async () => {
  const run = collector(async url => { const page = Number(new URL(url).searchParams.get("page")); return response(Array.from({ length: 100 }, (_, index) => raw(page * 100 + index, AT - (page * 100 + index) * 1000)), { total_pages: 4 }); });
  await run.run(); assert.equal(run.polls[0]!.deployments.length, 300); assert.equal(run.polls[0]!.truncated, true);
});
await test("collector detects non-advancing pages", async () => {
  const run = collector(async () => response(Array.from({ length: 100 }, (_, index) => raw(index + 1, AT - index * 1000)), { total_pages: 5 }));
  await run.run(); assert.equal(run.polls[0]!.truncated, true);
});
await test("optional version enrichment failure preserves history", async () => {
  const polls: DeploymentPoll[] = [];
  const run = collector(async url => url.includes("/versions/") ? new Response("denied", { status: 403 }) : response([raw()]), { store: { async recordDeploymentPoll(value) { polls.push(value); }, async knownDeploymentVersions() { return []; } } });
  await run.run(); assert.equal(polls[0]!.error, null); assert.equal(polls[0]!.deployments.length, 1); assert.equal(polls[0]!.versions.length, 0);
});
await test("a project failure does not stop the next project's poll", async () => {
  const run = collector(async url => url.includes("/scripts/stats/") ? new Response("denied", { status: 403 }) : response([raw()]), { projects: [{ id: "stats", worker: "stats" }, { id: "stuff", worker: "stuff" }] });
  await run.run(); assert.equal(run.polls.find(poll => poll.project === "stats")!.error, "unauthorized"); assert.equal(run.polls.find(poll => poll.project === "stuff")!.error, null);
});
await test("client decoders reject identity mismatches and malformed metric values", () => {
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


await test("time alone does not certify partial metrics as settled", () => {
  const value = comparison({ metricsSettled: false });
  assert.equal(cpu(value).verdict, "confounded");
  assert.ok(value.reasons.some(reason => reason.includes("No proof")));
});
await test("coverage merges adjoining windows but preserves outage gaps", () => {
  const state = storage(); initializeDeployments(state.sql);
  rememberSettledWindow(state.sql, "stats", "stats", AT - 3 * H, AT - 2 * H);
  rememberSettledWindow(state.sql, "stats", "stats", AT - 2 * H, AT - H);
  rememberSettledWindow(state.sql, "stats", "stats", AT, AT + H);
  assert.equal(hasSettledWindow(state.sql, "stats", "stats", AT - 3 * H, AT - H), true);
  assert.equal(hasSettledWindow(state.sql, "stats", "stats", AT - 3 * H, AT + H), false);
  assert.equal(hasSettledWindow(state.sql, "stats", "different-worker", AT - 3 * H, AT - H), false);
  rememberSettledWindow(state.sql, "stats", "stats", AT - H, AT);
  assert.equal(hasSettledWindow(state.sql, "stats", "stats", AT - 3 * H, AT + H), true);
  assert.equal(state.sql.rows("SELECT * FROM project_deployment_coverage").length, 1);
  const before = changes(state.db);
  rememberSettledWindow(state.sql, "stats", "stats", AT - H, AT);
  assert.equal(changes(state.db), before);
  state.db.close();
});

await test("latest project summary matches retained history and reads only referenced rows at the caps", async () => {
  const { readLatestDeployment } = await import("../../src/deployments/store.ts");
  const { decodeLatestProjectDeployment } = await import("../../src/deployments/decode.ts");
  const state = storage();
  initializeDeployments(state.sql);
  assert.deepEqual(readLatestDeployment(state.sql, "stats", "stats", NOW), { status: "none" });
  const insertDeployment = state.db.prepare("INSERT INTO project_deployments VALUES (?, ?, ?, ?, ?)");
  const insertVersion = state.db.prepare("INSERT INTO project_deployment_versions VALUES (?, ?, ?, ?, ?)");
  const split = parseDeployment(raw(1, NOW, [{ version_id: id(1001), percentage: 25 }, { version_id: id(1002), percentage: 75 }]));
  state.db.exec("BEGIN");
  for (let index = 1; index <= 1000; index += 1) {
    const deployment = index === 1 ? split : parseDeployment(raw(index, index === 2 ? NOW : NOW - index));
    insertDeployment.run("stats", "stats", deployment.id, deployment.atMs, JSON.stringify(deployment));
  }
  for (let index = 1; index <= 2000; index += 1) {
    const version = { id: id(index + 1000), tag: index === 1 ? "release" : null, message: null };
    insertVersion.run("stats", "stats", version.id, NOW, JSON.stringify(version));
  }
  state.db.exec("COMMIT");
  const counts: number[] = [];
  const measured: SqlDatabase = {
    rows<T>(query: string, ...params: SqlValue[]) { const rows = state.sql.rows<T>(query, ...params); counts.push(rows.length); return rows; },
    each: (query, params, visit) => state.sql.each(query, params, visit),
    run: (query, ...params) => state.sql.run(query, ...params),
    transaction: fn => state.sql.transaction(fn),
    rowsWritten: () => state.sql.rowsWritten(), total: () => state.sql.total(), databaseBytes: () => state.sql.databaseBytes(),
  };
  const summary = readLatestDeployment(measured, "stats", "stats", NOW);
  assert.equal(summary.status, "available");
  if (summary.status !== "available") throw new Error("missing summary");
  assert.deepEqual(summary.deployment, readDeployments(state.sql, "stats", "stats", NOW)[0]);
  assert.deepEqual(counts, [1, 1, 1]);
  assert.deepEqual(decodeLatestProjectDeployment(summary, "stats"), summary);
  assert.ok(new TextEncoder().encode(JSON.stringify(summary)).length < 1000);
  assert.equal(summary.versions[1]!.tag, null);
  assert.deepEqual(readLatestDeployment(state.sql, "stats", "stats", NOW + DEPLOYMENT_RETENTION_MS + 1), { status: "none" });
  const ids = readVersionIds(state.sql, "stats", "stats");
  assert.deepEqual(ids, readVersions(state.sql, "stats", "stats").map(version => version.id));
  assert.equal(ids.length, 2000);
  state.db.close();
});
