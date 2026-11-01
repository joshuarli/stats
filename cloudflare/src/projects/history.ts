import { HOUR_MS, RANGE_MS, type RangeKey } from "../limits.ts";
import { windowStartMs } from "./collector.ts";
import type { ProjectConfig } from "./config.ts";
import { aggregationOf } from "./parse.ts";
import { BUCKET_MS } from "./queries.ts";

export const SETTLE_MS = 45 * 60_000;
export const STALE_AFTER_MS = 15 * 60_000;
export const MAX_HISTORY_POINTS = 900;
export const PROJECT_KINDS = ["worker", "r2", "probes", "collector"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

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
const R2_SUFFIXES = ["ops.success", "ops.userError", "ops.other", "storageBytes", "objects"];

export interface CollectorSummary {
  readonly lastRunAtMs: number | null;
  readonly lastSuccessAtMs: number | null;
  readonly lastError: string | null;
  readonly stale: boolean;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly worker: string;
  readonly buckets: readonly string[];
  readonly probes: readonly { readonly name: string; readonly url: string }[];
  readonly collector: CollectorSummary;
}

export interface MetricHistory {
  readonly projectId: string;
  readonly range: RangeKey;
  readonly kind: Exclude<ProjectKind, "collector">;
  readonly fromMs: number;
  readonly toMs: number;
  readonly stepMs: number;
  readonly series: readonly { readonly metric: string; readonly values: readonly (number | null)[] }[];
}

export interface CollectorHistory {
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

export function expectedMetrics(project: ProjectConfig, kind: Exclude<ProjectKind, "collector">): string[] {
  switch (kind) {
    case "worker":
      return WORKER_METRICS;
    case "r2":
      return project.buckets.flatMap((bucket) => R2_SUFFIXES.map((suffix) => `r2.${bucket}.${suffix}`));
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

export function readMetricHistory(
  sql: SqlStorage,
  project: ProjectConfig,
  range: RangeKey,
  kind: Exclude<ProjectKind, "collector">,
  now: number,
): MetricHistory {
  const stepMs = bucketWidthMs(RANGE_MS[range]);
  const fromMs = Math.floor((now - RANGE_MS[range]) / stepMs) * stepMs;
  const count = Math.floor((now - fromMs) / stepMs) + 1;
  const metrics = expectedMetrics(project, kind);
  const rows = readGrouped(sql, project.id, kind, stepMs, fromMs);
  const fillable = fillableBuckets(sql, fromMs, now);
  const series = metrics.map((metric) => {
    const aggregation = aggregationOf(metric);
    const found = rows.get(metric);
    const values: (number | null)[] = [];
    for (let index = 0; index < count; index += 1) {
      const atMs = fromMs + index * stepMs;
      const row = found?.get(atMs);
      if (row !== undefined) {
        values.push(aggregation === "sum" ? row.sum : row.max);
      } else if (aggregation === "sum" && fillable(atMs, atMs + stepMs)) {
        values.push(0);
      } else {
        values.push(null);
      }
    }
    return { metric, values };
  });
  return { projectId: project.id, range, kind, fromMs, toMs: now, stepMs, series };
}

type Grouped = ReadonlyMap<string, ReadonlyMap<number, { sum: number; max: number }>>;

const KIND_PREFIX: Record<Exclude<ProjectKind, "collector">, string> = { worker: "worker.", r2: "r2.", probes: "probe." };

function readGrouped(
  sql: SqlStorage,
  project: string,
  kind: Exclude<ProjectKind, "collector">,
  stepMs: number,
  fromMs: number,
): Grouped {
  const prefix = KIND_PREFIX[kind];
  const [table, column] = stepMs < HOUR_MS ? ["project_samples", "bucket_ms"] : ["project_hours", "hour_ms"];
  const cursor = sql.exec<{ metric: string; at: number; sum_value: number; max_value: number }>(
    `SELECT metric, (${column} / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS at, SUM(value) AS sum_value, MAX(value) AS max_value
     FROM ${table} WHERE project = ? AND metric >= ? AND metric < ? AND ${column} >= ?
     GROUP BY metric, at`,
    stepMs,
    stepMs,
    project,
    prefix,
    `${prefix}\uffff`,
    fromMs,
  );
  const grouped = new Map<string, Map<number, { sum: number; max: number }>>();
  for (const row of cursor) {
    const byTime = grouped.get(row.metric) ?? new Map<number, { sum: number; max: number }>();
    byTime.set(row.at, { sum: row.sum_value, max: row.max_value });
    grouped.set(row.metric, byTime);
  }
  return grouped;
}

function fillableBuckets(sql: SqlStorage, fromMs: number, now: number): (startMs: number, endMs: number) => boolean {
  const successes = sql
    .exec<{ at_ms: number }>("SELECT at_ms FROM collector_runs WHERE ok = 1 AND at_ms >= ? ORDER BY at_ms", fromMs)
    .toArray()
    .map((row) => row.at_ms);
  const bucketFillable = (bucketStartMs: number): boolean => {
    const settledAtMs = bucketStartMs + BUCKET_MS + SETTLE_MS;
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
