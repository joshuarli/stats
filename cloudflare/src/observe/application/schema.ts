import type { SnapshotPolicy } from "../../core/export/snapshot.ts";
import type { SqlStatements } from "../../core/sql.ts";

export const APPLICATION_ROLLUP_TABLE = "observe_application_rollups";
export const APPLICATION_SUMMARY_TABLE = "observe_application_projection";
export const APPLICATION_SNAPSHOT_POLICY: SnapshotPolicy = { derivedTables: new Set([APPLICATION_SUMMARY_TABLE, APPLICATION_ROLLUP_TABLE]) };
const APPLICATION_SUMMARY_INDEX = "observe_external_events_covering";
const FIELDS = [
  ["json_extract(payload, '$.operation')", "operation"],
  ["json_extract(payload, '$.outcome')", "outcome"],
  ["json_extract(payload, '$.durationMs')", "duration_ms"],
  ["CASE WHEN json_type(payload, '$.work.http_status') = 'integer' AND json_extract(payload, '$.work.http_status') BETWEEN 100 AND 599 THEN json_extract(payload, '$.work.http_status') END", "http_status"]
] as const;
// SQLite still seeks the WITHOUT ROWID table for expression-only indexes. Including payload makes this index covering.
export const APPLICATION_SUMMARY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${APPLICATION_SUMMARY_INDEX} ON observe_external_events (service, event_at, ${FIELDS.map(([expression]) => expression).join(", ")}, payload)`;

const COLUMNS = "service, event_at, event_id, operation, outcome, duration_ms, http_status";
const VALUES = ["service", "event_at", "event_id", ...FIELDS.map(([expression, name]) => name === "http_status" ? `COALESCE(${expression}, 0)` : expression)];

/** Must run within the canonical store's schema transaction. */
export function upgradeApplicationProjection(db: SqlStatements): void {
  if (db.rows("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", APPLICATION_SUMMARY_TABLE).length > 0) return;
  db.run(`CREATE TABLE ${APPLICATION_SUMMARY_TABLE} (
    service TEXT NOT NULL,
    event_at INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    operation TEXT,
    outcome TEXT,
    duration_ms INTEGER,
    http_status INTEGER NOT NULL,
    PRIMARY KEY (service, event_at, event_id)
  ) WITHOUT ROWID`);
  const insert = `INSERT INTO ${APPLICATION_SUMMARY_TABLE} (${COLUMNS}) VALUES (${VALUES.map(expression => expression.replace(/\b(service|event_at|event_id|payload)\b/gu, "NEW.$1")).join(", ")});`;
  const remove = `DELETE FROM ${APPLICATION_SUMMARY_TABLE} WHERE service = OLD.service AND event_at = OLD.event_at AND event_id = OLD.event_id;`;
  db.run(`CREATE TRIGGER observe_projection_insert AFTER INSERT ON observe_external_events BEGIN ${insert} END`);
  db.run(`CREATE TRIGGER observe_projection_delete AFTER DELETE ON observe_external_events BEGIN ${remove} END`);
  db.run(`CREATE TRIGGER observe_projection_update AFTER UPDATE ON observe_external_events BEGIN ${remove} ${insert} END`);
  db.run(`INSERT INTO ${APPLICATION_SUMMARY_TABLE} (${COLUMNS}) SELECT ${VALUES.join(", ")} FROM observe_external_events INDEXED BY ${APPLICATION_SUMMARY_INDEX}`);
}
