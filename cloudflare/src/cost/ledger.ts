import type { TimeWindow } from "../client/chart-data.ts";
import type { Track } from "../client/columns.ts";
import { metricTrack, type MetricHistory } from "../client/history.ts";
import { BYTES_PER_GB, DURABLE_OBJECT_MEMORY_GB, LIST_PRICE_PER_GB_MONTH, LIST_PRICE_PER_MILLION, WORKERS_PAID_INCLUDED } from "./pricing.ts";
import type { ObjectMethodStats } from "../observe/core/store.ts";
import type { SamplingSummary } from "../observe/core/counts.ts";
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
  | { readonly kind: "requests"; readonly calls: Amount | null; readonly cpuMs: Amount | null }
  | { readonly kind: "objects"; readonly calls: Amount | null; readonly wallMs: Amount | null; readonly cpuMs: Amount | null; readonly latency: { readonly p50WallMs: number; readonly p95WallMs: number; readonly failed: number } | null }
  | { readonly kind: "rows"; readonly read: Amount | null; readonly written: Amount | null; readonly queries: Amount | null }
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
  readonly sampling?: { readonly now: SamplingSummary | null; readonly before: SamplingSummary | null };
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

function workerRequestPrice(billing: WorkerBilling): number {
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

function usageFactor(kind: LineKind, histories: LedgerHistories, window: TimeWindow): number {
  const span = Math.max(1, window.toMs - window.fromMs);
  switch (kind) {
    case "worker": return MONTH_MS / Math.max(1, coveredMs(histories.worker, window));
    case "route": return MONTH_MS / Math.max(1, coveredMs(histories.routes, window));
    case "objects": return histories.durableObjects === undefined ? 1 : MONTH_MS / Math.max(1, coveredMs(histories.durableObjects, window));
    case "object-method": return MONTH_MS / span;
    case "d1": return histories.d1 === undefined ? 1 : MONTH_MS / Math.max(1, coveredMs(histories.d1, window));
    case "statement": return histories.d1Statements === undefined ? 1 : MONTH_MS / Math.max(1, coveredMs(histories.d1Statements, window));
    case "bucket":
    case "d1-storage":
    case "object-storage":
    case "r2":
    case "uncollected":
    case "unrouted": return 1;
  }
}

export function windowUsage(line: CostLine, histories: LedgerHistories, previous: LedgerHistories | undefined, window: TimeWindow, previousWindow: TimeWindow): Usage {
  const nowFactor = usageFactor(line.kind, histories, window);
  const beforeFactor = previous === undefined ? 1 : usageFactor(line.kind, previous, previousWindow);
  const scale = (amount: Amount): Amount => ({
    now: amount.now / nowFactor,
    before: amount.before === null ? null : amount.before / beforeFactor
  });
  const usage = line.usage;
  switch (usage.kind) {
    case "requests": return { kind: "requests", calls: usage.calls === null ? null : scale(usage.calls), cpuMs: usage.cpuMs === null ? null : scale(usage.cpuMs) };
    case "objects": return { kind: "objects", calls: usage.calls === null ? null : scale(usage.calls), wallMs: usage.wallMs === null ? null : scale(usage.wallMs), cpuMs: usage.cpuMs === null ? null : scale(usage.cpuMs), latency: usage.latency };
    case "rows": return { kind: "rows", read: usage.read === null ? null : scale(usage.read), written: usage.written === null ? null : scale(usage.written), queries: usage.queries === null ? null : scale(usage.queries) };
    case "stored":
    case "none": return usage;
  }
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

function metricAmount(input: LedgerInput, pick: (history: LedgerHistories) => MetricHistory | undefined, name: string): Amount | null {
  const current = pick(input.current);
  if (current === undefined || coveredMs(current, input.window, [name]) === 0) return null;
  const covered = coveredMs(current, input.window);
  const prior = input.previous === undefined ? undefined : pick(input.previous);
  const priorCovered = prior === undefined || prior.fromMs > input.previousWindow.fromMs || coveredMs(prior, input.previousWindow, [name]) === 0 ? 0 : coveredMs(prior, input.previousWindow);
  return {
    now: inWindow(metricTrack(current, name), input.window) * MONTH_MS / covered,
    before: prior === undefined || priorCovered === 0 ? null : inWindow(metricTrack(prior, name), input.previousWindow) * MONTH_MS / priorCovered
  };
}

function workerLine(input: LedgerInput): CostLine {
  const requestPrice = workerRequestPrice(input.workerBilling);
  const worker = (history: LedgerHistories) => history.worker;
  const routes = (history: LedgerHistories) => history.routes;
  const amount = (pick: (history: LedgerHistories) => MetricHistory, name: string): Amount | null => metricAmount(input, pick, name);
  const cost = (calls: number | null, cpu: number | null) => perMillion(calls ?? 0, requestPrice) + perMillion(cpu ?? 0, LIST_PRICE_PER_MILLION.workerCpuMs);
  const currentCost = (calls: Amount | null, cpu: Amount | null) => cost(calls?.now ?? null, cpu?.now ?? null);
  const beforeCost = (calls: Amount | null, cpu: Amount | null) =>
    (requestPrice > 0 && calls !== null && calls.before === null) || (cpu !== null && cpu.before === null) ? null : cost(calls?.before ?? null, cpu?.before ?? null);
  const calls = amount(worker, "worker.invocations");
  const cpu = amount(worker, "worker.cpuMsSum");
  const stepMs = input.current.worker.stepMs;
  const children: CostLine[] = routeNames(input.current.routes).map(route => {
    const calls = amount(routes, `${ROUTE_PREFIX}${route}.invocations`);
    const cpu = amount(routes, `${ROUTE_PREFIX}${route}.cpuMsSum`);
    const callsTrack = metricTrack(input.current.routes, `${ROUTE_PREFIX}${route}.invocations`);
    const cpuTrack = metricTrack(input.current.routes, `${ROUTE_PREFIX}${route}.cpuMsSum`);
    return {
      id: `route:${route}`, kind: "route", label: route,
      price: calls === null && cpu === null ? NO_DATA : priced(currentCost(calls, cpu), beforeCost(calls, cpu)),
      parts: [...(calls === null ? [] : [{ label: "requests", monthly: perMillion(calls.now, requestPrice), bound: "estimate" as const }]), ...(cpu === null ? [] : [{ label: "CPU", monthly: perMillion(cpu.now, LIST_PRICE_PER_MILLION.workerCpuMs), bound: "estimate" as const }])],
      usage: { kind: "requests", calls, cpuMs: cpu },
      trend: sumTracks([trendOf(callsTrack, stepMs, value => perMillion(value, requestPrice)), trendOf(cpuTrack, stepMs, value => perMillion(value, LIST_PRICE_PER_MILLION.workerCpuMs))]),
      children: []
    } satisfies CostLine;
  }).filter(line => line.usage.kind === "requests" && ((line.usage.calls?.now ?? 0) > 0 || (line.usage.calls?.before ?? 0) > 0 || (line.usage.cpuMs?.now ?? 0) > 0));
  const total = currentCost(calls, cpu);
  const routed = children.reduce((sum, line) => sum + (monthlyOf(line)?.now ?? 0), 0);
  const totalBefore = beforeCost(calls, cpu);
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
    price: cpu === null && (requestPrice === 0 || calls === null) ? NO_DATA : priced(total, totalBefore),
    parts: [...(calls === null ? [] : [{ label: "requests", monthly: perMillion(calls.now, requestPrice), bound: "estimate" as const }]), ...(cpu === null ? [] : [{ label: "CPU", monthly: perMillion(cpu.now, LIST_PRICE_PER_MILLION.workerCpuMs), bound: "estimate" as const }])],
    usage: { kind: "requests", calls, cpuMs: cpu },
    trend: sumTracks([
      trendOf(metricTrack(input.current.worker, "worker.invocations"), stepMs, value => perMillion(value, requestPrice)),
      trendOf(metricTrack(input.current.worker, "worker.cpuMsSum"), stepMs, value => perMillion(value, LIST_PRICE_PER_MILLION.workerCpuMs))
    ]),
    children: byCost(children)
  };
}

const durationCost = (wallMs: number) => perMillion((wallMs / 1000) * DURABLE_OBJECT_MEMORY_GB, LIST_PRICE_PER_MILLION.durableObjectGbSeconds);
const requestCost = (calls: number) => perMillion(calls, LIST_PRICE_PER_MILLION.durableObjectRequests);

function methodLines(methods: ObjectMethods, requests: Amount | null, duration: Amount | null, scale: { readonly now: number; readonly before: number }): CostLine[] {
  const totals = (list: readonly ObjectMethodStats[]) => ({ calls: list.reduce((sum, m) => sum + m.requests, 0), wall: list.reduce((sum, m) => sum + m.wallMs, 0) });
  const now = totals(methods.now);
  const before = methods.before === null ? null : totals(methods.before);
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  return methods.now.map(method => {
    const previous = methods.before?.find(entry => entry.label === method.label);
    const previousUnknown = before === null || methods.sampling?.before != null;
    const sampled = methods.sampling?.now != null;
    const monthlyNow = share(method.requests, now.calls) * (requests?.now ?? 0) + share(method.wallMs, now.wall) * (duration?.now ?? 0);
    const monthlyBefore = before === null || (requests !== null && requests.before === null) || (duration !== null && duration.before === null) ? null
      : previous === undefined ? (previousUnknown ? null : 0) : share(previous.requests, before.calls) * (requests?.before ?? 0) + share(previous.wallMs, before.wall) * (duration?.before ?? 0);
    return {
      id: `object:${method.label}`, kind: "object-method", label: method.label,
      price: requests === null && duration === null ? NO_DATA : priced(monthlyNow, monthlyBefore, sampled || duration === null ? "estimate" : "upper"),
      parts: [...(requests === null ? [] : [{ label: "requests", monthly: share(method.requests, now.calls) * requests.now, bound: "estimate" as const }]), ...(duration === null ? [] : [{ label: "duration", monthly: share(method.wallMs, now.wall) * duration.now, bound: sampled ? "estimate" as const : "upper" as const }])],
      usage: {
        kind: "objects",
        calls: { now: method.requests * scale.now, before: previous === undefined ? (previousUnknown ? null : 0) : previous.requests * scale.before },
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
  const calls = metricAmount(input, pick, "do.invocations");
  const wall = metricAmount(input, pick, "do.wallMsSum");
  const cpu = metricAmount(input, pick, "do.cpuMsSum");
  const requests = calls === null ? null : { now: requestCost(calls.now), before: calls.before === null ? null : requestCost(calls.before) };
  const duration = wall === null ? null : { now: durationCost(wall.now), before: wall.before === null ? null : durationCost(wall.before) };
  const before = (requests !== null && requests.before === null) || (duration !== null && duration.before === null) ? null : (requests?.before ?? 0) + (duration?.before ?? 0);
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
    price: requests === null && duration === null && stored === null ? NO_DATA : priced((requests?.now ?? 0) + (duration?.now ?? 0) + (stored?.now ?? 0), before === null || stored?.before === null ? null : before + (stored?.before ?? 0), duration === null ? "estimate" : "upper"),
    parts: [...(requests === null ? [] : [{ label: "requests", monthly: requests.now, bound: "estimate" as const }]), ...(duration === null ? [] : [{ label: "duration", monthly: duration.now, bound: "upper" as const }]), ...storageParts],
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
  const read = metricAmount(input, pick, "d1.rowsRead");
  const written = metricAmount(input, pick, "d1.rowsWritten");
  const queries = metricAmount(input, pick, "d1.queries");
  const beforeCost = (r: Amount | null, w: Amount | null) =>
    (r !== null && r.before === null) || (w !== null && w.before === null) ? null : rowsCost(r?.before ?? 0, w?.before ?? 0);
  const statementLines: CostLine[] = input.current.d1Statements === undefined ? [] : statementNames(input.current.d1Statements).map(statement => {
    const metric = (field: string) => `${STATEMENT_PREFIX}${statement}.${field}`;
    const r = metricAmount(input, statements, metric("rowsRead"));
    const w = metricAmount(input, statements, metric("rowsWritten"));
    const q = metricAmount(input, statements, metric("queries"));
    return {
      id: `statement:${statement}`, kind: "statement", label: statement,
      price: r === null && w === null ? NO_DATA : priced(rowsCost(r?.now ?? 0, w?.now ?? 0), beforeCost(r, w)),
      parts: [...(r === null ? [] : [{ label: "rows read", monthly: perMillion(r.now, LIST_PRICE_PER_MILLION.d1RowsRead), bound: "estimate" as const }]), ...(w === null ? [] : [{ label: "rows written", monthly: perMillion(w.now, LIST_PRICE_PER_MILLION.d1RowsWritten), bound: "estimate" as const }])],
      usage: { kind: "rows", read: r, written: w, queries: q },
      trend: null,
      children: []
    } satisfies CostLine;
  }).filter(line => line.usage.kind === "rows" && ((line.usage.queries?.now ?? 0) + (line.usage.queries?.before ?? 0) > 0 || (line.usage.read?.now ?? 0) > 0 || (line.usage.written?.now ?? 0) > 0));
  const storage = input.databases.map(database => storedLine(
    `d1-storage:${database}`, "d1-storage", `storage · ${database.slice(0, 8)}`,
    metricTrack(history, `d1.${database}.storageBytes`),
    input.previous?.d1 === undefined ? undefined : metricTrack(input.previous.d1, `d1.${database}.storageBytes`),
    input, LIST_PRICE_PER_GB_MONTH.d1Storage
  )).filter(line => line !== null);
  const rowsNow = rowsCost(read?.now ?? 0, written?.now ?? 0);
  const rowsBefore = beforeCost(read, written);
  const storageNow = storage.reduce((sum, line) => sum + (monthlyOf(line)?.now ?? 0), 0);
  const storageBefore = storage.every(line => monthlyOf(line)?.before !== null) ? storage.reduce((sum, line) => sum + (monthlyOf(line)?.before ?? 0), 0) : null;
  const attributed = statementLines.reduce((sum, line) => sum + (monthlyOf(line)?.now ?? 0), 0);
  const children = [...statementLines];
  if (rowsNow - attributed > rowsNow * UNATTRIBUTED_SHARE) {
    children.push({ id: "statement:unattributed", kind: "unrouted", label: "not attributed to a statement", price: priced(rowsNow - attributed, null), parts: [], usage: { kind: "none" }, trend: null, children: [] });
  }
  return {
    id: "d1", kind: "d1", label: "D1",
    price: read === null && written === null && storage.length === 0 ? NO_DATA : priced(rowsNow + storageNow, rowsBefore === null || storageBefore === null ? null : rowsBefore + storageBefore),
    parts: [
      ...(read === null ? [] : [{ label: "rows read", monthly: perMillion(read.now, LIST_PRICE_PER_MILLION.d1RowsRead), bound: "estimate" as const }]),
      ...(written === null ? [] : [{ label: "rows written", monthly: perMillion(written.now, LIST_PRICE_PER_MILLION.d1RowsWritten), bound: "estimate" as const }]),
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
    if (kind.kind === "requests" && line.kind === "worker") { usage.workerRequests = ledger.workerBilling === "cpu-only" ? 0 : kind.calls?.now ?? 0; usage.workerCpuMs = kind.cpuMs?.now ?? 0; }
    if (kind.kind === "objects") { usage.durableObjectRequests = kind.calls?.now ?? 0; usage.durableObjectGbSeconds = ((kind.wallMs?.now ?? 0) / 1000) * DURABLE_OBJECT_MEMORY_GB; usage.durableObjectStorage = stored(line.children.find(child => child.kind === "object-storage")); }
    if (kind.kind === "rows") { usage.d1RowsRead = kind.read?.now ?? 0; usage.d1RowsWritten = kind.written?.now ?? 0; usage.d1Storage = line.children.filter(child => child.kind === "d1-storage").reduce((sum, child) => sum + stored(child), 0); }
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
  const worker = sample.covers(input.current.worker) ? workerLine(input) : emptyLine("worker", "worker", "Worker");
  const lines = byCost([worker, objectsLine(input, sample), d1Line(input, sample), r2Line(input)].filter(line => line !== null));
  const entries = lines.map(line => ({ line, amount: monthlyOf(line) }));
  const now = entries.reduce((sum, entry) => sum + (entry.amount?.now ?? 0), 0);
  const compared = entries.filter(entry => entry.amount !== null && entry.amount.before !== null);
  const change = compared.reduce((sum, entry) => sum + (entry.amount!.now - entry.amount!.before!), 0);
  const uncompared = entries.filter(entry => entry.amount !== null && entry.amount.before === null).map(entry => entry.line.label);
  return { window: input.window, previousWindow: input.previousWindow, monthly: { now, before: compared.length === 0 ? null : now - change }, uncompared, lines, workerBilling: input.workerBilling };
}
