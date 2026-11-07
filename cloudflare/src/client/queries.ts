import { onCleanup } from "solid-js";
import { getFleetHistories, getHosts, getProjects, getServices, getSystem, type HistoryQuery, type Host, type HostSystem, type Project, type Service } from "./api";
import type { DiskSeries, FilesystemSeries, NetSeries, SummaryTable } from "./history";

export function loadQuery<T>(
  load: (signal: AbortSignal) => Promise<T>,
  previous?: T,
  onRefreshError?: (error: unknown) => void
): Promise<T> {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const promise = load(controller.signal);
  if (previous === undefined || onRefreshError === undefined) return promise;
  return promise.then(
    value => {
      if (!controller.signal.aborted) onRefreshError(null);
      return value;
    },
    (error: unknown) => {
      if (controller.signal.aborted) throw error;
      onRefreshError(error);
      return previous;
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

async function mapLimit<T, R>(values: readonly T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  if (limit < 1) throw new Error("limit must be positive");
  const results: R[] = [];
  for (let index = 0; index < values.length; index += limit) {
    results.push(...await Promise.all(values.slice(index, index + limit).map(run)));
  }
  return results;
}

export function loadFleetRows(
  hosts: readonly Host[],
  query: HistoryQuery,
  previous?: readonly FleetRow[],
  onRefreshError?: (error: unknown) => void
): Promise<readonly FleetRow[]> {
  return loadQuery(signal => mapLimit(hosts, 4, async host => {
    const [history, system] = await Promise.all([getFleetHistories(host.hostId, query, signal), getSystem(host.hostId, signal)]);
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
  }), previous, onRefreshError);
}
