import { clock } from "./format";

export type Health = "ok" | "elevated" | "critical";

export interface Limits {
  readonly elevated: number;
  readonly critical: number;
  readonly direction: "above" | "below";
}

export type Marker = { readonly index: number; readonly kind: "elevated" | "critical" | "recovered" };

export interface Episode {
  readonly startIndex: number;
  readonly endIndex: number | null;
  readonly criticalIndex: number | null;
  readonly peak: "elevated" | "critical";
  readonly okSince: number | null;
}

const MIB = 1024 * 1024;
export const MIN_SCORED_EVENTS = 100;
export const RECOVERY_MS = 5 * 60_000;
const RANK: Readonly<Record<Health, number>> = { ok: 0, elevated: 1, critical: 2 };

export const HEALTH_LABEL: Readonly<Record<Health, string>> = { ok: "OK", elevated: "Elevated", critical: "Critical" };
export const HEALTH_GLYPH: Readonly<Record<Health, string>> = { ok: "●", elevated: "▲", critical: "◆" };

export const LIMITS = {
  cpuPercent: { elevated: 70, critical: 90, direction: "above" },
  memoryUsedPercent: { elevated: 85, critical: 95, direction: "above" },
  pressureSome: { elevated: 10, critical: 25, direction: "above" },
  memoryPressureWarnPercent: { elevated: 5, critical: 25, direction: "above" },
  diskBusyPercent: { elevated: 70, critical: 95, direction: "above" },
  filesystemUsedPercent: { elevated: 80, critical: 90, direction: "above" },
  swapBytesPerSec: { elevated: MIB, critical: 16 * MIB, direction: "above" },
  netFaultsPerSec: { elevated: 1, critical: 10, direction: "above" },
  blockP99Us: { elevated: 25_000, critical: 100_000, direction: "above" },
  workerServerErrorPercent: { elevated: 1, critical: 5, direction: "above" },
  workerCpuMs: { elevated: 5, critical: 20, direction: "above" },
  r2OtherPercent: { elevated: 0.5, critical: 2, direction: "above" },
  collectorStaleMinutes: { elevated: 15, critical: 60, direction: "above" },
  probeUp: { elevated: 0, critical: 0, direction: "below" }
} as const satisfies Readonly<Record<string, Limits>>;

export function loadLimits(cpuCount: number | undefined): Limits | undefined {
  return cpuCount === undefined || cpuCount < 1 ? undefined : { elevated: cpuCount, critical: cpuCount * 2, direction: "above" };
}

export function memoryUsedLimits(totalBytes: number | undefined): Limits | undefined {
  return totalBytes === undefined || totalBytes <= 0 ? undefined : { elevated: totalBytes * 0.85, critical: totalBytes * 0.95, direction: "above" };
}

export function healthOf(value: number | null | undefined, limits: Limits): Health | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const past = (limit: number) => (limits.direction === "above" ? value >= limit : value <= limit);
  return past(limits.critical) ? "critical" : past(limits.elevated) ? "elevated" : "ok";
}

export function worse(left: Health | null, right: Health | null): Health | null {
  if (left === null) return right;
  if (right === null) return left;
  return RANK[right] > RANK[left] ? right : left;
}

export function findEpisodes(healths: readonly (Health | null)[], times: readonly number[], recoveryMs: number): Episode[] {
  const episodes: Episode[] = [];
  let open: { startIndex: number; criticalIndex: number | null; peak: "elevated" | "critical"; okSince: number | null } | null = null;
  const close = (endIndex: number | null) => {
    if (open !== null) episodes.push({ startIndex: open.startIndex, endIndex, criticalIndex: open.criticalIndex, peak: open.peak, okSince: endIndex === null ? open.okSince : null });
    open = null;
  };
  healths.forEach((health, index) => {
    if (health === null) return;
    if (health === "ok") {
      if (open === null) return;
      open.okSince ??= index;
      if ((times[index] ?? 0) - (times[open.okSince] ?? 0) >= recoveryMs) close(open.okSince);
      return;
    }
    open ??= { startIndex: index, criticalIndex: null, peak: "elevated", okSince: null };
    open.okSince = null;
    if (health === "critical") {
      open.peak = "critical";
      open.criticalIndex ??= index;
    }
  });
  close(null);
  return episodes;
}

export function markersOf(episodes: readonly Episode[]): Marker[] {
  const markers: Marker[] = [];
  for (const episode of episodes) {
    markers.push({ index: episode.startIndex, kind: episode.criticalIndex === episode.startIndex ? "critical" : "elevated" });
    if (episode.criticalIndex !== null && episode.criticalIndex !== episode.startIndex) markers.push({ index: episode.criticalIndex, kind: "critical" });
    if (episode.endIndex !== null) markers.push({ index: episode.endIndex, kind: "recovered" });
  }
  return markers;
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  return `${Math.round(hours / 24)} d`;
}

export function episodeText(times: readonly number[], episode: Episode): string {
  const start = times[episode.startIndex] ?? 0;
  if (episode.endIndex === null) return `${HEALTH_LABEL[episode.peak]} since ${clock(start)} · ongoing`;
  const end = times[episode.endIndex] ?? start;
  return `${HEALTH_LABEL[episode.peak]} · ${clock(start)} to ${clock(end)} · ${duration(end - start)}`;
}

export interface Evaluation {
  readonly healths: readonly (Health | null)[];
  readonly episodes: readonly Episode[];
}

export function evaluate(times: readonly number[], columns: readonly (readonly (number | null)[])[], limits: Limits | undefined): Evaluation {
  if (limits === undefined) return { healths: [], episodes: [] };
  const healths = times.map((_, index) => columns.reduce<Health | null>((worst, column) => worse(worst, healthOf(column[index], limits)), null));
  return { healths, episodes: findEpisodes(healths, times, RECOVERY_MS) };
}
