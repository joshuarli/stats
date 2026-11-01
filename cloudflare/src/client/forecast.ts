import type { Health } from "./health";

export interface UsagePoint {
  readonly atMs: number;
  readonly total: number;
  readonly available: number;
}

export type Forecast =
  | { readonly kind: "unknown" }
  | { readonly kind: "stable" }
  | { readonly kind: "filling"; readonly daysToFull: number; readonly bytesPerDay: number };

const DAY_MS = 86_400_000;
const MIN_POINTS = 8;
const MIN_SPAN_MS = 6 * 3_600_000;
const STABLE_SHARE_PER_DAY = 0.0005;

export function forecastFull(points: readonly UsagePoint[]): Forecast {
  const usable = points.filter(point => Number.isFinite(point.atMs) && Number.isFinite(point.total) && Number.isFinite(point.available) && point.total > 0);
  const first = usable[0];
  const last = usable.at(-1);
  if (first === undefined || last === undefined || usable.length < MIN_POINTS || last.atMs - first.atMs < MIN_SPAN_MS) return { kind: "unknown" };
  const days = usable.map(point => (point.atMs - first.atMs) / DAY_MS);
  const used = usable.map(point => point.total - point.available);
  const meanDay = days.reduce((sum, value) => sum + value, 0) / days.length;
  const meanUsed = used.reduce((sum, value) => sum + value, 0) / used.length;
  let covariance = 0;
  let variance = 0;
  days.forEach((day, index) => {
    covariance += (day - meanDay) * (used[index]! - meanUsed);
    variance += (day - meanDay) ** 2;
  });
  if (variance === 0) return { kind: "unknown" };
  const bytesPerDay = covariance / variance;
  if (bytesPerDay <= last.total * STABLE_SHARE_PER_DAY) return { kind: "stable" };
  return { kind: "filling", daysToFull: Math.max(0, last.available / bytesPerDay), bytesPerDay };
}

export function forecastHealth(forecast: Forecast): Health | undefined {
  if (forecast.kind !== "filling") return forecast.kind === "stable" ? "ok" : undefined;
  return forecast.daysToFull <= 7 ? "critical" : forecast.daysToFull <= 30 ? "elevated" : "ok";
}

export function forecastText(forecast: Forecast, formatBytes: (value: number) => string): string {
  if (forecast.kind === "unknown") return "not enough history";
  if (forecast.kind === "stable") return "stable";
  const when = forecast.daysToFull < 1 ? "under a day" : forecast.daysToFull > 365 ? "over a year" : `${Math.round(forecast.daysToFull)} d`;
  return `full in ${when} · +${formatBytes(forecast.bytesPerDay)}/day`;
}
