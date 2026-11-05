import type { DeploymentComparison } from "../../deployments/compare.ts";
import type { DeploymentHistory } from "../../deployments/model.ts";
import type { ObserveHealth } from "../../observe/client/decode.ts";
import type { StatsWindow } from "../../observe/core/store.ts";
import type { ProjectSummary } from "../decode.ts";
import { timeText } from "../text.ts";
import type { SafetyRecord } from "./decide.ts";
import { isOperationPolicy, type Policy } from "./policy.ts";

export const OBSERVE_STALE_MS = 60 * 60 * 1000;
export const OBSERVE_BUCKET_MS = 300_000;
const COMPARISON_UNAVAILABLE = ["disabled", "expired", "truncated"];

export interface ReadinessSignal {
  readonly signal: string;
  readonly status: "available" | `unavailable:${string}`;
  readonly message: string;
}

export type Source<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };

export interface ReadinessInputs {
  readonly nowMs: number;
  readonly project: Source<ProjectSummary>;
  readonly observeHealth: Source<ObserveHealth> | null;
  readonly window: Source<StatsWindow> | null;
  readonly history?: Source<DeploymentHistory>;
  readonly comparison?: Source<DeploymentComparison>;
  readonly safety?: SafetyRecord | null;
}

export function readinessWindow(nowMs: number, policy: Policy): { readonly fromMs: number; readonly toMs: number } {
  const toMs = Math.floor(nowMs / OBSERVE_BUCKET_MS) * OBSERVE_BUCKET_MS;
  const classed = policy.workloadClass !== null;
  return { fromMs: toMs - (classed ? 3_600_000 : 6 * 3_600_000), toMs };
}

const available = (signal: string, message: string): ReadinessSignal => ({ signal, status: "available", message });
const unavailable = (signal: string, code: string, message: string): ReadinessSignal => ({ signal, status: `unavailable:${code}`, message });

function fromFailure(signal: string, source: { readonly code: string; readonly message: string }): ReadinessSignal {
  return unavailable(signal, source.code, source.message);
}

export function readinessSignals(policy: Policy, inputs: ReadinessInputs): ReadinessSignal[] {
  const signals: ReadinessSignal[] = [];
  const { project, observeHealth, window, history, comparison } = inputs;

  if (!project.ok) signals.push(fromFailure("analytics-collector", project));
  else {
    const { collector } = project.value;
    if (collector.lastSuccessAtMs === null) signals.push(unavailable("analytics-collector", "collector_never_succeeded", "the analytics collector has never completed a run"));
    else if (collector.stale) signals.push(unavailable("analytics-collector", "collector_stale", `the last successful collector run was ${timeText(collector.lastSuccessAtMs)}`));
    else signals.push(available("analytics-collector", `collector last succeeded ${timeText(collector.lastSuccessAtMs)}`));
  }

  if (history !== undefined) {
    if (!history.ok) signals.push(fromFailure("deployment-history", history));
    else if (!history.value.enabled) signals.push(unavailable("deployment-history", "deployments_not_enabled", "deployment history is not enabled for this project"));
    else if (history.value.sync === null || history.value.sync.lastSuccessAtMs === null) signals.push(unavailable("deployment-history", "sync_never_succeeded", "no deployment sync has succeeded"));
    else if (history.value.sync.truncated) signals.push(unavailable("deployment-history", "history_truncated", "the deployment list was truncated, so older deployments are missing"));
    else signals.push(available("deployment-history", `${history.value.deployments.length} deployments recorded`));
  }

  if (comparison !== undefined) {
    if (!comparison.ok) signals.push(fromFailure("deployment-comparison", comparison));
    else {
      const blocked = comparison.value.reasonCodes.find(code => COMPARISON_UNAVAILABLE.includes(code));
      if (blocked !== undefined) signals.push(unavailable("deployment-comparison", blocked, comparison.value.reasons[comparison.value.reasonCodes.indexOf(blocked)] ?? "the comparison cannot be built"));
      else signals.push(available("deployment-comparison", `bounds are exact; ready at ${timeText(comparison.value.readyAtMs)}`));
      if (!isOperationPolicy(policy)) {
        const metric = comparison.value.metrics.find(item => item.metric === policy.metric);
        signals.push(metric === undefined ? unavailable("global-metric", "metric_absent", `the comparison has no ${policy.metric} metric`) : available("global-metric", `${policy.metric} is computed by the comparison`));
      }
    }
  }

  if (observeHealth === null) {
    signals.push(unavailable("observe-events", "not_observed", `${policy.project} is not observed; only stats is`));
  } else if (!observeHealth.ok) signals.push(fromFailure("observe-events", observeHealth));
  else if (observeHealth.value.newestAtMs === null) signals.push(unavailable("observe-events", "no_events", "no invocations are retained"));
  else if (inputs.nowMs - observeHealth.value.newestAtMs > OBSERVE_STALE_MS) signals.push(unavailable("observe-events", "events_stale", `the newest retained invocation is from ${timeText(observeHealth.value.newestAtMs)}`));
  else signals.push(available("observe-events", `newest invocation ${timeText(observeHealth.value.newestAtMs)}`));

  if (window === null) {
    signals.push(unavailable("observe-invocations", "not_observed", `${policy.project} is not observed; only stats is`));
    if (isOperationPolicy(policy)) signals.push(unavailable("operation-summaries", "not_observed", `operation summaries absent for ${policy.operation}: ${policy.project} is not observed`));
  } else if (!window.ok) {
    signals.push(fromFailure("observe-invocations", window));
    if (isOperationPolicy(policy)) signals.push(fromFailure("operation-summaries", window));
  } else {
    const span = `[${timeText(window.value.fromMs)}, ${timeText(window.value.toMs)})`;
    signals.push(window.value.invocations.length > 0 ? available("observe-invocations", `${window.value.invocations.length} invocation rows in ${span}`) : unavailable("observe-invocations", "no_invocation_rows", `no observed invocations in ${span}, so coverage cannot be computed`));
    if (isOperationPolicy(policy)) {
      const rows = window.value.operations.filter(row => row.operation === policy.operation && !row.synthetic && (policy.workloadClass === null || row.workloadClass === policy.workloadClass));
      const scope = policy.workloadClass === null ? policy.operation : `${policy.operation} class ${policy.workloadClass}`;
      signals.push(rows.length > 0 ? available("operation-summaries", `${rows.length} organic summary rows for ${scope} in ${span}`) : unavailable("operation-summaries", "no_operation_summaries", `operation summaries absent for ${scope} in ${span}`));
    }
  }

  if (policy.guardrails.includes("probe-failure-share") && project.ok) {
    const names = project.value.probes.map(probe => probe.name);
    signals.push(available("probes", names.length === 0 ? "the project defines no probes; the probe guardrail is not applicable" : `probes: ${names.join(", ")}`));
  }

  if (inputs.safety !== undefined) {
    signals.push(inputs.safety === null
      ? unavailable("safety-check", "safety_check_missing", "no `check ingest` result is recorded; run it inside the warm-up and pass --safety-check-file")
      : inputs.safety.ok ? available("safety-check", `check ingest passed at ${timeText(inputs.safety.atMs)}`) : unavailable("safety-check", "safety_check_failed", `check ingest failed at step ${inputs.safety.failedStep ?? "unknown"}`));
  }
  return signals;
}
