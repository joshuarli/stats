import { HOUR_MS, PROJECT_SETTLE_MS, RANGE_MS, type RangeKey } from "../limits.ts";
import { windowStartMs } from "./collector.ts";
import type { ProjectConfig } from "./config.ts";
import { aggregationOf, D1_ROWS_READ_PER_ROW_WRITTEN_PRICE } from "./parse.ts";
import { BUCKET_MS } from "./queries.ts";
import { PROJECT_HOUR_RETENTION_MS, PROJECT_SAMPLE_RETENTION_MS } from "./store.ts";

const STALE_AFTER_MS = 15 * 60_000;
const MAX_HISTORY_POINTS = 900;
export const PROJECT_KINDS = ["worker", "routes", "durable-objects", "r2", "d1", "d1-statements", "probes", "collector"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
type MetricKind = Exclude<ProjectKind, "collector">;

const BUCKET_WIDTHS_MS = [BUCKET_MS, 15 * 60_000, HOUR_MS, 3 * HOUR_MS] as const;
const WORKER_METRICS = [
  "worker.invocations",
  "worker.cpuMsSum",
  "worker.cpuMsMax",
  "worker.status.2xx",
  "worker.status.3xx",
  "worker.status.4xx",
  "worker.status.5xx",
  "worker.status.other",
];
const DURABLE_OBJECT_METRICS = ["do.invocations", "do.errors", "do.cpuMsSum", "do.cpuMsMax", "do.wallMsSum"];
const D1_METRICS = ["d1.queries", "d1.rowsRead", "d1.rowsWritten"];
const R2_SUFFIXES = ["ops.success", "ops.userError", "ops.other", "storageBytes", "objects"];

interface CollectorSummary {
  readonly lastRunAtMs: number | null;
  readonly lastSuccessAtMs: number | null;
  readonly lastError: string | null;
  readonly stale: boolean;
}

interface MetricHistory {
  readonly projectId: string;
  readonly range: RangeKey;
  readonly kind: MetricKind;
  readonly fromMs: number;
  readonly toMs: number;
  readonly stepMs: number;
  readonly series: readonly { readonly metric: string; readonly values: readonly (number | null)[] }[];
}

interface CollectorHistory {
  readonly projectId: string;
  readonly range: RangeKey;
  readonly kind: "collector";
  readonly fromMs: number;
  readonly toMs: number;
  readonly runs: readonly {
    readonly atMs: number;
    readonly ok: boolean;
    readonly detail: string;
    readonly rowsRead: number;
    readonly durationMs: number;
  }[];
}

export type ProjectHistory = MetricHistory | CollectorHistory;

export interface ProjectHistoryBundle {
  readonly projectId: string;
  readonly histories: Readonly<Partial<Record<ProjectKind, ProjectHistory>>>;
}

export function bucketWidthMs(rangeMs: number): number {
  const width = BUCKET_WIDTHS_MS.find((candidate) => rangeMs / candidate <= MAX_HISTORY_POINTS);
  if (width === undefined) {
    throw new RangeError("range is too long for the widest bucket");
  }
  return width;
}

export function projectKind(value: string | null): ProjectKind | null {
  return value !== null && (PROJECT_KINDS as readonly string[]).includes(value) ? (value as ProjectKind) : null;
}

export function projectKindsValue(value: string): ProjectKind[] | null {
  const kinds: ProjectKind[] = [];
  for (const part of value.split(",")) {
    const kind = projectKind(part);
    if (kind === null) return null;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function expectedMetrics(project: ProjectConfig, kind: MetricKind): string[] {
  switch (kind) {
    case "worker":
      return WORKER_METRICS;
    case "routes":
      return [];
    case "durable-objects":
      return DURABLE_OBJECT_METRICS;
    case "r2":
      return project.buckets.flatMap((bucket) => R2_SUFFIXES.map((suffix) => `r2.${bucket}.${suffix}`));
    case "d1":
      return [...D1_METRICS, ...project.d1Databases.map((id) => `d1.${id}.storageBytes`)];
    case "d1-statements":
      return [];
    case "probes":
      return project.probes.flatMap((probe) => [`probe.${probe.name}.up`, `probe.${probe.name}.ms`]);
  }
}

export function summarizeCollector(sql: SqlStorage, now: number): CollectorSummary {
  const last = sql
    .exec<{ at_ms: number; ok: number; detail: string }>("SELECT at_ms, ok, detail FROM collector_runs ORDER BY id DESC LIMIT 1")
    .toArray()[0];
  const success = sql
    .exec<{ at_ms: number }>("SELECT at_ms FROM collector_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1")
    .toArray()[0];
  const lastSuccessAtMs = success?.at_ms ?? null;
  return {
    lastRunAtMs: last?.at_ms ?? null,
    lastSuccessAtMs,
    lastError: last !== undefined && last.ok === 0 ? last.detail : null,
    stale: lastSuccessAtMs === null || now - lastSuccessAtMs >= STALE_AFTER_MS,
  };
}

export function readCollectorHistory(sql: SqlStorage, project: ProjectConfig, range: RangeKey, now: number): CollectorHistory {
  const fromMs = now - RANGE_MS[range];
  const runs = sql
    .exec<{ at_ms: number; ok: number; detail: string; rows_read: number; duration_ms: number }>(
      "SELECT at_ms, ok, detail, rows_read, duration_ms FROM collector_runs WHERE at_ms >= ? ORDER BY id",
      fromMs,
    )
    .toArray()
    .map((row) => ({ atMs: row.at_ms, ok: row.ok === 1, detail: row.detail, rowsRead: row.rows_read, durationMs: row.duration_ms }));
  return { projectId: project.id, range, kind: "collector", fromMs, toMs: now, runs };
}

interface MetricWindow {
  readonly stepMs: number;
  readonly fromMs: number;
  readonly count: number;
}

function metricWindow(range: RangeKey, now: number): MetricWindow {
  const stepMs = bucketWidthMs(RANGE_MS[range]);
  const retentionMs = stepMs < HOUR_MS ? PROJECT_SAMPLE_RETENTION_MS : PROJECT_HOUR_RETENTION_MS;
  const floored = Math.floor((now - RANGE_MS[range]) / stepMs) * stepMs;
  const fromMs = floored < now - retentionMs ? floored + stepMs : floored;
  const count = Math.floor((now - fromMs) / stepMs) + 1;
  return { stepMs, fromMs, count };
}

export function readProjectHistories(
  sql: SqlStorage,
  project: ProjectConfig,
  range: RangeKey,
  kinds: readonly ProjectKind[],
  now: number,
): ProjectHistoryBundle {
  const metricKinds = kinds.filter((kind): kind is MetricKind => kind !== "collector");
  const metrics = new Map<MetricKind, MetricHistory>();
  if (metricKinds.length > 0) {
    const window = metricWindow(range, now);
    const grouped = readGrouped(sql, project.id, metricKinds, window.stepMs, window.fromMs);
    const fillable = fillableBuckets(sql, window.fromMs, now);
    for (const kind of metricKinds) {
      metrics.set(kind, buildMetricHistory(project, range, kind, grouped.get(kind) ?? new Map(), fillable, window, now));
    }
  }
  const histories: Partial<Record<ProjectKind, ProjectHistory>> = {};
  for (const kind of kinds) {
    if (kind === "collector") histories.collector = readCollectorHistory(sql, project, range, now);
    else histories[kind] = metrics.get(kind)!;
  }
  return { projectId: project.id, histories };
}

export function readMetricHistory(
  sql: SqlStorage,
  project: ProjectConfig,
  range: RangeKey,
  kind: MetricKind,
  now: number,
): MetricHistory {
  return readProjectHistories(sql, project, range, [kind], now).histories[kind] as MetricHistory;
}

function buildMetricHistory(
  project: ProjectConfig,
  range: RangeKey,
  kind: MetricKind,
  rows: Grouped,
  fillable: (startMs: number, endMs: number) => boolean,
  window: MetricWindow,
  now: number,
): MetricHistory {
  const metrics = kind === "routes" ? routeMetrics(rows) : kind === "d1-statements" ? statementMetrics(rows) : expectedMetrics(project, kind);
  const series = metrics.map((metric) => {
    const aggregation = aggregationOf(metric);
    const found = rows.get(metric);
    const values: (number | null)[] = [];
    for (let index = 0; index < window.count; index += 1) {
      const atMs = window.fromMs + index * window.stepMs;
      const row = found?.get(atMs);
      if (row !== undefined) {
        values.push(row[aggregation]);
      } else if (aggregation === "sum" && fillable(atMs, atMs + window.stepMs)) {
        values.push(0);
      } else {
        values.push(null);
      }
    }
    return { metric, values };
  });
  return { projectId: project.id, range, kind, fromMs: window.fromMs, toMs: now, stepMs: window.stepMs, series };
}

type Folded = { sum: number; max: number; min: number };
type Grouped = ReadonlyMap<string, ReadonlyMap<number, Folded>>;

const METRIC_KINDS: readonly MetricKind[] = PROJECT_KINDS.filter((kind): kind is MetricKind => kind !== "collector");

const KIND_PREFIX: Record<MetricKind, string> = {
  worker: "worker.",
  routes: "route.",
  "durable-objects": "do.",
  r2: "r2.",
  d1: "d1.",
  "d1-statements": "d1q.",
  probes: "probe.",
};

function metricKind(metric: string): MetricKind | null {
  for (const kind of METRIC_KINDS) {
    if (metric.startsWith(KIND_PREFIX[kind])) return kind;
  }
  return null;
}

function routeMetrics(rows: Grouped): string[] {
  const cpuTotal = (route: string): number => {
    let total = 0;
    for (const folded of rows.get(`${route}.cpuMsSum`)?.values() ?? []) total += folded.sum;
    return total;
  };
  const routes = new Set([...rows.keys()].map((metric) => metric.slice(0, metric.lastIndexOf("."))));
  return [...routes]
    .sort((left, right) => cpuTotal(right) - cpuTotal(left) || left.localeCompare(right))
    .flatMap((route) => [`${route}.invocations`, `${route}.cpuMsSum`]);
}

function statementMetrics(rows: Grouped): string[] {
  const total = (statement: string, suffix: string): number => {
    let sum = 0;
    for (const folded of rows.get(`${statement}.${suffix}`)?.values() ?? []) sum += folded.sum;
    return sum;
  };
  const cost = (statement: string): number => total(statement, "rowsWritten") + total(statement, "rowsRead") / D1_ROWS_READ_PER_ROW_WRITTEN_PRICE;
  const statements = new Set([...rows.keys()].map((metric) => metric.slice(0, metric.lastIndexOf("."))));
  return [...statements]
    .sort((left, right) => cost(right) - cost(left) || left.localeCompare(right))
    .flatMap((statement) => [`${statement}.queries`, `${statement}.rowsRead`, `${statement}.rowsWritten`]);
}

function readGrouped(
  sql: SqlStorage,
  project: string,
  kinds: readonly MetricKind[],
  stepMs: number,
  fromMs: number,
): ReadonlyMap<MetricKind, Grouped> {
  const prefixes = kinds.map((kind) => KIND_PREFIX[kind]);
  const conditions = prefixes.map(() => "(metric >= ? AND metric < ?)").join(" OR ");
  const [table, column] = stepMs < HOUR_MS ? ["project_samples", "bucket_ms"] : ["project_hours", "hour_ms"];
  const cursor = sql.exec<{ metric: string; at: number; sum_value: number; max_value: number; min_value: number }>(
    `SELECT metric, (${column} / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS at, SUM(value) AS sum_value, MAX(value) AS max_value, MIN(value) AS min_value
     FROM ${table} WHERE project = ? AND (${conditions}) AND ${column} >= ?
     GROUP BY metric, at`,
    stepMs,
    stepMs,
    project,
    ...prefixes.flatMap((prefix) => [prefix, `${prefix}\uffff`]),
    fromMs,
  );
  const grouped = new Map<MetricKind, Map<string, Map<number, Folded>>>();
  for (const row of cursor) {
    const kind = metricKind(row.metric);
    if (kind === null) continue;
    let byMetric = grouped.get(kind);
    if (byMetric === undefined) {
      byMetric = new Map();
      grouped.set(kind, byMetric);
    }
    const byTime = byMetric.get(row.metric) ?? new Map<number, Folded>();
    byTime.set(row.at, { sum: row.sum_value, max: row.max_value, min: row.min_value });
    byMetric.set(row.metric, byTime);
  }
  return grouped;
}

function fillableBuckets(sql: SqlStorage, fromMs: number, now: number): (startMs: number, endMs: number) => boolean {
  const successes = sql
    .exec<{ at_ms: number }>("SELECT at_ms FROM collector_runs WHERE ok = 1 AND at_ms >= ? ORDER BY at_ms", fromMs)
    .toArray()
    .map((row) => row.at_ms);
  const bucketFillable = (bucketStartMs: number): boolean => {
    const settledAtMs = bucketStartMs + BUCKET_MS + PROJECT_SETTLE_MS;
    if (now < settledAtMs) {
      return false;
    }
    const covering = firstAtOrAfter(successes, settledAtMs);
    return covering !== undefined && windowStartMs(covering) <= bucketStartMs;
  };
  return (startMs, endMs) => {
    for (let bucketStartMs = startMs; bucketStartMs < endMs; bucketStartMs += BUCKET_MS) {
      if (!bucketFillable(bucketStartMs)) {
        return false;
      }
    }
    return true;
  };
}

function firstAtOrAfter(sorted: readonly number[], target: number): number | undefined {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] as number) < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return sorted[low];
}
