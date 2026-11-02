import { parseDeployment, parseVersion, record, type DeploymentHistory } from "./model.ts";
import { COMPARISON_WINDOWS, type ComparisonWindow, type DeploymentComparison, type MetricComparison, type Verdict, type WindowBounds } from "./compare.ts";

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
  const metrics = array<MetricComparison>(item["metrics"], 64, raw => {
    const metric = record(raw);
    const verdict = string(metric["verdict"]) as Verdict;
    if (!verdicts.includes(verdict)) throw new Error("invalid comparison verdict");
    return { metric: string(metric["metric"]), label: string(metric["label"]), unit: string(metric["unit"], 16), before: nullableNumber(metric["before"]), after: nullableNumber(metric["after"]), delta: nullableNumber(metric["delta"]), deltaPercent: nullableNumber(metric["deltaPercent"]), verdict };
  });
  return { deploymentId, window, before: bounds(item["before"]), after: bounds(item["after"]), readyAtMs: time(item["readyAtMs"]), beforeInvocations: nullableNumber(item["beforeInvocations"]), afterInvocations: nullableNumber(item["afterInvocations"]), reasons: array(item["reasons"], 20, value => string(value)), warnings: array(item["warnings"], 20, value => string(value)), metrics };
}
