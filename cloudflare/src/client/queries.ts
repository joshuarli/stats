import { onCleanup } from "solid-js";
import { getDisks, getHosts, getNets, getSummary, type DiskSeries, type Host, type NetSeries, type SummaryPoint } from "./api";

export function loadQuery<T>(load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  return load(controller.signal);
}

export function loadHosts(): Promise<readonly Host[]> {
  return loadQuery(signal => getHosts(signal));
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

export function loadFleetRows(hosts: readonly Host[], range: string): Promise<readonly FleetRow[]> {
  return loadQuery(signal => mapLimit(hosts, 4, async host => {
    const [summary, disks, nets] = await Promise.all([
      getSummary(host.hostId, range, signal),
      getDisks(host.hostId, range, signal),
      getNets(host.hostId, range, signal)
    ]);
    return {
      host,
      summary: summary.points ?? [],
      stepMs: summary.stepMs,
      disks: disks.series ?? [],
      nets: nets.series ?? []
    };
  }));
}
