import test from "node:test";
import assert from "node:assert/strict";
import { billedBeyondPlan, previousWindowOf, type MeterUsage } from "../../src/cost/ledger.ts";
import { PRICING_REVISION } from "../../src/cost/pricing.ts";
import { buildCostReport, PricingRevisionMismatch, utcMonthOf, type CostReport, type CostReportInput, type ReportLine } from "../../src/cost/report.ts";
import { H, histories } from "./support.ts";

const T0 = 100 * H;
const WINDOW = { fromMs: T0, toMs: T0 + 2 * H };
const NOW = T0 + 3 * H;
const MONTH_FACTOR = (30 * 24) / 2;
const PROJECT = { id: "p", name: "P", worker: "w", workerBilling: "requests-and-cpu" as const, buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [] };

function report(parts: Partial<CostReportInput> & Pick<CostReportInput, "current">): CostReport {
  return buildCostReport({ nowMs: NOW, pricingRevision: PRICING_REVISION, project: PROJECT, windows: { current: WINDOW, previous: previousWindowOf(WINDOW) }, previous: undefined, objectMethods: undefined, planMonth: undefined, ...parts });
}

const find = (lines: readonly ReportLine[], id: string) => lines.find(entry => entry.id === id)!;
const warned = (built: CostReport, code: string, subject: string) => built.warnings.some(entry => entry.code === code && entry.subject === subject);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

await test("rejects a pricing revision other than the table's", () => {
  assert.throws(() => report({ current: histories(T0, {}), pricingRevision: "2000-01-01" }), PricingRevisionMismatch);
});

await test("a Worker series with no covered bucket is uncollected, not free", () => {
  const built = report({ current: histories(T0, { worker: { "worker.invocations": [null, null, null], "worker.cpuMsSum": [null, null, null] } }) });
  const worker = find(built.lines, "worker");
  assert.deepEqual(worker.price, { kind: "uncollected", cause: "no-data" });
  assert.equal(worker.confidence, "unavailable");
  assert.equal(built.total.monthly.now, 0);
  assert.deepEqual(built.total.pricedMeters, []);
  assert.ok(built.total.excluded.some(entry => entry.meter === "workerRequests" && entry.reason === "no-data"));
  assert.ok(warned(built, "line-no-data", "worker"));
  assert.equal(built.total.confidence, "unavailable");
});

await test("a measured zero is a verified price of zero, distinct from unavailable", () => {
  const built = report({ current: histories(T0, { worker: { "worker.invocations": [0, 0, 0], "worker.cpuMsSum": [0, 0, 0] } }) });
  const worker = find(built.lines, "worker");
  assert.deepEqual(worker.price, { kind: "priced", monthly: { now: 0, before: null }, bound: "estimate" });
  assert.equal(worker.confidence, "verified");
  assert.deepEqual(built.total.pricedMeters, ["workerCpuMs", "workerRequests"]);
});

await test("a cpu-only Worker keeps its request counts but prices and bills only CPU, and lists requests as excluded", () => {
  const current = histories(T0, { worker: { "worker.invocations": [1_000_000, 1_000_000, 9e9], "worker.cpuMsSum": [5_000_000, 5_000_000, 9e9] } });
  const settledMs = T0 + 2 * H;
  const planMonth = { histories: current, settledMs };
  const billed = report({ current, planMonth });
  const tail = report({ current, planMonth, project: { ...PROJECT, workerBilling: "cpu-only" } });
  const worker = find(tail.lines, "worker");
  near(find(billed.lines, "worker").parts.find(part => part.label === "requests")!.monthly, 216);
  near(worker.parts.find(part => part.label === "requests")!.monthly, 0);
  near(tail.total.monthly.now, 72);
  assert.deepEqual(worker.usage, { kind: "requests", calls: { now: 720_000_000, before: null }, cpuMs: { now: 3_600_000_000, before: null } });
  assert.ok(warned(tail, "tail-requests-unpriced", "worker"));
  assert.ok(!warned(billed, "tail-requests-unpriced", "worker"));
  assert.deepEqual(tail.total.pricedMeters, ["workerCpuMs"]);
  assert.deepEqual(tail.total.excluded, [{ meter: "workerRequests", reason: "tail-cpu-only" }]);
  assert.equal(tail.planBill.kind, "isolated");
  if (tail.planBill.kind === "isolated" && billed.planBill.kind === "isolated") {
    assert.equal(tail.planBill.usage.workerRequests, 0);
    assert.ok(billed.planBill.usage.workerRequests > 0);
    assert.ok(tail.planBill.projectedMonthEnd < billed.planBill.projectedMonthEnd);
  }
});

await test("a partially covered window gives a qualified run rate with its denominator, never verified", () => {
  const built = report({ current: histories(T0, { worker: { "worker.invocations": [1_000_000, null, 0], "worker.cpuMsSum": [0, null, 0] } }) });
  const worker = find(built.lines, "worker");
  assert.equal(worker.confidence, "qualified");
  assert.deepEqual(worker.coverage, { coveredMs: H, windowMs: 2 * H, fraction: 0.5 });
  near(built.total.monthly.now, 0.3 * 30 * 24);
  assert.ok(warned(built, "window-partial-coverage", "worker"));
  assert.equal(built.total.confidence, "qualified");
});

await test("an absent baseline leaves the change unknown instead of a saving or an increase", () => {
  const built = report({ current: histories(T0, { worker: { "worker.invocations": [10, 10, 0], "worker.cpuMsSum": [1, 1, 0] } }) });
  assert.equal(built.comparison.baseline, "absent");
  assert.equal(built.comparison.change, null);
  assert.equal(built.total.monthly.before, null);
  assert.equal(find(built.lines, "worker").baselineCoverage, null);
  assert.ok(warned(built, "baseline-unavailable", "previous"));
  assert.deepEqual(built.ranking.byChange, []);
});

await test("a baseline that does not reach the previous window start is unknown", () => {
  const previous = histories(T0 - H, { worker: { "worker.invocations": [5], "worker.cpuMsSum": [5] } });
  const built = report({ current: histories(T0, { worker: { "worker.invocations": [10, 10, 0], "worker.cpuMsSum": [1, 1, 0] } }), previous });
  assert.equal(built.comparison.baseline, "absent");
  assert.ok(warned(built, "baseline-missing", "worker"));
});

await test("a route that left the top-N moves into the residual instead of reading as a saving", () => {
  const worker = (calls: number) => ({ "worker.invocations": [calls, calls, 0], "worker.cpuMsSum": [0, 0, 0] });
  const current = histories(T0, { worker: worker(1_000_000), routes: { "route.GET /b.invocations": [400_000, 400_000, 0], "route.GET /b.cpuMsSum": [0, 0, 0] } });
  const previous = histories(T0 - 2 * H, {
    worker: { "worker.invocations": [1_000_000, 1_000_000], "worker.cpuMsSum": [0, 0] },
    routes: { "route.GET /a.invocations": [600_000, 600_000], "route.GET /a.cpuMsSum": [0, 0], "route.GET /b.invocations": [400_000, 400_000], "route.GET /b.cpuMsSum": [0, 0] }
  });
  const built = report({ current, previous });
  const children = find(built.lines, "worker").children;
  assert.deepEqual(children.map(child => child.id), ["route:GET /b", "route:unattributed"]);
  const residual = children[1]!;
  assert.ok(residual.price.kind === "priced" && residual.price.monthly.before !== null);
  assert.ok(residual.price.kind === "priced" && residual.price.monthly.before !== null && Math.abs(residual.price.monthly.now - residual.price.monthly.before) < 1e-9);
  assert.deepEqual(built.total.residuals.map(entry => entry.lineId), ["route:unattributed"]);
  assert.ok(built.ranking.byChange.every(entry => Math.abs(entry.change ?? 0) < 1e-9));
});

await test("a route absent from the previous top-N has an unknown baseline, not a zero one", () => {
  const current = histories(T0, {
    worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [0, 0, 0] },
    routes: { "route.GET /new.invocations": [900_000, 900_000, 0], "route.GET /new.cpuMsSum": [0, 0, 0] }
  });
  const previous = histories(T0 - 2 * H, {
    worker: { "worker.invocations": [1_000_000, 1_000_000], "worker.cpuMsSum": [0, 0] },
    routes: { "route.GET /old.invocations": [900_000, 900_000], "route.GET /old.cpuMsSum": [0, 0] }
  });
  const route = find(find(report({ current, previous }).lines, "worker").children, "route:GET /new");
  assert.ok(route.price.kind === "priced");
  assert.equal(route.price.monthly.before, null);
});

await test("truncated SQL labels that share a prefix stay separate statements", () => {
  const shared = "SELECT value FROM metrics WHERE project = ? AND";
  const database = "9870c4da-3758-4f0c-ab6d-2372eb34009b";
  const current = histories(T0, {
    d1: { "d1.rowsRead": [30, 0, 0], "d1.rowsWritten": [0, 0, 0], "d1.queries": [3, 0, 0], [`d1.${database}.storageBytes`]: [1e9, 1e9, 1e9] },
    d1Statements: {
      [`d1q.${shared} a.queries`]: [1, 0, 0], [`d1q.${shared} a.rowsRead`]: [10, 0, 0], [`d1q.${shared} a.rowsWritten`]: [0, 0, 0],
      [`d1q.${shared} b.queries`]: [2, 0, 0], [`d1q.${shared} b.rowsRead`]: [20, 0, 0], [`d1q.${shared} b.rowsWritten`]: [0, 0, 0],
      "d1q.UPDATE t SET v = v.next.queries": [1, 0, 0], "d1q.UPDATE t SET v = v.next.rowsRead": [0, 0, 0], "d1q.UPDATE t SET v = v.next.rowsWritten": [0, 0, 0]
    }
  });
  const d1 = find(report({ current, project: { ...PROJECT, d1Databases: [database] } }).lines, "d1");
  const statements = d1.children.filter(child => child.kind === "statement");
  assert.deepEqual(statements.map(child => child.label).sort(), [`${shared} a`, `${shared} b`, "UPDATE t SET v = v.next"]);
  const reads = (id: string) => { const usage = find(statements, id).usage; return usage.kind === "rows" ? usage.read.now / MONTH_FACTOR : NaN; };
  near(reads(`statement:${shared} a`), 10);
  near(reads(`statement:${shared} b`), 20);
});

await test("Durable Object duration is an upper bound labelled as a proxy, and SQLite rows are not priced", () => {
  const current = histories(T0, { durableObjects: { "do.invocations": [1_000_000, 1_000_000, 0], "do.wallMsSum": [1_000_000_000, 1_000_000_000, 0], "do.cpuMsSum": [1, 1, 0] } });
  const built = report({ current, project: { ...PROJECT, durableObjectNamespaces: ["a".repeat(32)] } });
  const objects = find(built.lines, "objects");
  assert.ok(objects.price.kind === "priced" && objects.price.bound === "upper");
  assert.equal(objects.confidence, "qualified");
  assert.ok(warned(built, "duration-upper-bound-proxy", "objects"));
  assert.deepEqual(find(objects.children, "object:sqlite").price, { kind: "uncollected", cause: "no-source" });
  assert.ok(built.total.excluded.some(entry => entry.meter === "durableObjectSqliteRows" && entry.reason === "no-source"));
  assert.ok(built.total.excluded.some(entry => entry.meter === "durableObjectStorage" && entry.reason === "no-data"));
  assert.deepEqual(built.total.pricedMeters, ["durableObjectGbSeconds", "durableObjectRequests", "workerCpuMs", "workerRequests"]);
});

await test("R2 operations are listed as excluded because the source has no action column", () => {
  const built = report({ current: histories(T0, { r2: { "r2.media.storageBytes": [1e9, 1e9, 1e9] } }), project: { ...PROJECT, buckets: ["media"] } });
  assert.deepEqual(built.total.excluded.map(entry => [entry.meter, entry.reason]), [["r2ClassAOperations", "no-action-column"], ["r2ClassBOperations", "no-action-column"]]);
  assert.ok(built.total.pricedMeters.includes("r2Storage"));
});

await test("the plan bill is isolated to a UTC month, accrues held storage over time, and leaves the account total unknown", () => {
  const month = Date.UTC(2026, 10, 1);
  const planMonth = { settledMs: month + 2 * H, histories: histories(month, { r2: { "r2.media.storageBytes": [10e9, null, null] } }) };
  const built = report({ current: histories(T0, {}), project: { ...PROJECT, buckets: ["media"] }, planMonth });
  assert.ok(built.planBill.kind === "isolated");
  assert.equal(built.planBill.basis, "utc-month");
  assert.equal(built.planBill.assumption, "project-alone-on-account-allowances");
  assert.deepEqual(built.planBill.month, { fromMs: month, toMs: Date.UTC(2026, 11, 1) });
  near(built.planBill.usage.r2Storage, (10 * 2) / (30 * 24));
  assert.deepEqual(built.planBill.account, { kind: "unknown", reason: "other-projects-not-covered" });
  assert.equal(built.planBill.coverage.windowMs, 2 * H);
});

await test("a month with some buckets uncollected is billed from what exists and warns with the covered fraction", () => {
  const month = Date.UTC(2026, 10, 1);
  const planMonth = { settledMs: month + 2 * H, histories: histories(month, { worker: { "worker.invocations": [0], "worker.cpuMsSum": [0] } }) };
  const built = report({ current: histories(T0, {}), planMonth });
  assert.ok(built.planBill.kind === "isolated");
  assert.equal(built.planBill.coverage.fraction, 0.5);
  const partial = built.warnings.find(entry => entry.code === "plan-month-partial");
  assert.equal(partial?.subject, "plan-bill");
  assert.match(partial?.message ?? "", /50\.0%/u);
  assert.ok(!built.warnings.some(entry => entry.code === "plan-month-unavailable"));
});

await test("a month with no collected bucket has no plan bill rather than a zero one", () => {
  const month = Date.UTC(2026, 10, 1);
  const planMonth = { settledMs: month + 2 * H, histories: histories(month - 10 * H, {}) };
  const built = report({ current: histories(T0, {}), planMonth });
  assert.deepEqual(built.planBill, { kind: "unavailable", reason: "no-data" });
  assert.ok(warned(built, "plan-month-unavailable", "plan-bill"));
  assert.ok(!built.warnings.some(entry => entry.code === "plan-month-partial"));
});

await test("without month histories there is no plan bill and a warning says so", () => {
  const built = report({ current: histories(T0, {}) });
  assert.deepEqual(built.planBill, { kind: "unavailable", reason: "month-histories-not-supplied" });
  assert.ok(warned(built, "plan-month-unavailable", "plan-bill"));
});

await test("the UTC month is the calendar month containing the instant, not a billing cycle", () => {
  assert.deepEqual(utcMonthOf(Date.UTC(2026, 10, 30, 23, 59)), { fromMs: Date.UTC(2026, 10, 1), toMs: Date.UTC(2026, 11, 1) });
  assert.deepEqual(utcMonthOf(Date.UTC(2026, 11, 1)), { fromMs: Date.UTC(2026, 11, 1), toMs: Date.UTC(2027, 0, 1) });
});

await test("a meter is free up to its allowance and billed from the next unit", () => {
  const none: MeterUsage = { workerRequests: 0, workerCpuMs: 0, durableObjectRequests: 0, durableObjectGbSeconds: 0, d1RowsWritten: 0, d1RowsRead: 0, r2Storage: 0, d1Storage: 0, durableObjectStorage: 0 };
  assert.equal(billedBeyondPlan({ ...none, workerRequests: 10_000_000 }), 0);
  near(billedBeyondPlan({ ...none, workerRequests: 10_000_001 }), 0.3e-6);
  assert.equal(billedBeyondPlan({ ...none, d1RowsRead: 25_000_000_000 }), 0);
  near(billedBeyondPlan({ ...none, d1Storage: 6 }), 0.75);
});

await test("a window ending after the clock is flagged", () => {
  const built = report({ current: histories(T0, {}), nowMs: T0 });
  assert.ok(warned(built, "window-ends-after-now", "current"));
});

await test("the report is deterministic and survives a JSON round trip unchanged", () => {
  const current = histories(T0, {
    worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [5, 5, 0] },
    routes: { "route.GET /a.invocations": [600_000, 600_000, 0], "route.GET /a.cpuMsSum": [1, 1, 0] }
  });
  const month = Date.UTC(2026, 10, 1);
  const build = () => report({ current, planMonth: { settledMs: month + H, histories: histories(month, {}) } });
  const first = build();
  assert.deepEqual(build(), first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});
