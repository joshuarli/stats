import { onCleanup } from "solid-js";
import { getFleetHistories, getHosts, getProjects, getServices, getSystem, type HistoryQuery, type Host, type HostSystem, type Project, type Service } from "./api";
import type { DiskSeries, FilesystemSeries, FleetHistories, NetSeries, SummaryTable } from "./history";
import { windowParams } from "./history-path";

export interface RefreshRetention {
  settledKey: string | null;
}

export function createRefreshRetention(): RefreshRetention {
  return { settledKey: null };
}

export interface RefreshOnError<T> {
  readonly key: string;
  readonly previous: T | undefined;
  readonly retention: RefreshRetention;
  readonly onError: (error: unknown) => void;
}

export function loadQuery<T>(load: (signal: AbortSignal) => Promise<T>, refresh?: RefreshOnError<T>): Promise<T> {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const promise = load(controller.signal);
  if (refresh === undefined) return promise;
  return promise.then(
    value => {
      if (!controller.signal.aborted) {
        refresh.retention.settledKey = refresh.key;
        refresh.onError(null);
      }
      return value;
    },
    (error: unknown) => {
      if (controller.signal.aborted || refresh.previous === undefined || refresh.retention.settledKey !== refresh.key) throw error;
      refresh.onError(error);
      return refresh.previous;
    }
  );
}

export function loadHosts(): Promise<readonly Host[]> {
  return loadQuery(signal => getHosts(signal));
}

export function loadProjects(): Promise<readonly Project[]> {
  return loadQuery(signal => getProjects(signal));
}

export function loadServices(): Promise<readonly Service[]> {
  return loadQuery(signal => getServices(signal));
}

export interface FleetRow {
  readonly host: Host;
  readonly system: HostSystem | null;
  readonly summary: SummaryTable;
  readonly fromMs: number;
  readonly toMs: number;
  readonly stepMs: number;
  readonly filesystemStepMs: number;
  readonly disks: readonly DiskSeries[];
  readonly nets: readonly NetSeries[];
  readonly filesystems: readonly FilesystemSeries[];
}

export interface FleetRowCache {
  readonly systems: Map<string, HostSystem | null>;
  readonly histories: Map<string, { readonly queryKey: string; readonly history: FleetHistories }>;
}

export async function mapLimit<T, R>(values: readonly T[], limit: number, run: (value: T, index: number) => Promise<R>): Promise<R[]> {
  if (limit < 1) throw new Error("limit must be positive");
  if (values.length === 0) return [];
  const results = Array.from<R>({ length: values.length });
  let nextIndex = 0;
  const workerCount = Math.min(limit, values.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await run(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function loadFleetRows(
  hosts: readonly Host[],
  query: HistoryQuery,
  refresh?: Omit<RefreshOnError<readonly FleetRow[]>, "key">,
  cache?: FleetRowCache
): Promise<readonly FleetRow[]> {
  const queryKey = windowParams(query);
  return loadQuery(signal => mapLimit(hosts, 4, async host => {
    const knownHistory = cache?.histories.get(host.hostId);
    const hasSystem = cache?.systems.has(host.hostId) === true;
    const historyPromise = knownHistory !== undefined && knownHistory.queryKey === queryKey
      ? Promise.resolve(knownHistory.history)
      : getFleetHistories(host.hostId, query, signal).then(loaded => {
          if (!signal.aborted) cache?.histories.set(host.hostId, { queryKey, history: loaded });
          return loaded;
        });
    const systemPromise = hasSystem
      ? Promise.resolve(cache!.systems.get(host.hostId) ?? null)
      : getSystem(host.hostId, signal).then(loaded => {
          if (!signal.aborted) cache?.systems.set(host.hostId, loaded);
          return loaded;
        });
    const [history, system] = await Promise.all([historyPromise, systemPromise]);
    return {
      host,
      system,
      summary: history.summary.table,
      fromMs: history.summary.fromMs,
      toMs: history.summary.toMs,
      stepMs: history.summary.stepMs,
      filesystemStepMs: history.filesystems.stepMs,
      disks: history.disks.series,
      nets: history.nets.series,
      filesystems: history.filesystems.series
    };
  }), refresh === undefined ? undefined : { ...refresh, key: `${hosts.map(host => host.hostId).join(",")}|${queryKey}` });
}
