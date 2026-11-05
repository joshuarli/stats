import { COUNT_BUCKET_MS, MAX_LABEL_BYTES, MAX_OUTCOME_ROUTES_PER_CLASS, RETENTION_MS } from "./limits.ts";
import { COUNT_OUTCOMES, EXCLUDED_OUTCOMES, OPERATION, OTHER_ROUTE, VERSION, utf8Length, type CountDelta, type Stage } from "./model.ts";
import type { SampledPolicy } from "./sampling.ts";
import type { SqlStatements, SqlValue } from "../../core/sql.ts";

export interface SamplingEvents {
  readonly untraced: number;
  readonly flush: number;
}

export const COUNT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS observe_counts (
    bucket_at INTEGER PRIMARY KEY,
    untraced INTEGER NOT NULL,
    flushes INTEGER NOT NULL,
    entries TEXT NOT NULL CHECK (json_valid(entries))
  ) WITHOUT ROWID`,
  `CREATE VIEW IF NOT EXISTS observe_count_entries AS
    SELECT c.bucket_at AS bucket_at,
      json_extract(e.value, '$.version') AS version,
      json_extract(e.value, '$.stage') AS stage,
      json_extract(e.value, '$.outcome') AS outcome,
      json_extract(e.value, '$.route') AS route,
      json_extract(e.value, '$.operation') AS operation,
      json_extract(e.value, '$.kept') AS kept,
      json_extract(e.value, '$.sampledOut') AS sampled_out,
      json_extract(e.value, '$.cpuMsSum') AS cpu_ms_sum,
      json_extract(e.value, '$.wallMsSum') AS wall_ms_sum
    FROM observe_counts c, json_each(c.entries) e`
];

export function eventBucket(eventAtMs: number | null, nowMs: number, widthMs: number): number {
  const at = eventAtMs === null ? nowMs : Math.min(eventAtMs, nowMs);
  return at - (at % widthMs);
}

export function countBucket(eventAtMs: number, nowMs: number): number {
  return eventBucket(eventAtMs, nowMs, COUNT_BUCKET_MS);
}

function deltaKey(delta: CountDelta): string {
  return [delta.bucketAt, delta.version, delta.stage, delta.outcome, delta.route, delta.operation].join("\u0000");
}

export function addCount(into: Map<string, CountDelta>, delta: CountDelta): void {
  const key = deltaKey(delta);
  const existing = into.get(key);
  into.set(key, existing === undefined ? delta : {
    ...existing,
    kept: existing.kept + delta.kept,
    sampledOut: existing.sampledOut + delta.sampledOut,
    capped: existing.capped + delta.capped,
    cpuMsSum: existing.cpuMsSum + delta.cpuMsSum,
    wallMsSum: existing.wallMsSum + delta.wallMsSum
  });
}

function wellFormed(delta: CountDelta): boolean {
  const integers = [delta.kept, delta.sampledOut, delta.capped, delta.cpuMsSum, delta.wallMsSum];
  return Number.isSafeInteger(delta.bucketAt) && delta.bucketAt > 0 && delta.bucketAt % COUNT_BUCKET_MS === 0
    && integers.every(value => Number.isSafeInteger(value) && value >= 0) && delta.kept + delta.sampledOut > 0 && delta.capped <= delta.sampledOut
    && (delta.version === "" || VERSION.test(delta.version))
    && (delta.stage === "worker" || delta.stage === "object")
    && (COUNT_OUTCOMES as readonly string[]).includes(delta.outcome)
    && (delta.operation === "" || OPERATION.test(delta.operation))
    && delta.route !== "" && utf8Length(delta.route) <= MAX_LABEL_BYTES;
}

export interface CountsRecorded {
  readonly invalid: number;
  readonly expired: number;
}

type StoredEntry = Omit<CountDelta, "bucketAt" | "capped"> & { readonly capped?: number };

interface BucketCounts {
  readonly bucketAt: number;
  readonly entries: Map<string, CountDelta>;
  readonly routes: Map<string, Set<string>>;
}

function routeGroup(delta: CountDelta): string {
  return [delta.version, delta.stage, delta.outcome].join("\u0000");
}

function loadBucket(db: SqlStatements, bucketAt: number): BucketCounts {
  const entries = new Map<string, CountDelta>();
  const routes = new Map<string, Set<string>>();
  const stored = db.rows<{ entries: string }>("SELECT entries FROM observe_counts WHERE bucket_at = ?", bucketAt)[0];
  for (const entry of stored === undefined ? [] : JSON.parse(stored.entries) as StoredEntry[]) {
    const delta = { ...entry, capped: entry.capped ?? 0, bucketAt };
    entries.set(deltaKey(delta), delta);
    const group = routeGroup(delta);
    const known = routes.get(group);
    if (known === undefined) routes.set(group, new Set([delta.route])); else known.add(delta.route);
  }
  return { bucketAt, entries, routes };
}

function storeBucket(db: SqlStatements, bucket: BucketCounts, events: SamplingEvents): void {
  const entries = [...bucket.entries.values()].map((delta): StoredEntry => ({
    version: delta.version, stage: delta.stage, outcome: delta.outcome, route: delta.route, operation: delta.operation,
    kept: delta.kept, sampledOut: delta.sampledOut, capped: delta.capped, cpuMsSum: delta.cpuMsSum, wallMsSum: delta.wallMsSum
  }));
  db.run(
    `INSERT INTO observe_counts (bucket_at, untraced, flushes, entries) VALUES (?, ?, ?, ?)
     ON CONFLICT (bucket_at) DO UPDATE SET untraced = untraced + excluded.untraced, flushes = flushes + excluded.flushes, entries = excluded.entries`,
    bucket.bucketAt, events.untraced, events.flush, JSON.stringify(entries)
  );
}

export function recordCounts(db: SqlStatements, nowMs: number, deltas: readonly CountDelta[], events: SamplingEvents): CountsRecorded {
  let invalid = 0;
  let expired = 0;
  const newest = countBucket(nowMs, nowMs);
  const oldest = nowMs - RETENTION_MS;
  const buckets = new Map<number, BucketCounts>();
  for (const delta of deltas) {
    if (!wellFormed(delta)) { invalid++; continue; }
    if (delta.bucketAt + COUNT_BUCKET_MS <= oldest) { expired++; continue; }
    const bucketAt = Math.min(delta.bucketAt, newest);
    let bucket = buckets.get(bucketAt);
    if (bucket === undefined) {
      bucket = loadBucket(db, bucketAt);
      buckets.set(bucketAt, bucket);
    }
    const group = routeGroup(delta);
    let known = bucket.routes.get(group);
    if (known === undefined) {
      known = new Set();
      bucket.routes.set(group, known);
    }
    const route = known.has(delta.route) || known.size < MAX_OUTCOME_ROUTES_PER_CLASS ? delta.route : OTHER_ROUTE;
    known.add(route);
    addCount(bucket.entries, { ...delta, bucketAt, route });
  }
  if (buckets.size === 0) {
    if (events.untraced === 0 && events.flush === 0) return { invalid, expired };
    buckets.set(newest, loadBucket(db, newest));
  }
  const carrier = Math.max(...buckets.keys());
  for (const bucket of buckets.values()) storeBucket(db, bucket, bucket.bucketAt === carrier ? events : { untraced: 0, flush: 0 });
  return { invalid, expired };
}

export function cleanupCounts(db: SqlStatements, cutoff: number): void {
  db.run("DELETE FROM observe_counts WHERE bucket_at <= ?", cutoff - COUNT_BUCKET_MS);
}

export function oldestCountExpiryMs(db: SqlStatements): number | null {
  const oldest = db.rows<{ at: number | null }>("SELECT MIN(bucket_at) AS at FROM observe_counts")[0]?.at ?? null;
  return oldest === null ? null : oldest + COUNT_BUCKET_MS + RETENTION_MS;
}

export interface SamplingSummary {
  readonly keepPerMillion: number;
  readonly kept: number;
  readonly observed: number;
}

export interface SamplingHealth {
  readonly policy: SampledPolicy;
  readonly kept: number;
  readonly sampledOut: number;
  readonly excluded: number;
  readonly untraced: number;
  readonly flushes: number;
  readonly capped: number;
}

const WINDOW = "bucket_at >= ? AND bucket_at < ?";

function windowParams(fromMs: number, toMs: number): [number, number] {
  return [fromMs - (fromMs % COUNT_BUCKET_MS), toMs];
}

export function samplingSummary(db: SqlStatements, policy: SampledPolicy, fromMs: number, toMs: number, stage: Stage | null = null): SamplingSummary {
  const row = db.rows<{ kept: number | null; observed: number | null }>(
    `SELECT SUM(kept) AS kept, SUM(kept + sampled_out) AS observed FROM observe_count_entries WHERE ${WINDOW} AND outcome IN ('ok', 'failed') AND (? IS NULL OR stage = ?)`,
    ...windowParams(fromMs, toMs), stage, stage
  )[0];
  return { keepPerMillion: policy.keepPerMillion, kept: row?.kept ?? 0, observed: row?.observed ?? 0 };
}

export function observedByRoute(db: SqlStatements, fromMs: number, toMs: number, stage: Stage): ReadonlyMap<string, number> {
  const rows = db.rows<{ route: string; observed: number }>(
    `SELECT route, SUM(kept + sampled_out) AS observed FROM observe_count_entries WHERE ${WINDOW} AND outcome IN ('ok', 'failed') AND stage = ? GROUP BY route`,
    ...windowParams(fromMs, toMs), stage
  );
  return new Map(rows.map(row => [row.route, row.observed]));
}

export function samplingHealth(db: SqlStatements, nowMs: number, policy: SampledPolicy): SamplingHealth {
  const cutoff = nowMs - RETENTION_MS;
  const totals = db.rows<{ kept: number | null; sampled_out: number | null; excluded: number | null }>(
    `SELECT SUM(CASE WHEN outcome IN ('ok', 'failed') THEN kept ELSE 0 END) AS kept,
       SUM(CASE WHEN outcome IN ('ok', 'failed') THEN sampled_out ELSE 0 END) AS sampled_out,
       SUM(CASE WHEN outcome IN ('ok', 'failed') THEN 0 ELSE sampled_out END) AS excluded
     FROM observe_count_entries WHERE bucket_at + ? > ?`,
    COUNT_BUCKET_MS, cutoff
  )[0];
  const events = db.rows<{ untraced: number | null; flushes: number | null }>(
    "SELECT SUM(untraced) AS untraced, SUM(flushes) AS flushes FROM observe_counts WHERE bucket_at + ? > ?", COUNT_BUCKET_MS, cutoff
  )[0];
  const capped = db.rows<{ capped: number | null }>(
    "SELECT SUM(json_extract(e.value, '$.capped')) AS capped FROM observe_counts c, json_each(c.entries) e WHERE c.bucket_at + ? > ?", COUNT_BUCKET_MS, cutoff
  )[0];
  return { policy, kept: totals?.kept ?? 0, sampledOut: totals?.sampled_out ?? 0, excluded: totals?.excluded ?? 0, untraced: events?.untraced ?? 0, flushes: events?.flushes ?? 0, capped: capped?.capped ?? 0 };
}

export interface CountWindow {
  readonly invocations: readonly { readonly bucketAt: number; readonly version: string; readonly stage: Stage; readonly count: number }[];
  readonly excluded: readonly { readonly bucketAt: number; readonly version: string; readonly stage: Stage; readonly outcome: typeof EXCLUDED_OUTCOMES[number]; readonly count: number }[];
}

export function countWindow(db: SqlStatements, fromMs: number, toMs: number): CountWindow {
  const params: SqlValue[] = [...windowParams(fromMs, toMs)];
  const invocations = db.rows<{ bucket_at: number; version: string; stage: Stage; count: number }>(
    `SELECT bucket_at, version, stage, SUM(kept + sampled_out) AS count FROM observe_count_entries WHERE ${WINDOW} AND outcome IN ('ok', 'failed')
     GROUP BY bucket_at, version, stage ORDER BY bucket_at, version, stage`, ...params
  ).map(row => ({ bucketAt: row.bucket_at, version: row.version, stage: row.stage, count: row.count }));
  const excluded = db.rows<{ bucket_at: number; version: string; stage: Stage; outcome: typeof EXCLUDED_OUTCOMES[number]; count: number }>(
    `SELECT bucket_at, version, stage, outcome, SUM(sampled_out) AS count FROM observe_count_entries WHERE ${WINDOW} AND outcome NOT IN ('ok', 'failed')
     GROUP BY bucket_at, version, stage, outcome ORDER BY bucket_at, version, stage, outcome`, ...params
  ).map(row => ({ bucketAt: row.bucket_at, version: row.version, stage: row.stage, outcome: row.outcome, count: row.count }));
  return { invocations, excluded };
}

export function versionRequests(db: SqlStatements, nowMs: number, versions: readonly string[]): ReadonlyMap<string, { readonly requests: number; readonly failed: number }> {
  const rows = db.rows<{ version: string; requests: number; failed: number }>(
    `SELECT version, SUM(kept + sampled_out) AS requests, SUM(CASE WHEN outcome = 'failed' THEN kept + sampled_out ELSE 0 END) AS failed FROM observe_count_entries
     WHERE stage = 'worker' AND outcome IN ('ok', 'failed') AND bucket_at + ? > ? AND version IN (SELECT value FROM json_each(?)) GROUP BY version`,
    COUNT_BUCKET_MS, nowMs - RETENTION_MS, JSON.stringify(versions)
  );
  return new Map(rows.map(row => [row.version, row]));
}
