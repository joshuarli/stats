import { alignSeries, type ChartPoint } from "./chart-data";
import { evaluate, type Health, type HealthState, type Limits } from "./health";

export interface Monitor {
  readonly id: string;
  readonly label: string;
  readonly anchor: string;
  readonly limits: Limits | undefined;
  readonly series: readonly (readonly ChartPoint[])[];
  readonly stepMs: number | undefined;
}

export interface Incident {
  readonly monitor: string;
  readonly label: string;
  readonly anchor: string;
  readonly peak: "elevated" | "critical";
  readonly startMs: number;
  readonly endMs: number | null;
}

export interface Monitored {
  readonly monitor: Monitor;
  readonly state: HealthState | undefined;
  readonly incidents: readonly Incident[];
}

export function monitorOne(monitor: Monitor): Monitored {
  const aligned = alignSeries(monitor.series, monitor.stepMs);
  const evaluation = evaluate(aligned.times, aligned.columns, monitor.limits);
  const incidents = evaluation.episodes.map((episode): Incident => ({
    monitor: monitor.id,
    label: monitor.label,
    anchor: monitor.anchor,
    peak: episode.peak,
    startMs: aligned.times[episode.startIndex]!,
    endMs: episode.endIndex === null ? null : aligned.times[episode.endIndex]!
  }));
  return { monitor, state: evaluation.state, incidents };
}

export function incidentsNewestFirst(monitored: readonly Monitored[], limit: number): Incident[] {
  return monitored.flatMap(entry => entry.incidents).sort((left, right) => right.startMs - left.startMs).slice(0, limit);
}

export function worstHealth(monitored: readonly Monitored[]): Health | undefined {
  const order: Readonly<Record<Health, number>> = { ok: 0, elevated: 1, critical: 2 };
  return monitored.reduce<Health | undefined>((worst, entry) => {
    const health = entry.state?.health;
    if (health === undefined) return worst;
    return worst === undefined || order[health] > order[worst] ? health : worst;
  }, undefined);
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
