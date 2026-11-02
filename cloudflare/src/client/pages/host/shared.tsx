import { useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Series, SummaryPoint } from "../../api";
import type { ChartPoint } from "../../chart-data";
import { count, isFiniteNumber } from "../../format";
import { rebootTimes } from "../../monitoring";
import { TimeChart, type ChartEvent, type TimeChartProps, type VizColor } from "../../components/TimeChart";
import { DeploymentEvents } from "../../components/DeploymentEvents";

export const AXIS_WIDTH = 76;
export const SERIES_COLORS = ["blue", "aqua", "violet", "magenta"] as const satisfies readonly VizColor[];

export function seriesColor(index: number): VizColor {
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? "neutral";
}

export function perSecond(value: number | undefined): string {
  return isFiniteNumber(value) ? `${count(value)}/s` : count(value);
}

export function rebootEvents(points: readonly SummaryPoint[]): ChartEvent[] {
  return rebootTimes(points).map(atMs => ({ atMs, label: "↻ reboot" }));
}

export function peakOf<T extends { readonly atMs: number }>(entry: Series<T>, pick: (point: T) => number | undefined): number {
  return Math.max(Number.NEGATIVE_INFINITY, ...entry.points.map(point => pick(point) ?? Number.NEGATIVE_INFINITY));
}

export function topSeries<T extends { readonly atMs: number }>(series: readonly Series<T>[], pick: (point: T) => number | undefined): Series<T>[] {
  const ranked = [...series].sort((left, right) => peakOf(right, pick) - peakOf(left, pick)).slice(0, SERIES_COLORS.length);
  return ranked.sort((left, right) => left.id.localeCompare(right.id));
}

export function colorsFor<T extends { readonly atMs: number }>(shown: readonly Series<T>[]): ReadonlyMap<string, VizColor> {
  return new Map(shown.map((entry, index) => [entry.id, SERIES_COLORS[index] ?? "neutral"]));
}

export function activeSeries<T extends { readonly atMs: number }>(series: readonly Series<T>[], stepMs: number): readonly Series<T>[] {
  const latest = Math.max(0, ...series.map(entry => entry.points.at(-1)?.atMs ?? 0));
  return series.filter(entry => (entry.points.at(-1)?.atMs ?? 0) >= latest - 2 * stepMs);
}

export function summarySeries(points: readonly SummaryPoint[], pick: (point: SummaryPoint) => number | undefined): ChartPoint[] {
  return points.map(point => ({ atMs: point.atMs, value: pick(point) }));
}

export function PanelChart(props: TimeChartProps): JSX.Element {
  const deployments = useContext(DeploymentEvents);
  return <TimeChart compact legend="inline" yAxisWidth={AXIS_WIDTH} {...props} events={[...(props.events ?? []), ...deployments()]} />;
}

export function PanelLabel(props: { readonly children: JSX.Element }): JSX.Element {
  return <div class="panel-label">{props.children}</div>;
}
