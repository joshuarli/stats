import { mergeServiceRollups, serviceLevels, type RollupPayload, type ServiceRollup } from "../../aggregate.ts";
import { HOUR_MS, HOUR_RETENTION_MS, MINUTE_MS, MINUTE_RETENTION_MS } from "../../limits.ts";
import type { HostServiceResources, ResourceResolution, ResourceWindow } from "./service-resources-model.ts";

export const SERVICE_RESOURCE_POINTS = 360;

export function resourceWindow(params: URLSearchParams, now: number): ResourceWindow | null {
  if ([...params.keys()].some(key => key !== "fromMs" && key !== "toMs")) return null;
  const from = Number(params.get("fromMs"));
  const to = Number(params.get("toMs"));
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || params.getAll("fromMs").length !== 1 || params.getAll("toMs").length !== 1) return null;
  const toMs = Math.min(to, now);
  const fromMs = Math.max(from, now - HOUR_RETENTION_MS);
  if (fromMs >= toMs) return null;
  const resolution: ResourceResolution = fromMs >= now - MINUTE_RETENTION_MS && toMs - fromMs <= 2 * 86_400_000 ? "1m" : "1h";
  const unit = resolution === "1m" ? MINUTE_MS : HOUR_MS;
  const stepMs = Math.max(1, Math.ceil((toMs - fromMs) / SERVICE_RESOURCE_POINTS / unit)) * unit;
  const alignedFrom = Math.floor(fromMs / stepMs) * stepMs;
  return { fromMs: alignedFrom, toMs, stepMs, resolution };
}

export function hostServiceResources(hostId: string, window: ResourceWindow, rows: readonly { readonly bucketMs: number; readonly payload: RollupPayload }[]): HostServiceResources {
  const buckets = new Map<string, Map<number, ServiceRollup>>();
  for (const row of rows) {
    if (row.bucketMs < window.fromMs || row.bucketMs >= window.toMs) continue;
    const atMs = window.fromMs + Math.floor((row.bucketMs - window.fromMs) / window.stepMs) * window.stepMs;
    for (const [name, rollup] of Object.entries(row.payload.services ?? {})) {
      let series = buckets.get(name);
      if (series === undefined) buckets.set(name, series = new Map<number, ServiceRollup>());
      series.set(atMs, mergeServiceRollups(series.get(atMs), rollup));
    }
  }
  const times = Array.from({ length: Math.ceil((window.toMs - window.fromMs) / window.stepMs) }, (_, index) => window.fromMs + index * window.stepMs);
  const services = [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, series]) => ({
    name,
    points: times.map(atMs => {
      const rollup = series.get(atMs);
      const levels = rollup === undefined ? {} : serviceLevels({ services: { [name]: rollup } }, name, 1);
      return { atMs, cpuCores: levels.cpuCores ?? null, memoryBytes: levels.memoryBytes ?? null, ioBytesPerSec: levels.ioBytesPerSec ?? null };
    })
  }));
  return { hostId, ...window, services };
}
