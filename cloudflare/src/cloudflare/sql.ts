import { SqlMeter, type SqlDatabase, type SqlRows, type SqlScopes, type SqlValue } from "../core/sql.ts";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

export class CloudflareSql implements SqlDatabase {
  private readonly storage: Storage;
  private readonly meter = new SqlMeter();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  rows<T>(query: string, ...params: SqlValue[]): T[] {
    const cursor = this.storage.sql.exec(query, ...params);
    try {
      return cursor.toArray() as T[];
    } finally {
      this.meter.record(cursor.rowsRead, cursor.rowsWritten);
    }
  }

  each<T>(query: string, params: readonly SqlValue[], visit: (row: T) => void): void {
    const cursor = this.storage.sql.exec(query, ...params);
    try {
      for (const row of cursor) visit(row as T);
    } finally {
      this.meter.record(cursor.rowsRead, cursor.rowsWritten);
    }
  }

  run(query: string, ...params: SqlValue[]): void {
    const cursor = this.storage.sql.exec(query, ...params);
    try {
      cursor.toArray();
    } finally {
      this.meter.record(cursor.rowsRead, cursor.rowsWritten);
    }
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  rowsWritten(): number {
    return this.meter.rowsWritten();
  }

  total(): SqlRows {
    return this.meter.total();
  }

  databaseBytes(): number {
    return this.storage.sql.databaseSize;
  }
}

export function cloudflareSqlScopes(storage: Storage): SqlScopes {
  return { open: () => new CloudflareSql(storage) };
}
