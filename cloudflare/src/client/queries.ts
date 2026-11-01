import { onCleanup } from "solid-js";
import * as Effect from "effect/Effect";
import { getDisks, getHosts, getNets, getSummary, run, type ApiFailure, type DiskSeries, type Host, type NetSeries, type SummaryPoint } from "./api";

export function loadQuery<T>(load: (signal: AbortSignal) => Effect.Effect<T, ApiFailure>): Promise<T> {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  return run(load(controller.signal));
}

export function loadHosts(): Promise<readonly Host[]> {
  return loadQuery(signal => getHosts(signal));
}

export interface FleetRow {
  readonly host: Host;
  readonly summary: readonly SummaryPoint[];
  readonly disks: readonly DiskSeries[];
  readonly nets: readonly NetSeries[];
}

export function loadFleetRows(hosts: readonly Host[], range: string): Promise<readonly FleetRow[]> {
  return loadQuery(signal => Effect.forEach(
    hosts,
    host => Effect.all({
      summary: getSummary(host.hostId, range, signal),
      disks: getDisks(host.hostId, range, signal),
      nets: getNets(host.hostId, range, signal)
    }).pipe(Effect.map(value => ({
      host,
      summary: value.summary.points ?? [],
      disks: value.disks.series ?? [],
      nets: value.nets.series ?? []
    }))),
    { concurrency: 4 }
  ));
}
