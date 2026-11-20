import { SERVICE_PROBE_NAME } from "../../deployments/service-compare.ts";
import { BUCKET_MS } from "../../projects/queries.ts";
import { HOUR_MS, HOUR_RETENTION_MS } from "../../limits.ts";
import type { SqlDatabase } from "../sql.ts";
import { serviceProbeOwner } from "./services.ts";
import type { HealthBar, ServiceHealthHistory } from "./service-health-model.ts";

export const HEALTH_BARS = 60;
const SAMPLE_RETENTION_MS = 7 * 24 * HOUR_MS;

export function healthWindow(params: URLSearchParams, now: number): { readonly fromMs: number; readonly toMs: number; readonly stepMs: number; readonly hourly: boolean } | null {
  if ([...params.keys()].some(key => key !== "fromMs" && key !== "toMs")) return null;
  if (params.getAll("fromMs").length !== 1 || params.getAll("toMs").length !== 1) return null;
  const from = Number(params.get("fromMs"));
  const to = Number(params.get("toMs"));
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
  const toMs = Math.min(to, now);
  const fromMs = Math.max(from, now - HOUR_RETENTION_MS);
  if (fromMs >= toMs) return null;
  const hourly = fromMs < now - SAMPLE_RETENTION_MS;
  const unit = hourly ? HOUR_MS : BUCKET_MS;
  let stepMs = Math.max(1, Math.ceil((toMs - fromMs) / HEALTH_BARS / unit)) * unit;
  while (Math.ceil((toMs - Math.floor(fromMs / stepMs) * stepMs) / stepMs) > HEALTH_BARS) stepMs += unit;
  return { fromMs: Math.floor(fromMs / stepMs) * stepMs, toMs, stepMs, hourly };
}

export function serviceHealthHistory(sql: SqlDatabase, name: string, window: NonNullable<ReturnType<typeof healthWindow>>): ServiceHealthHistory {
  const table = window.hourly ? "project_hours" : "project_samples";
  const column = window.hourly ? "hour_ms" : "bucket_ms";
  const rows = sql.rows<{ metric: string; at_ms: number; value: number }>(
    `SELECT metric, ${column} AS at_ms, value FROM ${table} WHERE project = ? AND metric IN (?, ?) AND ${column} >= ? AND ${column} < ?`,
    serviceProbeOwner(name), `probe.${SERVICE_PROBE_NAME}.up`, `probe.${SERVICE_PROBE_NAME}.ms`, window.fromMs, window.toMs
  );
  const bars = Array.from({ length: Math.ceil((window.toMs - window.fromMs) / window.stepMs) }, (_, index) => ({ atMs: window.fromMs + index * window.stepMs, probes: 0, up: 0, msSum: 0, msCount: 0 }));
  for (const row of rows) {
    const bar = bars[Math.floor((row.at_ms - window.fromMs) / window.stepMs)];
    if (bar === undefined) continue;
    if (row.metric.endsWith(".up")) {
      bar.probes += 1;
      if (row.value > 0) bar.up += 1;
    } else {
      bar.msSum += row.value;
      bar.msCount += 1;
    }
  }
  const result: HealthBar[] = bars.map(bar => ({ atMs: bar.atMs, probes: bar.probes, up: bar.up, meanMs: bar.msCount === 0 ? null : bar.msSum / bar.msCount }));
  return { service: name, fromMs: window.fromMs, toMs: window.toMs, stepMs: window.stepMs, bars: result };
}
