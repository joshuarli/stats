import { sumTracks, windowIndexes, windowTracks, worstTrack, type TimeWindow } from "../../chart-data";
import type { Cells, Times, Track } from "../../columns";
import { count, percent, perSecond, rate } from "../../format";
import type { DeviceHistory, SummaryHistory } from "../../history";
import { LIMITS, loadLimits, type Health, type Limits } from "../../health";
import { monitorState } from "../../monitoring";
import { cpuUsed, lastValue, memoryUsed, netFaults, usedShare } from "../../metrics";
import { psiField, type PsiWindow } from "../../psi";

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
  readonly times: Times;
  readonly format: (value: number | undefined) => string;
  readonly value: number | undefined;
  readonly reported: boolean;
  readonly detail: string;
  readonly limits: Limits | undefined;
}

export function rangeText(cells: Cells, format: (value: number | undefined) => string): string {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of cells) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (low > high) return "unavailable";
  return low === high ? "steady" : `peak ${format(high)}`;
}

interface Spec {
  readonly id: string;
  readonly label: string;
  readonly anchor: string;
  readonly limits: Limits | undefined;
  readonly series: readonly Track[];
  readonly stepMs: number;
  readonly reported: boolean;
  readonly format: (value: number | undefined) => string;
}

function finiteValue(value: number | null | undefined): boolean {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function reportedTrack(tracks: readonly Track[]): boolean {
  return tracks.some(track => track.values.some(finiteValue));
}

export function buildCells(data: HostData, view: TimeWindow | null, psiWindow: PsiWindow): MonitorCell[] {
  const table = data.summary.table;
  const stepMs = data.summary.stepMs;
  const [first, last] = windowIndexes(table.times, view);
  const cpuCount = last >= first ? table.at("cpuCount", last) : undefined;
  const cpu = [{ times: table.times, values: cpuUsed(table) }];
  const memory = [{ times: table.times, values: memoryUsed(table) }];
  const load = [table.track("load.one")];
  const pressure = [table.track(psiField("cpu", "some", psiWindow)), table.track(psiField("memory", "some", psiWindow)), table.track(psiField("io", "some", psiWindow))];
  const swap = [table.track("mem.swapInBytesPerSec"), table.track("mem.swapOutBytesPerSec")];
  const diskBusy = data.disks.series.map(entry => entry.table.track("busyPct"));
  const filesystemUsed = data.filesystems.series.map(entry => ({ times: entry.table.times, values: usedShare(entry.table) }));
  const faults = data.nets.series.map(entry => ({ times: entry.table.times, values: netFaults(entry.table) }));
  const seen = (tracks: readonly Track[]) => windowTracks(tracks, view);
  const specs: Spec[] = [
    { id: "cpu", label: "CPU", anchor: "cpu", limits: LIMITS.cpuPercent, series: seen(cpu), reported: reportedTrack(cpu), stepMs, format: percent },
    { id: "memory", label: "Memory", anchor: "memory", limits: LIMITS.memoryUsedPercent, series: seen(memory), reported: reportedTrack(memory), stepMs, format: percent },
    { id: "load", label: "Load 1m", anchor: "load", limits: loadLimits(cpuCount), series: seen(load), reported: reportedTrack(load), stepMs, format: count },
    {
      id: "pressure",
      label: "Pressure",
      anchor: reportedTrack(pressure) ? "memory" : "pressure",
      limits: LIMITS.pressureSome,
      series: seen(pressure),
      reported: reportedTrack(pressure),
      stepMs,
      format: percent
    },
    { id: "swap", label: "Swap paging", anchor: "memory", limits: LIMITS.swapBytesPerSec, series: seen(swap), reported: reportedTrack(swap), stepMs, format: rate },
    { id: "disk", label: "Disk busy", anchor: "disk", limits: LIMITS.diskBusyPercent, series: seen(diskBusy), reported: reportedTrack(diskBusy), stepMs: data.disks.stepMs, format: percent },
    { id: "filesystem", label: "Filesystem", anchor: "filesystems", limits: LIMITS.filesystemUsedPercent, series: seen(filesystemUsed), reported: reportedTrack(filesystemUsed), stepMs: data.filesystems.stepMs, format: percent },
    { id: "network", label: "Net faults", anchor: "network", limits: LIMITS.netFaultsPerSec, series: seen([sumTracks(faults)]), reported: reportedTrack([sumTracks(faults)]), stepMs: data.nets.stepMs, format: perSecond }
  ];
  return specs.map(spec => {
    const aligned = worstTrack(spec.series, spec.stepMs);
    const state = monitorState({ limits: spec.limits, series: spec.series, stepMs: spec.stepMs });
    return { id: spec.id, label: spec.label, anchor: spec.anchor, state, spark: aligned.values, times: aligned.times, format: spec.format, value: lastValue(aligned.values), reported: spec.reported, detail: rangeText(aligned.values, spec.format), limits: spec.limits };
  });
}
