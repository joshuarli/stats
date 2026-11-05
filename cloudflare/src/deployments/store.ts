import { DEPLOYMENT_RETENTION_MS, type Deployment, type DeploymentSync, type VersionMetadata } from "./model.ts";
import type { DeploymentPoll } from "./collector.ts";
import type { SqlDatabase } from "../core/sql.ts";

export const DEPLOYMENT_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS project_deployment_coverage (
    project TEXT NOT NULL, worker TEXT NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL,
    PRIMARY KEY (project, worker, from_ms)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS project_deployments (
    project TEXT NOT NULL, worker TEXT NOT NULL, id TEXT NOT NULL,
    at_ms INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (project, worker, id)
  ) STRICT, WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS project_deployments_by_time ON project_deployments (project, worker, at_ms)",
  `CREATE TABLE IF NOT EXISTS project_deployment_versions (
    project TEXT NOT NULL, worker TEXT NOT NULL, id TEXT NOT NULL,
    fetched_at_ms INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (project, worker, id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS project_deployment_sync (
    project TEXT NOT NULL, worker TEXT NOT NULL, attempt_ms INTEGER NOT NULL,
    success_ms INTEGER, error TEXT, truncated INTEGER NOT NULL,
    PRIMARY KEY (project, worker)
  ) STRICT, WITHOUT ROWID`,
];

export function initializeDeployments(sql: SqlDatabase): void {
  sql.transaction(() => { for (const statement of DEPLOYMENT_STATEMENTS) sql.run(statement); });
}

export function readDeploymentSync(sql: SqlDatabase, project: string, worker: string): DeploymentSync | null {
  const row = sql.rows<{ attempt_ms: number; success_ms: number | null; error: string | null; truncated: number }>(
    "SELECT attempt_ms, success_ms, error, truncated FROM project_deployment_sync WHERE project = ? AND worker = ?", project, worker,
  )[0];
  return row === undefined ? null : { lastAttemptAtMs: row.attempt_ms, lastSuccessAtMs: row.success_ms, error: row.error, truncated: row.truncated !== 0 };
}

export function readDeployments(sql: SqlDatabase, project: string, worker: string, now: number): Deployment[] {
  return sql.rows<{ payload: string }>(
    "SELECT payload FROM project_deployments WHERE project = ? AND worker = ? AND at_ms >= ? ORDER BY at_ms DESC, id LIMIT 1000",
    project, worker, now - DEPLOYMENT_RETENTION_MS,
  ).map(row => JSON.parse(row.payload) as Deployment);
}

export function readVersions(sql: SqlDatabase, project: string, worker: string): VersionMetadata[] {
  return sql.rows<{ payload: string }>(
    "SELECT payload FROM project_deployment_versions WHERE project = ? AND worker = ? ORDER BY fetched_at_ms DESC LIMIT 2000", project, worker,
  ).map(row => JSON.parse(row.payload) as VersionMetadata);
}

export function saveDeploymentPoll(sql: SqlDatabase, poll: DeploymentPoll): void {
  sql.transaction(() => {
    const previous = readDeploymentSync(sql, poll.project, poll.worker);
    // A slow, older cron must not replace the status of a newer completed poll.
    if (previous !== null && previous.lastAttemptAtMs > poll.atMs) return;
    if (poll.error === null) {
      for (const deployment of poll.deployments) {
        const payload = JSON.stringify(deployment);
        sql.run(
          "INSERT INTO project_deployments (project, worker, id, at_ms, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, worker, id) DO UPDATE SET at_ms = excluded.at_ms, payload = excluded.payload WHERE payload <> excluded.payload",
          poll.project, poll.worker, deployment.id, deployment.atMs, payload,
        );
      }
      for (const version of poll.versions) sql.run(
        "INSERT INTO project_deployment_versions (project, worker, id, fetched_at_ms, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, worker, id) DO NOTHING",
        poll.project, poll.worker, version.id, poll.atMs, JSON.stringify(version),
      );
    }
    sql.run(
      "INSERT INTO project_deployment_sync (project, worker, attempt_ms, success_ms, error, truncated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project, worker) DO UPDATE SET attempt_ms = excluded.attempt_ms, success_ms = excluded.success_ms, error = excluded.error, truncated = excluded.truncated",
      poll.project, poll.worker, poll.atMs, poll.error === null ? poll.atMs : previous?.lastSuccessAtMs ?? null, poll.error,
      (poll.error === null ? poll.truncated : previous?.truncated ?? false) ? 1 : 0,
    );
    // Time and count bounds prevent unbounded retention on unusually busy projects.
    sql.run("DELETE FROM project_deployments WHERE project = ? AND worker = ? AND (at_ms < ? OR id IN (SELECT id FROM project_deployments WHERE project = ? AND worker = ? ORDER BY at_ms DESC, id LIMIT -1 OFFSET 1000))", poll.project, poll.worker, poll.atMs - DEPLOYMENT_RETENTION_MS, poll.project, poll.worker);
    sql.run("DELETE FROM project_deployment_versions WHERE project = ? AND worker = ? AND (fetched_at_ms < ? OR id IN (SELECT id FROM project_deployment_versions WHERE project = ? AND worker = ? ORDER BY fetched_at_ms DESC, id LIMIT -1 OFFSET 2000))", poll.project, poll.worker, poll.atMs - DEPLOYMENT_RETENTION_MS, poll.project, poll.worker);
  });
}

export function purgeDeployments(sql: SqlDatabase, now: number): void {
  const cutoff = Math.floor((now - 7 * 86_400_000) / 300_000) * 300_000;
  sql.run("DELETE FROM project_deployment_coverage WHERE to_ms <= ?", cutoff);
  sql.run("UPDATE project_deployment_coverage SET from_ms = ? WHERE from_ms < ?", cutoff, cutoff);
  sql.run("DELETE FROM project_deployments WHERE (project, worker, id) IN (SELECT project, worker, id FROM project_deployments WHERE at_ms < ? LIMIT 1000)", now - DEPLOYMENT_RETENTION_MS);
  sql.run("DELETE FROM project_deployment_versions WHERE (project, worker, id) IN (SELECT project, worker, id FROM project_deployment_versions WHERE fetched_at_ms < ? LIMIT 1000)", now - DEPLOYMENT_RETENTION_MS);
  sql.run("DELETE FROM project_deployment_sync WHERE attempt_ms < ?", now - DEPLOYMENT_RETENTION_MS);
}

/** Merge only genuinely covered intervals; an outage must leave a hole. */
export function rememberSettledWindow(sql: SqlDatabase, project: string, worker: string, fromMs: number, toMs: number): void {
  if (fromMs >= toMs) return;
  const overlap = sql.rows<{ from_ms: number | null; to_ms: number | null; count: number }>(
    "SELECT MIN(from_ms) AS from_ms, MAX(to_ms) AS to_ms, COUNT(*) AS count FROM project_deployment_coverage WHERE project = ? AND worker = ? AND to_ms >= ? AND from_ms <= ?", project, worker, fromMs, toMs,
  )[0]!;
  const from = Math.min(fromMs, overlap.from_ms ?? fromMs), to = Math.max(toMs, overlap.to_ms ?? toMs);
  if (overlap.count === 1 && overlap.from_ms === from && overlap.to_ms === to) return;
  sql.run("DELETE FROM project_deployment_coverage WHERE project = ? AND worker = ? AND to_ms >= ? AND from_ms <= ?", project, worker, fromMs, toMs);
  sql.run("INSERT INTO project_deployment_coverage (project, worker, from_ms, to_ms) VALUES (?, ?, ?, ?)", project, worker, from, to);
}

export function hasSettledWindow(sql: SqlDatabase, project: string, worker: string, fromMs: number, toMs: number): boolean {
  return sql.rows("SELECT 1 FROM project_deployment_coverage WHERE project = ? AND worker = ? AND from_ms <= ? AND to_ms >= ? LIMIT 1", project, worker, fromMs, toMs).length > 0;
}
