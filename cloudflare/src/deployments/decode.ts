import { parseDeployment, parseVersion, record, type DeploymentHistory, type LatestDeployment } from "./model.ts";
import { COMPARISON_WINDOWS, METRIC_REASON_CODES, type BucketValue, type ComparisonWindow, type DeploymentComparison, type MetricComparison, type MetricReasonCode, type ReasonCode, type Verdict, type WindowBounds } from "./compare.ts";
import type { ComparableOperation, ComparisonScope, ComparisonSide, ComparisonSpec } from "../compare/spec.ts";

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid deployment number");
  return value;
}
function nullableNumber(value: unknown): number | null { return value === null ? null : number(value); }
function time(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 8.64e15) throw new Error("invalid deployment time");
  return result;
}
function string(value: unknown, limit = 1000): string {
  if (typeof value !== "string" || value.length > limit) throw new Error("invalid deployment string");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid deployment boolean");
  return value;
}
function array<T>(value: unknown, limit: number, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error("invalid deployment array");
  return value.map(decode);
}

export function decodeDeploymentHistory(value: unknown, projectId: string): DeploymentHistory {
  const item = record(value);
  if (item["projectId"] !== projectId) throw new Error("deployment project mismatch");
  const deployments = array(item["deployments"], 1000, raw => {
    const deployment = record(raw);
    return parseDeployment({
      id: deployment["id"], created_on: new Date(time(deployment["atMs"])).toISOString(), source: deployment["source"], strategy: "percentage",
      annotations: { "workers/message": deployment["message"] },
      code_update_strategy: { mode: boolean(deployment["deferred"]) ? "deferred" : "immediate" },
      versions: array(deployment["versions"], 2, rawVersion => { const version = record(rawVersion); return { version_id: version["id"], percentage: version["percentage"] }; }),
    });
  });
  if (new Set(deployments.map(deployment => deployment.id)).size !== deployments.length) throw new Error("duplicate deployment");
  const versions = array(item["versions"], 2000, raw => {
    const version = record(raw);
    const id = string(version["id"], 36);
    return parseVersion({ id, annotations: { "workers/tag": version["tag"], "workers/message": version["message"] } }, id);
  });
  const sync = item["sync"] === null ? null : record(item["sync"]);
  return {
    projectId, worker: string(item["worker"], 63), enabled: boolean(item["enabled"]), deployments, versions,
    sync: sync === null ? null : {
      lastAttemptAtMs: time(sync["lastAttemptAtMs"]),
      lastSuccessAtMs: sync["lastSuccessAtMs"] === null ? null : time(sync["lastSuccessAtMs"]),
      error: sync["error"] === null ? null : string(sync["error"], 128), truncated: boolean(sync["truncated"]),
    },
  };
}

export function decodeLatestProjectDeployment(value: unknown, projectId: string): LatestDeployment | undefined {
  if (value === undefined) return undefined;
  try {
    const item = record(value);
    if (item["status"] === "none" || item["status"] === "unavailable") return { status: item["status"] };
    if (item["status"] !== "available") throw new Error("invalid deployment summary");
    const versions = array(item["versions"], 2, entry => entry);
    const history = decodeDeploymentHistory({ projectId, worker: "", enabled: true, sync: null, deployments: [item["deployment"]], versions }, projectId);
    return { status: "available", deployment: history.deployments[0]!, versions: history.versions };
  } catch { return { status: "unavailable" }; }
}

const REASON_CODES: readonly ReasonCode[] = [
  "unsettled", "disabled", "not-ready", "expired", "truncated", "stale-history", "split", "baseline-missing", "baseline-split", "overlap",
  "invocations-missing", "invocations-floor", "route-mix", "no-data"
];
const COMPARABLE_OPERATIONS: readonly ComparableOperation[] = ["host.ingest", "host.history", "project.history", "collector.record"];

function decodeSide(value: unknown): ComparisonSide {
  const side = record(value);
  const deploymentId = side["deploymentId"] === null ? null : string(side["deploymentId"], 36);
  const fromMs = time(side["fromMs"]), toMs = time(side["toMs"]);
  if (toMs <= fromMs) throw new Error("invalid comparison side");
  return { deploymentId, versionIds: array(side["versionIds"], 2, item => string(item, 128)), fromMs, toMs };
}

function decodeScope(value: unknown): ComparisonScope | null {
  if (value === null) return null;
  const scope = record(value);
  const operation = string(scope["operation"], 32) as ComparableOperation;
  if (!COMPARABLE_OPERATIONS.includes(operation)) throw new Error("invalid comparison scope");
  if (operation === "host.history" || operation === "project.history") return { operation, workloadClass: string(scope["workloadClass"], 128) };
  if (scope["workloadClass"] !== null) throw new Error("invalid comparison scope");
  return { operation, workloadClass: null };
}

function decodeSpec(value: unknown): ComparisonSpec {
  const spec = record(value);
  const identity = record(spec["measurementRevision"]);
  return {
    before: decodeSide(spec["before"]), after: decodeSide(spec["after"]), scope: decodeScope(spec["scope"]),
    measurementRevision: { measurement: number(identity["measurement"]), observeFilter: number(identity["observeFilter"]), pricing: string(identity["pricing"], 32) }
  };
}

function decodeBuckets(value: unknown): BucketValue[] {
  return array(value, 2016, raw => { const bucket = record(raw); return { atMs: time(bucket["atMs"]), value: number(bucket["value"]) }; });
}

function metricReasonCode(value: unknown): MetricReasonCode {
  const code = METRIC_REASON_CODES.find(known => known === value);
  if (code === undefined) throw new Error("invalid metric reason code");
  return code;
}

function observedBasis(value: unknown): "observed-work" {
  if (value !== "observed-work") throw new Error("invalid metric basis");
  return value;
}

export function decodeDeploymentComparison(value: unknown, deploymentId: string, window: ComparisonWindow): DeploymentComparison {
  const item = record(value);
  if (item["deploymentId"] !== deploymentId || item["window"] !== window) throw new Error("deployment comparison mismatch");
  const bounds = (value: unknown): WindowBounds => {
    const span = record(value);
    const fromMs = time(span["fromMs"]), toMs = time(span["toMs"]);
    if (toMs - fromMs !== COMPARISON_WINDOWS[window]) throw new Error("invalid comparison duration");
    return { fromMs, toMs };
  };
  const verdicts: readonly Verdict[] = ["improved", "regressed", "unchanged", "insufficient-data", "confounded"];
  const metrics = array<MetricComparison>(item["metrics"], 96, raw => {
    const metric = record(raw);
    const verdict = string(metric["verdict"]) as Verdict;
    if (!verdicts.includes(verdict)) throw new Error("invalid comparison verdict");
    return { metric: string(metric["metric"]), label: string(metric["label"]), unit: string(metric["unit"], 32), before: nullableNumber(metric["before"]), after: nullableNumber(metric["after"]), delta: nullableNumber(metric["delta"]), deltaPercent: nullableNumber(metric["deltaPercent"]), verdict, ...(metric["supersededBy"] === undefined ? {} : { supersededBy: string(metric["supersededBy"], 64) }), ...(metric["reason"] === undefined ? {} : { reason: string(metric["reason"], 1000) }), ...(metric["reasonCode"] === undefined ? {} : { reasonCode: metricReasonCode(metric["reasonCode"]) }), ...(metric["basis"] === undefined ? {} : { basis: observedBasis(metric["basis"]) }) };
  });
  return { deploymentId, window, before: bounds(item["before"]), after: bounds(item["after"]), readyAtMs: time(item["readyAtMs"]), beforeInvocations: nullableNumber(item["beforeInvocations"]), afterInvocations: nullableNumber(item["afterInvocations"]), spec: decodeSpec(item["spec"]), reasons: array(item["reasons"], 20, value => string(value)), reasonCodes: array(item["reasonCodes"], 20, value => { const code = string(value, 32) as ReasonCode; if (!REASON_CODES.includes(code)) throw new Error("invalid comparison reason code"); return code; }), deferredObjects: boolean(item["deferredObjects"]), analyticsInvocations: { before: decodeBuckets(record(item["analyticsInvocations"])["before"]), after: decodeBuckets(record(item["analyticsInvocations"])["after"]) }, warnings: array(item["warnings"], 20, value => string(value)), metrics };
}
