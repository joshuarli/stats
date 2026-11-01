import type { ChartPoint } from "../../chart-data";

const MINUTE_MS = 60_000;
export function addAll(parts: readonly (readonly ChartPoint[])[]): ChartPoint[] {
  const first = parts[0];
  if (first === undefined) return [];
  return first.map((point, index) => {
    let total = 0;
    for (const part of parts) {
      const value = part[index]?.value;
      if (value === undefined) return { atMs: point.atMs, value: undefined };
      total += value;
    }
    return { atMs: point.atMs, value: total };
  });
}

const HOLD_MAX_MS = 60 * MINUTE_MS;

export function scaled(points: readonly ChartPoint[], factor: number): ChartPoint[] {
  return points.map(point => ({ atMs: point.atMs, value: point.value === undefined ? undefined : point.value * factor }));
}

export function holdLast(points: readonly ChartPoint[]): ChartPoint[] {
  let held: { readonly atMs: number; readonly value: number } | undefined;
  return points.map(point => {
    if (point.value !== undefined) held = { atMs: point.atMs, value: point.value };
    return { atMs: point.atMs, value: held !== undefined && point.atMs - held.atMs <= HOLD_MAX_MS ? held.value : undefined };
  });
}

export function ratio(part: readonly ChartPoint[], whole: readonly ChartPoint[], scale: number, minimumWhole = 0): ChartPoint[] {
  return whole.map((point, index) => {
    const numerator = part[index]?.value;
    const denominator = point.value;
    const scored = numerator !== undefined && denominator !== undefined && denominator > 0 && denominator >= minimumWhole;
    return { atMs: point.atMs, value: scored ? (numerator / denominator) * scale : undefined };
  });
}
