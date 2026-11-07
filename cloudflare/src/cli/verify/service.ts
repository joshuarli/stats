import type { ComparisonSpec } from "../../compare/spec.ts";
import { UUID } from "../../deployments/model.ts";
import { decodeServiceComparison, decodeServiceDeploymentHistory } from "../../deployments/service-decode.ts";
import { applicationMetricName, SERVICE_COMPARISON_CAVEAT, SERVICE_LEVEL_METRICS, type ServiceComparison, type SourceStatus, type WorkMetricKind } from "../../deployments/service-compare.ts";
import type { ComparisonWindow } from "../../deployments/compare.ts";
import { transportError, usageError } from "../exit.ts";
import type { HttpClient } from "../http.ts";
import { isPending, judgeTarget, PENDING_CODES, type Reason, type TargetReport, type VerifyVerdict } from "./decide.ts";
import type { ServicePolicy } from "./policy.ts";

const DATA_CODES: readonly string[] = ["no-data", "expired", "truncated"];

export interface ServiceVerdictPayload {
  readonly kind: "service-verdict";
  readonly verdict: VerifyVerdict;
  readonly policy: { readonly id: string; readonly hypothesis: string; readonly service: string; readonly metric: string; readonly operation: string | null; readonly work: string | null };
  readonly deployment: { readonly requested: string; readonly id: string };
  readonly window: ComparisonWindow;
  readonly spec: ComparisonSpec;
  readonly target: TargetReport;
  readonly sources: readonly SourceStatus[];
  readonly reasons: readonly Reason[];
  readonly caveat: string;
}

async function resolveLatestMarker(http: HttpClient, service: string): Promise<string> {
  const path = `/api/v1/services/${encodeURIComponent(service)}/deployments`;
  const fetched = await http.getJson(path, value => decodeServiceDeploymentHistory(value, service));
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  const newest = [...fetched.value.deployments].sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id))[0];
  if (newest === undefined) throw transportError("no_deployments", `no deployment markers are recorded for ${service}`);
  return newest.id;
}

function sourceOf(policy: ServicePolicy): SourceStatus["source"] {
  if (policy.operation !== null) return "application";
  return SERVICE_LEVEL_METRICS.find(entry => entry.metric === policy.metric)!.source;
}

function metricName(policy: ServicePolicy): string {
  return policy.operation === null ? policy.metric : applicationMetricName(policy.metric as WorkMetricKind, policy.operation, policy.work ?? undefined);
}

export function decideService(policy: ServicePolicy, comparison: ServiceComparison, nowMs: number): { readonly verdict: VerifyVerdict; readonly target: TargetReport; readonly reasons: readonly Reason[] } {
  const reasons: Reason[] = [];
  const row = comparison.metrics.find(item => item.metric === metricName(policy));
  const blocking = comparison.reasonCodes.filter(code => !DATA_CODES.includes(code) && !PENDING_CODES.includes(code));
  const pending = isPending(comparison, nowMs);
  const source = row === undefined || pending
    ? { before: null, after: null, verdict: pending ? "pending" as const : "insufficient-data" as const }
    : { before: row.before, after: row.after, verdict: row.verdict === "confounded" && blocking.length === 0 ? "insufficient-data" as const : row.verdict };
  const target = judgeTarget(policy, source);
  if (pending) reasons.push({ code: "pending", message: comparison.reasons.find((_, index) => PENDING_CODES.includes(comparison.reasonCodes[index]!)) ?? "waiting for the after window to settle" });
  if (target.verdict === "confounded") reasons.push({ code: "confounded", message: `the comparison is blocked by ${blocking.join(", ")}` });
  if (row?.supersededBy !== undefined) reasons.push({ code: "superseded", message: `${policy.metric} is judged as asked, but the service's cgroup reported in both windows, so ${row.supersededBy} is the better measure` });
  if (policy.operation !== null && comparison.applicationSuppression !== null) reasons.push({ code: comparison.applicationSuppression.code, message: comparison.applicationSuppression.detail });
  if (row?.reasonCode === "application-gap" && comparison.applicationCoverage !== null) {
    const { before, after } = comparison.applicationCoverage;
    reasons.push({ code: "application-gap", message: `${metricName(policy)}: ${before.emptyBucketsWhileUp} of ${before.buckets} before and ${after.emptyBucketsWhileUp} of ${after.buckets} after five-minute buckets had no application events while the service was up` });
  }
  if (row?.basis === "observed-work" && target.verdict !== "insufficient-data") reasons.push({ code: "observed-work", message: `${metricName(policy)} divides by observed work; ${comparison.applicationCoverage?.after.unrecorded.join(", ") ?? "producer drops"} are not recorded, so completion is unproven` });
  if (row?.reason !== undefined) reasons.push({ code: "target-unavailable", message: `${metricName(policy)}: ${row.reason}` });
  if (target.verdict === "insufficient-data") {
    const status = comparison.sources.find(item => item.source === sourceOf(policy));
    reasons.push({ code: "target-insufficient", message: `${policy.metric} has no usable value on both sides${status?.status === "unavailable" ? `: ${status.source} unavailable, ${status.detail}` : ""}` });
  }
  if (target.verdict === "regressed") reasons.push({ code: "target-wrong-way", message: `${policy.metric} moved the wrong way by ${target.deltaPercent === null ? "an unbounded share" : `${target.deltaPercent.toFixed(1)}%`}` });
  return { verdict: target.verdict, target, reasons };
}

export async function verifyService(http: HttpClient, nowMs: number, policy: ServicePolicy, requested: string): Promise<ServiceVerdictPayload> {
  if (requested !== "latest" && !UUID.test(requested)) throw usageError("--deployment must be a deployment id or latest");
  const deploymentId = requested === "latest" ? await resolveLatestMarker(http, policy.service) : requested.toLowerCase();
  const path = `/api/v1/services/${encodeURIComponent(policy.service)}/deployments/${deploymentId}/comparison?window=${policy.window}`;
  const fetched = await http.getJson(path, value => decodeServiceComparison(value, deploymentId, policy.window));
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  const comparison = fetched.value;
  const decision = decideService(policy, comparison, nowMs);
  return {
    kind: "service-verdict",
    verdict: decision.verdict,
    policy: { id: policy.id, hypothesis: policy.hypothesis, service: policy.service, metric: policy.metric, operation: policy.operation, work: policy.work },
    deployment: { requested, id: deploymentId },
    window: policy.window,
    spec: comparison.spec,
    target: decision.target,
    sources: comparison.sources,
    reasons: decision.reasons,
    caveat: SERVICE_COMPARISON_CAVEAT
  };
}
