import { catalog } from "./catalog.ts";
import { isDecimal, isU64, type Drops, type Histogram, type Values } from "./exposition.ts";

export type Scrape = {
  target: string; sequence: number; atMs: number; monoMs: number; outcome: string;
  durationUs: number; bytes: number; release: { runtime: string; app: string | null };
  process: { startTime: string | null }; dropped: Drops; values: Values;
};
export type Batch = {
  schema: "stats-infra-metrics/1"; catalog: 1;
  collector: { name: string; instance: string; startedAtMs: number };
  expected: string[];
  delivery: { queued: number; queueHigh: number; dropped: number; retries: number; rejected: number };
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
  if (b.schema !== "stats-infra-metrics/1" || b.catalog !== 1) fail();
  const collector = record(b.collector, ["name", "instance", "startedAtMs"]);
  text(collector.name, /^[a-z][a-z0-9-]{0,31}$/u);
  text(collector.instance, /^[a-f0-9]{16}$/u);
  count(collector.startedAtMs);
  if (!Array.isArray(b.expected) || b.expected.length > 16 || new Set(b.expected).size !== b.expected.length) fail();
  for (const target of b.expected) text(target, targetPattern);
  const delivery = record(b.delivery, ["queued", "queueHigh", "dropped", "retries", "rejected"]);
  for (const value of Object.values(delivery)) count(value);
  if ((delivery.queued as number) > 32 || (delivery.queueHigh as number) > 32) fail();
  if (!Array.isArray(b.scrapes) || b.scrapes.length > 16) fail();
  const pairs = new Set<string>();
  for (const item of b.scrapes) {
    const s = record(item, ["target", "sequence", "atMs", "monoMs", "outcome", "durationUs", "bytes", "release", "process", "dropped", "values"]);
    text(s.target, targetPattern);
    if (!b.expected.includes(s.target)) fail();
    for (const key of ["sequence", "atMs", "monoMs", "durationUs", "bytes"]) count(s[key]);
    if (s.sequence === 0 || (s.bytes as number) > 1024 * 1024) fail();
    const pair = `${s.target}:${String(s.sequence)}`;
    if (pairs.has(pair)) fail();
    pairs.add(pair);
    if (!["ok", "timeout", "refused", "http_status", "too_large", "parse_error", "identity_mismatch"].includes(s.outcome as string)) fail();
    const release = record(s.release, ["runtime", "app"]);
    text(release.runtime, /^oor-[a-f0-9]{16}$/u);
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
    if (new TextEncoder().encode(JSON.stringify({ values: s.values, dropped: s.dropped, durationUs: s.durationUs, bytes: s.bytes })).length > 8192) fail();
  }
  return input as Batch;
}
export function encodeBatch(batch: Batch): string {
  validateBatch(batch);
  const json = JSON.stringify(batch);
  if (new TextEncoder().encode(json).length > 65536) fail();
  return json;
}
export function decodeBatch(json: string): Batch {
  if (new TextEncoder().encode(json).length > 65536) fail();
  try { return validateBatch(JSON.parse(json)); } catch { return fail(); }
}
