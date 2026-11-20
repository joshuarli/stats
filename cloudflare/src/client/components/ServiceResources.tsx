import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { EmptyState, Skeleton } from "@laputa-systems/ui-dashboard";
import { getHostServiceResources } from "../api";
import type { HostServiceResources, ResourcePoint } from "../../core/installation/service-resources-model";
import { bytes, errorMessage, rate } from "../format";
import { useTelemetry } from "../state";
import { compareSortValues, createSort, SortHeader } from "./sort";
import { Notice, Widget } from "./ui";
import { PanelChart, PanelLabel } from "../pages/host/shared";
import type { ChartSeries } from "./TimeChart";
import "./service-resources.css";
import { selectedWindow } from "../service-metrics";

const SERIES_COLORS = 8;

export interface ResourceRow {
  readonly key: string;
  readonly service: string;
  readonly hostId: string;
  readonly points: readonly ResourcePoint[];
  readonly cpuNow: number | null;
  readonly cpuMean: number | null;
  readonly cpuPeak: number | null;
  readonly memoryNow: number | null;
  readonly ioMean: number | null;
}

function latest(points: readonly ResourcePoint[], pick: (point: ResourcePoint) => number | null): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = pick(points[index]!);
    if (value !== null) return value;
  }
  return null;
}

function mean(points: readonly ResourcePoint[], pick: (point: ResourcePoint) => number | null): number | null {
  const values = points.map(pick).filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function peak(points: readonly ResourcePoint[], pick: (point: ResourcePoint) => number | null): number | null {
  const values = points.map(pick).filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}

export function resourceRows(results: readonly HostServiceResources[], only?: string): ResourceRow[] {
  return results.flatMap(result => result.services.filter(service => only === undefined || service.name === only).map(service => ({
    key: `${result.hostId}/${service.name}`,
    service: service.name,
    hostId: result.hostId,
    points: service.points,
    cpuNow: latest(service.points, point => point.cpuCores),
    cpuMean: mean(service.points, point => point.cpuCores),
    cpuPeak: peak(service.points, point => point.cpuCores),
    memoryNow: latest(service.points, point => point.memoryBytes),
    ioMean: mean(service.points, point => point.ioBytesPerSec)
  })));
}

export function cores(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value < 0.01 && value > 0 ? "<0.01" : value.toFixed(2);
}

/** Loads per-service cgroup levels for the given hosts over the selected window. */
export function createServiceResources(hostIds: () => readonly string[]) {
  const { range, view, now, tick, manualTick } = useTelemetry();
  const [results, setResults] = createSignal<readonly HostServiceResources[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let loadedSelection: string | null = null;
  createEffect(() => ({ hosts: hostIds().join(","), range: range(), view: view(), refresh: `${tick()}:${manualTick()}` }), query => {
    const selection = `${query.hosts}:${query.range}:${query.view?.fromMs ?? ""}:${query.view?.toMs ?? ""}`;
    if (loadedSelection !== selection) setResults(null);
    const { fromMs: start, toMs: end } = selectedWindow(query.range, query.view, now());
    const controller = new AbortController();
    void Promise.all(hostIds().map(hostId => getHostServiceResources(hostId, start, end, controller.signal))).then(value => {
      if (controller.signal.aborted) return;
      loadedSelection = selection;
      setResults(value);
      setError(null);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  });
  return { results, error };
}

export function ServiceResourcesView(props: {
  readonly results: readonly HostServiceResources[] | null;
  readonly error: string | null;
  readonly only?: string | undefined;
  readonly hostName: (hostId: string) => string;
  readonly serviceHref?: ((service: string) => string | null) | undefined;
  readonly empty: JSX.Element;
}): JSX.Element {
  const rows = createMemo(() => props.results === null ? [] : resourceRows(props.results, props.only));
  const multiHost = createMemo(() => new Set(rows().map(row => row.hostId)).size > 1);
  const label = (row: ResourceRow) => props.only !== undefined ? props.hostName(row.hostId) : multiHost() ? `${row.service} @ ${props.hostName(row.hostId)}` : row.service;
  const [highlight, setHighlight] = createSignal<string | null>(null);
  const { sort, sortBy } = createSort<"service" | "cpuNow" | "cpuMean" | "cpuPeak" | "memory" | "io">({ key: "cpuMean", direction: -1 });
  const sorted = createMemo(() => {
    const key = sort().key;
    const value = (row: ResourceRow): number | string | null => key === "service" ? label(row) : key === "cpuNow" ? row.cpuNow : key === "cpuMean" ? row.cpuMean : key === "cpuPeak" ? row.cpuPeak : key === "memory" ? row.memoryNow : row.ioMean;
    return [...rows()].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      if (leftValue === null || rightValue === null) return leftValue === rightValue ? left.key.localeCompare(right.key) : leftValue === null ? 1 : -1;
      return compareSortValues(leftValue, rightValue) * sort().direction || left.key.localeCompare(right.key);
    });
  });
  const colorOf = createMemo(() => new Map(rows().map((row, index) => [row.key, index % SERIES_COLORS])));
  const series = (pick: (point: ResourcePoint) => number | null): ChartSeries[] => rows().map(row => ({
    label: label(row),
    color: colorOf().get(row.key) ?? 0,
    track: { times: row.points.map(point => point.atMs), values: row.points.map(pick) }
  }));
  const stepMs = () => props.results?.[0]?.stepMs;
  return (
    <>
      <Show when={props.error}>{message => <Notice tone="warn">{message()}</Notice>}</Show>
      <Show when={props.results !== null} fallback={props.error === null ? <Skeleton rows={3} chart /> : null}>
        <Show when={rows().length > 0} fallback={props.empty}>
          <Widget id="service-resources-table" title="Resource use by service" bodyClass="flush" meta={<span class="cell-note">cgroup counters from the host agent; mean and peak over the selected window</span>}>
            <div class="table-scroll" role="region" aria-label="Service resource table">
              <table class="data-table compact" aria-label="Service resources">
                <thead><tr>
                  <SortHeader label={props.only !== undefined ? "Host" : "Service"} sortKey="service" sort={sort()} onSort={sortBy} />
                  <SortHeader label="CPU now" sortKey="cpuNow" sort={sort()} onSort={sortBy} class="numeric" />
                  <SortHeader label="CPU mean" sortKey="cpuMean" sort={sort()} onSort={sortBy} class="numeric" />
                  <SortHeader label="CPU peak" sortKey="cpuPeak" sort={sort()} onSort={sortBy} class="numeric" />
                  <SortHeader label="Memory" sortKey="memory" sort={sort()} onSort={sortBy} class="numeric" />
                  <SortHeader label="Disk I/O mean" sortKey="io" sort={sort()} onSort={sortBy} class="numeric" />
                </tr></thead>
                <tbody>
                  <For each={sorted()} keyed={row => row.key}>{row => (
                    <tr onMouseEnter={() => setHighlight(label(row()))} onMouseLeave={() => setHighlight(null)}>
                      <th scope="row">
                        <span class="series-swatch" style={{ background: `var(--s${colorOf().get(row().key) ?? 0})` }} aria-hidden="true" />
                        <Show when={props.only === undefined ? props.serviceHref?.(row().service) ?? null : null} fallback={<span class="mono">{label(row())}</span>}>{href => <a class="mono" href={href()}>{label(row())}</a>}</Show>
                      </th>
                      <td class="numeric">{cores(row().cpuNow)}</td>
                      <td class="numeric">{cores(row().cpuMean)}</td>
                      <td class="numeric">{cores(row().cpuPeak)}</td>
                      <td class="numeric">{bytes(row().memoryNow ?? undefined)}</td>
                      <td class="numeric">{rate(row().ioMean ?? undefined)}</td>
                    </tr>
                  )}</For>
                </tbody>
              </table>
            </div>
          </Widget>
          <section class="charts" aria-label="Service resource charts">
            <Widget id="service-resources-cpu" title="CPU by service" expandable>
              <PanelChart label="CPU cores used per service" series={series(point => point.cpuCores)} format={value => `${cores(value)} cores`} min={0} stepMs={stepMs()} highlight={highlight()} sortTooltip />
            </Widget>
            <Widget id="service-resources-memory" title="Memory by service" expandable>
              <PanelChart label="Memory in use per service" series={series(point => point.memoryBytes)} format={bytes} min={0} stepMs={stepMs()} highlight={highlight()} sortTooltip />
              <PanelLabel>Disk reads and writes</PanelLabel>
              <PanelChart label="Disk I/O per service" series={series(point => point.ioBytesPerSec)} format={rate} min={0} stepMs={stepMs()} highlight={highlight()} sortTooltip />
            </Widget>
          </section>
        </Show>
      </Show>
    </>
  );
}

export function NoServiceResources(props: { readonly detail: string }): JSX.Element {
  return <Widget title="Resource use by service"><EmptyState title="No service resource data" detail={props.detail} /></Widget>;
}
