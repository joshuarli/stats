export interface ChartPoint {
  readonly atMs: number;
  readonly value?: number | undefined;
}

export interface TimeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface AlignedSeries {
  readonly times: readonly number[];
  readonly columns: readonly (readonly (number | null)[])[];
}

export interface WindowStats {
  readonly min: number;
  readonly avg: number;
  readonly max: number;
  readonly last: number;
}

export function alignSeries(series: readonly (readonly ChartPoint[])[], stepMs?: number): AlignedSeries {
  const snap = (atMs: number) => (stepMs === undefined ? atMs : Math.round(atMs / stepMs) * stepMs);
  const lookups = series.map(points => {
    const byTime = new Map<number, number | null>();
    for (const point of points) {
      const value = point.value;
      byTime.set(snap(point.atMs), value !== undefined && Number.isFinite(value) ? value : null);
    }
    return byTime;
  });
  const times = [...new Set(lookups.flatMap(byTime => [...byTime.keys()]))].sort((left, right) => left - right);
  return { times, columns: lookups.map(byTime => times.map(time => byTime.get(time) ?? null)) };
}

export function windowIndexes(times: readonly number[], window: TimeWindow | null): readonly [number, number] {
  if (times.length === 0) return [0, -1];
  if (window === null) return [0, times.length - 1];
  let first = times.findIndex(time => time >= window.fromMs);
  if (first === -1) first = times.length;
  let last = times.length - 1;
  while (last >= 0 && times[last]! > window.toMs) last -= 1;
  return [first, last];
}

export function windowStats(values: readonly (number | null)[], first: number, last: number): WindowStats | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let count = 0;
  let latest: number | undefined;
  for (let index = Math.max(0, first); index <= Math.min(values.length - 1, last); index += 1) {
    const value = values[index];
    if (value === null || value === undefined) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    count += 1;
    latest = value;
  }
  return count === 0 || latest === undefined ? undefined : { min, avg: sum / count, max, last: latest };
}

export function pointsIn<T extends { readonly atMs: number }>(points: readonly T[], window: TimeWindow | null): readonly T[] {
  return window === null ? points : points.filter(point => point.atMs >= window.fromMs && point.atMs <= window.toMs);
}

export function panWindow(window: TimeWindow, direction: -1 | 1, bounds: TimeWindow): TimeWindow {
  const span = window.toMs - window.fromMs;
  const fromMs = Math.min(bounds.toMs - span, Math.max(bounds.fromMs, window.fromMs + direction * span * 0.5));
  return { fromMs, toMs: fromMs + span };
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
