import { onCleanup } from "solid-js";
import { getFleetHistories, getHosts, getProjects, type DiskSeries, type HistoryQuery, type Host, type NetSeries, type Project, type SummaryPoint } from "./api";

export function loadQuery<T>(load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  return load(controller.signal);
}

export function loadHosts(): Promise<readonly Host[]> {
  return loadQuery(signal => getHosts(signal));
}

export function loadProjects(): Promise<readonly Project[]> {
  return loadQuery(signal => getProjects(signal));
}

export interface FleetRow {
  readonly host: Host;
  readonly summary: readonly SummaryPoint[];
  readonly stepMs: number;
  readonly disks: readonly DiskSeries[];
  readonly nets: readonly NetSeries[];
}

async function mapLimit<T, R>(values: readonly T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  if (limit < 1) throw new Error("limit must be positive");
  const results: R[] = [];
  for (let index = 0; index < values.length; index += limit) {
    results.push(...await Promise.all(values.slice(index, index + limit).map(run)));
  }
  return results;
}

export function loadFleetRows(hosts: readonly Host[], query: HistoryQuery): Promise<readonly FleetRow[]> {
  return loadQuery(signal => mapLimit(hosts, 4, async host => {
    const history = await getFleetHistories(host.hostId, query, signal);
    return {
      host,
      summary: history.summary.points ?? [],
      stepMs: history.summary.stepMs,
      disks: history.disks.series ?? [],
      nets: history.nets.series ?? []
    };
  }));
}
