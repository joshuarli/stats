import type { TimeWindow } from "../client/chart-data.ts";
import type { Track } from "../client/columns.ts";
import { metricTrack, type MetricHistory } from "../client/history.ts";
import { BYTES_PER_GB, DURABLE_OBJECT_MEMORY_GB, LIST_PRICE_PER_GB_MONTH, LIST_PRICE_PER_MILLION, WORKERS_PAID_INCLUDED } from "./pricing.ts";
import type { ObjectMethodStats } from "../observe/core/store.ts";
import { holdLast } from "../client/math.ts";
import type { WorkerBilling } from "../projects/config.ts";

export const MONTH_MS = 30 * 86_400_000;
const UNATTRIBUTED_SHARE = 0.01;
const OBJECT_STORAGE_METRIC = "do.storageBytes";
const ROUTE_PREFIX = "route.";
const STATEMENT_PREFIX = "d1q.";

export interface Amount {
  readonly now: number;
  readonly before: number | null;
}

export type Bound = "estimate" | "upper";

export type Price =
  | { readonly kind: "priced"; readonly monthly: Amount; readonly bound: Bound }
  | { readonly kind: "uncollected"; readonly cause: "no-data" | "no-source" };

export interface CostPart {
  readonly label: string;
  readonly monthly: number;
  readonly bound: Bound;
}

export type Usage =
  | { readonly kind: "requests"; readonly calls: Amount; readonly cpuMs: Amount }
  | { readonly kind: "objects"; readonly calls: Amount; readonly wallMs: Amount; readonly cpuMs: Amount; readonly latency: { readonly p50WallMs: number; readonly p95WallMs: number; readonly failed: number } | null }
  | { readonly kind: "rows"; readonly read: Amount; readonly written: Amount; readonly queries: Amount | null }
  | { readonly kind: "stored"; readonly bytes: Amount }
  | { readonly kind: "none" };

export type LineKind = "worker" | "route" | "unrouted" | "objects" | "object-method" | "d1" | "statement" | "d1-storage" | "object-storage" | "r2" | "bucket" | "uncollected";

export interface CostLine {
  readonly id: string;
  readonly kind: LineKind;
  readonly label: string;
  readonly price: Price;
  readonly parts: readonly CostPart[];
  readonly usage: Usage;
  readonly trend: Track | null;
  readonly children: readonly CostLine[];
}

export interface Ledger {
  readonly window: TimeWindow;
  readonly previousWindow: TimeWindow;
  readonly monthly: Amount;
  readonly uncompared: readonly string[];
  readonly lines: readonly CostLine[];
  readonly workerBilling: WorkerBilling;
}

export interface LedgerHistories {
  readonly worker: MetricHistory;
  readonly routes: MetricHistory;
  readonly r2: MetricHistory;
  readonly durableObjects: MetricHistory | undefined;
  readonly d1: MetricHistory | undefined;
  readonly d1Statements: MetricHistory | undefined;
}

export interface ObjectMethods {
  readonly now: readonly ObjectMethodStats[];
  readonly before: readonly ObjectMethodStats[] | null;
}

export interface LedgerInput {
  readonly current: LedgerHistories;
  readonly previous: LedgerHistories | undefined;
  readonly window: TimeWindow;
  readonly previousWindow: TimeWindow;
  readonly buckets: readonly string[];
  readonly databases: readonly string[];
  readonly objectMethods: ObjectMethods | undefined;
  readonly workerBilling: WorkerBilling;
}

export function workerRequestPrice(billing: WorkerBilling): number {
  return billing === "cpu-only" ? 0 : LIST_PRICE_PER_MILLION.workerRequests;
}

export function previousWindowOf(window: TimeWindow): TimeWindow {
  const length = window.toMs - window.fromMs;
  return { fromMs: window.fromMs - length, toMs: window.fromMs };
}

function inWindow(track: Track, window: TimeWindow): number {
  let total = 0;
  track.times.forEach((time, index) => {
    if (time >= window.fromMs && time < window.toMs) total += track.values[index] ?? 0;
  });
  return total;
}

function heldAt(track: Track, window: TimeWindow): number | null {
  const held = holdLast(track);
  let found: number | null = null;
  held.times.forEach((time, index) => {
    if (time < window.toMs && held.values[index] !== null) found = held.values[index]!;
  });
  return found;
}

const perMillion = (value: number, price: number) => (value * price) / 1_000_000;

function trendOf(track: Track, stepMs: number, price: (value: number) => number): Track {
  const factor = MONTH_MS / stepMs;
  return { times: track.times, values: track.values.map(value => (value === null ? null : price(value) * factor)) };
}

function sumTracks(tracks: readonly Track[]): Track {
  const first = tracks.find(track => track.times.length > 0);
  if (first === undefined) return { times: [], values: [] };
  return {
    times: first.times,
    values: first.times.map((_, index) => {
      let total: number | null = null;
      for (const track of tracks) {
        const value = track.values[index];
        if (value !== undefined && value !== null) total = (total ?? 0) + value;
      }
      return total;
    })
  };
}

function priced(now: number, before: number | null, bound: Bound = "estimate"): Price {
  return { kind: "priced", monthly: { now, before }, bound };
}

export function monthlyOf(line: CostLine): Amount | null {
  return line.price.kind === "priced" ? line.price.monthly : null;
}

const RESIDUAL_KINDS: ReadonlySet<LineKind> = new Set(["unrouted", "uncollected"]);

export function isResidual(line: CostLine): boolean {
  return RESIDUAL_KINDS.has(line.kind);
}

function byCost(lines: readonly CostLine[]): CostLine[] {
  return [...lines].sort((left, right) => Number(isResidual(left)) - Number(isResidual(right)) || (monthlyOf(right)?.now ?? -1) - (monthlyOf(left)?.now ?? -1) || left.label.localeCompare(right.label));
}

interface Sampler {
  readonly covers: (history: MetricHistory) => boolean;
  readonly now: (history: LedgerHistories, metric: (history: LedgerHistories) => MetricHistory | undefined, name: string) => number;
  readonly before: (metric: (history: LedgerHistories) => MetricHistory | undefined, name: string) => number | null;
}

export function coveredMs(history: MetricHistory, window: TimeWindow, only?: readonly string[]): number {
  const columns = history.table.names().filter(name => only === undefined || only.includes(name)).map(name => history.table.cells(name));
  let buckets = 0;
  history.table.times.forEach((time, index) => {
    if (time >= window.fromMs && time < window.toMs && columns.some(cells => cells[index] !== null)) buckets += 1;
  });
  return buckets * history.stepMs;
}

function sampler(input: LedgerInput): Sampler {
  const cache = { now: new Map<MetricHistory, number | null>(), before: new Map<MetricHistory, number | null>() };
  const factor = (history: MetricHistory, window: TimeWindow, requireStart: boolean): number | null => {
    const factors = requireStart ? cache.before : cache.now;
    const known = factors.get(history);
    if (known !== undefined) return known;
    const covered = coveredMs(history, window);
    const reaches = !requireStart || history.fromMs <= window.fromMs;
    const value = covered > 0 && reaches ? MONTH_MS / covered : null;
    factors.set(history, value);
    return value;
  };
  const nowFactor = (history: MetricHistory) => factor(history, input.window, false) ?? 0;
  const beforeFactor = (history: MetricHistory) => factor(history, input.previousWindow, true);
  return {
    covers: history => coveredMs(history, input.window) > 0,
    now: (history, pick, name) => {
      const source = pick(history);
      return source === undefined ? 0 : inWindow(metricTrack(source, name), input.window) * nowFactor(source);
    },
    before: (pick, name) => {
      if (input.previous === undefined) return null;
      const source = pick(input.previous);
      if (source === undefined) return null;
      const scale = beforeFactor(source);
      return scale === null ? null : inWindow(metricTrack(source, name), input.previousWindow) * scale;
    }
  };
}

function routeNames(history: MetricHistory): string[] {
  return [...new Set(history.table.names().filter(name => name.startsWith(ROUTE_PREFIX)).map(name => name.slice(ROUTE_PREFIX.length, name.lastIndexOf("."))))];
}

function workerLine(input: LedgerInput, sample: Sampler): CostLine {
  const requestPrice = workerRequestPrice(input.workerBilling);
  const worker = (history: LedgerHistories) => history.worker;
  const routes = (history: LedgerHistories) => history.routes;
  const callsNow = sample.now(input.current, worker, "worker.invocations");
  const cpuNow = sample.now(input.current, worker, "worker.cpuMsSum");
  const callsBefore = sample.before(worker, "worker.invocations");
  const cpuBefore = sample.before(worker, "worker.cpuMsSum");
  const cost = (calls: number, cpu: number) => perMillion(calls, requestPrice) + perMillion(cpu, LIST_PRICE_PER_MILLION.workerCpuMs);
  const beforeCost = (calls: number | null, cpu: number | null) => calls === null || cpu === null ? null : cost(calls, cpu);
  const stepMs = input.current.worker.stepMs;
  const children: CostLine[] = routeNames(input.current.routes).map(route => {
    const calls = sample.now(input.current, routes, `${ROUTE_PREFIX}${route}.invocations`);
    const cpu = sample.now(input.current, routes, `${ROUTE_PREFIX}${route}.cpuMsSum`);
    const callsName = `${ROUTE_PREFIX}${route}.invocations`;
    const cpuName = `${ROUTE_PREFIX}${route}.cpuMsSum`;
    const inBaseline = input.previous !== undefined && coveredMs(input.previous.routes, input.previousWindow, [callsName, cpuName]) > 0;
    const before = inBaseline ? { calls: sample.before(routes, callsName), cpu: sample.before(routes, cpuName) } : { calls: null, cpu: null };
    const callsTrack = metricTrack(input.current.routes, `${ROUTE_PREFIX}${route}.invocations`);
    const cpuTrack = metricTrack(input.current.routes, `${ROUTE_PREFIX}${route}.cpuMsSum`);
    return {
      id: `route:${route}`, kind: "route", label: route,
      price: priced(cost(calls, cpu), beforeCost(before.calls, before.cpu)),
      parts: [{ label: "requests", monthly: perMillion(calls, requestPrice), bound: "estimate" }, { label: "CPU", monthly: perMillion(cpu, LIST_PRICE_PER_MILLION.workerCpuMs), bound: "estimate" }],
      usage: { kind: "requests", calls: { now: calls, before: before.calls }, cpuMs: { now: cpu, before: before.cpu } },
      trend: sumTracks([trendOf(callsTrack, stepMs, value => perMillion(value, requestPrice)), trendOf(cpuTrack, stepMs, value => perMillion(value, LIST_PRICE_PER_MILLION.workerCpuMs))]),
      children: []
    } satisfies CostLine;
  }).filter(line => line.usage.kind === "requests" && (line.usage.calls.now > 0 || (line.usage.calls.before ?? 0) > 0));
  const total = cost(callsNow, cpuNow);
  const routed = children.reduce((sum, line) => sum + (monthlyOf(line)?.now ?? 0), 0);
  const totalBefore = beforeCost(callsBefore, cpuBefore);
  const routedBefore = children.reduce<number | null>((sum, line) => {
    const value = monthlyOf(line)?.before ?? null;
    return sum === null || value === null ? null : sum + value;
  }, 0);
  const residualBefore = totalBefore === null || routedBefore === null ? null : totalBefore - routedBefore;
  if (total - routed > total * UNATTRIBUTED_SHARE) {
    children.push({ id: "route:unattributed", kind: "unrouted", label: "not attributed to a route", price: priced(total - routed, residualBefore), parts: [], usage: { kind: "none" }, trend: null, children: [] });
  }
  return {
    id: "worker", kind: "worker", label: "Worker",
    price: priced(total, beforeCost(callsBefore, cpuBefore)),
    parts: [{ label: "requests", monthly: perMillion(callsNow, requestPrice), bound: "estimate" }, { label: "CPU", monthly: perMillion(cpuNow, LIST_PRICE_PER_MILLION.workerCpuMs), bound: "estimate" }],
    usage: { kind: "requests", calls: { now: callsNow, before: callsBefore }, cpuMs: { now: cpuNow, before: cpuBefore } },
    trend: sumTracks([
      trendOf(metricTrack(input.current.worker, "worker.invocations"), stepMs, value => perMillion(value, requestPrice)),
      trendOf(metricTrack(input.current.worker, "worker.cpuMsSum"), stepMs, value => perMillion(value, LIST_PRICE_PER_MILLION.workerCpuMs))
    ]),
    children: byCost(children)
  };
}

const durationCost = (wallMs: number) => perMillion((wallMs / 1000) * DURABLE_OBJECT_MEMORY_GB, LIST_PRICE_PER_MILLION.durableObjectGbSeconds);
const requestCost = (calls: number) => perMillion(calls, LIST_PRICE_PER_MILLION.durableObjectRequests);

function methodLines(methods: ObjectMethods, requests: Amount, duration: Amount, scale: { readonly now: number; readonly before: number }): CostLine[] {
  const totals = (list: readonly ObjectMethodStats[]) => ({ calls: list.reduce((sum, m) => sum + m.requests, 0), wall: list.reduce((sum, m) => sum + m.wallMs, 0) });
  const now = totals(methods.now);
  const before = methods.before === null ? null : totals(methods.before);
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  return methods.now.map(method => {
    const previous = methods.before?.find(entry => entry.label === method.label);
    const monthlyNow = share(method.requests, now.calls) * requests.now + share(method.wallMs, now.wall) * duration.now;
    const monthlyBefore = before === null || requests.before === null || duration.before === null ? null
      : previous === undefined ? 0 : share(previous.requests, before.calls) * requests.before + share(previous.wallMs, before.wall) * duration.before;
    return {
      id: `object:${method.label}`, kind: "object-method", label: method.label,
      price: priced(monthlyNow, monthlyBefore, "upper"),
      parts: [{ label: "requests", monthly: share(method.requests, now.calls) * requests.now, bound: "estimate" }, { label: "duration", monthly: share(method.wallMs, now.wall) * duration.now, bound: "upper" }],
      usage: {
        kind: "objects",
        calls: { now: method.requests * scale.now, before: previous === undefined ? (methods.before === null ? null : 0) : previous.requests * scale.before },
        wallMs: { now: method.wallMs * scale.now, before: previous === undefined ? null : previous.wallMs * scale.before },
        cpuMs: { now: method.cpuMs * scale.now, before: previous === undefined ? null : previous.cpuMs * scale.before },
        latency: { p50WallMs: method.p50WallMs, p95WallMs: method.p95WallMs, failed: method.failed }
      },
      trend: null,
      children: []
    } satisfies CostLine;
  });
}

const NO_DATA: Price = { kind: "uncollected", cause: "no-data" };

function emptyLine(id: string, kind: LineKind, label: string): CostLine {
  return { id, kind, label, price: NO_DATA, parts: [], usage: { kind: "none" }, trend: null, children: [] };
}

function objectsLine(input: LedgerInput, sample: Sampler): CostLine | null {
  const history = input.current.durableObjects;
  if (history === undefined) return null;
  if (!sample.covers(history)) return emptyLine("objects", "objects", "Durable Objects");
  const pick = (entry: LedgerHistories) => entry.durableObjects;
  const calls = { now: sample.now(input.current, pick, "do.invocations"), before: sample.before(pick, "do.invocations") };
  const wall = { now: sample.now(input.current, pick, "do.wallMsSum"), before: sample.before(pick, "do.wallMsSum") };
  const cpu = { now: sample.now(input.current, pick, "do.cpuMsSum"), before: sample.before(pick, "do.cpuMsSum") };
  const requests = { now: requestCost(calls.now), before: calls.before === null ? null : requestCost(calls.before) };
  const duration = { now: durationCost(wall.now), before: wall.before === null ? null : durationCost(wall.before) };
  const before = requests.before === null || duration.before === null ? null : requests.before + duration.before;
  const scale = {
    now: MONTH_MS / Math.max(1, input.window.toMs - input.window.fromMs),
    before: MONTH_MS / Math.max(1, input.previousWindow.toMs - input.previousWindow.fromMs)
  };
  const methods = input.objectMethods === undefined || input.objectMethods.now.length === 0 ? [] : methodLines(input.objectMethods, requests, duration, scale);
  const storage = storedLine(
    "object:storage", "object-storage", "SQLite storage",
    metricTrack(history, OBJECT_STORAGE_METRIC),
    input.previous?.durableObjects === undefined ? undefined : metricTrack(input.previous.durableObjects, OBJECT_STORAGE_METRIC),
    input, LIST_PRICE_PER_GB_MONTH.durableObjectStorage
  );
  const stored = storage === null ? null : monthlyOf(storage);
  const uncollected: CostLine = {
    id: "object:sqlite", kind: "uncollected", label: storage === null ? "SQLite rows and storage" : "SQLite rows",
    price: { kind: "uncollected", cause: "no-source" }, parts: [], usage: { kind: "none" }, trend: null, children: []
  };
  const storageParts: CostPart[] = stored === null ? [] : [{ label: "storage", monthly: stored.now, bound: "estimate" }];
  return {
    id: "objects", kind: "objects", label: "Durable Objects",
    price: priced(requests.now + duration.now + (stored?.now ?? 0), before === null || stored?.before === null ? null : before + (stored?.before ?? 0), "upper"),
    parts: [{ label: "requests", monthly: requests.now, bound: "estimate" }, { label: "duration", monthly: duration.now, bound: "upper" }, ...storageParts],
    usage: { kind: "objects", calls, wallMs: wall, cpuMs: cpu, latency: null },
    trend: sumTracks([
      trendOf(metricTrack(history, "do.invocations"), history.stepMs, requestCost),
      trendOf(metricTrack(history, "do.wallMsSum"), history.stepMs, durationCost),
      ...(storage?.trend ? [storage.trend] : [])
    ]),
    children: [...byCost(methods), ...(storage === null ? [] : [storage]), uncollected]
  };
}

function statementNames(history: MetricHistory): string[] {
  return [...new Set(history.table.names().filter(name => name.startsWith(STATEMENT_PREFIX)).map(name => name.slice(STATEMENT_PREFIX.length, name.lastIndexOf("."))))];
}

const rowsCost = (read: number, written: number) => perMillion(read, LIST_PRICE_PER_MILLION.d1RowsRead) + perMillion(written, LIST_PRICE_PER_MILLION.d1RowsWritten);

function storedLine(id: string, kind: "bucket" | "d1-storage" | "object-storage", label: string, track: Track, previous: Track | undefined, input: LedgerInput, pricePerGb: number): CostLine | null {
  const now = heldAt(track, input.window);
  if (now === null) return null;
  const before = previous === undefined ? heldAt(track, input.previousWindow) : heldAt(previous, input.previousWindow) ?? heldAt(track, input.previousWindow);
  const monthly = (bytes: number) => (bytes / BYTES_PER_GB) * pricePerGb;
  const held = holdLast(track);
  return {
    id, kind, label,
    price: priced(monthly(now), before === null ? null : monthly(before)),
    parts: [{ label: "storage", monthly: monthly(now), bound: "estimate" }],
    usage: { kind: "stored", bytes: { now, before } },
    trend: { times: held.times, values: held.values.map(value => (value === null ? null : monthly(value))) },
    children: []
  };
}

function d1Line(input: LedgerInput, sample: Sampler): CostLine | null {
  const history = input.current.d1;
  if (history === undefined) return null;
  if (!sample.covers(history)) return emptyLine("d1", "d1", "D1");
  const pick = (entry: LedgerHistories) => entry.d1;
  const statements = (entry: LedgerHistories) => entry.d1Statements;
  const read = { now: sample.now(input.current, pick, "d1.rowsRead"), before: sample.before(pick, "d1.rowsRead") };
  const written = { now: sample.now(input.current, pick, "d1.rowsWritten"), before: sample.before(pick, "d1.rowsWritten") };
  const queries = { now: sample.now(input.current, pick, "d1.queries"), before: sample.before(pick, "d1.queries") };
  const statementLines: CostLine[] = input.current.d1Statements === undefined ? [] : statementNames(input.current.d1Statements).map(statement => {
    const metric = (field: string) => `${STATEMENT_PREFIX}${statement}.${field}`;
    const r = { now: sample.now(input.current, statements, metric("rowsRead")), before: sample.before(statements, metric("rowsRead")) };
    const w = { now: sample.now(input.current, statements, metric("rowsWritten")), before: sample.before(statements, metric("rowsWritten")) };
    const q = { now: sample.now(input.current, statements, metric("queries")), before: sample.before(statements, metric("queries")) };
    return {
      id: `statement:${statement}`, kind: "statement", label: statement,
      price: priced(rowsCost(r.now, w.now), r.before === null || w.before === null ? null : rowsCost(r.before, w.before)),
      parts: [{ label: "rows read", monthly: perMillion(r.now, LIST_PRICE_PER_MILLION.d1RowsRead), bound: "estimate" }, { label: "rows written", monthly: perMillion(w.now, LIST_PRICE_PER_MILLION.d1RowsWritten), bound: "estimate" }],
      usage: { kind: "rows", read: r, written: w, queries: q },
      trend: null,
      children: []
    } satisfies CostLine;
  }).filter(line => line.usage.kind === "rows" && (line.usage.queries?.now ?? 0) + (line.usage.queries?.before ?? 0) > 0);
  const storage = input.databases.map(database => storedLine(
    `d1-storage:${database}`, "d1-storage", `storage · ${database.slice(0, 8)}`,
    metricTrack(history, `d1.${database}.storageBytes`),
    input.previous?.d1 === undefined ? undefined : metricTrack(input.previous.d1, `d1.${database}.storageBytes`),
    input, LIST_PRICE_PER_GB_MONTH.d1Storage
  )).filter(line => line !== null);
  const rowsNow = rowsCost(read.now, written.now);
  const rowsBefore = read.before === null || written.before === null ? null : rowsCost(read.before, written.before);
  const storageNow = storage.reduce((sum, line) => sum + (monthlyOf(line)?.now ?? 0), 0);
  const storageBefore = storage.every(line => monthlyOf(line)?.before !== null) ? storage.reduce((sum, line) => sum + (monthlyOf(line)?.before ?? 0), 0) : null;
  const attributed = statementLines.reduce((sum, line) => sum + (monthlyOf(line)?.now ?? 0), 0);
  const children = [...statementLines];
  if (rowsNow - attributed > rowsNow * UNATTRIBUTED_SHARE) {
    children.push({ id: "statement:unattributed", kind: "unrouted", label: "not attributed to a statement", price: priced(rowsNow - attributed, null), parts: [], usage: { kind: "none" }, trend: null, children: [] });
  }
  return {
    id: "d1", kind: "d1", label: "D1",
    price: priced(rowsNow + storageNow, rowsBefore === null || storageBefore === null ? null : rowsBefore + storageBefore),
    parts: [
      { label: "rows read", monthly: perMillion(read.now, LIST_PRICE_PER_MILLION.d1RowsRead), bound: "estimate" },
      { label: "rows written", monthly: perMillion(written.now, LIST_PRICE_PER_MILLION.d1RowsWritten), bound: "estimate" },
      { label: "storage", monthly: storageNow, bound: "estimate" }
    ],
    usage: { kind: "rows", read, written, queries },
    trend: sumTracks([
      trendOf(sumTracks([
        { times: metricTrack(history, "d1.rowsRead").times, values: metricTrack(history, "d1.rowsRead").values.map(value => (value === null ? null : perMillion(value, LIST_PRICE_PER_MILLION.d1RowsRead))) },
        { times: metricTrack(history, "d1.rowsWritten").times, values: metricTrack(history, "d1.rowsWritten").values.map(value => (value === null ? null : perMillion(value, LIST_PRICE_PER_MILLION.d1RowsWritten))) }
      ]), history.stepMs, value => value),
      ...storage.map(line => line.trend).filter(track => track !== null)
    ]),
    children: [...byCost(statementLines), ...byCost(storage), ...children.filter(isResidual)]
  };
}

function r2Line(input: LedgerInput): CostLine | null {
  if (input.buckets.length === 0) return null;
  const buckets = input.buckets.map(bucket => storedLine(
    `bucket:${bucket}`, "bucket", bucket,
    metricTrack(input.current.r2, `r2.${bucket}.storageBytes`),
    input.previous === undefined ? undefined : metricTrack(input.previous.r2, `r2.${bucket}.storageBytes`),
    input, LIST_PRICE_PER_GB_MONTH.r2Storage
  )).filter(line => line !== null);
  if (buckets.length === 0) return null;
  const now = buckets.reduce((sum, line) => sum + (monthlyOf(line)?.now ?? 0), 0);
  const before = buckets.every(line => monthlyOf(line)?.before !== null) ? buckets.reduce((sum, line) => sum + (monthlyOf(line)?.before ?? 0), 0) : null;
  const bytes = (pick: (amount: Amount) => number | null) => buckets.reduce<number | null>((sum, line) => {
    const value = line.usage.kind === "stored" ? pick(line.usage.bytes) : null;
    return sum === null || value === null ? null : sum + value;
  }, 0);
  return {
    id: "r2", kind: "r2", label: "R2 storage",
    price: priced(now, before),
    parts: [{ label: "storage", monthly: now, bound: "estimate" }],
    usage: { kind: "stored", bytes: { now: bytes(amount => amount.now) ?? 0, before: bytes(amount => amount.before) } },
    trend: sumTracks(buckets.map(line => line.trend).filter(track => track !== null)),
    children: byCost(buckets)
  };
}

export type Meter = keyof typeof WORKERS_PAID_INCLUDED;
export type MeterUsage = Readonly<Record<Meter, number>>;

function usageOf(units: (meter: Meter) => number): Record<Meter, number> {
  return {
    workerRequests: units("workerRequests"),
    workerCpuMs: units("workerCpuMs"),
    durableObjectRequests: units("durableObjectRequests"),
    durableObjectGbSeconds: units("durableObjectGbSeconds"),
    d1RowsWritten: units("d1RowsWritten"),
    d1RowsRead: units("d1RowsRead"),
    r2Storage: units("r2Storage"),
    d1Storage: units("d1Storage"),
    durableObjectStorage: units("durableObjectStorage")
  };
}

const UNIT_PRICE: MeterUsage = {
  workerRequests: LIST_PRICE_PER_MILLION.workerRequests / 1_000_000,
  workerCpuMs: LIST_PRICE_PER_MILLION.workerCpuMs / 1_000_000,
  durableObjectRequests: LIST_PRICE_PER_MILLION.durableObjectRequests / 1_000_000,
  durableObjectGbSeconds: LIST_PRICE_PER_MILLION.durableObjectGbSeconds / 1_000_000,
  d1RowsWritten: LIST_PRICE_PER_MILLION.d1RowsWritten / 1_000_000,
  d1RowsRead: LIST_PRICE_PER_MILLION.d1RowsRead / 1_000_000,
  r2Storage: LIST_PRICE_PER_GB_MONTH.r2Storage,
  d1Storage: LIST_PRICE_PER_GB_MONTH.d1Storage,
  durableObjectStorage: LIST_PRICE_PER_GB_MONTH.durableObjectStorage
};

export function billedBeyondPlan(usage: MeterUsage): number {
  return Object.values(usageOf(meter => Math.max(0, usage[meter] - WORKERS_PAID_INCLUDED[meter]) * UNIT_PRICE[meter])).reduce((sum, value) => sum + value, 0);
}

interface Accrual {
  readonly atMs: number;
  readonly meter: Meter;
  readonly units: number;
}

function counterAccruals(meter: Meter, history: MetricHistory | undefined, name: string, window: TimeWindow, scale = 1): Accrual[] {
  if (history === undefined) return [];
  const track = metricTrack(history, name);
  return track.times.flatMap((time, index) => {
    const value = track.values[index];
    return time >= window.fromMs && time < window.toMs && value !== null && value !== undefined
      ? [{ atMs: Math.min(time + history.stepMs, window.toMs), meter, units: value * scale }]
      : [];
  });
}

function storedAccruals(meter: Meter, history: MetricHistory | undefined, name: string, window: TimeWindow): Accrual[] {
  if (history === undefined) return [];
  const held = holdLast(metricTrack(history, name));
  return held.times.flatMap((time, index) => {
    const bytes = held.values[index];
    const start = Math.max(time, window.fromMs);
    const end = Math.min(held.times[index + 1] ?? window.toMs, window.toMs);
    return end > start && bytes !== null && bytes !== undefined
      ? [{ atMs: end, meter, units: (bytes / BYTES_PER_GB) * ((end - start) / MONTH_MS) }]
      : [];
  });
}

export interface PlanBill {
  readonly billed: Track;
  readonly usage: MeterUsage;
}

export function planBill(histories: LedgerHistories, window: TimeWindow, buckets: readonly string[], databases: readonly string[], workerBilling: WorkerBilling): PlanBill {
  const accruals = [
    ...(workerBilling === "cpu-only" ? [] : counterAccruals("workerRequests", histories.worker, "worker.invocations", window)),
    ...counterAccruals("workerCpuMs", histories.worker, "worker.cpuMsSum", window),
    ...counterAccruals("durableObjectRequests", histories.durableObjects, "do.invocations", window),
    ...counterAccruals("durableObjectGbSeconds", histories.durableObjects, "do.wallMsSum", window, DURABLE_OBJECT_MEMORY_GB / 1000),
    ...counterAccruals("d1RowsRead", histories.d1, "d1.rowsRead", window),
    ...counterAccruals("d1RowsWritten", histories.d1, "d1.rowsWritten", window),
    ...storedAccruals("durableObjectStorage", histories.durableObjects, OBJECT_STORAGE_METRIC, window),
    ...databases.flatMap(database => storedAccruals("d1Storage", histories.d1, `d1.${database}.storageBytes`, window)),
    ...buckets.flatMap(bucket => storedAccruals("r2Storage", histories.r2, `r2.${bucket}.storageBytes`, window))
  ].sort((left, right) => left.atMs - right.atMs);
  const usage = usageOf(() => 0);
  const times = [window.fromMs];
  const values = [0];
  for (const accrual of accruals) {
    usage[accrual.meter] += accrual.units;
    const billed = billedBeyondPlan(usage);
    if (times.at(-1) === accrual.atMs) values[values.length - 1] = billed;
    else { times.push(accrual.atMs); values.push(billed); }
  }
  return { billed: { times, values }, usage };
}

export function monthlyUsage(ledger: Ledger): MeterUsage {
  const usage = usageOf(() => 0);
  const stored = (line: CostLine | undefined) => (line?.usage.kind === "stored" ? line.usage.bytes.now / BYTES_PER_GB : 0);
  for (const line of ledger.lines) {
    const kind = line.usage;
    if (kind.kind === "requests" && line.kind === "worker") { usage.workerRequests = ledger.workerBilling === "cpu-only" ? 0 : kind.calls.now; usage.workerCpuMs = kind.cpuMs.now; }
    if (kind.kind === "objects") { usage.durableObjectRequests = kind.calls.now; usage.durableObjectGbSeconds = (kind.wallMs.now / 1000) * DURABLE_OBJECT_MEMORY_GB; usage.durableObjectStorage = stored(line.children.find(child => child.kind === "object-storage")); }
    if (kind.kind === "rows") { usage.d1RowsRead = kind.read.now; usage.d1RowsWritten = kind.written.now; usage.d1Storage = line.children.filter(child => child.kind === "d1-storage").reduce((sum, child) => sum + stored(child), 0); }
    if (line.kind === "r2") usage.r2Storage = stored(line);
  }
  return usage;
}

const PROJECTION_POINTS = 48;

export function projectedBill(bill: PlanBill, fromMs: number, toMs: number, monthly: MeterUsage): Track {
  const span = Math.max(0, toMs - fromMs);
  const times = Array.from({ length: PROJECTION_POINTS + 1 }, (_, index) => fromMs + (span * index) / PROJECTION_POINTS);
  const values = times.map(time => {
    const elapsed = (time - fromMs) / MONTH_MS;
    return billedBeyondPlan(usageOf(meter => bill.usage[meter] + monthly[meter] * elapsed));
  });
  return { times, values };
}

export function buildLedger(input: LedgerInput): Ledger {
  const sample = sampler(input);
  const worker = sample.covers(input.current.worker) ? workerLine(input, sample) : emptyLine("worker", "worker", "Worker");
  const lines = byCost([worker, objectsLine(input, sample), d1Line(input, sample), r2Line(input)].filter(line => line !== null));
  const entries = lines.map(line => ({ line, amount: monthlyOf(line) }));
  const now = entries.reduce((sum, entry) => sum + (entry.amount?.now ?? 0), 0);
  const compared = entries.filter(entry => entry.amount !== null && entry.amount.before !== null);
  const change = compared.reduce((sum, entry) => sum + (entry.amount!.now - entry.amount!.before!), 0);
  const uncompared = entries.filter(entry => entry.amount !== null && entry.amount.before === null).map(entry => entry.line.label);
  return { window: input.window, previousWindow: input.previousWindow, monthly: { now, before: compared.length === 0 ? null : now - change }, uncompared, lines, workerBilling: input.workerBilling };
}
