import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Table } from "../../src/client/columns.ts";
import type { MetricHistory } from "../../src/client/history.ts";
import type { ProjectConfig } from "../../src/projects/config.ts";
import { CoverageIndex, previousWindowOf, windowUsage, type CostLine, type LedgerHistories } from "../../src/cost/ledger.ts";
import { PRICING_REVISION } from "../../src/cost/pricing.ts";
import { buildCostReport } from "../../src/cost/report.ts";
import { H, histories } from "./support.ts";
import { tableView, type Cell } from "../support/history.ts";

await test("report coverage traverses route columns linearly on the stuff capture", () => {
  const directory = new URL("../ui/captures/stuff/", import.meta.url);
  const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, directory), "utf8")) as T;
  const load = (file: string): MetricHistory => {
    const source = read<{ kind: MetricHistory["kind"]; fromMs: number; toMs: number; stepMs: number; series: { metric: string; values: Cell[] }[] }>(file);
    const rows = source.series[0]?.values.length ?? 0;
    return { projectId: "stuff", kind: source.kind, fromMs: source.fromMs, toMs: source.toMs, stepMs: source.stepMs, table: Table.from(tableView(rows, Object.fromEntries(source.series.map(series => [series.metric, series.values]))), Array.from({ length: rows }, (_, index) => source.fromMs + index * source.stepMs)) };
  };
  const worker = load("worker-30d.json");
  const routes = load("routes-30d.json");
  const current: LedgerHistories = { worker, routes, r2: load("r2-30d.json"), durableObjects: undefined, d1: undefined, d1Statements: undefined };
  const project = read<ProjectConfig[]>("projects.json").find(entry => entry.id === "stuff")!;
  const window = { fromMs: worker.fromMs, toMs: worker.toMs };
  let cells = 0;
  let names = 0;
  const originalCells = routes.table.cells.bind(routes.table);
  const originalNames = routes.table.names.bind(routes.table);
  routes.table.cells = field => { cells += 1; return originalCells(field); };
  routes.table.names = () => { names += 1; return originalNames(); };
  const report = buildCostReport({ nowMs: window.toMs, pricingRevision: PRICING_REVISION, project, windows: { current: window, previous: previousWindowOf(window) }, current, previous: undefined, objectMethods: undefined, planMonth: undefined });
  console.log(`stuff report route table: cells=${cells} names=${names}`);
  assert.equal(report.total.monthly.now, 0.20705114667);
  assert.ok(cells < 3000, `cells=${cells}`);
  assert.ok(names < 10, `names=${names}`);
  cells = 0;
  names = 0;
  const coverage = new CoverageIndex();
  const lines = (entries: readonly CostLine[]): CostLine[] => entries.flatMap(line => [line, ...lines(line.children)]);
  const all = lines(report.lines);
  const shared = all.map(line => windowUsage(line, current, undefined, window, previousWindowOf(window), coverage));
  assert.equal(names, 1);
  assert.equal(cells, originalNames().length);
  assert.deepEqual(shared, all.map(line => windowUsage(line, current, undefined, window, previousWindowOf(window))));
});

await test("one shared coverage index keeps current and previous denominators distinct", () => {
  const current = histories(0, { worker: { "worker.invocations": [10, null, 10], "worker.cpuMsSum": [30, null, 30] } });
  const previous = histories(-3 * H, { worker: { "worker.invocations": [5, 5, 5], "worker.cpuMsSum": [10, 10, 10] } });
  const window = { fromMs: 0, toMs: 3 * H };
  const project: ProjectConfig = { id: "p", name: "p", worker: "p", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [] };
  const report = buildCostReport({ nowMs: window.toMs, pricingRevision: PRICING_REVISION, project, windows: { current: window, previous: previousWindowOf(window) }, current, previous, objectMethods: undefined, planMonth: undefined });
  const worker = report.lines.find(line => line.kind === "worker")!;
  const coverage = new CoverageIndex();
  assert.deepEqual(windowUsage(worker, current, previous, window, previousWindowOf(window), coverage), { kind: "requests", calls: { now: 20, before: 15 }, cpuMs: { now: 60, before: 30 } });
});
