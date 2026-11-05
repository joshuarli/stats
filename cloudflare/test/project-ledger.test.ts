import { describe, expect, it } from "vitest";
import { Table } from "../src/client/columns";
import type { MetricHistory } from "../src/client/history";
import { buildLedger, monthlyOf, planBill, previousWindowOf, projectedBill, type CostLine, type LedgerHistories, type LedgerInput } from "../src/cost/ledger.ts";
import { tableView, type Cell } from "./support/history";

const H = 3_600_000;
const T0 = 100 * H;
const MONTH_FACTOR = (30 * 24) / 2;
const WINDOW = { fromMs: T0, toMs: T0 + 2 * H };

function history(kind: MetricHistory["kind"], fromMs: number, columns: Record<string, Cell[]>): MetricHistory {
  const rows = Object.values(columns)[0]?.length ?? 0;
  return { projectId: "p", kind, fromMs, toMs: fromMs + rows * H, stepMs: H, table: Table.from(tableView(rows, columns), Array.from({ length: rows }, (_, index) => fromMs + index * H)) };
}

function histories(fromMs: number, parts: Partial<Record<keyof LedgerHistories, Record<string, Cell[]>>>): LedgerHistories {
  return {
    worker: history("worker", fromMs, parts.worker ?? { "worker.invocations": [0, 0, 0], "worker.cpuMsSum": [0, 0, 0] }),
    routes: history("routes", fromMs, parts.routes ?? {}),
    r2: history("r2", fromMs, parts.r2 ?? {}),
    durableObjects: parts.durableObjects === undefined ? undefined : history("durable-objects", fromMs, parts.durableObjects),
    d1: parts.d1 === undefined ? undefined : history("d1", fromMs, parts.d1),
    d1Statements: parts.d1Statements === undefined ? undefined : history("d1-statements", fromMs, parts.d1Statements)
  };
}

function input(current: LedgerHistories, previous: LedgerHistories | undefined, extra: Partial<LedgerInput> = {}): LedgerInput {
  return { current, previous, window: WINDOW, previousWindow: previousWindowOf(WINDOW), buckets: [], databases: [], objectMethods: undefined, ...extra };
}

const line = (lines: readonly CostLine[], id: string) => lines.find(entry => entry.id === id)!;
const now = (entry: CostLine) => monthlyOf(entry)!.now;

describe("project cost ledger", () => {
  it("projects Worker requests and CPU from the window to a month and splits them by route", () => {
    const current = histories(T0, {
      worker: { "worker.invocations": [1_000_000, 1_000_000, 9e9], "worker.cpuMsSum": [5_000_000, 5_000_000, 9e9] },
      routes: { "route.GET /a.invocations": [600_000, 600_000, 1], "route.GET /a.cpuMsSum": [4_000_000, 4_000_000, 1], "route.POST /b.invocations": [300_000, 300_000, 1], "route.POST /b.cpuMsSum": [500_000, 500_000, 1] }
    });
    const previous = histories(T0 - 2 * H, {
      worker: { "worker.invocations": [500_000, 500_000], "worker.cpuMsSum": [1_000_000, 1_000_000] },
      routes: { "route.POST /b.invocations": [1, 1], "route.POST /b.cpuMsSum": [1, 1] }
    });
    const ledger = buildLedger(input(current, previous));
    const worker = line(ledger.lines, "worker");
    expect(now(worker)).toBeCloseTo((2 * 0.3 + 10 * 0.02) * MONTH_FACTOR, 6);
    expect(monthlyOf(worker)!.before).toBeCloseTo((1 * 0.3 + 2 * 0.02) * MONTH_FACTOR, 6);
    expect(worker.children.map(child => child.label)).toEqual(["GET /a", "POST /b", "not attributed to a route"]);
    expect(now(line(worker.children, "route:GET /a"))).toBeCloseTo((1.2 * 0.3 + 8 * 0.02) * MONTH_FACTOR, 6);
    const routed = worker.children.reduce((sum, child) => sum + now(child), 0);
    expect(routed).toBeCloseTo(now(worker), 6);
    expect(monthlyOf(line(worker.children, "route:GET /a"))!.before).toBeNull();
  });

  it("leaves the change unknown when the previous window could not be read", () => {
    const ledger = buildLedger(input(histories(T0, { worker: { "worker.invocations": [10, 10, 0], "worker.cpuMsSum": [1, 1, 0] } }), undefined));
    expect(ledger.monthly.before).toBeNull();
    expect(monthlyOf(line(ledger.lines, "worker"))!.before).toBeNull();
  });

  it("projects from the covered part of a window, so a collector gap is not read as savings", () => {
    const ledger = buildLedger(input(histories(T0, { worker: { "worker.invocations": [1_000_000, null, 0], "worker.cpuMsSum": [0, null, 0] } }), undefined));
    expect(now(line(ledger.lines, "worker"))).toBeCloseTo(0.3 * 30 * 24, 6);
  });

  it("has no baseline when the previous window starts after the history's retention", () => {
    const previous = histories(T0 - H, { worker: { "worker.invocations": [5], "worker.cpuMsSum": [5] } });
    const ledger = buildLedger(input(histories(T0, { worker: { "worker.invocations": [10, 10, 0], "worker.cpuMsSum": [1, 1, 0] } }), previous));
    expect(monthlyOf(line(ledger.lines, "worker"))!.before).toBeNull();
  });

  it("prices Durable Object requests and an upper bound on duration, split by method, and names what is not collected", () => {
    const current = histories(T0, { durableObjects: { "do.invocations": [1_000_000, 1_000_000, 0], "do.wallMsSum": [1_000_000_000, 1_000_000_000, 0], "do.cpuMsSum": [1, 1, 0] } });
    const ledger = buildLedger(input(current, undefined, {
      objectMethods: {
        now: [
          { label: "Installation.ingest", requests: 300, failed: 0, cpuMs: 30, wallMs: 1000, p50WallMs: 3, p95WallMs: 9 },
          { label: "Installation GET /hosts", requests: 100, failed: 1, cpuMs: 90, wallMs: 3000, p50WallMs: 30, p95WallMs: 80 }
        ],
        before: null
      }
    }));
    const objects = line(ledger.lines, "objects");
    const requests = 2 * 0.15 * MONTH_FACTOR;
    const duration = 2_000_000 * 0.128 * 12.5 / 1_000_000 * MONTH_FACTOR;
    expect(now(objects)).toBeCloseTo(requests + duration, 6);
    expect(objects.price.kind === "priced" && objects.price.bound).toBe("upper");
    expect(now(line(objects.children, "object:Installation GET /hosts"))).toBeCloseTo(requests * 0.25 + duration * 0.75, 6);
    expect(objects.children.filter(child => child.kind === "object-method").reduce((sum, child) => sum + now(child), 0)).toBeCloseTo(now(objects), 6);
    expect(objects.children.at(-1)!).toMatchObject({ label: "SQLite rows and storage", price: { kind: "uncollected", cause: "no-source" } });
  });

  it("adds the object's self-reported SQLite storage to the Durable Object total and leaves only rows uncollected", () => {
    const calls = { "do.invocations": [1_000_000, 1_000_000, 0], "do.wallMsSum": [0, 0, 0], "do.cpuMsSum": [0, 0, 0] };
    const current = histories(T0, { durableObjects: { ...calls, "do.storageBytes": [4e9, null, 9e9] } });
    const previous = histories(T0 - 2 * H, { durableObjects: { "do.invocations": [0, 0], "do.wallMsSum": [0, 0], "do.cpuMsSum": [0, 0], "do.storageBytes": [1e9, 2e9] } });
    const objects = line(buildLedger(input(current, previous)).lines, "objects");
    const requests = 2 * 0.15 * MONTH_FACTOR;
    expect(monthlyOf(line(objects.children, "object:storage"))).toEqual({ now: 4 * 0.2, before: 2 * 0.2 });
    expect(now(objects)).toBeCloseTo(requests + 4 * 0.2, 6);
    expect(monthlyOf(objects)!.before).toBeCloseTo(2 * 0.2, 6);
    expect(objects.parts.map(part => part.label)).toEqual(["requests", "duration", "storage"]);
    expect(objects.children.map(child => child.label)).toEqual(["SQLite storage", "SQLite rows"]);
    expect(objects.children.at(-1)!.price).toEqual({ kind: "uncollected", cause: "no-source" });
  });

  it("prices stored bytes at the end of each window as a monthly rate", () => {
    const current = histories(T0, { r2: { "r2.media.storageBytes": [2e9, 3e9, 4e9] } });
    const previous = histories(T0 - 2 * H, { r2: { "r2.media.storageBytes": [1e9, 1.5e9] } });
    const ledger = buildLedger(input(current, previous, { buckets: ["media"] }));
    const r2 = line(ledger.lines, "r2");
    expect(monthlyOf(r2)).toEqual({ now: 3 * 0.015, before: 1.5 * 0.015 });
    expect(r2.children.map(child => child.id)).toEqual(["bucket:media"]);
  });

  it("splits D1 rows by statement, keeps the unattributed remainder, and adds storage", () => {
    const database = "9870c4da-3758-4f0c-ab6d-2372eb34009b";
    const current = histories(T0, {
      d1: { "d1.rowsRead": [1_000_000, 0, 0], "d1.rowsWritten": [1_000_000, 0, 0], "d1.queries": [10, 0, 0], [`d1.${database}.storageBytes`]: [10e9, 10e9, 10e9] },
      d1Statements: { "d1q.INSERT x.queries": [5, 0, 0], "d1q.INSERT x.rowsRead": [0, 0, 0], "d1q.INSERT x.rowsWritten": [500_000, 0, 0] }
    });
    const ledger = buildLedger(input(current, undefined, { databases: [database] }));
    const d1 = line(ledger.lines, "d1");
    expect(d1.children.map(child => child.kind)).toEqual(["statement", "d1-storage", "unrouted"]);
    expect(now(line(d1.children, "statement:INSERT x"))).toBeCloseTo(0.5 * MONTH_FACTOR, 6);
    expect(now(line(d1.children, `d1-storage:${database}`))).toBeCloseTo(10 * 0.75, 6);
    expect(now(d1)).toBeCloseTo((0.001 + 1) * MONTH_FACTOR + 7.5, 6);
  });

  it("shows a component without data as missing, and compares the total only over lines with a baseline", () => {
    const current = histories(T0, {
      worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [0, 0, 0] },
      d1: { "d1.rowsRead": [null, null, null], "d1.rowsWritten": [null, null, null], "d1.queries": [null, null, null] }
    });
    const previous = histories(T0 - 2 * H, { worker: { "worker.invocations": [500_000, 500_000], "worker.cpuMsSum": [0, 0] } });
    const ledger = buildLedger(input(current, previous, { databases: ["9870c4da-3758-4f0c-ab6d-2372eb34009b"] }));
    expect(line(ledger.lines, "d1").price).toEqual({ kind: "uncollected", cause: "no-data" });
    expect(ledger.monthly.now - ledger.monthly.before!).toBeCloseTo(0.3 * MONTH_FACTOR, 6);
    expect(ledger.uncompared).toEqual([]);
  });

  it("orders components by cost and totals them", () => {
    const current = histories(T0, { worker: { "worker.invocations": [1, 1, 0], "worker.cpuMsSum": [0, 0, 0] }, r2: { "r2.media.storageBytes": [100e9, 100e9, 100e9] } });
    const ledger = buildLedger(input(current, undefined, { buckets: ["media"] }));
    expect(ledger.lines.map(entry => entry.id)).toEqual(["r2", "worker"]);
    expect(ledger.monthly.now).toBeCloseTo(ledger.lines.reduce((sum, entry) => sum + now(entry), 0), 9);
  });

  it("bills only usage beyond the Workers Paid allowances, bucket by bucket inside the window", () => {
    const database = "9870c4da-3758-4f0c-ab6d-2372eb34009b";
    const current = histories(T0, {
      worker: { "worker.invocations": [6_000_000, 6_000_000, 9e9], "worker.cpuMsSum": [0, 0, 9e9] },
      d1: { "d1.rowsRead": [0, 0, 9e9], "d1.rowsWritten": [1_000_000, 0, 9e9], "d1.queries": [1, 0, 9e9], [`d1.${database}.storageBytes`]: [10e9, 10e9, 10e9] }
    });
    const bill = planBill(current, WINDOW, [], [database]);
    expect(bill.billed.times).toEqual([T0, T0 + H, T0 + 2 * H]);
    expect(bill.billed.values[1]).toBe(0);
    expect(bill.billed.values[2]).toBeCloseTo(2 * 0.3, 9);
    expect(bill.usage.workerRequests).toBe(12_000_000);
    expect(bill.usage.d1RowsWritten).toBe(1_000_000);
    expect(bill.usage.d1Storage).toBeCloseTo((10 * 2) / (30 * 24), 9);
  });

  it("projects each meter at its monthly rate and bills it only once it passes its allowance", () => {
    const usage = { workerRequests: 9_000_000, workerCpuMs: 0, durableObjectRequests: 0, durableObjectGbSeconds: 0, d1RowsWritten: 0, d1RowsRead: 0, r2Storage: 0, d1Storage: 0, durableObjectStorage: 0 };
    const monthly = { ...usage, workerRequests: 30_000_000 };
    const halfMonth = 15 * 24 * H;
    const projected = projectedBill({ billed: { times: [T0], values: [0] }, usage }, T0, T0 + halfMonth, monthly);
    expect(projected.times[0]).toBe(T0);
    expect(projected.times.at(-1)).toBe(T0 + halfMonth);
    expect(projected.values[0]).toBe(0);
    expect(projected.values[1]).toBe(0);
    expect(projected.values.at(-1)).toBeCloseTo((9 + 15 - 10) * 0.3, 9);
  });
});
