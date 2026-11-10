import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import { ConditionalCache, getHistory, getProjectHistories, type Project } from "../../api";
import type { TimeWindow } from "../../chart-data";
import { errorMessage } from "../../format";
import { decodeWorkerHistory, type MetricHistory, type ProjectHistories } from "../../history";
import { decodeObjectMethods } from "../../../observe/client/decode";
import type { ObserveRead } from "./Observe";
import { previousWindowOf } from "../../../cost/ledger.ts";
import { utcMonthOf, type PlanMonthInput } from "../../../cost/report.ts";
import type { RangeKey } from "../../../limits.ts";
import { assembleProjectLedger, baselineMethodsRetained, historyKinds, ledgerHistories, objectMethodsOf, observeObjectsPath, settledWindow, type ProjectLedger } from "../../project-ledger.ts";
import type { ObjectMethods } from "../../../cost/ledger.ts";

export { historyKinds, ledgerHistories, settledWindow, type ProjectLedger };

const settleProbeCache = new ConditionalCache<MetricHistory>();

export function getSettleProbe(projectId: string, range: RangeKey, signal: AbortSignal): Promise<MetricHistory> {
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/history?range=${encodeURIComponent(range)}&kinds=worker`;
  return getHistory(path, decodeWorkerHistory, settleProbeCache, signal);
}

export type Baseline =
  | { readonly kind: "loaded"; readonly histories: ProjectHistories }
  | { readonly kind: "failed"; readonly message: string };

interface LedgerLoad {
  readonly scope: string;
  readonly window: TimeWindow;
  readonly previous: TimeWindow;
  readonly current: ProjectHistories;
  readonly baseline: Baseline;
  readonly objectMethods: ObjectMethods | undefined;
  readonly objectMethodsError: string | null;
  readonly loadedAtMs: number;
}

export interface ObjectMethodSource {
  readonly read: ObserveRead;
  readonly retentionMs: number;
  readonly now: Accessor<number>;
}

export function createProjectLedger(project: Accessor<Project>, window: Accessor<TimeWindow | null>, scope: Accessor<string>, refreshKey: Accessor<string>, objects: ObjectMethodSource | null, planMonth: Accessor<PlanMonthInput | null>) {
  const [stored, setLoad] = createSignal<LedgerLoad | null>(null);
  const requestedScope = () => `${project().id}|${scope()}`;
  const load = (): LedgerLoad | null => {
    const bounds = window();
    const loaded = stored();
    return loaded !== null && bounds !== null && loaded.scope === requestedScope() && loaded.window.fromMs === bounds.fromMs && loaded.window.toMs === bounds.toMs ? loaded : null;
  };
  const [error, setError] = createSignal<string | null>(null);
  createEffect(() => {
    const bounds = window();
    return `${project().id}:${bounds === null ? "pending" : `${bounds.fromMs}:${bounds.toMs}`}:${refreshKey()}`;
  }, () => {
    const current = window();
    if (current === null) return;
    const requested = requestedScope();
    const previous = previousWindowOf(current);
    const kinds = historyKinds(project());
    const controller = new AbortController();
    const methods = objects === null || !kinds.durableObjects ? Promise.resolve({ value: undefined, error: null }) : Promise.all([
      objects.read(observeObjectsPath(current), controller.signal, decodeObjectMethods),
      baselineMethodsRetained(previous, objects.now(), objects.retentionMs) ? objects.read(observeObjectsPath(previous), controller.signal, decodeObjectMethods).catch(() => null) : Promise.resolve(null)
    ]).then(([now, before]) => ({ value: objectMethodsOf(now, before), error: null }), (cause: unknown) => ({ value: undefined, error: errorMessage(cause) }));
    void Promise.all([
      getProjectHistories(project().id, current, kinds, controller.signal),
      getProjectHistories(project().id, previous, kinds, controller.signal)
        .then((loaded): Baseline => ({ kind: "loaded", histories: loaded }), (cause: unknown): Baseline => ({ kind: "failed", message: errorMessage(cause) })),
      methods
    ]).then(([histories, baseline, objectMethods]) => {
      if (controller.signal.aborted) return;
      setLoad({ scope: requested, window: current, previous, current: histories, baseline, objectMethods: objectMethods.value, objectMethodsError: objectMethods.error, loadedAtMs: Date.now() });
      setError(null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    });
    return () => controller.abort();
  });
  const ledger = createMemo((): ProjectLedger | null => {
    const loaded = load();
    if (loaded === null) return null;
    return assembleProjectLedger({
      nowMs: loaded.loadedAtMs,
      project: project(),
      windows: { current: loaded.window, previous: loaded.previous },
      current: loaded.current,
      baseline: loaded.baseline.kind === "loaded" ? loaded.baseline.histories : undefined,
      objectMethods: loaded.objectMethods,
      planMonth: planMonth() ?? undefined
    });
  });
  const histories = () => load()?.current ?? null;
  const baselineError = () => {
    const loaded = load();
    return loaded?.baseline.kind === "failed" ? loaded.baseline.message : null;
  };
  const objectMethodsError = () => load()?.objectMethodsError ?? null;
  return { ledger, histories, error, baselineError, objectMethodsError };
}

export function createMonthSpend(project: Accessor<Project>, settledMs: Accessor<number>, refreshKey: Accessor<string>) {
  const [stored, setSpend] = createSignal<{ readonly projectId: string; readonly value: PlanMonthInput } | null>(null);
  const [failure, setError] = createSignal<{ readonly projectId: string; readonly settledMs: number; readonly message: string } | null>(null);
  const spend = () => {
    const result = stored();
    return result !== null && result.projectId === project().id && result.value.settledMs === settledMs() ? result.value : null;
  };
  const error = () => {
    const result = failure();
    return result !== null && result.projectId === project().id && result.settledMs === settledMs() ? result.message : null;
  };
  createEffect(() => ({ projectId: project().id, settledMs: settledMs(), refresh: refreshKey() }), query => {
    const month = utcMonthOf(query.settledMs);
    const window = { fromMs: month.fromMs, toMs: Math.max(month.fromMs, query.settledMs) };
    const controller = new AbortController();
    getProjectHistories(query.projectId, window, historyKinds(project()), controller.signal).then(histories => {
      if (controller.signal.aborted) return;
      setSpend({ projectId: query.projectId, value: { histories: ledgerHistories(histories), settledMs: window.toMs } });
      setError(null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError({ projectId: query.projectId, settledMs: query.settledMs, message: errorMessage(cause) });
    });
    return () => controller.abort();
  });
  return { spend, error };
}
