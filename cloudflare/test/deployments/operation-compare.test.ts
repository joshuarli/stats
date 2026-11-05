import test from "node:test";
import assert from "node:assert/strict";
import { parseDeployment } from "../../src/deployments/model.ts";
import { comparisonBounds, compareDeployment, DEPLOYMENT_BUCKET_MS as B, type DeploymentComparison, type MetricRow } from "../../src/deployments/compare.ts";
import { decodeDeploymentComparison } from "../../src/deployments/decode.ts";
import { measurementIdentity, scopeSpec, windowQuery, type ComparisonScope } from "../../src/compare/spec.ts";
import { computeCoverage, observedEventTotals, type BucketCount } from "../../src/compare/coverage.ts";
import { compareOperation, failedShareGuardrail, ingestPersistenceGuardrail, type MetricFloors, type OperationComparisonInput, type ScopedSpec } from "../../src/compare/operation.ts";
import type { OperationWindowRow, OperationWorkTotals } from "../../src/observe/core/store.ts";

const H = 3_600_000, SETTLE = 45 * 60_000;
const AT = Date.UTC(2026, 10, 2, 12);
const NOW = AT + 3 * H;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const raw = (n: number, atMs: number, version: number) => ({ id: id(n), created_on: new Date(atMs).toISOString(), source: "api", strategy: "percentage", versions: [{ version_id: id(version), percentage: 100 }] });
const deployed = parseDeployment(raw(2, AT, 102));
const previous = parseDeployment(raw(1, AT - 2 * H, 101));
const bounds = comparisonBounds(AT, "1h");

function analyticsRows(routeShift = false): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const [key, route] of [["before", "a"], ["after", routeShift ? "b" : "a"]] as const) {
    for (let at = bounds[key].fromMs; at < bounds[key].toMs; at += B) {
      rows.push({ metric: "worker.invocations", bucket_ms: at, value: 1000 }, { metric: "worker.cpuMsSum", bucket_ms: at, value: key === "before" ? 10_000 : 8_000 }, { metric: `route.${route}.invocations`, bucket_ms: at, value: 1000 });
    }
  }
  return rows;
}
function global(routeShift: boolean): DeploymentComparison {
  return compareDeployment({ deployment: deployed, deployments: [deployed, previous], rows: analyticsRows(routeShift), window: "1h", now: NOW, settleMs: SETTLE, lastSuccessAtMs: NOW, truncated: false, enabled: true, metricsSettled: true });
}

const ZERO_WORK: OperationWorkTotals = {
  received: 0, persisted: 0, duplicate: 0, rejectedInvalidSample: 0, rejectedTooOld: 0, rejectedConflict: 0, inputBytes: 0, points: 0, cells: 0, outputBytes: 0, cacheHit304: 0, cacheRebuilt: 0,
  runs: 0, metricRows: 0, hourRollups: 0, upstreamQueries: 0, expired: 0, backlogRemaining: 0
};
const FLOORS: MetricFloors = { cpuMsPerUnit: 0.01, wallMsPerUnit: 0.1, rowsReadPerUnit: 0.1, rowsWrittenPerUnit: 0.1, statementsPerUnit: 0.1 };

function opRows(side: "before" | "after", version: string, over: Partial<Omit<OperationWindowRow, "work">> & { work?: Partial<OperationWorkTotals> } = {}, operation: OperationWindowRow["operation"] = "host.ingest", workloadClass = ""): OperationWindowRow[] {
  const { work, ...rest } = over;
  const rows: OperationWindowRow[] = [];
  for (let at = bounds[side].fromMs; at < bounds[side].toMs; at += B) {
    rows.push({
      bucketAt: at, version, operation, workloadClass, synthetic: false, count: 20, failed: 0, cpuMsSum: 200, wallMsSum: 400, rowsRead: 40, rowsWritten: 100, statements: 80,
      lagCount: 20, lagMsMax: 100, lagMsSum: 1000, work: { ...ZERO_WORK, received: 200, persisted: 200, ...work }, ...rest
    });
  }
  return rows;
}

function scoped(comparison: DeploymentComparison, scope: ComparisonScope): ScopedSpec {
  return scopeSpec(comparison.spec, scope) as ScopedSpec;
}
function ingestInput(comparison: DeploymentComparison, before: OperationWindowRow[], after: OperationWindowRow[], extra: Partial<OperationComparisonInput> = {}): OperationComparisonInput {
  return { spec: scoped(comparison, { operation: "host.ingest", workloadClass: null }), before, after, coverage: "reconciled", globalReasonCodes: comparison.reasonCodes, deferredObjects: comparison.deferredObjects, floors: FLOORS, ...extra };
}
const verdicts = (result: ReturnType<typeof compareOperation>): Record<string, string | undefined> => Object.fromEntries(result.metrics.map(metric => [metric.metric.split(".").pop(), metric.verdict]) as [string, string][]);

await test("the comparison carries the exact windows, version ids and measurement identity, and round-trips through its decoder", () => {
  const comparison = global(false);
  assert.deepEqual([comparison.spec.before.fromMs, comparison.spec.before.toMs, comparison.spec.after.fromMs, comparison.spec.after.toMs], [bounds.before.fromMs, bounds.before.toMs, bounds.after.fromMs, bounds.after.toMs]);
  assert.deepEqual([comparison.spec.before.deploymentId, comparison.spec.before.versionIds, comparison.spec.after.deploymentId, comparison.spec.after.versionIds], [id(1), [id(101)], id(2), [id(102)]]);
  assert.deepEqual(comparison.spec.measurementRevision, measurementIdentity());
  assert.equal(comparison.spec.scope, null);
  assert.deepEqual(windowQuery(comparison.spec, "after"), { fromMs: bounds.after.fromMs, toMs: bounds.after.toMs });
  assert.deepEqual(windowQuery(scoped(comparison, { operation: "host.history", workloadClass: "1h:cpu" }), "before"), { fromMs: bounds.before.fromMs, toMs: bounds.before.toMs, operation: "host.history" });
  assert.deepEqual(decodeDeploymentComparison(JSON.parse(JSON.stringify(comparison)), id(2), "1h"), comparison);
  assert.equal(comparison.analyticsInvocations.before.length, 12);
});

await test("a route-mix change blocks the global metrics but not a stable operation-scoped metric", () => {
  const comparison = global(true);
  assert.ok(comparison.reasonCodes.includes("route-mix"));
  assert.equal(comparison.metrics.find(metric => metric.metric === "worker.cpu")!.verdict, "confounded");
  const improved = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { cpuMsSum: 100 })));
  assert.deepEqual(improved.blockedBy, []);
  assert.deepEqual(verdicts(improved), { cpuMsPerUnit: "improved", wallMsPerUnit: "unchanged", rowsReadPerUnit: "unchanged", rowsWrittenPerUnit: "unchanged", statementsPerUnit: "unchanged" });
  const regressed = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { cpuMsSum: 400 })));
  assert.equal(verdicts(regressed)["cpuMsPerUnit"], "regressed");
});

await test("global blockers other than route mix confound the operation metric", () => {
  const overlapping = parseDeployment(raw(3, AT + 20 * 60_000, 103));
  const comparison = compareDeployment({ deployment: deployed, deployments: [deployed, previous, overlapping], rows: analyticsRows(), window: "1h", now: NOW, settleMs: SETTLE, lastSuccessAtMs: NOW, truncated: false, enabled: true, metricsSettled: false });
  const result = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { cpuMsSum: 100 })));
  assert.ok(result.blockedBy.includes("unsettled") && result.blockedBy.includes("overlap"));
  assert.ok(result.metrics.every(metric => metric.verdict === "confounded"));
  const deferred = compareOperation(ingestInput(global(false), opRows("before", id(101)), opRows("after", id(102), { cpuMsSum: 100 }), { deferredObjects: true }));
  assert.deepEqual(deferred.blockedBy, ["deferred"]);
});

await test("work units per operation moving beyond 2x blocks, and exactly 2x does not", () => {
  const comparison = global(false);
  const doubled = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { count: 20, work: { persisted: 400 }, cpuMsSum: 200 })));
  assert.deepEqual(doubled.blockedBy, []);
  const tripled = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { work: { persisted: 601 } })));
  assert.deepEqual(tripled.blockedBy, ["work-drift"]);
  assert.ok(tripled.metrics.every(metric => metric.verdict === "confounded"));
  const halved = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { work: { persisted: 99 } })));
  assert.deepEqual(halved.blockedBy, ["work-drift"]);
});

await test("a workload-class share moving more than 20 points blocks a classed operation", () => {
  const comparison = global(false);
  const history = (side: "before" | "after", version: string, scope: number, other: number) => [
    ...opRows(side, version, { count: scope }, "host.history", "1h:cpu"), ...opRows(side, version, { count: other }, "host.history", "raw:cpu")
  ];
  const spec = scoped(comparison, { operation: "host.history", workloadClass: "1h:cpu" });
  const input = (before: OperationWindowRow[], after: OperationWindowRow[]): OperationComparisonInput => ({ spec, before, after, coverage: "reconciled", globalReasonCodes: [], deferredObjects: false, floors: FLOORS });
  const steady = compareOperation(input(history("before", id(101), 10, 10), history("after", id(102), 12, 8)));
  assert.deepEqual(steady.blockedBy, []);
  assert.equal(steady.operations.before, 120);
  const shifted = compareOperation(input(history("before", id(101), 10, 10), history("after", id(102), 15, 5)));
  assert.deepEqual(shifted.blockedBy, ["share-drift"]);
  assert.ok(shifted.metrics.every(metric => metric.verdict === "confounded"));
});

await test("partial or unknown coverage gives insufficient-data, and blockers still win", () => {
  const comparison = global(false);
  for (const coverage of ["partial", "unknown"] as const) {
    const result = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { cpuMsSum: 100 }), { coverage }));
    assert.ok(result.metrics.every(metric => metric.verdict === "insufficient-data"));
    assert.equal(result.guardrails.find(guardrail => guardrail.name === "coverage")!.status, "insufficient-data");
  }
  const blocked = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { work: { persisted: 601 } }), { coverage: "partial" }));
  assert.ok(blocked.metrics.every(metric => metric.verdict === "confounded"));
});

await test("fewer than 100 operations on a side, a foreign version, or no work units cannot give a verdict", () => {
  const comparison = global(false);
  const thin = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { count: 5 })));
  assert.ok(thin.metrics.every(metric => metric.verdict === "insufficient-data" && metric.after === null));
  const rollback = compareOperation(ingestInput(comparison, opRows("before", id(101)), [...opRows("after", id(102)), ...opRows("after", id(101)).slice(0, 1)]));
  assert.deepEqual(rollback.blockedBy, ["version-mismatch"]);
  const idle = compareOperation(ingestInput(comparison, opRows("before", id(101)), opRows("after", id(102), { work: { persisted: 0 } })));
  assert.ok(idle.metrics.every(metric => metric.verdict === "insufficient-data"));
  const synthetic = compareOperation(ingestInput(comparison, opRows("before", id(101)), [...opRows("after", id(102)), ...opRows("after", id(103), { synthetic: true, cpuMsSum: 1e6 })]));
  assert.deepEqual(synthetic.blockedBy, []);
});

await test("the failed-share guardrail keeps a clean baseline clean and otherwise allows one point", () => {
  const side = (failed: number, operations = 1000) => ({ failed, operations });
  assert.equal(failedShareGuardrail(side(0), side(0)).status, "pass");
  assert.equal(failedShareGuardrail(side(0), side(1)).status, "regressed");
  assert.equal(failedShareGuardrail(side(10), side(20)).status, "pass");
  assert.equal(failedShareGuardrail(side(10), side(21)).status, "regressed");
  assert.equal(failedShareGuardrail(side(0), side(0, 99)).status, "insufficient-data");
});

await test("the ingest persistence guardrail fails only when persisted over accepted-for-processing falls", () => {
  const side = (persisted: number, received: number, rejected: number) => ({ persisted, received, rejected });
  assert.equal(ingestPersistenceGuardrail(side(90, 100, 0), side(90, 100, 0)).status, "pass");
  assert.equal(ingestPersistenceGuardrail(side(90, 100, 0), side(95, 100, 0)).status, "pass");
  assert.equal(ingestPersistenceGuardrail(side(90, 100, 0), side(89, 100, 0)).status, "regressed");
  assert.equal(ingestPersistenceGuardrail(side(90, 100, 10), side(89, 100, 10)).status, "regressed");
  assert.equal(ingestPersistenceGuardrail(side(80, 100, 20), side(80, 100, 20)).status, "pass");
  assert.equal(ingestPersistenceGuardrail(side(0, 10, 10), side(1, 10, 0)).status, "insufficient-data");
});

const FROM = AT, TO = AT + 12 * B;
const counts = (value: number, skip = -1): BucketCount[] => Array.from({ length: 12 }, (_, n) => ({ atMs: FROM + n * B, value })).filter((_, n) => n !== skip);

await test("coverage reconciles within 5 percent inclusive and is partial beyond it", () => {
  const exact = computeCoverage({ fromMs: FROM, toMs: TO, observed: counts(95), analytics: counts(100) });
  assert.equal(exact.state, "reconciled");
  assert.equal(exact.spread, 0.05);
  assert.equal(computeCoverage({ fromMs: FROM, toMs: TO, observed: counts(105), analytics: counts(100) }).state, "reconciled");
  const over = computeCoverage({ fromMs: FROM, toMs: TO, observed: counts(94), analytics: counts(100) });
  assert.equal(over.state, "partial");
  assert.ok(over.spread! > 0.05);
  assert.equal(computeCoverage({ fromMs: FROM, toMs: TO, observed: counts(106), analytics: counts(100) }).state, "partial");
});

await test("coverage treats a bucket missing from either source as partial, and a source without the window as unknown", () => {
  assert.deepEqual(computeCoverage({ fromMs: FROM, toMs: TO, observed: counts(100, 3), analytics: counts(100) }).missingBuckets, 1);
  assert.equal(computeCoverage({ fromMs: FROM, toMs: TO, observed: counts(100, 3), analytics: counts(100) }).state, "partial");
  assert.equal(computeCoverage({ fromMs: FROM, toMs: TO, observed: counts(100), analytics: counts(100, 11) }).state, "partial");
  for (const [observed, analytics] of [[null, counts(100)], [counts(100), null], [[], counts(100)], [counts(100), []]] as const) {
    assert.equal(computeCoverage({ fromMs: FROM, toMs: TO, observed, analytics }).state, "unknown");
  }
  const outside = counts(100).map(item => ({ ...item, atMs: item.atMs + 24 * B }));
  assert.equal(computeCoverage({ fromMs: FROM, toMs: TO, observed: outside, analytics: counts(100) }).state, "unknown");
  assert.equal(computeCoverage({ fromMs: FROM, toMs: TO, observed: counts(0), analytics: counts(0) }).state, "partial");
});

await test("observed event totals add every outcome class to the retained invocations of the chosen stages", () => {
  const window = {
    invocations: [{ bucketAt: FROM, version: "v", stage: "worker" as const, count: 90 }, { bucketAt: FROM, version: "v", stage: "object" as const, count: 40 }],
    outcomes: [
      { bucketAt: FROM, version: "v", stage: "worker" as const, outcome: "excluded-status:404" as const, count: 6, lagCount: 0, lagMsMax: 0, lagMsSum: 0, filterRevision: 1 },
      { bucketAt: FROM + B, version: "v", stage: "worker" as const, outcome: "excluded-route" as const, count: 4, lagCount: 0, lagMsMax: 0, lagMsSum: 0, filterRevision: 1 }
    ]
  };
  assert.deepEqual(observedEventTotals(window, ["worker"]), [{ atMs: FROM, value: 96 }, { atMs: FROM + B, value: 4 }]);
  assert.deepEqual(observedEventTotals(window, ["worker", "object"]), [{ atMs: FROM, value: 136 }, { atMs: FROM + B, value: 4 }]);
});
