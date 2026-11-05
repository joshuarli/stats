export interface SqlRows {
  readonly read: number;
  readonly written: number;
  readonly statements: number;
}

export class SqlAccount {
  private readonly storage: SqlStorage;
  private read = 0;
  private written = 0;
  private statements = 0;

  constructor(storage: SqlStorage) {
    this.storage = storage;
  }

  exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.storage.exec<T>(query, ...bindings);
    try {
      return cursor.toArray();
    } finally {
      this.settle(cursor);
    }
  }

  each<T extends Record<string, SqlStorageValue>>(query: string, bindings: readonly unknown[], visit: (row: T) => void): void {
    const cursor = this.storage.exec<T>(query, ...bindings);
    try {
      for (const row of cursor) visit(row);
    } finally {
      this.settle(cursor);
    }
  }

  total(): SqlRows {
    return { read: this.read, written: this.written, statements: this.statements };
  }

  private settle(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): void {
    this.read += cursor.rowsRead;
    this.written += cursor.rowsWritten;
    this.statements++;
  }
}
