import type { Track } from "../../columns";

const MINUTE_MS = 60_000;
const HOLD_MAX_MS = 60 * MINUTE_MS;

export function addAll(parts: readonly Track[]): Track {
  const first = parts[0];
  if (first === undefined) return { times: [], values: [] };
  const values = first.times.map((_, index) => {
    let total = 0;
    for (const part of parts) {
      const value = part.values[index];
      if (value === undefined || value === null) return null;
      total += value;
    }
    return total;
  });
  return { times: first.times, values };
}

export function scaled(track: Track, factor: number): Track {
  return { times: track.times, values: track.values.map(value => (value === null ? null : value * factor)) };
}

export function holdLast(track: Track): Track {
  let held: { readonly atMs: number; readonly value: number } | undefined;
  const values = track.values.map((value, index) => {
    const atMs = track.times[index]!;
    if (value !== null) held = { atMs, value };
    return held !== undefined && atMs - held.atMs <= HOLD_MAX_MS ? held.value : null;
  });
  return { times: track.times, values };
}

export function ratio(part: Track, whole: Track, scale: number, minimumWhole = 0): Track {
  const values = whole.values.map((denominator, index) => {
    const numerator = part.values[index];
    const scored = numerator !== undefined && numerator !== null && denominator !== null && denominator > 0 && denominator >= minimumWhole;
    return scored ? (numerator / denominator) * scale : null;
  });
  return { times: whole.times, values };
}
