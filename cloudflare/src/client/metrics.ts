import type { SummaryPoint } from "./api";
import type { SparkPoint } from "./components/Sparkline";
import { isFiniteNumber, percentUsed } from "./format";

export function cpuUsed(point: SummaryPoint | undefined): number | undefined {
  return point?.cpu === undefined ? undefined : point.cpu.user + point.cpu.system;
}

export function memoryUsed(point: SummaryPoint | undefined): number | undefined {
  return point?.mem === undefined ? undefined : percentUsed(point.mem.total, point.mem.available);
}

export function memoryFree(point: SummaryPoint | undefined): number | undefined {
  return point?.mem?.available;
}

export function memoryTotal(point: SummaryPoint | undefined): number | undefined {
  return point?.mem?.total;
}

export function loadOne(point: SummaryPoint | undefined): number | undefined {
  return point?.load?.one;
}

export function psiCpu(point: SummaryPoint | undefined): number | undefined {
  return point?.psi?.cpu?.some10;
}

export function latestPoint(points: readonly SummaryPoint[]): SummaryPoint | undefined {
  return points.at(-1);
}

export function sparkPoints(points: readonly SummaryPoint[], pick: (point: SummaryPoint) => number | undefined): SparkPoint[] {
  return points.map(point => ({ atMs: point.atMs, value: pick(point) }));
}

export function sumLatest<T>(series: readonly { readonly points: readonly T[] }[], pick: (point: T) => number | undefined): number | undefined {
  let total = 0;
  let present = 0;
  for (const entry of series) {
    const point = entry.points.at(-1);
    if (point === undefined) continue;
    const value = pick(point);
    if (!isFiniteNumber(value)) continue;
    total += value;
    present += 1;
  }
  return present === 0 ? undefined : total;
}
