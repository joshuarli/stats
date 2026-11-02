import { alignTracks, sumTracks, windowIndexes, windowTracks, type TimeWindow } from "../../chart-data";
import type { Cells, Track } from "../../columns";
import { count, percent, rate } from "../../format";
import type { DeviceHistory, SummaryHistory } from "../../history";
import { LIMITS, loadLimits, type Health, type Limits } from "../../health";
import { monitorState } from "../../monitoring";
import { cpuUsed, memoryUsed, netFaults, usedShare } from "../../metrics";
import type { VizColor } from "../../components/TimeChart";
import { perSecond } from "./shared";

export interface HostData {
  readonly summary: SummaryHistory;
  readonly disks: DeviceHistory<"disks">;
  readonly nets: DeviceHistory<"nets">;
  readonly filesystems: DeviceHistory<"filesystems">;
}

export interface MonitorCell {
  readonly id: string;
  readonly label: string;
  readonly anchor: string;
  readonly state: Health | undefined;
  readonly spark: Cells;
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

export function worstOf(tracks: readonly Track[], stepMs: number): Track {
  const aligned = alignTracks(tracks, stepMs);
  const values = aligned.times.map((_, index) => {
    let worst: number | null = null;
    for (const column of aligned.columns) {
      const value = column[index];
      if (value !== null && value !== undefined && (worst === null || value > worst)) worst = value;
    }
    return worst;
  });
  return { times: aligned.times, values };
}

export function lastValue(cells: Cells): number | undefined {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const value = cells[index];
    if (value !== null && value !== undefined && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function rangeText(cells: Cells, format: (value: number | undefined) => string, limits?: Limits): string {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of cells) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (low > high) return "unavailable";
  const ceiling = limits === undefined || limits.direction !== "above" ? "" : ` · elevated at ${format(limits.elevated)}`;
  return low === high ? `steady${ceiling}` : `peak ${format(high)}${ceiling}`;
}

interface Spec {
  readonly id: string;
  readonly label: string;
  readonly anchor: string;
  readonly limits: Limits | undefined;
  readonly series: readonly Track[];
  readonly stepMs: number;
  readonly format: (value: number | undefined) => string;
}

export function buildCells(data: HostData, view: TimeWindow | null): MonitorCell[] {
  const table = data.summary.table;
  const stepMs = data.summary.stepMs;
  const [first, last] = windowIndexes(table.times, view);
  const times = view === null ? table.times : table.times.slice(first, last + 1);
  const take = (cells: Cells): Track => ({ times, values: view === null ? cells : cells.slice(first, last + 1) });
  const cpuCount = last >= first ? table.at("cpuCount", last) : undefined;
  const reportsPsi = take(table.cells("psi")).values.some(value => value !== null);
  const diskBusy = windowTracks(data.disks.series.map(entry => entry.table.track("busyPct")), view);
  const filesystemUsed = windowTracks(data.filesystems.series.map(entry => ({ times: entry.table.times, values: usedShare(entry.table) })), view);
  const faults = sumTracks(windowTracks(data.nets.series.map(entry => ({ times: entry.table.times, values: netFaults(entry.table) })), view));
  const specs: Spec[] = [
    { id: "cpu", label: "CPU", anchor: "cpu", limits: LIMITS.cpuPercent, series: [take(cpuUsed(table))], stepMs, format: percent },
    { id: "memory", label: "Memory", anchor: "memory", limits: LIMITS.memoryUsedPercent, series: [take(memoryUsed(table))], stepMs, format: percent },
    { id: "load", label: "Load 1m", anchor: "load", limits: loadLimits(cpuCount), series: [take(table.cells("load.one"))], stepMs, format: count },
    {
      id: "pressure",
      label: "Pressure",
      anchor: reportsPsi ? "memory" : "pressure",
      limits: LIMITS.pressureSome,
      series: [take(table.cells("psi.cpu.some10")), take(table.cells("psi.memory.some10")), take(table.cells("psi.io.some10"))],
      stepMs,
      format: percent
    },
    {
      id: "swap",
      label: "Swap paging",
      anchor: "memory",
      limits: LIMITS.swapBytesPerSec,
      series: [take(table.cells("mem.swapInBytesPerSec")), take(table.cells("mem.swapOutBytesPerSec"))],
      stepMs,
      format: rate
    },
    { id: "disk", label: "Disk busy", anchor: "disk", limits: LIMITS.diskBusyPercent, series: diskBusy, stepMs: data.disks.stepMs, format: percent },
    { id: "filesystem", label: "Filesystem", anchor: "filesystems", limits: LIMITS.filesystemUsedPercent, series: filesystemUsed, stepMs: data.filesystems.stepMs, format: percent },
    { id: "network", label: "Net faults", anchor: "network", limits: LIMITS.netFaultsPerSec, series: [faults], stepMs: data.nets.stepMs, format: perSecond }
  ];
  return specs.map(spec => {
    const spark = spec.series.length === 1 ? spec.series[0]!.values : worstOf(spec.series, spec.stepMs).values;
    const state = monitorState({ limits: spec.limits, series: spec.series, stepMs: spec.stepMs });
    return { id: spec.id, label: spec.label, anchor: spec.anchor, state, spark, format: spec.format, value: lastValue(spark), detail: rangeText(spark, spec.format, spec.limits), limits: spec.limits, hue: CELL_HUES[spec.id] ?? "neutral" };
  });
}
