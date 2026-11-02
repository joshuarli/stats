import { alignTracks } from "./chart-data";
import type { Cells, Times, Track } from "./columns";
import { evaluate, type Health, type Limits } from "./health";

export interface MonitoredSeries {
  readonly limits: Limits | undefined;
  readonly series: readonly Track[];
  readonly stepMs: number | undefined;
}

export function monitorState(monitored: MonitoredSeries): Health | undefined {
  const aligned = alignTracks(monitored.series, monitored.stepMs);
  const healths = evaluate(aligned.times, aligned.columns, monitored.limits).healths;
  for (let index = healths.length - 1; index >= 0; index -= 1) {
    const health = healths[index];
    if (health !== null && health !== undefined) return health;
  }
  return undefined;
}

export function rebootTimes(times: Times, uptimeMs: Cells): number[] {
  const reboots: number[] = [];
  let previous: number | undefined;
  for (let row = 0; row < times.length; row += 1) {
    const uptime = uptimeMs[row];
    if (uptime === null || uptime === undefined) continue;
    if (previous !== undefined && uptime < previous) reboots.push(times[row]!);
    previous = uptime;
  }
  return reboots;
}
