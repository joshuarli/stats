import { DAY_MS, HOUR_MS, HOUR_RETENTION_MS } from "../limits.ts";
import { aggregationOf, type MetricPoint } from "./metrics.ts";
import { BUCKET_MS } from "./queries.ts";
import { rowsWrittenBy } from "../operations.ts";
import type { SqlDatabase } from "../core/sql.ts";

export const PROJECT_SAMPLE_RETENTION_MS = 7 * DAY_MS;
export const PROJECT_HOUR_RETENTION_MS = HOUR_RETENTION_MS;
export const COLLECTOR_RUNS_KEPT = 500;
export const PURGE_BATCH = 1000;

const PROJECT_SAMPLES = `CREATE TABLE IF NOT EXISTS project_samples (
  project TEXT NOT NULL,
  metric TEXT NOT NULL,
  bucket_ms INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (project, metric, bucket_ms)
) STRICT, WITHOUT ROWID`;
const PROJECT_SAMPLES_EXPIRY = "CREATE INDEX IF NOT EXISTS project_samples_by_bucket ON project_samples (bucket_ms)";
const PROJECT_HOURS = `CREATE TABLE IF NOT EXISTS project_hours (
  project TEXT NOT NULL,
  metric TEXT NOT NULL,
  hour_ms INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (project, metric, hour_ms)
) STRICT, WITHOUT ROWID`;
const PROJECT_HOURS_EXPIRY = "CREATE INDEX IF NOT EXISTS project_hours_by_hour ON project_hours (hour_ms)";
const COLLECTOR_RUNS = `CREATE TABLE IF NOT EXISTS collector_runs (
  id INTEGER PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL,
  rows_read INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
) STRICT`;

export const PROJECT_STATEMENTS: readonly string[] = [
  PROJECT_SAMPLES,
  PROJECT_SAMPLES_EXPIRY,
  PROJECT_HOURS,
  PROJECT_HOURS_EXPIRY,
  COLLECTOR_RUNS,
];

export interface ProjectPoints {
  readonly project: string;
  readonly points: readonly MetricPoint[];
}

export type CollectorRun = {
  readonly atMs: number;
  readonly detail: string;
  readonly rowsRead: number;
  readonly durationMs: number;
  readonly upstreamQueries: number;
} & (
  | { readonly ok: true; readonly collected: readonly ProjectPoints[]; readonly storeOwners: readonly string[] }
  | { readonly ok: false }
);

export const STORE_SIZE_METRIC = "do.storageBytes";

export function collectedPoints(run: CollectorRun & { readonly ok: true }, storeSizeBytes: number): readonly ProjectPoints[] {
  const size: MetricPoint = { metric: STORE_SIZE_METRIC, bucketMs: Math.floor(run.atMs / BUCKET_MS) * BUCKET_MS, value: storeSizeBytes };
  return run.collected.map((entry) => (run.storeOwners.includes(entry.project) ? { project: entry.project, points: [...entry.points, size] } : entry));
}

export interface UpsertResult {
  readonly rowsWritten: number;
  readonly samples: number;
  readonly hours: number;
}

export function upsertPoints(sql: SqlDatabase, project: string, points: readonly MetricPoint[]): UpsertResult {
  let rowsWritten = 0;
  let samples = 0;
  let hours = 0;
  const changedHours = new Map<string, { metric: string; hourMs: number }>();
  const stored = storedValues(sql, project, points);
  for (const point of points) {
    if (stored.get(`${point.metric}\n${point.bucketMs}`) === point.value) {
      continue;
    }
    rowsWritten += rowsWrittenBy(
      sql,
      "INSERT INTO project_samples (project, metric, bucket_ms, value) VALUES (?, ?, ?, ?) ON CONFLICT (project, metric, bucket_ms) DO UPDATE SET value = excluded.value",
      project,
      point.metric,
      point.bucketMs,
      point.value,
    );
    samples += 1;
    const hourMs = Math.floor(point.bucketMs / HOUR_MS) * HOUR_MS;
    changedHours.set(`${point.metric}\n${hourMs}`, { metric: point.metric, hourMs });
  }
  const rebuilt = rebuildHours(sql, project, changedHours);
  rowsWritten += rebuilt.rowsWritten;
  hours += rebuilt.hours;
  return { rowsWritten, samples, hours };
}

function storedValues(sql: SqlDatabase, project: string, points: readonly MetricPoint[]): Map<string, number> {
  const stored = new Map<string, number>();
  if (points.length === 0) {
    return stored;
  }
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const point of points) {
    earliestMs = Math.min(earliestMs, point.bucketMs);
  }
  sql.each<{ metric: string; bucket_ms: number; value: number }>(
    "SELECT metric, bucket_ms, value FROM project_samples INDEXED BY project_samples_by_bucket WHERE project = ? AND bucket_ms >= ?",
    [project, earliestMs],
    (row) => stored.set(`${row.metric}\n${row.bucket_ms}`, row.value),
  );
  return stored;
}

function storedHours(sql: SqlDatabase, project: string, changed: Iterable<{ metric: string; hourMs: number }>): Map<string, number> {
  const stored = new Map<string, number>();
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const item of changed) {
    earliest = Math.min(earliest, item.hourMs);
    latest = Math.max(latest, item.hourMs);
  }
  if (!Number.isFinite(earliest)) return stored;
  sql.each<{ metric: string; hour_ms: number; value: number }>(
    "SELECT metric, hour_ms, value FROM project_hours INDEXED BY project_hours_by_hour WHERE project = ? AND hour_ms >= ? AND hour_ms <= ?",
    [project, earliest, latest],
    (row) => stored.set(`${row.metric}\n${row.hour_ms}`, row.value),
  );
  return stored;
}

function rebuildHours(
  sql: SqlDatabase,
  project: string,
  changedHours: Map<string, { metric: string; hourMs: number }>,
): { rowsWritten: number; hours: number } {
  if (changedHours.size === 0) return { rowsWritten: 0, hours: 0 };
  const existing = storedHours(sql, project, changedHours.values());
  const byFold = new Map<string, { metric: string; hourMs: number }[]>();
  for (const item of changedHours.values()) {
    const fold = { sum: "SUM", max: "MAX", min: "MIN" }[aggregationOf(item.metric)];
    let list = byFold.get(fold);
    if (list === undefined) {
      list = [];
      byFold.set(fold, list);
    }
    list.push(item);
  }

  let rowsWritten = 0;
  let hours = 0;
  for (const [fold, items] of byFold.entries()) {
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    const metrics = new Set<string>();
    for (const item of items) {
      earliest = Math.min(earliest, item.hourMs);
      latest = Math.max(latest, item.hourMs + HOUR_MS);
      metrics.add(item.metric);
    }
    const metricList = [...metrics];
    const placeholders = metricList.map(() => "?").join(", ");
    const rows = sql.rows<{ metric: string; hour_ms: number; value: number }>(
      `SELECT metric, (bucket_ms / ${HOUR_MS}) * ${HOUR_MS} AS hour_ms, ${fold}(value) AS value FROM project_samples WHERE project = ? AND bucket_ms >= ? AND bucket_ms < ? AND metric IN (${placeholders}) GROUP BY metric, hour_ms`,
      project,
      earliest,
      latest,
      ...metricList,
    );
    for (const row of rows) {
      const key = `${row.metric}\n${row.hour_ms}`;
      if (!changedHours.has(key)) continue;
      const current = existing.get(key);
      if (current === row.value) continue;
      rowsWritten += rowsWrittenBy(
        sql,
        "INSERT INTO project_hours (project, metric, hour_ms, value) VALUES (?, ?, ?, ?) ON CONFLICT (project, metric, hour_ms) DO UPDATE SET value = excluded.value",
        project,
        row.metric,
        row.hour_ms,
        row.value,
      );
      hours += 1;
    }
  }
  return { rowsWritten, hours };
}

export function recordRun(sql: SqlDatabase, run: CollectorRun): number {
  let written = rowsWrittenBy(
    sql,
    "INSERT INTO collector_runs (at_ms, ok, detail, rows_read, duration_ms) VALUES (?, ?, ?, ?, ?)",
    run.atMs,
    run.ok ? 1 : 0,
    run.detail,
    run.rowsRead,
    run.durationMs,
  );
  written += rowsWrittenBy(sql, "DELETE FROM collector_runs WHERE id <= (SELECT MAX(id) FROM collector_runs) - ?", COLLECTOR_RUNS_KEPT);
  return written;
}

export function purgeExpired(sql: SqlDatabase, nowMs: number): { samples: number; hours: number } {
  const samples = rowsWrittenBy(
    sql,
    `DELETE FROM project_samples WHERE (project, metric, bucket_ms) IN (
       SELECT project, metric, bucket_ms FROM project_samples WHERE bucket_ms < ? LIMIT ?)`,
    nowMs - PROJECT_SAMPLE_RETENTION_MS,
    PURGE_BATCH,
  );
  const hours = rowsWrittenBy(
    sql,
    `DELETE FROM project_hours WHERE (project, metric, hour_ms) IN (
       SELECT project, metric, hour_ms FROM project_hours WHERE hour_ms < ? LIMIT ?)`,
    nowMs - PROJECT_HOUR_RETENTION_MS,
    PURGE_BATCH,
  );
  return { samples, hours };
}
