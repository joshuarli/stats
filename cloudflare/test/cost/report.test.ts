import test from "node:test";
import assert from "node:assert/strict";
import { billedBeyondPlan, previousWindowOf, type MeterUsage } from "../../src/cost/ledger.ts";
import { PRICING_REVISION } from "../../src/cost/pricing.ts";
import { buildCostReport, PricingRevisionMismatch, utcMonthOf, type CostReport, type CostReportInput, type ReportLine } from "../../src/cost/report.ts";
import { objectMethodsOf } from "../../src/client/project-ledger.ts";
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

await test("missing worker CPU is excluded instead of priced as zero", () => {
  const current = histories(T0, { worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [null, null, null] } });
  const built = report({ current });
  const worker = find(built.lines, "worker");
  assert.equal(worker.price.kind, "priced");
  assert.ok(built.total.pricedMeters.includes("workerRequests"));
  assert.ok(!built.total.pricedMeters.includes("workerCpuMs"));
  assert.ok(built.total.excluded.some(entry => entry.meter === "workerCpuMs" && entry.reason === "no-data"));
  assert.equal(worker.confidence, "qualified");
  assert.ok(warned(built, "meter-no-data", "workerCpuMs"));
  assert.ok(built.total.monthly.now > 0);
  assert.equal(worker.usage.kind === "requests" && worker.usage.cpuMs, null);
  assert.equal(worker.parts.some(part => part.label === "CPU"), false);
  const zero = report({ current: histories(T0, { worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [0, 0, 0] } }) });
  assert.ok(zero.total.pricedMeters.includes("workerCpuMs"));
  const zeroWorker = find(zero.lines, "worker");
  assert.equal(zeroWorker.usage.kind === "requests" && zeroWorker.usage.cpuMs?.now, 0);
  const previous = histories(T0 - 2 * H, { worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [null, null, null] } });
  const later = report({ current: histories(T0, { worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [100, 100, 0] } }), previous });
  const laterWorker = find(later.lines, "worker");
  assert.equal(laterWorker.price.kind === "priced" && laterWorker.price.monthly.before, null);
});

await test("a monthly bill and projection name missing worker meters", () => {
  const month = Date.UTC(2026, 10, 1);
  const worker = { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [null, null, null] };
  const built = report({ current: histories(T0, { worker }), planMonth: { settledMs: month + 2 * H, histories: histories(month, { worker }) } });
  assert.equal(built.planBill.kind, "isolated");
  if (built.planBill.kind !== "isolated") throw new Error("expected a partial plan bill");
  assert.equal(built.planBill.usage.workerCpuMs, null);
  assert.deepEqual(built.planBill.missingBilledMeters, ["workerCpuMs"]);
  assert.deepEqual(built.planBill.missingProjectionMeters, ["workerCpuMs"]);
  assert.ok(warned(built, "plan-month-missing-meter", "plan-bill"));
  assert.ok(warned(built, "plan-projection-missing-meter", "plan-bill"));
  const completeMonth = histories(month, { worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [0, 0, 0] } });
  const projectionOnly = report({ current: histories(T0, { worker }), planMonth: { settledMs: month + 2 * H, histories: completeMonth } });
  if (projectionOnly.planBill.kind !== "isolated") throw new Error("expected a partial projection");
  assert.equal(projectionOnly.planBill.usage.workerCpuMs, 0);
  assert.deepEqual(projectionOnly.planBill.missingBilledMeters, []);
  assert.deepEqual(projectionOnly.planBill.missingProjectionMeters, ["workerCpuMs"]);
  const billedOnly = report({ current: histories(T0, { worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [0, 0, 0] } }), planMonth: { settledMs: month + 2 * H, histories: histories(month, { worker }) } });
  if (billedOnly.planBill.kind !== "isolated") throw new Error("expected a partial bill");
  assert.deepEqual(billedOnly.planBill.missingBilledMeters, ["workerCpuMs"]);
  assert.deepEqual(billedOnly.planBill.missingProjectionMeters, ["workerCpuMs"]);
});

await test("monthly bills disclose the Durable Object wall-time proxy separately for each window", () => {
  const month = Date.UTC(2026, 10, 1);
  const worker = { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [null, null, null] };
  const object = { "do.invocations": [100, 100, 0], "do.wallMsSum": [500, 500, 0] };
  const project = { ...PROJECT, durableObjectNamespaces: ["store"] };
  const monthWithProxy = histories(month, { worker, durableObjects: object });
  const noCurrentProxy = histories(T0, { worker });
  const billedProxy = report({ current: noCurrentProxy, project, planMonth: { settledMs: month + 2 * H, histories: monthWithProxy } });
  if (billedProxy.planBill.kind !== "isolated") throw new Error("expected plan bill");
  assert.deepEqual(billedProxy.planBill.durationProxy, { billed: true, projected: true });
  assert.ok(warned(billedProxy, "plan-duration-upper-bound-proxy", "plan-bill"));
  const monthWithoutProxy = histories(month, { worker });
  const projectedProxy = report({ current: histories(T0, { worker, durableObjects: object }), project, planMonth: { settledMs: month + 2 * H, histories: monthWithoutProxy } });
  if (projectedProxy.planBill.kind !== "isolated") throw new Error("expected plan bill");
  assert.deepEqual(projectedProxy.planBill.durationProxy, { billed: false, projected: true });
  const noProxy = report({ current: noCurrentProxy, project, planMonth: { settledMs: month + 2 * H, histories: monthWithoutProxy } });
  if (noProxy.planBill.kind !== "isolated") throw new Error("expected plan bill");
  assert.deepEqual(noProxy.planBill.durationProxy, { billed: false, projected: false });
  assert.equal(warned(noProxy, "plan-duration-upper-bound-proxy", "plan-bill"), false);
});

await test("missing worker requests leave measured CPU available", () => {
  const current = histories(T0, { worker: { "worker.invocations": [null, null, null], "worker.cpuMsSum": [100, 100, 0] } });
  const built = report({ current });
  const worker = find(built.lines, "worker");
  assert.equal(worker.usage.kind === "requests" && worker.usage.calls, null);
  assert.ok(built.total.pricedMeters.includes("workerCpuMs"));
  assert.ok(built.total.excluded.some(entry => entry.meter === "workerRequests" && entry.reason === "no-data"));
  assert.ok(warned(built, "meter-no-data", "workerRequests"));
  assert.ok(built.total.monthly.now > 0);
  const cpuOnly = report({ current, project: { ...PROJECT, workerBilling: "cpu-only" } });
  assert.ok(cpuOnly.total.pricedMeters.includes("workerCpuMs"));
  assert.ok(cpuOnly.total.excluded.some(entry => entry.meter === "workerRequests" && entry.reason === "tail-cpu-only"));
  assert.equal(warned(cpuOnly, "meter-no-data", "workerRequests"), false);
});

await test("a route missing CPU is a partial contributor rather than zero CPU", () => {
  const current = histories(T0, {
    worker: { "worker.invocations": [100, 100, 0], "worker.cpuMsSum": [200, 200, 0] },
    routes: { "route.GET /a.invocations": [50, 50, 0], "route.GET /a.cpuMsSum": [null, null, null] }
  });
  const built = report({ current });
  const route = find(find(built.lines, "worker").children, "route:GET /a");
  assert.equal(route.usage.kind === "requests" && route.usage.cpuMs, null);
  assert.equal(route.confidence, "qualified");
  assert.ok(warned(built, "route-meter-no-data", "route:GET /a"));
  assert.ok(built.total.pricedMeters.includes("workerCpuMs"));
  assert.ok(built.total.residuals.some(entry => entry.lineId === "route:unattributed"));
});

await test("missing Durable Object duration is excluded while known requests remain priced", () => {
  const month = Date.UTC(2026, 10, 1);
  const object = { "do.invocations": [1_000_000, 1_000_000, 0], "do.wallMsSum": [null, null, null], "do.cpuMsSum": [100, 100, 0] };
  const project = { ...PROJECT, durableObjectNamespaces: ["store"] };
  const method = { label: "Store.get", requests: 4, failed: 0, cpuMs: 10, wallMs: 20, p50WallMs: 5, p95WallMs: 8 };
  const current = histories(T0, { durableObjects: object });
  const built = report({ current, project, objectMethods: { now: [method], before: null }, planMonth: { settledMs: month + 2 * H, histories: histories(month, { durableObjects: object }) } });
  const objects = find(built.lines, "objects");
  assert.equal(objects.usage.kind === "objects" && objects.usage.wallMs, null);
  assert.equal(objects.confidence, "qualified");
  assert.ok(built.total.pricedMeters.includes("durableObjectRequests"));
  assert.ok(built.total.excluded.some(entry => entry.meter === "durableObjectGbSeconds" && entry.reason === "no-data"));
  assert.ok(warned(built, "meter-no-data", "durableObjectGbSeconds"));
  assert.ok(warned(built, "object-method-meter-no-data", "object:Store.get"));
  assert.equal(find(objects.children, "object:Store.get").price.kind, "priced");
  if (built.planBill.kind !== "isolated") throw new Error("expected partial plan bill");
  assert.equal(built.planBill.usage.durableObjectGbSeconds, null);
  assert.ok(built.planBill.missingBilledMeters.includes("durableObjectGbSeconds"));
  assert.ok(built.planBill.missingProjectionMeters.includes("durableObjectGbSeconds"));
  const zero = report({ current: histories(T0, { durableObjects: { ...object, "do.wallMsSum": [0, 0, 0] } }), project });
  const zeroObjects = find(zero.lines, "objects");
  assert.equal(zeroObjects.usage.kind === "objects" && zeroObjects.usage.wallMs?.now, 0);
  assert.ok(zero.total.pricedMeters.includes("durableObjectGbSeconds"));
  const missingCalls = report({ current: histories(T0, { durableObjects: { "do.invocations": [null, null, null], "do.wallMsSum": [500, 500, 0], "do.cpuMsSum": [null, null, null] } }), project });
  const calls = find(missingCalls.lines, "objects");
  assert.equal(calls.usage.kind === "objects" && calls.usage.calls, null);
  assert.equal(calls.usage.kind === "objects" && calls.usage.cpuMs, null);
  assert.ok(missingCalls.total.excluded.some(entry => entry.meter === "durableObjectRequests" && entry.reason === "no-data"));
  assert.ok(missingCalls.total.pricedMeters.includes("durableObjectGbSeconds"));
  const previous = histories(T0 - 2 * H, { durableObjects: object });
  const currentWall = histories(T0, { durableObjects: { ...object, "do.wallMsSum": [500, 500, 0] } });
  const later = find(report({ current: currentWall, previous, project }).lines, "objects");
  assert.equal(later.price.kind === "priced" && later.price.monthly.before, null);
});

await test("missing D1 rows written are excluded instead of priced as zero", () => {
  const current = histories(T0, { d1: { "d1.rowsRead": [100, 100, 0], "d1.rowsWritten": [null, null, null], "d1.queries": [10, 10, 0] } });
  const built = report({ current, project: { ...PROJECT, d1Databases: ["db"] } });
  const d1 = find(built.lines, "d1");
  assert.equal(d1.usage.kind === "rows" && d1.usage.written, null);
  assert.ok(built.total.pricedMeters.includes("d1RowsRead"));
  assert.ok(built.total.excluded.some(entry => entry.meter === "d1RowsWritten" && entry.reason === "no-data"));
  assert.ok(warned(built, "meter-no-data", "d1RowsWritten"));
  assert.equal(d1.confidence, "qualified");
  const zero = report({ current: histories(T0, { d1: { "d1.rowsRead": [100, 100, 0], "d1.rowsWritten": [0, 0, 0], "d1.queries": [10, 10, 0] } }), project: { ...PROJECT, d1Databases: ["db"] } });
  const zeroD1 = find(zero.lines, "d1");
  assert.equal(zeroD1.usage.kind === "rows" && zeroD1.usage.written?.now, 0);
  assert.ok(zero.total.pricedMeters.includes("d1RowsWritten"));
});

await test("missing D1 statement and month meters remain partial", () => {
  const month = Date.UTC(2026, 10, 1);
  const d1 = { "d1.rowsRead": [100, 100, 0], "d1.rowsWritten": [null, null, null], "d1.queries": [10, 10, 0] };
  const statement = { "d1q.SELECT 1.queries": [10, 10, 0], "d1q.SELECT 1.rowsRead": [100, 100, 0], "d1q.SELECT 1.rowsWritten": [null, null, null] };
  const current = histories(T0, { d1, d1Statements: statement });
  const built = report({ current, project: { ...PROJECT, d1Databases: ["db"] }, planMonth: { settledMs: month + 2 * H, histories: histories(month, { d1 }) } });
  const line = find(find(built.lines, "d1").children, "statement:SELECT 1");
  assert.equal(line.usage.kind === "rows" && line.usage.written, null);
  assert.equal(line.confidence, "qualified");
  assert.ok(warned(built, "statement-meter-no-data", "statement:SELECT 1"));
  assert.equal(built.planBill.kind, "isolated");
  if (built.planBill.kind !== "isolated") throw new Error("expected a partial bill");
  assert.equal(built.planBill.usage.d1RowsWritten, null);
  assert.ok(built.planBill.missingBilledMeters.includes("d1RowsWritten"));
  assert.ok(built.planBill.missingProjectionMeters.includes("d1RowsWritten"));
  const noQueries = histories(T0, { d1, d1Statements: { ...statement, "d1q.SELECT 1.queries": [null, null, null] } });
  const retained = find(find(report({ current: noQueries, project: { ...PROJECT, d1Databases: ["db"] } }).lines, "d1").children, "statement:SELECT 1");
  assert.equal(retained.usage.kind === "rows" && retained.usage.queries, null);
});

await test("sampled object methods do not turn an unseen baseline into zero", () => {
  const metrics = { "do.invocations": [100, 100, 0], "do.wallMsSum": [1_000, 1_000, 0], "do.cpuMsSum": [100, 100, 0] };
  const current = histories(T0, { durableObjects: metrics });
  const previous = histories(T0 - 2 * H, { durableObjects: metrics });
  const method = { label: "Store.get", requests: 4, failed: 0, cpuMs: 10, wallMs: 20, p50WallMs: 5, p95WallMs: 8 };
  const sampling = { keepPerMillion: 100_000, kept: 4, observed: 40 };
  const now = { fromMs: T0, toMs: T0 + 2 * H, methods: [method], sampling };
  const before = { fromMs: T0 - 2 * H, toMs: T0, methods: [], sampling };
  const built = report({ current, previous, project: { ...PROJECT, durableObjectNamespaces: ["store"] }, objectMethods: objectMethodsOf(now, before) });
  const entry = find(find(built.lines, "objects").children, "object:Store.get");
  assert.equal(entry.price.kind, "priced");
  if (entry.price.kind !== "priced" || entry.usage.kind !== "objects" || entry.usage.calls === null) throw new Error("expected priced object usage");
  assert.equal(entry.price.monthly.before, null);
  assert.equal(entry.usage.calls.before, null);
  assert.equal(entry.price.bound, "estimate");
  assert.equal(entry.confidence, "qualified");
  assert.ok(warned(built, "object-method-sampled", "current"));
  assert.ok(warned(built, "object-method-sampled", "previous"));
  const unsampled = report({ current, previous, project: { ...PROJECT, durableObjectNamespaces: ["store"] }, objectMethods: objectMethodsOf({ fromMs: now.fromMs, toMs: now.toMs, methods: now.methods }, { fromMs: before.fromMs, toMs: before.toMs, methods: before.methods }) });
  const plain = find(find(unsampled.lines, "objects").children, "object:Store.get");
  assert.equal(plain.price.kind === "priced" && plain.price.monthly.before, 0);
  assert.equal(warned(unsampled, "object-method-sampled", "current"), false);
  const earlierSampled = report({ current, previous, project: { ...PROJECT, durableObjectNamespaces: ["store"] }, objectMethods: objectMethodsOf({ fromMs: now.fromMs, toMs: now.toMs, methods: now.methods }, before) });
  const mixed = find(find(earlierSampled.lines, "objects").children, "object:Store.get");
  assert.equal(mixed.price.kind === "priced" && mixed.price.monthly.before, null);
  assert.equal(mixed.price.kind === "priced" && mixed.price.bound, "upper");
  assert.equal(warned(earlierSampled, "object-method-sampled", "current"), false);
  assert.ok(warned(earlierSampled, "object-method-sampled", "previous"));
});

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
    assert.ok(billed.planBill.usage.workerRequests !== null && billed.planBill.usage.workerRequests > 0);
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
  const reads = (id: string) => { const usage = find(statements, id).usage; return usage.kind === "rows" && usage.read !== null ? usage.read.now / MONTH_FACTOR : NaN; };
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
