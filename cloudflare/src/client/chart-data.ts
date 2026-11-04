import type { Cells, Times, Track } from "./columns";
import type { Limits } from "./health";

export interface TimeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface AlignedSeries {
  readonly times: Times;
  readonly columns: readonly Cells[];
}

export interface WindowStats {
  readonly min: number;
  readonly avg: number;
  readonly max: number;
  readonly last: number;
}

export interface SparkGap {
  readonly x0: number;
  readonly x1: number;
}

export interface SparkGeometry {
  readonly paths: readonly string[];
  readonly area: string | undefined;
  readonly areas: readonly (string | undefined)[];
  readonly dot: { readonly x: number; readonly y: number } | undefined;
  readonly gaps: readonly SparkGap[];
  readonly low: number;
  readonly high: number;
}

export type SparkTone = "base" | "elevated" | "critical";

export interface SparkToneStop {
  readonly offset: number;
  readonly tone: SparkTone;
}

const SPARK_WIDTH = 160;
const SPARK_BOTTOM = 36;
const SPARK_HEIGHT = 30;
const SPARK_FLOOR = 40;

export function sparkGeometry(tracks: readonly Cells[], times: Times | undefined, window: TimeWindow | undefined, zeroBased: boolean, mirror = false): SparkGeometry | null {
  const length = Math.max(0, ...tracks.map(track => track.length));
  if (length === 0) return null;
  const fromMs = window?.fromMs ?? times?.[0];
  const toMs = window?.toMs ?? times?.at(-1);
  const timed = times !== undefined && fromMs !== undefined && toMs !== undefined && toMs > fromMs;
  const x = (index: number): number | undefined => {
    if (!timed) return length <= 1 ? 0 : (index / (length - 1)) * SPARK_WIDTH;
    const time = times[index];
    if (time === undefined) return undefined;
    return Math.min(SPARK_WIDTH, Math.max(0, ((time - fromMs) / (toMs - fromMs)) * SPARK_WIDTH));
  };
  const present = (index: number): boolean => tracks.some(track => {
    const value = track[index];
    return value !== null && value !== undefined && Number.isFinite(value);
  });
  const presentX = Array.from({ length }, (_, index) => (present(index) ? x(index) : undefined)).filter((value): value is number => value !== undefined);
  const gaps: SparkGap[] = [];
  const first = presentX[0];
  const last = presentX.at(-1);
  if (first === undefined || last === undefined) gaps.push({ x0: 0, x1: SPARK_WIDTH });
  else {
    if (first > 0.5) gaps.push({ x0: 0, x1: first });
    if (last < SPARK_WIDTH - 0.5) gaps.push({ x0: last, x1: SPARK_WIDTH });
  }
  const values = tracks.flatMap(track => track.filter((value): value is number => value !== null && Number.isFinite(value)));
  if (values.length === 0) return { paths: [], area: undefined, areas: [], dot: undefined, gaps, low: 0, high: 0 };
  const low = mirror || zeroBased ? Math.min(0, ...values) : Math.min(...values);
  const high = mirror ? Math.max(0, ...values) : Math.max(...values);
  const span = high - low || 1;
  const baseline = mirror ? (SPARK_BOTTOM - ((0 - low) / span) * SPARK_HEIGHT).toFixed(2) : `${SPARK_FLOOR}`;
  const paths: string[] = [];
  const areas: (string | undefined)[] = tracks.map(() => undefined);
  let dot: { readonly x: number; readonly y: number } | undefined;
  tracks.forEach((track, position) => {
    const segments: { readonly x: number; readonly y: number }[][] = [];
    let segment: { readonly x: number; readonly y: number }[] = [];
    track.forEach((value, index) => {
      const pointX = x(index);
      if (value === null || !Number.isFinite(value) || pointX === undefined) {
        if (segment.length > 0) segments.push(segment);
        segment = [];
        return;
      }
      const point = { x: pointX, y: SPARK_BOTTOM - ((value - low) / span) * SPARK_HEIGHT };
      segment.push(point);
      if (position === 0) dot = point;
    });
    if (segment.length > 0) segments.push(segment);
    paths.push(segments.map(entry => entry.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ")).filter(path => path !== "").join(" "));
    if (position === 0 || mirror) {
      areas[position] = segments.map(entry => {
        const first = entry[0]!;
        const last = entry.at(-1)!;
        return `M${first.x.toFixed(2)},${baseline} L${entry.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" L")} L${last.x.toFixed(2)},${baseline} Z`;
      }).join(" ");
    }
  });
  return { paths, area: areas[0], areas, dot, gaps, low, high };
}

export function sparkToneStops(geometry: SparkGeometry, limits: Limits): readonly SparkToneStop[] {
  const span = geometry.high - geometry.low || 1;
  const offset = (value: number) => Math.min(1, Math.max(0, (SPARK_BOTTOM - ((value - geometry.low) / span) * SPARK_HEIGHT) / SPARK_FLOOR));
  const elevated = offset(limits.elevated);
  const critical = offset(limits.critical);
  return limits.direction === "above"
    ? [
        { offset: 0, tone: "critical" }, { offset: critical, tone: "critical" },
        { offset: critical, tone: "elevated" }, { offset: elevated, tone: "elevated" },
        { offset: elevated, tone: "base" }, { offset: 1, tone: "base" }
      ]
    : [
        { offset: 0, tone: "base" }, { offset: elevated, tone: "base" },
        { offset: elevated, tone: "elevated" }, { offset: critical, tone: "elevated" },
        { offset: critical, tone: "critical" }, { offset: 1, tone: "critical" }
      ];
}

interface Grid {
  readonly times: Times;
  readonly dense: boolean;
}

const grids = new WeakMap<Times, Map<number, Grid>>();

function gridOf(times: Times, step: number): Grid {
  let byStep = grids.get(times);
  if (byStep === undefined) {
    byStep = new Map();
    grids.set(times, byStep);
  }
  let found = byStep.get(step);
  if (found === undefined) {
    const snapped = times.map(time => Math.round(time / step) * step);
    let dense = true;
    let identical = true;
    for (let index = 0; index < snapped.length; index += 1) {
      if (snapped[index] !== times[index]) identical = false;
      if (index > 0 && snapped[index]! - snapped[index - 1]! !== step) dense = false;
    }
    found = { times: identical ? times : snapped, dense };
    byStep.set(step, found);
  }
  return found;
}

function alignedOnGrid(tracks: readonly Track[], step: number): AlignedSeries {
  const first = tracks[0];
  if (first !== undefined && tracks.every(track => track.times === first.times)) {
    const grid = gridOf(first.times, step);
    if (grid.dense || grid.times.length === 0) return { times: grid.times, columns: tracks.map(track => track.values) };
  }
  const snapped = tracks.map(track => gridOf(track.times, step).times);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const times of snapped) {
    for (const time of times) {
      if (time < low) low = time;
      if (time > high) high = time;
    }
  }
  if (!Number.isFinite(low)) return { times: [], columns: tracks.map(() => []) };
  const count = Math.floor((high - low) / step) + 1;
  const times = Array.from({ length: count }, (_, index) => low + index * step);
  const columns = tracks.map((track, position) => {
    const column = Array.from({ length: count }, (): number | null => null);
    const at = snapped[position]!;
    for (let index = 0; index < at.length; index += 1) {
      const value = track.values[index];
      column[Math.round((at[index]! - low) / step)] = value !== undefined && value !== null && Number.isFinite(value) ? value : null;
    }
    return column;
  });
  return { times, columns };
}

function alignedByTime(tracks: readonly Track[]): AlignedSeries {
  const lookups = tracks.map(track => {
    const byTime = new Map<number, number | null>();
    for (let index = 0; index < track.times.length; index += 1) {
      const value = track.values[index];
      byTime.set(track.times[index]!, value !== undefined && value !== null && Number.isFinite(value) ? value : null);
    }
    return byTime;
  });
  const times = [...new Set(lookups.flatMap(byTime => [...byTime.keys()]))].sort((left, right) => left - right);
  return { times, columns: lookups.map(byTime => times.map(time => byTime.get(time) ?? null)) };
}

export function alignTracks(tracks: readonly Track[], stepMs?: number): AlignedSeries {
  return stepMs !== undefined && stepMs > 0 ? alignedOnGrid(tracks, stepMs) : alignedByTime(tracks);
}

export function worstTrack(tracks: readonly Track[], stepMs: number): Track {
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

export function sumTracks(tracks: readonly Track[]): Track {
  const first = tracks[0];
  if (first === undefined) return { times: [], values: [] };
  const shared = tracks.every(track => track.times === first.times || (track.times.length === first.times.length && track.times.every((time, index) => time === first.times[index])));
  if (shared && first.times.every((time, index) => index === 0 || time > first.times[index - 1]!)) {
    const values = first.times.map((_, row) => {
      let total: number | null = null;
      for (const track of tracks) {
        const value = track.values[row];
        if (value !== undefined && value !== null && Number.isFinite(value)) total = (total ?? 0) + value;
      }
      return total;
    });
    return { times: first.times, values };
  }
  const totals = new Map<number, number | null>();
  for (const track of tracks) {
    for (let index = 0; index < track.times.length; index += 1) {
      const value = track.values[index];
      const time = track.times[index]!;
      const known = totals.get(time) ?? null;
      totals.set(time, value !== undefined && value !== null && Number.isFinite(value) ? (known ?? 0) + value : known);
    }
  }
  const ordered = [...totals].sort((left, right) => left[0] - right[0]);
  return { times: ordered.map(([time]) => time), values: ordered.map(([, value]) => value) };
}

export function windowTracks(tracks: readonly Track[], window: TimeWindow | null): Track[] {
  if (window === null) return [...tracks];
  const windows = new Map<Times, { readonly times: Times; readonly first: number; readonly last: number }>();
  return tracks.map(track => {
    let found = windows.get(track.times);
    if (found === undefined) {
      const [first, last] = windowIndexes(track.times, window);
      found = { times: track.times.slice(first, last + 1), first, last };
      windows.set(track.times, found);
    }
    return { times: found.times, values: track.values.slice(found.first, found.last + 1) };
  });
}

export function windowIndexes(times: Times, window: TimeWindow | null): readonly [number, number] {
  if (times.length === 0) return [0, -1];
  if (window === null) return [0, times.length - 1];
  let first = times.findIndex(time => time >= window.fromMs);
  if (first === -1) first = times.length;
  let last = times.length - 1;
  while (last >= 0 && times[last]! > window.toMs) last -= 1;
  return [first, last];
}

export function windowStats(values: Cells, first: number, last: number): WindowStats | undefined {
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
