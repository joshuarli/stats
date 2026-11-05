import { compareOperation, type GuardrailResult, type OperationComparison, type OperationReason } from "../../compare/operation.ts";
import { computeCoverage, observedEventTotals, type Coverage, type CoverageState } from "../../compare/coverage.ts";
import { scopeSpec, type ComparisonScope } from "../../compare/spec.ts";
import type { DeploymentComparison, ReasonCode } from "../../deployments/compare.ts";
import type { StatsWindow } from "../../observe/core/store.ts";
import { isOperationPolicy, operationFloors, type GuardrailId, type Policy } from "./policy.ts";

export const VERDICTS = ["improved", "unchanged", "confounded", "insufficient-data", "pending", "regressed"] as const;
export type VerifyVerdict = typeof VERDICTS[number];
export type GuardrailStatus = "pass" | "regressed" | "insufficient-data" | "pending" | "waived" | "not-applicable";

export const PENDING_CODES: readonly ReasonCode[] = ["not-ready", "unsettled", "stale-history"];
const DATA_CODES: readonly string[] = ["disabled", "expired", "truncated", "invocations-missing", "invocations-floor"];
export const COVERAGE_STAGES = ["worker", "object"] as const;
export const PROBE_FAILURE_RISE_POINTS = 1;

export interface SafetyRecord {
  readonly ok: boolean;
  readonly atMs: number;
  readonly hostId: string;
  readonly origin: string;
  readonly failedStep: string | null;
  readonly file: string;
}

export interface IssueCheck {
  readonly versions: readonly { readonly versionId: string; readonly groups: number }[];
  readonly skipped: readonly string[];
}

export interface Evidence {
  readonly comparison: DeploymentComparison;
  readonly deployedAtMs: number;
  readonly windows: { readonly before: StatsWindow; readonly after: StatsWindow } | null;
  readonly issues: IssueCheck | null;
  readonly probes: readonly string[] | null;
}

export interface Reason {
  readonly code: string;
  readonly message: string;
}

export interface GuardrailReport {
  readonly id: GuardrailId;
  readonly status: GuardrailStatus;
  readonly detail: string;
  readonly before: number | null;
  readonly after: number | null;
}

export interface TargetReport {
  readonly metric: string;
  readonly direction: Policy["direction"];
  readonly floor: number;
  readonly minChangePercent: number;
  readonly before: number | null;
  readonly after: number | null;
  readonly delta: number | null;
  readonly deltaPercent: number | null;
  readonly verdict: VerifyVerdict;
}

export interface CoverageReport {
  readonly before: Coverage | null;
  readonly after: Coverage | null;
  readonly state: CoverageState | null;
}

export interface Decision {
  readonly verdict: VerifyVerdict;
  readonly target: TargetReport;
  readonly guardrails: readonly GuardrailReport[];
  readonly coverage: CoverageReport;
  readonly blockedBy: readonly string[];
  readonly operations: { readonly before: number; readonly after: number } | null;
  readonly workUnits: { readonly before: number; readonly after: number } | null;
  readonly unit: string | null;
  readonly reasons: readonly Reason[];
  readonly warnings: readonly string[];
}

export function isPending(comparison: DeploymentComparison, nowMs: number): boolean {
  return nowMs < comparison.readyAtMs || comparison.reasonCodes.some(code => PENDING_CODES.includes(code));
}

export function combineCoverage(before: CoverageState, after: CoverageState): CoverageState {
  if (before === "unknown" || after === "unknown") return "unknown";
  return before === "reconciled" && after === "reconciled" ? "reconciled" : "partial";
}

function sideCoverage(window: StatsWindow, analytics: DeploymentComparison["analyticsInvocations"]["before"]): Coverage {
  return computeCoverage({ fromMs: window.fromMs, toMs: window.toMs, observed: observedEventTotals(window, COVERAGE_STAGES), analytics });
}

function judgeTarget(policy: Policy, source: { readonly before: number | null; readonly after: number | null; readonly verdict: VerifyVerdict }): TargetReport {
  const base = { metric: policy.metric, direction: policy.direction, floor: policy.floor, minChangePercent: policy.minChangePercent, before: source.before, after: source.after };
  const delta = source.before === null || source.after === null ? null : source.after - source.before;
  const deltaPercent = delta === null || source.before === null || source.before === 0 ? null : delta / source.before * 100;
  if (source.verdict === "confounded" || source.verdict === "insufficient-data" || source.verdict === "pending" || delta === null) {
    return { ...base, delta, deltaPercent, verdict: source.verdict === "confounded" || source.verdict === "pending" ? source.verdict : "insufficient-data" };
  }
  const material = Math.abs(delta) >= policy.floor && (deltaPercent === null || Math.abs(deltaPercent) >= policy.minChangePercent);
  if (!material) return { ...base, delta, deltaPercent, verdict: "unchanged" };
  const better = policy.direction === "decrease" ? delta < 0 : delta > 0;
  return { ...base, delta, deltaPercent, verdict: better ? "improved" : "regressed" };
}

function fromComparison(result: GuardrailResult | undefined, id: GuardrailId, missing: string): GuardrailReport {
  if (result === undefined) return { id, status: "insufficient-data", detail: missing, before: null, after: null };
  const detail = result.status === "pass" ? "within the allowed change" : result.status === "regressed" ? "moved the wrong way" : "not enough data on a side";
  return { id, status: result.status, detail, before: result.before, after: result.after };
}

function safetyGuardrail(safety: SafetyRecord | null, comparison: DeploymentComparison, deployedAtMs: number): GuardrailReport {
  const id = "safety-check";
  if (safety === null) return { id, status: "insufficient-data", detail: "no safety check is recorded; run `statsctl check ingest` inside the deployment warm-up and pass --safety-check-file", before: null, after: null };
  if (!safety.ok) return { id, status: "regressed", detail: `check ingest failed at step ${safety.failedStep ?? "unknown"}`, before: null, after: null };
  if (safety.atMs < deployedAtMs) return { id, status: "insufficient-data", detail: "the safety check ran before the deployment, so it did not exercise the candidate", before: null, after: null };
  const inside = safety.atMs >= comparison.after.fromMs;
  return { id, status: "pass", detail: inside ? "passed, but ran inside the after window rather than the warm-up interval" : "passed inside the deployment warm-up interval", before: null, after: null };
}

function issueGuardrail(issues: IssueCheck | null): GuardrailReport {
  const id = "new-issue-group";
  if (issues === null) return { id, status: "insufficient-data", detail: "observe issue groups were not read", before: null, after: null };
  const groups = issues.versions.reduce((sum, item) => sum + item.groups, 0);
  if (groups > 0) return { id, status: "regressed", detail: `${groups} issue groups first appeared in the candidate version`, before: null, after: groups };
  if (issues.skipped.length > 0) return { id, status: "insufficient-data", detail: `issue groups were not read for ${issues.skipped.length} versions; too many candidate versions for the poll budget`, before: null, after: 0 };
  return { id, status: "pass", detail: issues.versions.length === 0 ? "the deployment introduced no new version" : "no issue group has the candidate as its first version", before: null, after: 0 };
}

function probeGuardrail(probes: readonly string[] | null, comparison: DeploymentComparison): GuardrailReport {
  const id = "probe-failure-share";
  if (probes === null) return { id, status: "insufficient-data", detail: "the project's probe list was not read", before: null, after: null };
  if (probes.length === 0) return { id, status: "not-applicable", detail: "the project defines no probes", before: null, after: null };
  let worst: GuardrailReport = { id, status: "pass", detail: "no probe failure share rose", before: null, after: null };
  for (const name of probes) {
    const metric = comparison.metrics.find(item => item.metric === `probe.${name}.failure`);
    if (metric === undefined || metric.before === null || metric.after === null) return { id, status: "insufficient-data", detail: `probe ${name} has no failure share on both sides`, before: metric?.before ?? null, after: metric?.after ?? null };
    if (metric.after - metric.before >= PROBE_FAILURE_RISE_POINTS) return { id, status: "regressed", detail: `probe ${name} failure share rose from ${metric.before} to ${metric.after} percent`, before: metric.before, after: metric.after };
    worst = { ...worst, before: metric.before, after: metric.after };
  }
  return worst;
}

function globalFailedShare(comparison: DeploymentComparison): GuardrailReport {
  const id = "failed-share";
  const metric = comparison.metrics.find(item => item.metric === "worker.errors");
  if (metric === undefined || metric.before === null || metric.after === null) return { id, status: "insufficient-data", detail: "the Worker 5xx share needs 1,000 invocations on both sides", before: metric?.before ?? null, after: metric?.after ?? null };
  const regressed = metric.before === 0 ? metric.after > 0 : metric.after - metric.before > 1;
  return { id, status: regressed ? "regressed" : "pass", detail: regressed ? "the 5xx share rose beyond the allowed change" : "the 5xx share did not rise beyond the allowed change", before: metric.before, after: metric.after };
}

function coverageGuardrail(coverage: CoverageReport): GuardrailReport {
  const id = "coverage";
  const describe = (side: Coverage | null) => side === null ? "unread" : `${side.state}${side.spread === null ? "" : ` (spread ${(side.spread * 100).toFixed(1)}%)`}`;
  const detail = `before ${describe(coverage.before)}, after ${describe(coverage.after)}`;
  return { id, status: coverage.state === "reconciled" ? "pass" : "insufficient-data", detail, before: coverage.before?.spread ?? null, after: coverage.after?.spread ?? null };
}

function waivedReports(policy: Policy): GuardrailReport[] {
  return policy.waivedGuardrails.map(({ guardrail, reason }) => ({ id: guardrail, status: "waived", detail: `waived: ${reason}`, before: null, after: null }));
}

function pendingReport(id: GuardrailId): GuardrailReport {
  return { id, status: "pending", detail: "waiting for the after window to settle", before: null, after: null };
}

export function decide(policy: Policy, evidence: Evidence, safety: SafetyRecord | null, nowMs: number): Decision {
  const { comparison } = evidence;
  const warnings = [...comparison.warnings];
  const reasons: Reason[] = [];
  const pending = isPending(comparison, nowMs);
  const checked = (ids: readonly GuardrailId[]) => ids.filter(id => policy.guardrails.includes(id));
  const listed = (reports: readonly GuardrailReport[]) => reports.filter(report => policy.guardrails.includes(report.id));
  const emptyTarget = (verdict: VerifyVerdict): TargetReport => judgeTarget(policy, { before: null, after: null, verdict });
  const empty = { operations: null, workUnits: null, unit: null, blockedBy: [] as string[] };

  const finish = (target: TargetReport, guardrails: GuardrailReport[], coverage: CoverageReport, extra: Pick<Decision, "operations" | "workUnits" | "unit" | "blockedBy">): Decision => {
    const all = [...guardrails, ...waivedReports(policy)];
    const statuses = all.map(item => item.status);
    let verdict: VerifyVerdict;
    if (statuses.includes("regressed") || target.verdict === "regressed") verdict = "regressed";
    else if (target.verdict === "confounded") verdict = "confounded";
    else if (target.verdict === "insufficient-data" || statuses.includes("insufficient-data")) verdict = "insufficient-data";
    else if (pending || target.verdict === "pending" || statuses.includes("pending")) verdict = "pending";
    else verdict = target.verdict;
    for (const item of all) if (item.status === "regressed" || item.status === "insufficient-data") reasons.push({ code: `guardrail-${item.status}`, message: `${item.id}: ${item.detail}` });
    if (target.verdict === "confounded") reasons.push({ code: "confounded", message: `the comparison is blocked by ${extra.blockedBy.join(", ") || "its reasons"}` });
    if (target.verdict === "insufficient-data") reasons.push({ code: "target-insufficient", message: `${policy.metric} has no usable value on both sides` });
    if (verdict === "pending") reasons.push({ code: "pending", message: comparison.reasons.find((_, index) => PENDING_CODES.includes(comparison.reasonCodes[index] as ReasonCode)) ?? "waiting for the after window to settle" });
    if (target.verdict === "regressed") reasons.push({ code: "target-wrong-way", message: `${policy.metric} moved the wrong way by ${target.deltaPercent === null ? "an unbounded share" : `${target.deltaPercent.toFixed(1)}%`}` });
    return { verdict, target, guardrails: all, coverage, reasons, warnings, ...extra };
  };

  const unreadCoverage: CoverageReport = { before: null, after: null, state: null };

  if (pending) {
    const guardrails: GuardrailReport[] = checked(["safety-check", "failed-share", "new-issue-group", "probe-failure-share", "coverage", "ingest-persistence"]).map(id => id === "safety-check" ? safetyGuardrail(safety, comparison, evidence.deployedAtMs) : pendingReport(id));
    return finish(emptyTarget("pending"), guardrails, unreadCoverage, empty);
  }

  const { windows } = evidence;
  if (windows === null) {
    reasons.push({ code: "windows-missing", message: "the observe windows were not read" });
    const guardrails = checked(["safety-check", "failed-share", "new-issue-group", "probe-failure-share", "coverage", "ingest-persistence"]).map(id => id === "safety-check" ? safetyGuardrail(safety, comparison, evidence.deployedAtMs) : { id, status: "insufficient-data" as const, detail: "the observe windows were not read", before: null, after: null });
    return finish(emptyTarget("insufficient-data"), guardrails, unreadCoverage, empty);
  }

  const before = sideCoverage(windows.before, comparison.analyticsInvocations.before);
  const after = sideCoverage(windows.after, comparison.analyticsInvocations.after);
  const coverage: CoverageReport = { before, after, state: combineCoverage(before.state, after.state) };
  const common = (): GuardrailReport[] => [
    safetyGuardrail(safety, comparison, evidence.deployedAtMs),
    issueGuardrail(evidence.issues),
    probeGuardrail(evidence.probes, comparison),
    coverageGuardrail(coverage)
  ];

  if (!isOperationPolicy(policy)) {
    const row = comparison.metrics.find(item => item.metric === policy.metric);
    if (row === undefined) reasons.push({ code: "metric-absent", message: `the comparison has no ${policy.metric} metric` });
    const deferred = comparison.deferredObjects && (policy.metric.startsWith("do.") || policy.metric === "cost");
    const blocking: string[] = [...comparison.reasonCodes.filter(code => !DATA_CODES.includes(code)), ...(deferred ? ["deferred"] : [])];
    const source = row === undefined ? { before: null, after: null, verdict: "insufficient-data" as const } : { before: row.before, after: row.after, verdict: row.verdict === "confounded" && blocking.length === 0 ? "insufficient-data" as const : row.verdict };
    const guardrails = [...common(), globalFailedShare(comparison)];
    return finish(judgeTarget(policy, source), listed(guardrails), coverage, { ...empty, blockedBy: blocking });
  }

  const scope: ComparisonScope = policy.operation === "host.history" || policy.operation === "project.history" ? { operation: policy.operation, workloadClass: policy.workloadClass } : { operation: policy.operation, workloadClass: null };
  const spec = { ...scopeSpec(comparison.spec, scope), scope };
  const result: OperationComparison = compareOperation({
    spec, before: windows.before.operations, after: windows.after.operations, coverage: coverage.state ?? "unknown",
    globalReasonCodes: comparison.reasonCodes, deferredObjects: comparison.deferredObjects, floors: operationFloors(policy)
  });
  const row = result.metrics.find(item => item.metric === `${policy.operation}.${policy.metric}`);
  const dataOnly = result.blockedBy.every((code: OperationReason) => DATA_CODES.includes(code));
  const source = row === undefined ? { before: null, after: null, verdict: "insufficient-data" as const } : { before: row.before, after: row.after, verdict: row.verdict === "confounded" && dataOnly ? "insufficient-data" as const : row.verdict };
  const guardrails = [
    ...common(),
    fromComparison(result.guardrails.find(item => item.name === "failed-share"), "failed-share", "no failed-share result"),
    ...(policy.operation === "host.ingest" ? [fromComparison(result.guardrails.find(item => item.name === "ingest-persistence"), "ingest-persistence", "no ingest-persistence result")] : [])
  ];
  return finish(judgeTarget(policy, source), listed(guardrails), coverage, { operations: result.operations, workUnits: result.workUnits, unit: result.unit, blockedBy: result.blockedBy });
}

export const EXIT_FOR_VERDICT: Readonly<Record<VerifyVerdict, 0 | 5 | 6 | 7>> = {
  improved: 0,
  unchanged: 6,
  confounded: 6,
  "insufficient-data": 5,
  pending: 5,
  regressed: 7
};
