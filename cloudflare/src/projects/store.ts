import { DAY_MS, HOUR_MS, HOUR_RETENTION_MS } from "../limits.ts";
import { aggregationOf, type MetricPoint } from "./parse.ts";
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
  for (const { metric, hourMs } of changedHours.values()) {
    const written = rebuildHour(sql, project, metric, hourMs);
    rowsWritten += written;
    if (written > 0) hours += 1;
  }
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

function rebuildHour(sql: SqlDatabase, project: string, metric: string, hourMs: number): number {
  const fold = { sum: "SUM", max: "MAX", min: "MIN" }[aggregationOf(metric)];
  const rebuilt = sql.rows<{ value: number }>(
    `SELECT ${fold}(value) AS value FROM project_samples WHERE project = ? AND metric = ? AND bucket_ms >= ? AND bucket_ms < ?`,
    project,
    metric,
    hourMs,
    hourMs + HOUR_MS,
  )[0]!.value;
  const existing = sql.rows<{ value: number }>(
    "SELECT value FROM project_hours WHERE project = ? AND metric = ? AND hour_ms = ?",
    project,
    metric,
    hourMs,
  )[0];
  if (existing !== undefined && existing.value === rebuilt) {
    return 0;
  }
  return rowsWrittenBy(
    sql,
    "INSERT INTO project_hours (project, metric, hour_ms, value) VALUES (?, ?, ?, ?) ON CONFLICT (project, metric, hour_ms) DO UPDATE SET value = excluded.value",
    project,
    metric,
    hourMs,
    rebuilt,
  );
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
