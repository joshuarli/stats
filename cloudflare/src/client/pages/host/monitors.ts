import type { DiskSeries, FilesystemSeries, NetSeries, SummaryPoint } from "../../api";
import { alignSeries, pointsIn, type ChartPoint, type TimeWindow } from "../../chart-data";
import { count, percent, percentUsed, rate } from "../../format";
import { LIMITS, loadLimits, type Limits } from "../../health";
import { monitorOne, type Monitored } from "../../incidents";
import { cpuUsed, loadOne, memoryUsed, sumSeries } from "../../metrics";
import type { VizColor } from "../../components/TimeChart";
import { perSecond, summarySeries } from "./shared";

export interface HostData {
  readonly points: readonly SummaryPoint[];
  readonly stepMs: number;
  readonly disks: readonly DiskSeries[];
  readonly diskStepMs: number;
  readonly nets: readonly NetSeries[];
  readonly netStepMs: number;
  readonly filesystems: readonly FilesystemSeries[];
  readonly fsStepMs: number;
}

export interface MonitorCell {
  readonly id: string;
  readonly label: string;
  readonly anchor: string;
  readonly monitored: Monitored;
  readonly spark: readonly ChartPoint[];
  readonly format: (value: number | undefined) => string;
  readonly value: number | undefined;
  readonly detail: string;
  readonly limits: Limits | undefined;
  readonly hue: VizColor;
}

export const CELL_HUES: Readonly<Record<string, VizColor>> = {
  cpu: "blue",
  load: "blue",
  pressure: "blue",
  memory: "aqua",
  swap: "aqua",
  disk: "violet",
  filesystem: "violet",
  network: "magenta",
  requests: "blue",
  "server-errors": "blue",
  "cpu-time": "violet",
  "r2-other": "aqua",
  "r2-storage": "aqua",
  endpoints: "magenta",
  collector: "neutral"
};

export function worstOf(series: readonly (readonly ChartPoint[])[], stepMs: number): ChartPoint[] {
  const aligned = alignSeries(series, stepMs);
  return aligned.times.map((atMs, index) => {
    const values = aligned.columns.flatMap(column => (column[index] === null || column[index] === undefined ? [] : [column[index]!]));
    return { atMs, value: values.length === 0 ? undefined : Math.max(...values) };
  });
}

export function lastValue(points: readonly ChartPoint[]): number | undefined {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]!.value;
    if (value !== undefined && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function rangeText(points: readonly ChartPoint[], format: (value: number | undefined) => string, limits?: Limits): string {
  const values = points.flatMap(point => (point.value === undefined || !Number.isFinite(point.value) ? [] : [point.value]));
  if (values.length === 0) return "unavailable";
  const peak = format(Math.max(...values));
  const ceiling = limits === undefined || limits.direction !== "above" ? "" : ` · elevated at ${format(limits.elevated)}`;
  return Math.min(...values) === Math.max(...values) ? `steady${ceiling}` : `peak ${peak}${ceiling}`;
}

interface Spec {
  readonly id: string;
  readonly label: string;
  readonly anchor: string;
  readonly limits: Limits | undefined;
  readonly series: readonly (readonly ChartPoint[])[];
  readonly stepMs: number;
  readonly format: (value: number | undefined) => string;
}

export function buildCells(data: HostData, view: TimeWindow | null): MonitorCell[] {
  const points = pointsIn(data.points, view);
  const inView = <T extends { readonly atMs: number }>(series: readonly { readonly id: string; readonly points: readonly T[] }[]) => series.map(entry => ({ id: entry.id, points: pointsIn(entry.points, view) }));
  const disks = inView(data.disks);
  const nets = inView(data.nets);
  const filesystems = inView(data.filesystems);
  const cpuCount = points.at(-1)?.cpuCount;
  const specs: Spec[] = [
    { id: "cpu", label: "CPU", anchor: "cpu", limits: LIMITS.cpuPercent, series: [summarySeries(points, cpuUsed)], stepMs: data.stepMs, format: percent },
    { id: "memory", label: "Memory", anchor: "memory", limits: LIMITS.memoryUsedPercent, series: [summarySeries(points, memoryUsed)], stepMs: data.stepMs, format: percent },
    { id: "load", label: "Load 1m", anchor: "load", limits: loadLimits(cpuCount), series: [summarySeries(points, loadOne)], stepMs: data.stepMs, format: count },
    {
      id: "pressure",
      label: "Pressure",
      anchor: points.some(point => point.psi !== undefined) ? "memory" : "pressure",
      limits: LIMITS.pressureSome,
      series: [summarySeries(points, point => point.psi?.cpu?.some10), summarySeries(points, point => point.psi?.memory?.some10), summarySeries(points, point => point.psi?.io?.some10)],
      stepMs: data.stepMs,
      format: percent
    },
    {
      id: "swap",
      label: "Swap paging",
      anchor: "memory",
      limits: LIMITS.swapBytesPerSec,
      series: [summarySeries(points, point => point.mem?.swapInBytesPerSec), summarySeries(points, point => point.mem?.swapOutBytesPerSec)],
      stepMs: data.stepMs,
      format: rate
    },
    { id: "disk", label: "Disk busy", anchor: "disk", limits: LIMITS.diskBusyPercent, series: disks.map(entry => entry.points.map(point => ({ atMs: point.atMs, value: point.busyPct }))), stepMs: data.diskStepMs, format: percent },
    {
      id: "filesystem",
      label: "Filesystem",
      anchor: "filesystems",
      limits: LIMITS.filesystemUsedPercent,
      series: filesystems.map(entry => entry.points.map(point => ({ atMs: point.atMs, value: percentUsed(point.total, point.available) }))),
      stepMs: data.fsStepMs,
      format: percent
    },
    {
      id: "network",
      label: "Net faults",
      anchor: "network",
      limits: LIMITS.netFaultsPerSec,
      series: [sumSeries(nets, point => point.rxDropsPerSec + point.txDropsPerSec + point.rxErrorsPerSec + point.txErrorsPerSec)],
      stepMs: data.netStepMs,
      format: perSecond
    }
  ];
  return specs.map(spec => {
    const spark = spec.series.length === 1 ? spec.series[0]! : worstOf(spec.series, spec.stepMs);
    const monitored = monitorOne({ id: spec.id, label: spec.label, anchor: spec.anchor, limits: spec.limits, series: spec.series, stepMs: spec.stepMs });
    return { id: spec.id, label: spec.label, anchor: spec.anchor, monitored, spark, format: spec.format, value: lastValue(spark), detail: rangeText(spark, spec.format, spec.limits), limits: spec.limits, hue: CELL_HUES[spec.id] ?? "neutral" };
  });
}
