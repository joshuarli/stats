import { BUCKET_MS } from "./queries.ts";

type Aggregation = "sum" | "max";

export interface MetricPoint {
  readonly metric: string;
  readonly bucketMs: number;
  readonly value: number;
}

type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";

type R2Outcome = "success" | "userError" | "other";

const FIXED_AGGREGATIONS: Readonly<Record<string, Aggregation>> = {
  "worker.invocations": "sum",
  "worker.cpuMsSum": "sum",
  "worker.cpuMsMax": "max",
  "worker.status.2xx": "sum",
  "worker.status.3xx": "sum",
  "worker.status.4xx": "sum",
  "worker.status.5xx": "sum",
  "worker.status.other": "sum",
};

const PATTERN_AGGREGATIONS: readonly (readonly [RegExp, Aggregation])[] = [
  [/^r2\.[a-z0-9][a-z0-9-]{1,62}\.ops\.(success|userError|other)$/, "sum"],
  [/^r2\.[a-z0-9][a-z0-9-]{1,62}\.(storageBytes|objects)$/, "max"],
  [/^probe\.[a-z][a-z0-9-]{0,31}\.(up|ms)$/, "max"],
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

export function statusClass(httpStatus: number): StatusClass {
  if (httpStatus >= 200 && httpStatus < 300) return "2xx";
  if (httpStatus >= 300 && httpStatus < 400) return "3xx";
  if (httpStatus >= 400 && httpStatus < 500) return "4xx";
  if (httpStatus >= 500 && httpStatus < 600) return "5xx";
  return "other";
}

function r2Outcome(actionStatus: string): R2Outcome {
  if (actionStatus === "success") return "success";
  if (actionStatus === "userError") return "userError";
  return "other";
}

export function workerBucketMs(day: string, hour: number, slot: number): number {
  const dayMs = parseUtc(day, DAY_PATTERN, "day");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError("analytics row has an invalid hour");
  }
  if (!Number.isInteger(slot) || slot < 0 || slot > 11) {
    throw new RangeError("analytics row has an invalid slot");
  }
  return dayMs + hour * 3_600_000 + slot * BUCKET_MS;
}

export function parseWorkerRows(rows: readonly unknown[]): MetricPoint[] {
  const points = new PointSet();
  for (const row of rows) {
    const record = asRecord(row);
    const bucketMs = workerBucketMs(
      text(record, "day"),
      count(record, "hour"),
      count(record, "slot"),
    );
    const invocations = count(record, "invocations");
    const cpuSum = count(record, "cpu_sum");
    const cpuMax = count(record, "cpu_max");
    points.add("worker.invocations", bucketMs, invocations);
    points.add("worker.cpuMsSum", bucketMs, cpuSum);
    points.add("worker.cpuMsMax", bucketMs, cpuMax);
    points.add(`worker.status.${statusClass(count(record, "httpStatus"))}`, bucketMs, invocations);
  }
  return points.list();
}

export function parseR2OperationRows(rows: readonly unknown[]): MetricPoint[] {
  const points = new PointSet();
  for (const row of rows) {
    const record = asRecord(row);
    const bucketMs = parseUtc(text(record, "bucket"), DATETIME_PATTERN, "bucket");
    const metric = `r2.${text(record, "bucketName")}.ops.${r2Outcome(text(record, "actionStatus"))}`;
    points.add(metric, bucketMs, count(record, "operations"));
  }
  return points.list();
}

export function parseR2StorageRows(rows: readonly unknown[]): MetricPoint[] {
  const points = new PointSet();
  for (const row of rows) {
    const record = asRecord(row);
    const bucketMs = parseUtc(text(record, "bucket"), DATETIME_PATTERN, "bucket");
    const name = text(record, "bucketName");
    points.add(`r2.${name}.storageBytes`, bucketMs, count(record, "storage_bytes"));
    points.add(`r2.${name}.objects`, bucketMs, count(record, "objects"));
  }
  return points.list();
}

class PointSet {
  private readonly values = new Map<string, MetricPoint>();

  add(metric: string, bucketMs: number, value: number): void {
    const aggregation = aggregationOf(metric);
    const key = `${metric}\n${bucketMs}`;
    const existing = this.values.get(key);
    const merged =
      existing === undefined
        ? value
        : aggregation === "sum"
          ? existing.value + value
          : Math.max(existing.value, value);
    this.values.set(key, { metric, bucketMs, value: merged });
  }

  list(): MetricPoint[] {
    return [...this.values.values()];
  }
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function parseUtc(value: string, pattern: RegExp, field: string): number {
  const match = pattern.exec(value);
  if (match === null) {
    throw new RangeError(`analytics row has an invalid ${field}`);
  }
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1).map(Number);
  const ms = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour, minute, second);
  if (!Number.isFinite(ms)) {
    throw new RangeError(`analytics row has an invalid ${field}`);
  }
  return ms;
}

function asRecord(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new TypeError("analytics row is not an object");
  }
  return row as Record<string, unknown>;
}

function text(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`analytics row is missing ${field}`);
  }
  return value;
}

function count(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(\.\d+)?$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`analytics row has an invalid ${field}`);
  }
  return parsed;
}
