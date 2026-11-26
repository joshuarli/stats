import type { DatabaseSync } from "node:sqlite";

export interface CheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

export function configureSqlite(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 1000; PRAGMA locking_mode = EXCLUSIVE");
  const journal = db.prepare("PRAGMA journal_mode = WAL").get();
  if (journal?.["journal_mode"] !== "wal") throw new Error("SQLite could not enable WAL");
  db.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE; COMMIT");
}

export function checkpointSqlite(db: DatabaseSync): CheckpointResult {
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (row === undefined || typeof row["busy"] !== "number" || typeof row["log"] !== "number" || typeof row["checkpointed"] !== "number") throw new Error("SQLite checkpoint returned an invalid result");
  return { busy: row["busy"], log: row["log"], checkpointed: row["checkpointed"] };
}

export function scheduleCheckpoint(db: DatabaseSync, report?: (result: CheckpointResult) => void): () => void {
  const timer = setInterval(() => {
    try { const result = checkpointSqlite(db); report?.(result); }
    catch (error) { console.error(JSON.stringify({ event: "sqlite_checkpoint_failed", name: error instanceof Error ? error.name : typeof error })); }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
