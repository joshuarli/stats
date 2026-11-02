import { alignSeries, type ChartPoint } from "./chart-data";
import { evaluate, type Health, type Limits } from "./health";

export interface MonitoredSeries {
  readonly limits: Limits | undefined;
  readonly series: readonly (readonly ChartPoint[])[];
  readonly stepMs: number | undefined;
}

export function monitorState(monitored: MonitoredSeries): Health | undefined {
  const aligned = alignSeries(monitored.series, monitored.stepMs);
  const healths = evaluate(aligned.times, aligned.columns, monitored.limits).healths;
  for (let index = healths.length - 1; index >= 0; index -= 1) {
    const health = healths[index];
    if (health !== null && health !== undefined) return health;
  }
  return undefined;
}

export function rebootTimes(points: readonly { readonly atMs: number; readonly uptimeMs?: number | undefined }[]): number[] {
  const times: number[] = [];
  let previous: number | undefined;
  for (const point of points) {
    if (point.uptimeMs === undefined) continue;
    if (previous !== undefined && point.uptimeMs < previous) times.push(point.atMs);
    previous = point.uptimeMs;
  }
  return times;
}
