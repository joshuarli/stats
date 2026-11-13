import type { OperationSummary } from "./observe/producer/channel.ts";
import type { SqlDatabase, SqlValue } from "./core/sql.ts";
import type { HostHistoryColumns } from "./history-frame.ts";
import type { HistoryKind } from "./limits.ts";
import type { ProjectHistory, ProjectKind } from "./projects/history.ts";

export const SYNTHETIC_HOST_NAME = "synthetic-check";

type Described<T> = T extends unknown ? Omit<T, "rows"> : never;
export type OperationDescription = Described<OperationSummary>;

export interface OperationSink {
  invocation(): void;
  operation(summary: OperationSummary): void;
}

export class OperationRun {
  readonly sql: SqlDatabase;
  private readonly sink: OperationSink;
  private describer: (() => OperationDescription) | null = null;
  private finished = false;
  private readonly now: (() => number) | undefined;
  private readonly startedAt: number | undefined;

  constructor(sql: SqlDatabase, sink: OperationSink, now?: () => number) {
    this.sql = sql;
    this.sink = sink;
    this.now = now;
    this.startedAt = now?.();
  }

  describe(describer: () => OperationDescription): void {
    this.describer = describer;
  }

  finish(): void {
    if (this.finished) throw new Error("operation already published");
    this.finished = true;
    if (this.describer === null) this.sink.invocation();
    else {
      const durationMs = this.now === undefined || this.startedAt === undefined ? undefined : Math.max(0, Math.round(this.now() - this.startedAt));
      this.sink.operation({ ...this.describer(), rows: this.sql.total(), ...(durationMs === undefined ? {} : { durationMs }) } as OperationSummary);
    }
  }
}

export function isSyntheticHost(name: string): boolean {
  return name === SYNTHETIC_HOST_NAME;
}

export function meteredWritesBy(sql: SqlDatabase, query: string, ...params: SqlValue[]): number {
  const before = sql.rowsWritten();
  sql.run(query, ...params);
  return sql.rowsWritten() - before;
}

export function affectedBy(sql: SqlDatabase, query: string, ...params: SqlValue[]): number {
  return sql.rows<{ one: number }>(`${query} RETURNING 1`, ...params).length;
}

export type HostHistoryResolution = "raw" | "1m" | "1h";
export type ProjectHistorySource = "samples" | "hours" | "runs";

export function hostHistoryClass(resolution: HostHistoryResolution, kinds: readonly HistoryKind[]): string {
  return `${resolution}:${kinds.length === 1 ? kinds[0] : "bundle"}`;
}

export function projectHistoryClass(source: ProjectHistorySource, kinds: readonly ProjectKind[]): string {
  return `${source}:${kinds.length === 1 ? kinds[0] : "bundle"}`;
}

export interface HistoryExtent {
  readonly points: number;
  readonly cells: number;
}

export function hostHistoryExtent(columns: readonly HostHistoryColumns[]): HistoryExtent {
  let points = 0;
  let cells = 0;
  for (const entry of columns) {
    for (const series of entry.series) {
      points += series.rows.rows;
      cells += series.rows.rows * series.rows.columns.length;
    }
  }
  return { points, cells };
}

const COLLECTOR_RUN_FIELDS = 5;

export function projectHistoryExtent(histories: readonly ProjectHistory[]): HistoryExtent {
  let points = 0;
  let cells = 0;
  for (const history of histories) {
    if (history.kind === "collector") {
      points += history.runs.length;
      cells += history.runs.length * COLLECTOR_RUN_FIELDS;
    } else {
      const rows = history.series[0]?.values.length ?? 0;
      points += rows;
      cells += rows * history.series.length;
    }
  }
  return { points, cells };
}
