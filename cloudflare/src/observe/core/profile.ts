import { RETENTION_MS } from "./limits.ts";
import { isFailedInvocation, type PreparedInvocation, type Stage } from "./model.ts";
import type { SqlStatements } from "../../core/sql.ts";

export const MAX_RETAINED_PROFILE_ROWS = 20_000;

export const PROFILE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS observe_profile (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    operation TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('worker', 'object')),
    failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
    cpu_ms INTEGER NOT NULL,
    wall_ms INTEGER NOT NULL,
    rows_read INTEGER NOT NULL,
    rows_written INTEGER NOT NULL,
    statements INTEGER NOT NULL,
    r2_class_a INTEGER NOT NULL,
    r2_class_b INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS observe_profile_time ON observe_profile (observed_at)"
];

export interface ProfilePercentiles {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly total: number;
}

export interface ProfileRowAccount {
  readonly read: number;
  readonly written: number;
  readonly statements: number;
}

export interface ProfileR2Account {
  readonly classA: number;
  readonly classB: number;
}

export interface ProfileOperation {
  readonly operation: string;
  readonly stage: Stage;
  readonly invocations: number;
  readonly failed: number;
  readonly cpuMs: ProfilePercentiles;
  readonly wallMs: ProfilePercentiles;
  readonly rows: ProfileRowAccount;
  readonly r2: ProfileR2Account | null;
}

export interface ProfileWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly operations: readonly ProfileOperation[];
}

function captured(invocation: PreparedInvocation): boolean {
  return invocation.serviceOperation !== undefined;
}

export function recordProfile(db: SqlStatements, invocations: readonly PreparedInvocation[], nowMs: number): void {
  const cutoff = nowMs - RETENTION_MS;
  for (const invocation of invocations) {
    if (!captured(invocation)) continue;
    if (invocation.eventAtMs <= cutoff) continue;
    const operation = invocation.serviceOperation!;
    const rows = operation.rows;
    db.run(
      "INSERT INTO observe_profile (observed_at, operation, stage, failed, cpu_ms, wall_ms, rows_read, rows_written, statements, r2_class_a, r2_class_b) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      Math.min(invocation.eventAtMs, nowMs), operation.name, invocation.stage, isFailedInvocation({ errorCount: invocation.errors.length, status: invocation.status, outcome: invocation.outcome }) ? 1 : 0, invocation.cpuMs, invocation.wallMs,
      rows?.read ?? 0, rows?.written ?? 0, rows?.statements ?? 0, operation.r2?.classA ?? 0, operation.r2?.classB ?? 0
    );
  }
}

interface ProfileRow {
  operation: string;
  stage: Stage;
  cpu_ms: number;
  wall_ms: number;
  failed: number;
  rows_read: number;
  rows_written: number;
  statements: number;
  r2_class_a: number;
  r2_class_b: number;
}

function nearestRank(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? null;
}

function percentiles(values: readonly number[]): ProfilePercentiles {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: nearestRank(sorted, 0.5), p95: nearestRank(sorted, 0.95), total: values.reduce((sum, value) => sum + value, 0) };
}

export function profileWindow(db: SqlStatements, fromMs: number, toMs: number): ProfileWindow {
  const rows = db.rows<ProfileRow>(
    `SELECT operation, stage, cpu_ms, wall_ms, failed, rows_read, rows_written, statements, r2_class_a, r2_class_b
     FROM observe_profile WHERE observed_at >= ? AND observed_at < ? ORDER BY operation, stage, observed_at`,
    fromMs, toMs
  );
  const groups = new Map<string, ProfileRow[]>();
  for (const row of rows) {
    const key = `${row.operation}\u0000${row.stage}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]); else group.push(row);
  }
  const operations = [...groups].map(([, group]): ProfileOperation => {
    const first = group[0]!;
    const r2 = group.some(row => row.r2_class_a > 0 || row.r2_class_b > 0)
      ? { classA: group.reduce((sum, row) => sum + row.r2_class_a, 0), classB: group.reduce((sum, row) => sum + row.r2_class_b, 0) }
      : null;
    return {
      operation: first.operation,
      stage: first.stage,
      invocations: group.length,
      failed: group.reduce((sum, row) => sum + row.failed, 0),
      cpuMs: percentiles(group.map(row => row.cpu_ms)),
      wallMs: percentiles(group.map(row => row.wall_ms)),
      rows: {
        read: group.reduce((sum, row) => sum + row.rows_read, 0),
        written: group.reduce((sum, row) => sum + row.rows_written, 0),
        statements: group.reduce((sum, row) => sum + row.statements, 0)
      },
      r2
    };
  }).sort((left, right) => right.cpuMs.total - left.cpuMs.total || left.operation.localeCompare(right.operation) || left.stage.localeCompare(right.stage));
  return { fromMs, toMs, operations };
}

export function cleanupProfile(db: SqlStatements, cutoff: number): number {
  db.run("DELETE FROM observe_profile WHERE observed_at <= ?", cutoff);
  const excess = db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_profile")[0]?.n ?? 0;
  const over = Math.max(0, excess - MAX_RETAINED_PROFILE_ROWS);
  if (over > 0) db.run("DELETE FROM observe_profile WHERE id IN (SELECT id FROM observe_profile ORDER BY observed_at LIMIT ?)", over);
  return over;
}
