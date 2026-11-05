import { Table } from "../../src/client/columns.ts";
import type { MetricHistory } from "../../src/client/history.ts";
import type { LedgerHistories } from "../../src/cost/ledger.ts";
import { tableView, type Cell } from "../support/history.ts";

export const H = 3_600_000;

export function history(kind: MetricHistory["kind"], fromMs: number, columns: Record<string, Cell[]>): MetricHistory {
  const rows = Object.values(columns)[0]?.length ?? 0;
  return { projectId: "p", kind, fromMs, toMs: fromMs + rows * H, stepMs: H, table: Table.from(tableView(rows, columns), Array.from({ length: rows }, (_, index) => fromMs + index * H)) };
}

export function histories(fromMs: number, parts: Partial<Record<keyof LedgerHistories, Record<string, Cell[]>>>): LedgerHistories {
  return {
    worker: history("worker", fromMs, parts.worker ?? { "worker.invocations": [0, 0, 0], "worker.cpuMsSum": [0, 0, 0] }),
    routes: history("routes", fromMs, parts.routes ?? {}),
    r2: history("r2", fromMs, parts.r2 ?? {}),
    durableObjects: parts.durableObjects === undefined ? undefined : history("durable-objects", fromMs, parts.durableObjects),
    d1: parts.d1 === undefined ? undefined : history("d1", fromMs, parts.d1),
    d1Statements: parts.d1Statements === undefined ? undefined : history("d1-statements", fromMs, parts.d1Statements)
  };
}
