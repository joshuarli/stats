import { openHistory } from "../binary/history.ts";
import type { LedgerHistories, ObjectMethods } from "../cost/ledger.ts";
import { PRICING_REVISION } from "../cost/pricing.ts";
import { buildCostReport, type CostReport, type PlanMonthInput } from "../cost/report.ts";
import { PROJECT_SETTLE_MS } from "../limits.ts";
import type { ObjectMethods as ObservedObjectMethods } from "../observe/core/store.ts";
import type { TimeWindow } from "./chart-data.ts";
import { decodeProjectHistories, type MetricHistory, type ProjectHistories } from "./history.ts";
import type { ProjectSummary } from "./project-model.ts";
import { historyKinds, projectHistoryPath, windowParams, type HistoryKinds, type HistoryQuery } from "./history-path.ts";

export { historyKinds, projectHistoryPath, windowParams, type HistoryKinds, type HistoryQuery };

export interface ProjectLedger {
  readonly report: CostReport;
  readonly histories: LedgerHistories;
  readonly previous: LedgerHistories | undefined;
}

export interface LedgerInputs {
  readonly nowMs: number;
  readonly project: ProjectSummary;
  readonly windows: { readonly current: TimeWindow; readonly previous: TimeWindow };
  readonly current: ProjectHistories;
  readonly baseline: ProjectHistories | undefined;
  readonly objectMethods: ObjectMethods | undefined;
  readonly planMonth: PlanMonthInput | undefined;
}




export function provisionalFromMs(history: MetricHistory): number {
  const cutoff = history.toMs - history.stepMs - PROJECT_SETTLE_MS;
  return history.fromMs + (Math.floor((cutoff - history.fromMs) / history.stepMs) + 1) * history.stepMs;
}

export function settledWindow(worker: MetricHistory, rangeMs: number, view: TimeWindow | null): TimeWindow {
  const settled = provisionalFromMs(worker);
  if (view !== null) return { fromMs: view.fromMs, toMs: Math.max(view.fromMs, Math.min(view.toMs, settled)) };
  return { fromMs: settled - rangeMs, toMs: settled };
}

export function ledgerHistories(histories: ProjectHistories): LedgerHistories {
  return { worker: histories.worker, routes: histories.routes, r2: histories.r2, durableObjects: histories["durable-objects"], d1: histories.d1, d1Statements: histories["d1-statements"] };
}

export function decodeProjectFrame(bytes: ArrayBuffer | Uint8Array): ProjectHistories {
  return decodeProjectHistories(openHistory(bytes).root);
}

export function observeObjectsPath(window: TimeWindow): string {
  return `/objects?from=${Math.round(window.fromMs)}&to=${Math.round(window.toMs)}`;
}

export function baselineMethodsRetained(previous: TimeWindow, nowMs: number, retentionMs: number): boolean {
  return previous.fromMs >= nowMs - retentionMs;
}

export function objectMethodsOf(now: ObservedObjectMethods, before: ObservedObjectMethods | null): ObjectMethods {
  return { now: now.methods, before: before?.methods ?? null };
}

export function assembleProjectLedger(inputs: LedgerInputs): ProjectLedger {
  const histories = ledgerHistories(inputs.current);
  const previous = inputs.baseline === undefined ? undefined : ledgerHistories(inputs.baseline);
  return {
    histories,
    previous,
    report: buildCostReport({
      nowMs: inputs.nowMs,
      pricingRevision: PRICING_REVISION,
      project: inputs.project,
      windows: inputs.windows,
      current: histories,
      previous,
      objectMethods: inputs.objectMethods,
      planMonth: inputs.planMonth
    })
  };
}
