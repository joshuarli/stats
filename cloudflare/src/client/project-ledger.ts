import { openHistory } from "../binary/history.ts";
import type { LedgerHistories, ObjectMethods } from "../cost/ledger.ts";
import { PRICING_REVISION } from "../cost/pricing.ts";
import { buildCostReport, type CostReport, type PlanMonthInput } from "../cost/report.ts";
import { PROJECT_SETTLE_MS, type RangeKey } from "../limits.ts";
import type { ObjectMethods as ObservedObjectMethods } from "../observe/core/store.ts";
import type { TimeWindow } from "./chart-data.ts";
import { decodeProjectHistories, type MetricHistory, type ProjectHistories } from "./history.ts";
import type { ProjectSummary } from "./project-model.ts";

export type HistoryQuery = { readonly range: RangeKey } | { readonly fromMs: number; readonly toMs: number };

export interface HistoryKinds {
  readonly durableObjects: boolean;
  readonly d1: boolean;
  readonly probes: boolean;
}

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

export function windowParams(query: HistoryQuery): string {
  return "range" in query ? `range=${encodeURIComponent(query.range)}` : `from=${Math.round(query.fromMs)}&to=${Math.round(query.toMs)}`;
}

export function projectHistoryPath(projectId: string, query: HistoryQuery, options: HistoryKinds): string {
  const kinds = ["worker", "routes", "r2", "collector"];
  if (options.durableObjects) kinds.push("durable-objects");
  if (options.d1) kinds.push("d1", "d1-statements");
  if (options.probes) kinds.push("probes");
  return `/api/v1/projects/${encodeURIComponent(projectId)}/history?${windowParams(query)}&kinds=${kinds.join(",")}`;
}

export function historyKinds(project: Pick<ProjectSummary, "durableObjectNamespaces" | "d1Databases" | "probes">): HistoryKinds {
  return { durableObjects: project.durableObjectNamespaces.length > 0, d1: project.d1Databases.length > 0, probes: project.probes.length > 0 };
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
