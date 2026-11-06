import { COUNT_BUCKET_MS, MAX_LABEL_BYTES, MAX_OUTCOME_ROUTES_PER_CLASS, RETENTION_MS } from "./limits.ts";
import { COUNT_OUTCOMES, NO_SUMMARY_TOTALS, OPERATION, OTHER_ROUTE, VERSION, utf8Length, type CountDelta, type Stage, type SummaryTotals } from "./model.ts";
import type { SampledPolicy } from "./sampling.ts";
import type { SqlStatements, SqlValue } from "../../core/sql.ts";

type UncountedOutcome = Exclude<typeof COUNT_OUTCOMES[number], "ok" | "failed">;

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
      json_extract(e.value, '$.wallMsSum') AS wall_ms_sum,
      COALESCE(json_extract(e.value, '$.rowAccounts'), 0) AS row_accounts,
      COALESCE(json_extract(e.value, '$.rowsRead'), 0) AS rows_read,
      COALESCE(json_extract(e.value, '$.rowsWritten'), 0) AS rows_written,
      COALESCE(json_extract(e.value, '$.statements'), 0) AS statements,
      COALESCE(json_extract(e.value, '$.workLagCount'), 0) AS work_lag_count,
      COALESCE(json_extract(e.value, '$.workLagMsMax'), 0) AS work_lag_ms_max,
      COALESCE(json_extract(e.value, '$.workLagMsSum'), 0) AS work_lag_ms_sum
    FROM observe_counts c, json_each(c.entries) e`
];

export function upgradeCountEntriesView(db: SqlStatements): void {
  const view = db.rows<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'observe_count_entries'")[0];
  if (view === undefined || view.sql.includes("work_lag_ms_sum")) return;
  db.run("DROP VIEW observe_count_entries");
  db.run(COUNT_STATEMENTS[1]!);
}

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
    wallMsSum: existing.wallMsSum + delta.wallMsSum,
    rowAccounts: existing.rowAccounts + delta.rowAccounts,
    rowsRead: existing.rowsRead + delta.rowsRead,
    rowsWritten: existing.rowsWritten + delta.rowsWritten,
    statements: existing.statements + delta.statements,
    workLagCount: existing.workLagCount + delta.workLagCount,
    workLagMsMax: Math.max(existing.workLagMsMax, delta.workLagMsMax),
    workLagMsSum: existing.workLagMsSum + delta.workLagMsSum
  });
}

const COUNT_TEXT_FIELDS = ["version", "stage", "route", "operation", "outcome"] as const;
const COUNT_NUMBER_FIELDS = ["bucketAt", "kept", "sampledOut", "capped", "cpuMsSum", "wallMsSum", ...Object.keys(NO_SUMMARY_TOTALS) as (keyof SummaryTotals)[]] as const;
const COUNT_FIELDS_ADDED_LATER: Readonly<Record<string, string | number>> = { operation: "", capped: 0, ...NO_SUMMARY_TOTALS };

export function decodeCountDelta(value: unknown): CountDelta | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const sent = value as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of [...COUNT_TEXT_FIELDS, ...COUNT_NUMBER_FIELDS]) fields[key] = sent[key] === undefined ? COUNT_FIELDS_ADDED_LATER[key] : sent[key];
  if (!COUNT_TEXT_FIELDS.every(key => typeof fields[key] === "string") || !COUNT_NUMBER_FIELDS.every(key => typeof fields[key] === "number")) return null;
  return fields as unknown as CountDelta;
}

function wellFormed(delta: CountDelta): boolean {
  const integers = [delta.kept, delta.sampledOut, delta.capped, delta.cpuMsSum, delta.wallMsSum, delta.rowAccounts, delta.rowsRead, delta.rowsWritten, delta.statements, delta.workLagCount, delta.workLagMsMax, delta.workLagMsSum];
  const invocations = delta.kept + delta.sampledOut;
  return Number.isSafeInteger(delta.bucketAt) && delta.bucketAt > 0 && delta.bucketAt % COUNT_BUCKET_MS === 0
    && integers.every(value => Number.isSafeInteger(value) && value >= 0) && invocations > 0 && delta.capped <= delta.sampledOut
    && delta.rowAccounts <= invocations && (delta.rowAccounts > 0 || delta.rowsRead + delta.rowsWritten + delta.statements === 0)
    && delta.workLagCount <= invocations && delta.workLagMsMax <= delta.workLagMsSum && (delta.workLagCount > 0 || delta.workLagMsSum === 0)
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

type StoredEntry = Omit<CountDelta, "bucketAt" | "capped" | keyof SummaryTotals> & { readonly capped?: number } & Partial<SummaryTotals>;

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
    const delta: CountDelta = { ...NO_SUMMARY_TOTALS, ...entry, capped: entry.capped ?? 0, bucketAt };
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
    kept: delta.kept, sampledOut: delta.sampledOut, capped: delta.capped, cpuMsSum: delta.cpuMsSum, wallMsSum: delta.wallMsSum,
    ...(delta.rowAccounts === 0 ? {} : { rowAccounts: delta.rowAccounts, rowsRead: delta.rowsRead, rowsWritten: delta.rowsWritten, statements: delta.statements }),
    ...(delta.workLagCount === 0 ? {} : { workLagCount: delta.workLagCount, workLagMsMax: delta.workLagMsMax, workLagMsSum: delta.workLagMsSum })
  }));
  db.run(
    `INSERT INTO observe_counts (bucket_at, untraced, flushes, entries) VALUES (?, ?, ?, ?)
     ON CONFLICT (bucket_at) DO UPDATE SET untraced = untraced + excluded.untraced, flushes = flushes + excluded.flushes, entries = excluded.entries`,
    bucket.bucketAt, events.untraced, events.flush, JSON.stringify(entries)
  );
}

export function recordCounts(db: SqlStatements, nowMs: number, sent: readonly unknown[], events: SamplingEvents): CountsRecorded {
  let invalid = 0;
  let expired = 0;
  const newest = countBucket(nowMs, nowMs);
  const oldest = nowMs - RETENTION_MS;
  const buckets = new Map<number, BucketCounts>();
  for (const value of sent) {
    const delta = decodeCountDelta(value);
    if (delta === null || !wellFormed(delta)) { invalid++; continue; }
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
  readonly excluded: readonly { readonly bucketAt: number; readonly version: string; readonly stage: Stage; readonly outcome: UncountedOutcome; readonly count: number }[];
}

export function countWindow(db: SqlStatements, fromMs: number, toMs: number): CountWindow {
  const params: SqlValue[] = [...windowParams(fromMs, toMs)];
  const invocations = db.rows<{ bucket_at: number; version: string; stage: Stage; count: number }>(
    `SELECT bucket_at, version, stage, SUM(kept + sampled_out) AS count FROM observe_count_entries WHERE ${WINDOW} AND outcome IN ('ok', 'failed')
     GROUP BY bucket_at, version, stage ORDER BY bucket_at, version, stage`, ...params
  ).map(row => ({ bucketAt: row.bucket_at, version: row.version, stage: row.stage, count: row.count }));
  const excluded = db.rows<{ bucket_at: number; version: string; stage: Stage; outcome: UncountedOutcome; count: number }>(
    `SELECT bucket_at, version, stage, outcome, SUM(sampled_out) AS count FROM observe_count_entries WHERE ${WINDOW} AND outcome NOT IN ('ok', 'failed')
     GROUP BY bucket_at, version, stage, outcome ORDER BY bucket_at, version, stage, outcome`, ...params
  ).map(row => ({ bucketAt: row.bucket_at, version: row.version, stage: row.stage, outcome: row.outcome, count: row.count }));
  return { invocations, excluded };
}

export interface CountedRoute extends SummaryTotals {
  readonly version: string;
  readonly stage: Stage;
  readonly route: string;
  readonly operation: string;
  readonly count: number;
  readonly failed: number;
  readonly cpuMsSum: number;
  readonly wallMsSum: number;
}

export function countedRoutes(db: SqlStatements, fromMs: number, toMs: number, operation?: string): CountedRoute[] {
  return db.rows<{ version: string; stage: Stage; route: string; operation: string; count: number; failed: number; cpu_ms_sum: number; wall_ms_sum: number; row_accounts: number; rows_read: number; rows_written: number; statements: number; work_lag_count: number; work_lag_ms_max: number; work_lag_ms_sum: number }>(
    `SELECT version, stage, route, operation, SUM(kept + sampled_out) AS count, SUM(CASE WHEN outcome = 'failed' THEN kept + sampled_out ELSE 0 END) AS failed,
       SUM(cpu_ms_sum) AS cpu_ms_sum, SUM(wall_ms_sum) AS wall_ms_sum, SUM(row_accounts) AS row_accounts, SUM(rows_read) AS rows_read, SUM(rows_written) AS rows_written,
       SUM(statements) AS statements, SUM(work_lag_count) AS work_lag_count, MAX(work_lag_ms_max) AS work_lag_ms_max, SUM(work_lag_ms_sum) AS work_lag_ms_sum
     FROM observe_count_entries WHERE ${WINDOW} AND outcome IN ('ok', 'failed') AND (? IS NULL OR operation = ?)
     GROUP BY version, stage, route, operation ORDER BY version, stage, route, operation`,
    ...windowParams(fromMs, toMs), operation ?? null, operation ?? null
  ).map(row => ({
    version: row.version, stage: row.stage, route: row.route, operation: row.operation, count: row.count, failed: row.failed, cpuMsSum: row.cpu_ms_sum, wallMsSum: row.wall_ms_sum,
    rowAccounts: row.row_accounts, rowsRead: row.rows_read, rowsWritten: row.rows_written, statements: row.statements,
    workLagCount: row.work_lag_count, workLagMsMax: row.work_lag_ms_max, workLagMsSum: row.work_lag_ms_sum
  }));
}

export function versionRequests(db: SqlStatements, nowMs: number, versions: readonly string[]): ReadonlyMap<string, { readonly requests: number; readonly failed: number }> {
  const rows = db.rows<{ version: string; requests: number; failed: number }>(
    `SELECT version, SUM(kept + sampled_out) AS requests, SUM(CASE WHEN outcome = 'failed' THEN kept + sampled_out ELSE 0 END) AS failed FROM observe_count_entries
     WHERE stage = 'worker' AND outcome IN ('ok', 'failed') AND bucket_at + ? > ? AND version IN (SELECT value FROM json_each(?)) GROUP BY version`,
    COUNT_BUCKET_MS, nowMs - RETENTION_MS, JSON.stringify(versions)
  );
  return new Map(rows.map(row => [row.version, row]));
}
