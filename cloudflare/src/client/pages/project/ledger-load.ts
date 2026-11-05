import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { getProjectHistories, type Project } from "../../api";
import type { TimeWindow } from "../../chart-data";
import { errorMessage } from "../../format";
import type { MetricHistory, ProjectHistories } from "../../history";
import { decodeObjectMethods } from "../../../observe/client/decode";
import type { ObserveRead } from "./Observe";
import { buildLedger, planBill, previousWindowOf, type Ledger, type LedgerHistories, type ObjectMethods, type PlanBill } from "./cost-ledger";
import { provisionalFromMs } from "./series";

export type Baseline =
  | { readonly kind: "loaded"; readonly histories: ProjectHistories }
  | { readonly kind: "failed"; readonly message: string };

interface LedgerLoad {
  readonly window: TimeWindow;
  readonly previous: TimeWindow;
  readonly current: ProjectHistories;
  readonly baseline: Baseline;
  readonly objectMethods: ObjectMethods | undefined;
}

export interface ProjectLedger {
  readonly ledger: Ledger;
  readonly histories: LedgerHistories;
  readonly previous: LedgerHistories | undefined;
}

export interface ObjectMethodSource {
  readonly read: ObserveRead;
  readonly retentionMs: number;
  readonly now: Accessor<number>;
}

export function ledgerHistories(histories: ProjectHistories): LedgerHistories {
  return { worker: histories.worker, routes: histories.routes, r2: histories.r2, durableObjects: histories["durable-objects"], d1: histories.d1, d1Statements: histories["d1-statements"] };
}

export function settledWindow(worker: MetricHistory, rangeMs: number, view: TimeWindow | null): TimeWindow {
  const settled = provisionalFromMs(worker);
  if (view !== null) return { fromMs: view.fromMs, toMs: Math.max(view.fromMs, Math.min(view.toMs, settled)) };
  return { fromMs: settled - rangeMs, toMs: settled };
}

export function historyKinds(project: Project) {
  return { durableObjects: project.durableObjectNamespaces.length > 0, d1: project.d1Databases.length > 0, probes: project.probes.length > 0 };
}

function span(bounds: TimeWindow): URLSearchParams {
  return new URLSearchParams({ from: String(Math.round(bounds.fromMs)), to: String(Math.round(bounds.toMs)) });
}

export function createProjectLedger(project: Accessor<Project>, window: Accessor<TimeWindow>, refreshKey: Accessor<string>, objects: ObjectMethodSource | null) {
  const [load, setLoad] = createSignal<LedgerLoad | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(() => {
    const bounds = window();
    return `${project().id}:${bounds.fromMs}:${bounds.toMs}:${refreshKey()}`;
  }, () => {
    const current = window();
    const previous = previousWindowOf(current);
    const kinds = historyKinds(project());
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const methods = objects === null || !kinds.durableObjects ? Promise.resolve(undefined) : Promise.all([
      objects.read(`/objects?${span(current)}`, controller.signal, decodeObjectMethods),
      previous.fromMs >= objects.now() - objects.retentionMs ? objects.read(`/objects?${span(previous)}`, controller.signal, decodeObjectMethods) : Promise.resolve(null)
    ]).then(([now, before]): ObjectMethods => ({ now: now.methods, before: before?.methods ?? null }), () => undefined);
    void Promise.all([
      getProjectHistories(project().id, current, kinds, controller.signal),
      getProjectHistories(project().id, previous, kinds, controller.signal)
        .then((loaded): Baseline => ({ kind: "loaded", histories: loaded }), (cause: unknown): Baseline => ({ kind: "failed", message: errorMessage(cause) })),
      methods
    ]).then(([histories, baseline, objectMethods]) => {
      if (controller.signal.aborted) return;
      setLoad({ window: current, previous, current: histories, baseline, objectMethods });
      setError(null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    });
  });
  const ledger = createMemo((): ProjectLedger | null => {
    const loaded = load();
    if (loaded === null) return null;
    const histories = ledgerHistories(loaded.current);
    const previous = loaded.baseline.kind === "loaded" ? ledgerHistories(loaded.baseline.histories) : undefined;
    return {
      histories,
      previous,
      ledger: buildLedger({
        current: histories,
        previous,
        window: loaded.window,
        previousWindow: loaded.previous,
        buckets: project().buckets,
        databases: project().d1Databases,
        objectMethods: loaded.objectMethods
      })
    };
  });
  const baselineError = () => {
    const loaded = load();
    return loaded?.baseline.kind === "failed" ? loaded.baseline.message : null;
  };
  return { ledger, error, baselineError };
}

export function monthOf(atMs: number): TimeWindow {
  const at = new Date(atMs);
  return { fromMs: Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1), toMs: Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1) };
}

export interface MonthSpend {
  readonly month: TimeWindow;
  readonly settledMs: number;
  readonly bill: PlanBill;
}

export function createMonthSpend(project: Accessor<Project>, settledMs: Accessor<number>, refreshKey: Accessor<string>) {
  const [spend, setSpend] = createSignal<MonthSpend | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(() => `${project().id}:${settledMs()}:${refreshKey()}`, () => {
    const month = monthOf(settledMs());
    const window = { fromMs: month.fromMs, toMs: Math.max(month.fromMs, settledMs()) };
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    getProjectHistories(project().id, window, historyKinds(project()), controller.signal).then(histories => {
      if (controller.signal.aborted) return;
      setSpend({ month, settledMs: window.toMs, bill: planBill(ledgerHistories(histories), window, project().buckets, project().d1Databases) });
      setError(null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    });
  });
  return { spend, error };
}
