import { judge, type MetricComparison, type ReasonCode, type Verdict } from "../deployments/compare.ts";
import type { OperationWindowRow } from "../observe/core/store.ts";
import type { CoverageState } from "./coverage.ts";
import type { ComparisonScope, ComparisonSide, ComparisonSpec } from "./spec.ts";

export const OPERATION_MIN_COUNT = 100;
export const OPERATION_DRIFT_FACTOR = 2;
export const OPERATION_SHARE_DRIFT = 0.2;
export const FAILED_SHARE_RISE_POINTS = 1;

export const OPERATION_METRICS = ["cpuMsPerUnit", "wallMsPerUnit", "rowsReadPerUnit", "rowsWrittenPerUnit", "statementsPerUnit"] as const;
export type OperationMetric = typeof OPERATION_METRICS[number];
export type MetricFloors = Readonly<Record<OperationMetric, number>>;

export type ScopedSpec = ComparisonSpec & { readonly scope: ComparisonScope };

type NonBlocking = "route-mix" | "invocations-missing" | "invocations-floor";
type Blocking = Exclude<ReasonCode, NonBlocking>;
export type OperationReason = "deferred" | "version-mismatch" | "work-drift" | "share-drift" | Blocking;
const NON_BLOCKING: readonly NonBlocking[] = ["route-mix", "invocations-missing", "invocations-floor"];
const isBlocking = (code: ReasonCode): code is Blocking => !(NON_BLOCKING as readonly ReasonCode[]).includes(code);

export interface GuardrailResult {
  readonly name: "failed-share" | "ingest-persistence" | "coverage";
  readonly status: "pass" | "regressed" | "insufficient-data";
  readonly before: number | null;
  readonly after: number | null;
}

export interface OperationComparison {
  readonly spec: ScopedSpec;
  readonly unit: string;
  readonly operations: { readonly before: number; readonly after: number };
  readonly workUnits: { readonly before: number; readonly after: number };
  readonly coverage: CoverageState;
  readonly blockedBy: readonly OperationReason[];
  readonly metrics: readonly MetricComparison[];
  readonly guardrails: readonly GuardrailResult[];
}

export interface OperationComparisonInput {
  readonly spec: ScopedSpec;
  readonly before: readonly OperationWindowRow[];
  readonly after: readonly OperationWindowRow[];
  readonly coverage: CoverageState;
  readonly globalReasonCodes: readonly ReasonCode[];
  readonly deferredObjects: boolean;
  readonly floors: MetricFloors;
}

const METRIC_LABELS: Readonly<Record<OperationMetric, { readonly label: string; readonly unit: string }>> = {
  cpuMsPerUnit: { label: "CPU per work unit", unit: "ms" },
  wallMsPerUnit: { label: "Wall time per work unit", unit: "ms" },
  rowsReadPerUnit: { label: "SQLite rows read per work unit", unit: "rows" },
  rowsWrittenPerUnit: { label: "SQLite rows written per work unit", unit: "rows" },
  statementsPerUnit: { label: "SQLite statements per work unit", unit: "statements" }
};

const UNITS: Readonly<Record<ScopedSpec["scope"]["operation"], string>> = {
  "host.ingest": "persisted sample",
  "host.history": "request",
  "project.history": "request",
  "collector.record": "successful run",
  "cleanup.retention": "row expired"
};

interface SideTotals {
  readonly operations: number;
  readonly workUnits: number;
  readonly failed: number;
  readonly received: number;
  readonly persisted: number;
  readonly rejected: number;
  readonly classShare: number;
  readonly foreignVersion: boolean;
  readonly numerators: Readonly<Record<OperationMetric, number>>;
}

function sideTotals(rows: readonly OperationWindowRow[], scope: ComparisonScope, side: ComparisonSide): SideTotals {
  const operationRows = rows.filter(row => row.operation === scope.operation && !row.synthetic && row.bucketAt >= side.fromMs && row.bucketAt < side.toMs);
  const scoped = operationRows.filter(row => scope.workloadClass === null || row.workloadClass === scope.workloadClass);
  const sum = (pick: (row: OperationWindowRow) => number) => scoped.reduce((total, row) => total + pick(row), 0);
  const operations = sum(row => row.count);
  const all = operationRows.reduce((total, row) => total + row.count, 0);
  const workUnits = (() => {
    switch (scope.operation) {
      case "host.ingest": return sum(row => row.work.persisted);
      case "host.history":
      case "project.history": return operations;
      case "collector.record": return sum(row => row.work.runs);
      case "cleanup.retention": return sum(row => row.work.expired);
    }
  })();
  return {
    operations, workUnits, failed: sum(row => row.failed),
    received: sum(row => row.work.received), persisted: sum(row => row.work.persisted),
    rejected: sum(row => row.work.rejectedInvalidSample + row.work.rejectedTooOld + row.work.rejectedConflict),
    classShare: all === 0 ? 0 : operations / all,
    foreignVersion: scoped.some(row => !side.versionIds.includes(row.version)),
    numerators: { cpuMsPerUnit: sum(row => row.cpuMsSum), wallMsPerUnit: sum(row => row.wallMsSum), rowsReadPerUnit: sum(row => row.rowsRead), rowsWrittenPerUnit: sum(row => row.rowsWritten), statementsPerUnit: sum(row => row.statements) }
  };
}

function perUnit(totals: SideTotals, metric: OperationMetric): number | null {
  return totals.operations < OPERATION_MIN_COUNT || totals.workUnits === 0 ? null : totals.numerators[metric] / totals.workUnits;
}

/** Failed share may not rise by more than a point; a clean baseline must stay clean. */
export function failedShareGuardrail(before: { readonly failed: number; readonly operations: number }, after: { readonly failed: number; readonly operations: number }): GuardrailResult {
  const share = (side: { readonly failed: number; readonly operations: number }) => side.operations < OPERATION_MIN_COUNT ? null : side.failed / side.operations * 100;
  const left = share(before), right = share(after);
  if (left === null || right === null) return { name: "failed-share", status: "insufficient-data", before: left, after: right };
  const regressed = before.failed === 0 ? after.failed > 0 : right - left > FAILED_SHARE_RISE_POINTS;
  return { name: "failed-share", status: regressed ? "regressed" : "pass", before: left, after: right };
}

/** persisted / (received - rejected) must not fall. */
export function ingestPersistenceGuardrail(before: { readonly persisted: number; readonly received: number; readonly rejected: number }, after: { readonly persisted: number; readonly received: number; readonly rejected: number }): GuardrailResult {
  const eligible = (side: { readonly received: number; readonly rejected: number }) => side.received - side.rejected;
  const left = eligible(before), right = eligible(after);
  if (left <= 0 || right <= 0) return { name: "ingest-persistence", status: "insufficient-data", before: left > 0 ? before.persisted / left : null, after: right > 0 ? after.persisted / right : null };
  const fell = after.persisted * left < before.persisted * right;
  return { name: "ingest-persistence", status: fell ? "regressed" : "pass", before: before.persisted / left, after: after.persisted / right };
}

function drifted(before: number, after: number): boolean {
  return before > 0 && after > 0 && (after / before > OPERATION_DRIFT_FACTOR || after / before < 1 / OPERATION_DRIFT_FACTOR);
}

/** Descriptive comparison of one operation's work-normalised cost; the global route-mix check does not apply. */
export function compareOperation(input: OperationComparisonInput): OperationComparison {
  const { spec } = input;
  const before = sideTotals(input.before, spec.scope, spec.before);
  const after = sideTotals(input.after, spec.scope, spec.after);
  const blockedBy: OperationReason[] = input.globalReasonCodes.filter(isBlocking);
  if (input.deferredObjects) blockedBy.push("deferred");
  if (before.foreignVersion || after.foreignVersion) blockedBy.push("version-mismatch");
  if (before.operations >= OPERATION_MIN_COUNT && after.operations >= OPERATION_MIN_COUNT && drifted(before.workUnits / before.operations, after.workUnits / after.operations)) blockedBy.push("work-drift");
  if (Math.abs(after.classShare - before.classShare) > OPERATION_SHARE_DRIFT) blockedBy.push("share-drift");
  const blocked = blockedBy.length > 0;
  const metrics = OPERATION_METRICS.map((metric): MetricComparison => {
    const left = perUnit(before, metric), right = perUnit(after, metric);
    const judged = judge(left, right, input.floors[metric], blocked);
    const verdict: Verdict = judged.verdict !== "confounded" && input.coverage !== "reconciled" ? "insufficient-data" : judged.verdict;
    return { metric: `${spec.scope.operation}.${metric}`, ...METRIC_LABELS[metric], before: left, after: right, ...judged, verdict };
  });
  const guardrails: GuardrailResult[] = [
    failedShareGuardrail(before, after),
    ...(spec.scope.operation === "host.ingest" ? [ingestPersistenceGuardrail(before, after)] : []),
    { name: "coverage", status: input.coverage === "reconciled" ? "pass" : "insufficient-data", before: null, after: null }
  ];
  return {
    spec, unit: UNITS[spec.scope.operation], operations: { before: before.operations, after: after.operations }, workUnits: { before: before.workUnits, after: after.workUnits },
    coverage: input.coverage, blockedBy, metrics, guardrails
  };
}
