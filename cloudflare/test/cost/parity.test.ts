import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Table } from "../../src/client/columns.ts";
import type { MetricHistory } from "../../src/client/history.ts";
import { buildLedger, monthlyOf, monthlyUsage, planBill, previousWindowOf, projectedBill, type CostLine, type LedgerHistories, type LedgerInput } from "../../src/cost/ledger.ts";
import { tableView, type Cell } from "../support/history.ts";
import { H, histories } from "./support.ts";

const T0 = 100 * H;
const MONTH_FACTOR = (30 * 24) / 2;
const WINDOW = { fromMs: T0, toMs: T0 + 2 * H };

function input(current: LedgerHistories, previous: LedgerHistories | undefined, extra: Partial<LedgerInput> = {}): LedgerInput {
  return { current, previous, window: WINDOW, previousWindow: previousWindowOf(WINDOW), buckets: [], databases: [], objectMethods: undefined, ...extra };
}

const line = (lines: readonly CostLine[], id: string) => lines.find(entry => entry.id === id)!;
const now = (entry: CostLine) => monthlyOf(entry)!.now;
const near = (actual: number, expected: number, digits = 6) => assert.ok(Math.abs(actual - expected) < 10 ** -digits / 2, `${actual} is not within 1e-${digits} of ${expected}`);

await test("projects Worker requests and CPU from the window to a month and splits them by route", () => {
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
  near(now(worker), (2 * 0.3 + 10 * 0.02) * MONTH_FACTOR);
  near(monthlyOf(worker)!.before!, (1 * 0.3 + 2 * 0.02) * MONTH_FACTOR);
  assert.deepEqual(worker.children.map(child => child.label), ["GET /a", "POST /b", "not attributed to a route"]);
  near(now(line(worker.children, "route:GET /a")), (1.2 * 0.3 + 8 * 0.02) * MONTH_FACTOR);
  near(worker.children.reduce((sum, child) => sum + now(child), 0), now(worker));
  assert.equal(monthlyOf(line(worker.children, "route:GET /a"))!.before, null);
});

await test("leaves the change unknown when the previous window could not be read", () => {
  const ledger = buildLedger(input(histories(T0, { worker: { "worker.invocations": [10, 10, 0], "worker.cpuMsSum": [1, 1, 0] } }), undefined));
  assert.equal(ledger.monthly.before, null);
  assert.equal(monthlyOf(line(ledger.lines, "worker"))!.before, null);
});

await test("projects from the covered part of a window, so a collector gap is not read as savings", () => {
  const ledger = buildLedger(input(histories(T0, { worker: { "worker.invocations": [1_000_000, null, 0], "worker.cpuMsSum": [0, null, 0] } }), undefined));
  near(now(line(ledger.lines, "worker")), 0.3 * 30 * 24);
});

await test("has no baseline when the previous window starts after the history's retention", () => {
  const previous = histories(T0 - H, { worker: { "worker.invocations": [5], "worker.cpuMsSum": [5] } });
  const ledger = buildLedger(input(histories(T0, { worker: { "worker.invocations": [10, 10, 0], "worker.cpuMsSum": [1, 1, 0] } }), previous));
  assert.equal(monthlyOf(line(ledger.lines, "worker"))!.before, null);
});

await test("prices Durable Object requests and an upper bound on duration, split by method, and names what is not collected", () => {
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
  near(now(objects), requests + duration);
  assert.equal(objects.price.kind === "priced" && objects.price.bound, "upper");
  near(now(line(objects.children, "object:Installation GET /hosts")), requests * 0.25 + duration * 0.75);
  near(objects.children.filter(child => child.kind === "object-method").reduce((sum, child) => sum + now(child), 0), now(objects));
  assert.partialDeepStrictEqual(objects.children.at(-1)!, { label: "SQLite rows and storage", price: { kind: "uncollected", cause: "no-source" } });
});

await test("adds the object's self-reported SQLite storage to the Durable Object total and leaves only rows uncollected", () => {
  const calls = { "do.invocations": [1_000_000, 1_000_000, 0], "do.wallMsSum": [0, 0, 0], "do.cpuMsSum": [0, 0, 0] };
  const current = histories(T0, { durableObjects: { ...calls, "do.storageBytes": [4e9, null, 9e9] } });
  const previous = histories(T0 - 2 * H, { durableObjects: { "do.invocations": [0, 0], "do.wallMsSum": [0, 0], "do.cpuMsSum": [0, 0], "do.storageBytes": [1e9, 2e9] } });
  const objects = line(buildLedger(input(current, previous)).lines, "objects");
  const requests = 2 * 0.15 * MONTH_FACTOR;
  assert.deepEqual(monthlyOf(line(objects.children, "object:storage")), { now: 4 * 0.2, before: 2 * 0.2 });
  near(now(objects), requests + 4 * 0.2);
  near(monthlyOf(objects)!.before!, 2 * 0.2);
  assert.deepEqual(objects.parts.map(part => part.label), ["requests", "duration", "storage"]);
  assert.deepEqual(objects.children.map(child => child.label), ["SQLite storage", "SQLite rows"]);
  assert.deepEqual(objects.children.at(-1)!.price, { kind: "uncollected", cause: "no-source" });
});

await test("prices stored bytes at the end of each window as a monthly rate", () => {
  const current = histories(T0, { r2: { "r2.media.storageBytes": [2e9, 3e9, 4e9] } });
  const previous = histories(T0 - 2 * H, { r2: { "r2.media.storageBytes": [1e9, 1.5e9] } });
  const ledger = buildLedger(input(current, previous, { buckets: ["media"] }));
  const r2 = line(ledger.lines, "r2");
  assert.deepEqual(monthlyOf(r2), { now: 3 * 0.015, before: 1.5 * 0.015 });
  assert.deepEqual(r2.children.map(child => child.id), ["bucket:media"]);
});

await test("splits D1 rows by statement, keeps the unattributed remainder, and adds storage", () => {
  const database = "9870c4da-3758-4f0c-ab6d-2372eb34009b";
  const current = histories(T0, {
    d1: { "d1.rowsRead": [1_000_000, 0, 0], "d1.rowsWritten": [1_000_000, 0, 0], "d1.queries": [10, 0, 0], [`d1.${database}.storageBytes`]: [10e9, 10e9, 10e9] },
    d1Statements: { "d1q.INSERT x.queries": [5, 0, 0], "d1q.INSERT x.rowsRead": [0, 0, 0], "d1q.INSERT x.rowsWritten": [500_000, 0, 0] }
  });
  const ledger = buildLedger(input(current, undefined, { databases: [database] }));
  const d1 = line(ledger.lines, "d1");
  assert.deepEqual(d1.children.map(child => child.kind), ["statement", "d1-storage", "unrouted"]);
  near(now(line(d1.children, "statement:INSERT x")), 0.5 * MONTH_FACTOR);
  near(now(line(d1.children, `d1-storage:${database}`)), 10 * 0.75);
  near(now(d1), (0.001 + 1) * MONTH_FACTOR + 7.5);
});

await test("shows a component without data as missing, and compares the total only over lines with a baseline", () => {
  const current = histories(T0, {
    worker: { "worker.invocations": [1_000_000, 1_000_000, 0], "worker.cpuMsSum": [0, 0, 0] },
    d1: { "d1.rowsRead": [null, null, null], "d1.rowsWritten": [null, null, null], "d1.queries": [null, null, null] }
  });
  const previous = histories(T0 - 2 * H, { worker: { "worker.invocations": [500_000, 500_000], "worker.cpuMsSum": [0, 0] } });
  const ledger = buildLedger(input(current, previous, { databases: ["9870c4da-3758-4f0c-ab6d-2372eb34009b"] }));
  assert.deepEqual(line(ledger.lines, "d1").price, { kind: "uncollected", cause: "no-data" });
  near(ledger.monthly.now - ledger.monthly.before!, 0.3 * MONTH_FACTOR);
  assert.deepEqual(ledger.uncompared, []);
});

await test("orders components by cost and totals them", () => {
  const current = histories(T0, { worker: { "worker.invocations": [1, 1, 0], "worker.cpuMsSum": [0, 0, 0] }, r2: { "r2.media.storageBytes": [100e9, 100e9, 100e9] } });
  const ledger = buildLedger(input(current, undefined, { buckets: ["media"] }));
  assert.deepEqual(ledger.lines.map(entry => entry.id), ["r2", "worker"]);
  near(ledger.monthly.now, ledger.lines.reduce((sum, entry) => sum + now(entry), 0), 9);
});

await test("bills only usage beyond the Workers Paid allowances, bucket by bucket inside the window", () => {
  const database = "9870c4da-3758-4f0c-ab6d-2372eb34009b";
  const current = histories(T0, {
    worker: { "worker.invocations": [6_000_000, 6_000_000, 9e9], "worker.cpuMsSum": [0, 0, 9e9] },
    d1: { "d1.rowsRead": [0, 0, 9e9], "d1.rowsWritten": [1_000_000, 0, 9e9], "d1.queries": [1, 0, 9e9], [`d1.${database}.storageBytes`]: [10e9, 10e9, 10e9] }
  });
  const bill = planBill(current, WINDOW, [], [database]);
  assert.deepEqual(bill.billed.times, [T0, T0 + H, T0 + 2 * H]);
  assert.equal(bill.billed.values[1], 0);
  near(bill.billed.values[2]!, 2 * 0.3, 9);
  assert.equal(bill.usage.workerRequests, 12_000_000);
  assert.equal(bill.usage.d1RowsWritten, 1_000_000);
  near(bill.usage.d1Storage, (10 * 2) / (30 * 24), 9);
});

await test("projects each meter at its monthly rate and bills it only once it passes its allowance", () => {
  const usage = { workerRequests: 9_000_000, workerCpuMs: 0, durableObjectRequests: 0, durableObjectGbSeconds: 0, d1RowsWritten: 0, d1RowsRead: 0, r2Storage: 0, d1Storage: 0, durableObjectStorage: 0 };
  const monthly = { ...usage, workerRequests: 30_000_000 };
  const halfMonth = 15 * 24 * H;
  const projected = projectedBill({ billed: { times: [T0], values: [0] }, usage }, T0, T0 + halfMonth, monthly);
  assert.equal(projected.times[0], T0);
  assert.equal(projected.times.at(-1), T0 + halfMonth);
  assert.equal(projected.values[0], 0);
  assert.equal(projected.values[1], 0);
  near(projected.values.at(-1)!, (9 + 15 - 10) * 0.3, 9);
});

interface CaptureSeries { readonly metric: string; readonly values: Cell[] }
interface CaptureHistory { readonly kind: MetricHistory["kind"]; readonly fromMs: number; readonly toMs: number; readonly stepMs: number; readonly series: readonly CaptureSeries[] }
interface CaptureProject { readonly id: string; readonly buckets: string[]; readonly d1Databases: string[] }

function capture(name: string) {
  const directory = new URL(`../ui/captures/${name}/`, import.meta.url);
  const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, directory), "utf8")) as T;
  const load = (file: string): MetricHistory => {
    const source = read<CaptureHistory>(file);
    const columns = Object.fromEntries(source.series.map(entry => [entry.metric, entry.values]));
    const rows = source.series[0]?.values.length ?? 0;
    return { projectId: name, kind: source.kind, fromMs: source.fromMs, toMs: source.toMs, stepMs: source.stepMs, table: Table.from(tableView(rows, columns), Array.from({ length: rows }, (_, index) => source.fromMs + index * source.stepMs)) };
  };
  const project = read<CaptureProject[]>("projects.json").find(entry => entry.id === name)!;
  const worker = load("worker-30d.json");
  const set: LedgerHistories = { worker, routes: load("routes-30d.json"), r2: load("r2-30d.json"), durableObjects: undefined, d1: undefined, d1Statements: undefined };
  return { project, set, window: { fromMs: worker.fromMs, toMs: worker.toMs } };
}

const MEASURED: Record<string, unknown> = {
  "stats": {"usage": {"workerRequests": 28940, "workerCpuMs": 82040, "durableObjectRequests": 0, "durableObjectGbSeconds": 0, "d1RowsWritten": 0, "d1RowsRead": 0, "r2Storage": 0, "d1Storage": 0, "durableObjectStorage": 0}, "billed": 0, "projected": 0, "projectedAtThousandFold": 94.17380339903069, "monthly": 0.09779494736842105, "lines": [["worker", 0.09779494736842105]]},
  "stuff": {"usage": {"workerRequests": 53056, "workerCpuMs": 280688, "durableObjectRequests": 0, "durableObjectGbSeconds": 0, "d1RowsWritten": 0, "d1RowsRead": 0, "r2Storage": 0.15088319503190553, "d1Storage": 0, "durableObjectStorage": 0}, "billed": 0, "projected": 0, "projectedAtThousandFold": 216.312708209405, "monthly": 0.22010197743923074, "lines": [["worker", 0.19874363076923074], ["r2", 0.02135834667]]},
  "usr-memories": {"usage": {"workerRequests": 142436, "workerCpuMs": 954336, "durableObjectRequests": 0, "durableObjectGbSeconds": 0, "d1RowsWritten": 0, "d1RowsRead": 0, "r2Storage": 0.5640650856646147, "d1Storage": 0, "durableObjectStorage": 0}, "billed": 0, "projected": 0, "projectedAtThousandFold": 668.6578220336322, "monthly": 0.6725339828778947, "lines": [["worker", 0.5856396631578946], ["r2", 0.08689431972]]}
};

for (const name of ["stats", "stuff", "usr-memories"]) {
  await test(`plan bill and projection on the ${name} capture are unchanged`, () => {
    const { project, set, window } = capture(name);
    const bill = planBill(set, window, project.buckets, project.d1Databases);
    const ledger = buildLedger({ current: set, previous: undefined, window, previousWindow: previousWindowOf(window), buckets: project.buckets, databases: project.d1Databases, objectMethods: undefined });
    const monthly = monthlyUsage(ledger);
    const scaled = Object.fromEntries(Object.entries(monthly).map(([meter, value]) => [meter, value * 1000])) as typeof monthly;
    const observed = {
      usage: bill.usage,
      billed: bill.billed.values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      projected: projectedBill(bill, window.fromMs, window.toMs, monthly).values.at(-1),
      projectedAtThousandFold: projectedBill(bill, window.fromMs, window.toMs, scaled).values.at(-1),
      monthly: ledger.monthly.now,
      lines: ledger.lines.map(entry => [entry.id, now(entry)])
    };
    assert.deepEqual(observed, MEASURED[name]);
  });
}
