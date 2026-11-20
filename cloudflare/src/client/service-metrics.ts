import type { TimeWindow } from "./chart-data";
import { rangeMs, type Range } from "./state";
import type { ResourcePoint } from "../core/installation/service-resources-model";
import type { HealthBar } from "../core/installation/service-health-model";

export interface ResourceSeries {
  readonly points: readonly ResourcePoint[];
}

export const NEVER_IDLE_CORES = 0.2;
const NEVER_IDLE_MIN_POINTS = 10;

export function selectedWindow(range: Range, view: TimeWindow | null, now: number): TimeWindow {
  const toMs = view?.toMs ?? now;
  return { fromMs: view?.fromMs ?? toMs - rangeMs[range], toMs };
}

/** True when CPU never dropped below the threshold in the window: steady load with no idle period. */
export function neverIdle(points: readonly ResourcePoint[]): boolean {
  const cpu = points.map(point => point.cpuCores).filter((value): value is number => value !== null);
  return cpu.length >= NEVER_IDLE_MIN_POINTS && Math.min(...cpu) >= NEVER_IDLE_CORES;
}

/** Sums one service's series across hosts; the hosts share the window and step, so points align by index. */
export function combinedPoints(rows: readonly ResourceSeries[]): ResourcePoint[] {
  const first = rows[0];
  if (first === undefined) return [];
  const add = (left: number | null, right: number | null) => left === null ? right : right === null ? left : left + right;
  return first.points.map((point, index) => rows.slice(1).reduce((sum, row) => {
    const other = row.points[index];
    return other === undefined ? sum : { atMs: sum.atMs, cpuCores: add(sum.cpuCores, other.cpuCores), memoryBytes: add(sum.memoryBytes, other.memoryBytes), ioBytesPerSec: add(sum.ioBytesPerSec, other.ioBytesPerSec) };
  }, point));
}

export type BarState = "up" | "degraded" | "down" | "none";

export function barState(bar: HealthBar): BarState {
  if (bar.probes === 0) return "none";
  if (bar.up === bar.probes) return "up";
  return bar.up === 0 ? "down" : "degraded";
}

export function uptime(bars: readonly HealthBar[]): number | null {
  const probes = bars.reduce((sum, bar) => sum + bar.probes, 0);
  return probes === 0 ? null : bars.reduce((sum, bar) => sum + bar.up, 0) / probes * 100;
}

