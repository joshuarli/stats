import { DatabaseSync, type StatementSync } from "node:sqlite";
import { SqlMeter, type SqlDatabase, type SqlRows, type SqlScopes, type SqlValue } from "../core/sql.ts";

class Connection {
  readonly db: DatabaseSync;
  private readonly totalChanges: StatementSync;
  private depth = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.totalChanges = db.prepare("SELECT total_changes() AS changes");
  }

  changes(): number {
    return Number((this.totalChanges.get() as { changes: number | bigint }).changes);
  }

  transaction<T>(fn: () => T): T {
    const savepoint = `nested_${this.depth}`;
    this.db.exec(this.depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    let value: T;
    try {
      value = fn();
    } catch (error) {
      this.depth -= 1;
      this.db.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
    this.depth -= 1;
    this.db.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    return value;
  }

  bytes(): number {
    const pages = (this.db.prepare("PRAGMA page_count").get() as { page_count: number | bigint }).page_count;
    const size = (this.db.prepare("PRAGMA page_size").get() as { page_size: number | bigint }).page_size;
    return Number(pages) * Number(size);
  }
}

/**
 * node:sqlite reports no rows read, and counts table rows changed without index rows,
 * so `read` stays 0 and `written` is total_changes(). Neither is a billing figure.
 */
class NodeSql implements SqlDatabase {
  private readonly connection: Connection;
  private readonly meter = new SqlMeter();

  constructor(connection: Connection) {
    this.connection = connection;
  }

  rows<T>(query: string, ...params: SqlValue[]): T[] {
    const before = this.connection.changes();
    try {
      return this.connection.db.prepare(query).all(...params) as T[];
    } finally {
      this.meter.record(0, this.connection.changes() - before);
    }
  }

  each<T>(query: string, params: readonly SqlValue[], visit: (row: T) => void): void {
    const before = this.connection.changes();
    try {
      for (const row of this.connection.db.prepare(query).iterate(...params)) visit(row as T);
    } finally {
      this.meter.record(0, this.connection.changes() - before);
    }
  }

  run(query: string, ...params: SqlValue[]): void {
    const before = this.connection.changes();
    try {
      this.connection.db.prepare(query).run(...params);
    } finally {
      this.meter.record(0, this.connection.changes() - before);
    }
  }

  transaction<T>(fn: () => T): T {
    return this.connection.transaction(fn);
  }

  rowsWritten(): number {
    return this.meter.rowsWritten();
  }

  total(): SqlRows {
    return this.meter.total();
  }

  databaseBytes(): number {
    return this.connection.bytes();
  }
}

export function nodeSqlScopes(db: DatabaseSync): SqlScopes {
  const connection = new Connection(db);
  return { open: () => new NodeSql(connection) };
}
