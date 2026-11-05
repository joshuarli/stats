export type SqlValue = string | number | null;

export interface SqlRows {
  readonly read: number;
  readonly written: number;
  readonly statements: number;
}

export interface SqlDatabase {
  rows<T>(query: string, ...params: SqlValue[]): T[];
  each<T>(query: string, params: readonly SqlValue[], visit: (row: T) => void): void;
  run(query: string, ...params: SqlValue[]): void;
  transaction<T>(fn: () => T): T;
  rowsWritten(): number;
  total(): SqlRows;
  databaseBytes(): number;
}

export interface SqlScopes {
  open(): SqlDatabase;
}

export class SqlMeter {
  private read = 0;
  private written = 0;
  private statements = 0;

  record(read: number, written: number): void {
    this.read += read;
    this.written += written;
    this.statements++;
  }

  rowsWritten(): number {
    return this.written;
  }

  total(): SqlRows {
    return { read: this.read, written: this.written, statements: this.statements };
  }
}
