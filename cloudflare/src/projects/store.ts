import { DAY_MS, HOUR_MS, HOUR_RETENTION_MS } from "../limits.ts";
import { aggregationOf, type MetricPoint } from "./parse.ts";

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
} & (
  | { readonly ok: true; readonly collected: readonly ProjectPoints[] }
  | { readonly ok: false }
);

export function upsertPoints(sql: SqlStorage, project: string, points: readonly MetricPoint[]): number {
  let written = 0;
  const changedHours = new Map<string, { metric: string; hourMs: number }>();
  for (const point of points) {
    const existing = sql
      .exec<{ value: number }>(
        "SELECT value FROM project_samples WHERE project = ? AND metric = ? AND bucket_ms = ?",
        project,
        point.metric,
        point.bucketMs,
      )
      .toArray()[0];
    if (existing !== undefined && existing.value === point.value) {
      continue;
    }
    written += sql.exec(
      "INSERT INTO project_samples (project, metric, bucket_ms, value) VALUES (?, ?, ?, ?) ON CONFLICT (project, metric, bucket_ms) DO UPDATE SET value = excluded.value",
      project,
      point.metric,
      point.bucketMs,
      point.value,
    ).rowsWritten;
    const hourMs = Math.floor(point.bucketMs / HOUR_MS) * HOUR_MS;
    changedHours.set(`${point.metric}\n${hourMs}`, { metric: point.metric, hourMs });
  }
  for (const { metric, hourMs } of changedHours.values()) {
    written += rebuildHour(sql, project, metric, hourMs);
  }
  return written;
}

function rebuildHour(sql: SqlStorage, project: string, metric: string, hourMs: number): number {
  const fold = aggregationOf(metric) === "sum" ? "SUM" : "MAX";
  const rebuilt = sql
    .exec<{ value: number }>(
      `SELECT ${fold}(value) AS value FROM project_samples WHERE project = ? AND metric = ? AND bucket_ms >= ? AND bucket_ms < ?`,
      project,
      metric,
      hourMs,
      hourMs + HOUR_MS,
    )
    .one().value;
  const existing = sql
    .exec<{ value: number }>(
      "SELECT value FROM project_hours WHERE project = ? AND metric = ? AND hour_ms = ?",
      project,
      metric,
      hourMs,
    )
    .toArray()[0];
  if (existing !== undefined && existing.value === rebuilt) {
    return 0;
  }
  return sql.exec(
    "INSERT INTO project_hours (project, metric, hour_ms, value) VALUES (?, ?, ?, ?) ON CONFLICT (project, metric, hour_ms) DO UPDATE SET value = excluded.value",
    project,
    metric,
    hourMs,
    rebuilt,
  ).rowsWritten;
}

export function recordRun(sql: SqlStorage, run: CollectorRun): number {
  let written = sql.exec(
    "INSERT INTO collector_runs (at_ms, ok, detail, rows_read, duration_ms) VALUES (?, ?, ?, ?, ?)",
    run.atMs,
    run.ok ? 1 : 0,
    run.detail,
    run.rowsRead,
    run.durationMs,
  ).rowsWritten;
  written += sql.exec(
    "DELETE FROM collector_runs WHERE id <= (SELECT MAX(id) FROM collector_runs) - ?",
    COLLECTOR_RUNS_KEPT,
  ).rowsWritten;
  return written;
}

export function purgeExpired(sql: SqlStorage, nowMs: number): { samples: number; hours: number } {
  const samples = sql.exec(
    `DELETE FROM project_samples WHERE (project, metric, bucket_ms) IN (
       SELECT project, metric, bucket_ms FROM project_samples WHERE bucket_ms < ? LIMIT ?)`,
    nowMs - PROJECT_SAMPLE_RETENTION_MS,
    PURGE_BATCH,
  ).rowsWritten;
  const hours = sql.exec(
    `DELETE FROM project_hours WHERE (project, metric, hour_ms) IN (
       SELECT project, metric, hour_ms FROM project_hours WHERE hour_ms < ? LIMIT ?)`,
    nowMs - PROJECT_HOUR_RETENTION_MS,
    PURGE_BATCH,
  ).rowsWritten;
  return { samples, hours };
}
