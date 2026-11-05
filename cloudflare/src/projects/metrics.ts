import { BUCKET_MS } from "./queries.ts";

const COLLECTION_WINDOW_MS = 90 * 60_000;
export const D1_ROWS_READ_PER_ROW_WRITTEN_PRICE = 1000;

export type Aggregation = "sum" | "max" | "min";

export interface MetricPoint {
  readonly metric: string;
  readonly bucketMs: number;
  readonly value: number;
}

const FIXED_AGGREGATIONS: Readonly<Record<string, Aggregation>> = {
  "worker.invocations": "sum",
  "worker.cpuMsSum": "sum",
  "worker.cpuMsMax": "max",
  "worker.status.2xx": "sum",
  "worker.status.3xx": "sum",
  "worker.status.4xx": "sum",
  "worker.status.5xx": "sum",
  "worker.status.other": "sum",
  "do.invocations": "sum",
  "do.errors": "sum",
  "do.cpuMsSum": "sum",
  "do.cpuMsMax": "max",
  "do.wallMsSum": "sum",
  "do.storageBytes": "max",
  "d1.queries": "sum",
  "d1.rowsRead": "sum",
  "d1.rowsWritten": "sum",
};

const PATTERN_AGGREGATIONS: readonly (readonly [RegExp, Aggregation])[] = [
  [/^route\..{1,80}\.(invocations|cpuMsSum)$/, "sum"],
  [/^d1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.storageBytes$/, "max"],
  [/^d1q\..{1,60}\.(queries|rowsRead|rowsWritten)$/, "sum"],
  [/^r2\.[a-z0-9][a-z0-9-]{1,62}\.ops\.(success|userError|other)$/, "sum"],
  [/^r2\.[a-z0-9][a-z0-9-]{1,62}\.(storageBytes|objects)$/, "max"],
  [/^probe\.[a-z][a-z0-9-]{0,31}\.up$/, "min"],
  [/^probe\.[a-z][a-z0-9-]{0,31}\.ms$/, "max"],
];

export function aggregationOf(metric: string): Aggregation {
  const fixed = FIXED_AGGREGATIONS[metric];
  if (fixed !== undefined) {
    return fixed;
  }
  for (const [pattern, aggregation] of PATTERN_AGGREGATIONS) {
    if (pattern.test(metric)) {
      return aggregation;
    }
  }
  throw new RangeError("unknown project metric");
}

export function windowStartMs(now: number): number {
  return Math.floor((now - COLLECTION_WINDOW_MS) / BUCKET_MS) * BUCKET_MS;
}
