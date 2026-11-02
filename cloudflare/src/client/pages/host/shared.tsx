import { useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Cells } from "../../columns";
import { count, isFiniteNumber } from "../../format";
import type { DeviceSeries, SummaryTable } from "../../history";
import { rebootTimes } from "../../monitoring";
import { TimeChart, type ChartEvent, type TimeChartProps, type VizColor } from "../../components/TimeChart";
import { DeploymentEvents } from "../../components/DeploymentEvents";
import type { HostKind } from "../../../binary/history";

export const AXIS_WIDTH = 76;
export const SERIES_COLORS = ["blue", "aqua", "violet", "magenta"] as const satisfies readonly VizColor[];

type DeviceKind = Exclude<HostKind, "summary">;

export function seriesColor(index: number): VizColor {
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? "neutral";
}

export function perSecond(value: number | undefined): string {
  return isFiniteNumber(value) ? `${count(value)}/s` : count(value);
}

export function rebootEvents(table: SummaryTable): ChartEvent[] {
  return rebootTimes(table.times, table.cells("uptimeMs")).map(atMs => ({ atMs, label: "↻ reboot" }));
}

export function peakOf(cells: Cells): number {
  let peak = Number.NEGATIVE_INFINITY;
  for (const value of cells) if (value !== null && value > peak) peak = value;
  return peak;
}

export function topSeries<K extends DeviceKind>(series: readonly DeviceSeries<K>[], cells: (table: DeviceSeries<K>["table"]) => Cells): DeviceSeries<K>[] {
  const peaks = new Map(series.map(entry => [entry, peakOf(cells(entry.table))]));
  const ranked = [...series].sort((left, right) => peaks.get(right)! - peaks.get(left)!).slice(0, SERIES_COLORS.length);
  return ranked.sort((left, right) => left.id.localeCompare(right.id));
}

export function colorsFor<K extends DeviceKind>(shown: readonly DeviceSeries<K>[]): ReadonlyMap<string, VizColor> {
  return new Map(shown.map((entry, index) => [entry.id, SERIES_COLORS[index] ?? "neutral"]));
}

export function activeSeries<K extends DeviceKind>(series: readonly DeviceSeries<K>[], stepMs: number): readonly DeviceSeries<K>[] {
  const lastAt = (entry: DeviceSeries<K>) => entry.table.times.at(-1) ?? 0;
  const latest = Math.max(0, ...series.map(lastAt));
  return series.filter(entry => lastAt(entry) >= latest - 2 * stepMs);
}

export function PanelChart(props: TimeChartProps): JSX.Element {
  const deployments = useContext(DeploymentEvents);
  return <TimeChart compact legend="inline" yAxisWidth={AXIS_WIDTH} {...props} events={[...(props.events ?? []), ...deployments()]} />;
}

export function PanelLabel(props: { readonly children: JSX.Element }): JSX.Element {
  return <div class="panel-label">{props.children}</div>;
}
