import { catalog, CATALOG_VERSION } from "./catalog.ts";
import { isDecimal, isU64, MAX_SCRAPE_BYTES, type Drops, type Histogram, type Values } from "./exposition.ts";

export const INFRA_METRICS_SCHEMA = "stats-infra-metrics/2";
export const MAX_METRIC_BATCH_BYTES = 65536;
export const MAX_METRIC_TARGETS = 16;
export const MAX_METRIC_QUEUE = 32;
export const MAX_METRIC_PAYLOAD_BYTES = 8192;

export type Scrape = {
  target: string; sequence: number; atMs: number; monoMs: number; outcome: string;
  durationUs: number; bytes: number; release: { runtime: string; app: string | null };
  process: { startTime: string | null }; dropped: Drops; values: Values;
};
export type TargetDelivery = { scraped: number; accepted: number; duplicates: number; rejected: number; dropped: number; failed: number };
export type Batch = {
  schema: typeof INFRA_METRICS_SCHEMA; catalog: typeof CATALOG_VERSION;
  collector: { name: string; instance: string; startedAtMs: number };
  expected: string[];
  delivery: { atMs: number; queued: number; queueHigh: number; targets: Record<string, TargetDelivery> };
  scrapes: Scrape[];
};

function fail(): never { throw new Error("invalid_batch"); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) return fail();
  return result;
}
function count(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
}
function text(value: unknown, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail();
}
const targetPattern = /^(?:worker:[a-z][a-z0-9-]{0,63}:(?:[0-9]|1[0-5])|engine:[a-z][a-z0-9-]{0,63})$/u;
function validateValues(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  let size = 0;
  for (const [name, entries] of Object.entries(input as Record<string, unknown>)) {
    const spec = catalog[name];
    if (!spec || !Array.isArray(entries) || entries.length > 256) fail();
    const seen = new Set<string>();
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length !== 2) fail();
      const labels = record(pair[0], Object.keys(spec.labels));
      for (const [key, value] of Object.entries(labels)) if (typeof value !== "string" || !spec.labels[key]?.includes(value)) fail();
      const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
      if (seen.has(key)) fail();
      seen.add(key);
      size++;
      if (spec.type === "histogram") {
        const h = record(pair[1], ["buckets", "count", "sum"]) as unknown as Histogram;
        if (!Array.isArray(h.buckets) || h.buckets.length !== spec.buckets?.length || !h.buckets.every((v) => typeof v === "string" && isU64(v)) || typeof h.count !== "string" || !isU64(h.count) || typeof h.sum !== "string" || !isDecimal(h.sum)) fail();
        if (h.buckets.some((v, i) => i > 0 && BigInt(v) < BigInt(h.buckets[i - 1]!)) || h.buckets.at(-1) !== h.count) fail();
      } else if (typeof pair[1] !== "string" || !(spec.form === "u64" ? isU64(pair[1]) : isDecimal(pair[1]))) fail();
    }
  }
  if (size > 256) fail();
}
export function validateBatch(input: unknown): Batch {
  const b = record(input, ["schema", "catalog", "collector", "expected", "delivery", "scrapes"]);
  if (b.schema !== INFRA_METRICS_SCHEMA || b.catalog !== CATALOG_VERSION) fail();
  const collector = record(b.collector, ["name", "instance", "startedAtMs"]);
  text(collector.name, /^[a-z][a-z0-9-]{0,31}$/u);
  text(collector.instance, /^[a-f0-9]{16}$/u);
  count(collector.startedAtMs);
  if (!Array.isArray(b.expected) || b.expected.length > MAX_METRIC_TARGETS || new Set(b.expected).size !== b.expected.length) fail();
  for (const target of b.expected) text(target, targetPattern);
  const delivery = record(b.delivery, ["atMs", "queued", "queueHigh", "targets"]);
  count(delivery.atMs); count(delivery.queued); count(delivery.queueHigh);
  const targets = record(delivery.targets, b.expected as string[]);
  for (const value of Object.values(targets)) {
    const counters = record(value, ["scraped", "accepted", "duplicates", "rejected", "dropped", "failed"]);
    for (const counter of Object.values(counters)) count(counter);
    if ((counters.accepted as number) + (counters.duplicates as number) + (counters.rejected as number) + (counters.dropped as number) > (counters.scraped as number)) fail();
  }
  if ((delivery.queued as number) > MAX_METRIC_QUEUE || (delivery.queueHigh as number) > MAX_METRIC_QUEUE) fail();
  if (!Array.isArray(b.scrapes) || b.scrapes.length > MAX_METRIC_TARGETS) fail();
  const pairs = new Set<string>();
  for (const item of b.scrapes) {
    const s = record(item, ["target", "sequence", "atMs", "monoMs", "outcome", "durationUs", "bytes", "release", "process", "dropped", "values"]);
    text(s.target, targetPattern);
    if (!b.expected.includes(s.target)) fail();
    for (const key of ["sequence", "atMs", "monoMs", "durationUs", "bytes"]) count(s[key]);
    if (s.sequence === 0 || (s.bytes as number) > MAX_SCRAPE_BYTES) fail();
    const pair = `${s.target}:${String(s.sequence)}`;
    if (pairs.has(pair)) fail();
    pairs.add(pair);
    if (!["ok", "timeout", "refused", "http_status", "too_large", "parse_error", "identity_mismatch"].includes(s.outcome as string)) fail();
    const release = record(s.release, ["runtime", "app"]);
    text(release.runtime, /^rt-[a-f0-9]{12}$/u);
    if (s.target.startsWith("engine:")) { if (release.app !== null) fail(); }
    else text(release.app, /^[a-f0-9]{12}$/u);
    const process = record(s.process, ["startTime"]);
    if (process.startTime !== null && (typeof process.startTime !== "string" || !isDecimal(process.startTime))) fail();
    const dropped = record(s.dropped, ["unlisted_family", "unlisted_label", "non_finite", "series_cap"]);
    for (const value of Object.values(dropped)) count(value);
    validateValues(s.values);
    if (s.outcome !== "ok" && Object.keys(s.values as object).length) fail();
    if (s.outcome === "ok" && s.target.startsWith("worker:")) {
      const [, worker, index] = s.target.split(":");
      const values = s.values as Values;
      const identity = values.openorange_worker_info;
      const start = values.openorange_worker_start_time_seconds;
      if (identity?.length !== 1 || identity[0]?.[0].worker !== worker || identity[0]?.[0].index !== index || identity[0]?.[1] !== "1" || start?.length !== 1 || start[0]?.[1] !== process.startTime) fail();
    }
    if (new TextEncoder().encode(JSON.stringify({ values: s.values, dropped: s.dropped, durationUs: s.durationUs, bytes: s.bytes })).length > MAX_METRIC_PAYLOAD_BYTES) fail();
  }
  return input as Batch;
}
export function encodeBatch(batch: Batch): string {
  validateBatch(batch);
  const json = JSON.stringify(batch);
  if (new TextEncoder().encode(json).length > MAX_METRIC_BATCH_BYTES) fail();
  return json;
}
export function decodeBatch(json: string): Batch {
  if (new TextEncoder().encode(json).length > MAX_METRIC_BATCH_BYTES) fail();
  try { return validateBatch(JSON.parse(json)); } catch { return fail(); }
}
