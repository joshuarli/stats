import type { SqlDatabase } from "../sql.ts";
import { PROJECT_STATEMENTS } from "../../projects/store.ts";
import { SERVICE_STATEMENTS } from "./services.ts";

const HOSTS = `CREATE TABLE IF NOT EXISTS hosts (
  host_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  last_received_at_ms INTEGER,
  window_start_ms INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0
) STRICT`;
const SAMPLES = `CREATE TABLE IF NOT EXISTS samples (
  host_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  seq TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  mono_ms INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  delta TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL,
  PRIMARY KEY (host_id, boot_id, seq)
) STRICT`;
const SAMPLE_TIME = "CREATE INDEX IF NOT EXISTS samples_by_time ON samples (host_id, at_ms)";
const SAMPLE_MONO = "CREATE INDEX IF NOT EXISTS samples_by_mono ON samples (host_id, boot_id, mono_ms)";
const ROLLUPS = `CREATE TABLE IF NOT EXISTS rollups (
  host_id TEXT NOT NULL,
  resolution TEXT NOT NULL,
  bucket_ms INTEGER NOT NULL,
  coverage_ms INTEGER NOT NULL,
  partial INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (host_id, resolution, bucket_ms)
) STRICT`;
const ROLLUP_TIME = "CREATE INDEX IF NOT EXISTS rollups_by_time ON rollups (host_id, resolution, bucket_ms)";
const SAMPLE_EXPIRY = "CREATE INDEX IF NOT EXISTS samples_by_received ON samples (received_at_ms)";
const ROLLUP_EXPIRY = "CREATE INDEX IF NOT EXISTS rollups_by_expiry ON rollups (resolution, bucket_ms)";
const HOST_SYSTEM = `CREATE TABLE IF NOT EXISTS host_system (
  host_id TEXT PRIMARY KEY,
  reported_at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT`;
const HOST_HISTORY_VERSIONS = `CREATE TABLE IF NOT EXISTS host_history_versions (
  host_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL
) STRICT`;
const ROLLUP_PENDING_HOURS = `CREATE TABLE IF NOT EXISTS rollup_pending_hours (
  host_id TEXT NOT NULL,
  hour_ms INTEGER NOT NULL,
  PRIMARY KEY (host_id, hour_ms)
) STRICT, WITHOUT ROWID`;
export const UPSERT_ROLLUP = `INSERT INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (host_id, resolution, bucket_ms) DO UPDATE SET coverage_ms = excluded.coverage_ms, partial = excluded.partial, payload = excluded.payload`;
const SCHEMA_VERSION = "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)";

const WEIGHTED_HISTORY_ENDS_MS = 1793565600000;
const WEIGHTED_METRICS = `(metric LIKE 'worker.%' AND metric <> 'worker.cpuMsMax') OR metric LIKE 'route.%' OR metric LIKE 'r2.%.ops.%' OR metric IN ('d1.queries', 'd1.rowsRead', 'd1.rowsWritten') OR metric LIKE 'd1q.%'`;
const PURGE_WEIGHTED_PROJECT_HISTORY: readonly string[] = [
  `DELETE FROM project_samples WHERE bucket_ms < ${WEIGHTED_HISTORY_ENDS_MS} AND (${WEIGHTED_METRICS})`,
  `DELETE FROM project_hours WHERE hour_ms < ${WEIGHTED_HISTORY_ENDS_MS} AND (${WEIGHTED_METRICS})`
];

const UNCORRECTED_RUNS_END_MS = 1793571049204;
const FORGET_UNCORRECTED_RUNS: readonly string[] = [
  `DELETE FROM collector_runs WHERE at_ms < ${UNCORRECTED_RUNS_END_MS}`
];

interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
  readonly apply?: (sql: SqlDatabase) => void;
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: [HOSTS, SAMPLES, SAMPLE_TIME, SAMPLE_MONO, ROLLUPS, ROLLUP_TIME] },
  { version: 2, statements: [SAMPLE_EXPIRY, ROLLUP_EXPIRY] },
  { version: 3, statements: [HOST_SYSTEM] },
  { version: 4, statements: PROJECT_STATEMENTS },
  { version: 5, statements: PURGE_WEIGHTED_PROJECT_HISTORY },
  { version: 6, statements: FORGET_UNCORRECTED_RUNS },
  { version: 7, statements: [HOST_HISTORY_VERSIONS, "INSERT OR IGNORE INTO host_history_versions (host_id, version) SELECT host_id, 0 FROM hosts"] },
  { version: 8, statements: SERVICE_STATEMENTS },
  {
    version: 9,
    statements: [],
    apply: sql => {
      if (!sql.rows<{ name: string }>("PRAGMA table_info(services)").some(column => column.name === "ingest_token_hash")) {
        sql.run("ALTER TABLE services ADD COLUMN ingest_token_hash TEXT");
      }
    }
  },
  { version: 10, statements: [ROLLUP_PENDING_HOURS] }
];

export function retentionDelayMs(deleted: { readonly raw: number; readonly minute: number; readonly hour: number; readonly project?: number; readonly pendingHours?: number }): number {
  return Math.max(deleted.raw, deleted.minute, deleted.hour, deleted.project ?? 0, deleted.pendingHours ?? 0) >= 1000 ? 60_000 : 600_000;
}

export function migrate(sql: SqlDatabase): void {
  sql.run(SCHEMA_VERSION);
  const row = sql.rows<{ version: number }>("SELECT version FROM schema_version LIMIT 1")[0];
  let current = row?.version ?? 0;
  let hasRow = row !== undefined;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    sql.transaction(() => {
      for (const statement of migration.statements) sql.run(statement);
      migration.apply?.(sql);
      if (hasRow) sql.run("UPDATE schema_version SET version = ?", migration.version);
      else sql.run("INSERT INTO schema_version (version) VALUES (?)", migration.version);
    });
    current = migration.version;
    hasRow = true;
  }
}
