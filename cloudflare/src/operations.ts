import { markInvocation, markOperation } from "./observe/cloudflare/mark.ts";
import type { OperationSummary } from "./observe/producer/channel.ts";
import { SqlAccount } from "./sql-account.ts";
import type { HostHistoryColumns } from "./history-frame.ts";
import type { HistoryKind } from "./limits.ts";
import type { ProjectHistory, ProjectKind } from "./projects/history.ts";

export const SYNTHETIC_HOST_NAME = "synthetic-check";

type Described<T> = T extends unknown ? Omit<T, "rows"> : never;
export type OperationDescription = Described<OperationSummary>;

export class OperationRun {
  readonly sql: SqlAccount;
  private describer: (() => OperationDescription) | null = null;
  private finished = false;

  constructor(storage: SqlStorage) {
    this.sql = new SqlAccount(storage);
  }

  describe(describer: () => OperationDescription): void {
    this.describer = describer;
  }

  finish(): void {
    if (this.finished) throw new Error("operation already published");
    this.finished = true;
    if (this.describer === null) markInvocation();
    else markOperation({ ...this.describer(), rows: this.sql.total() } as OperationSummary);
  }
}

export function isSyntheticHost(name: string): boolean {
  return name === SYNTHETIC_HOST_NAME;
}

export function rowsWrittenBy(sql: SqlAccount, query: string, ...bindings: unknown[]): number {
  const before = sql.total().written;
  sql.exec(query, ...bindings);
  return sql.total().written - before;
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
