import { COUNT_BUCKET_MS, HEALTH_BUCKET_MS, MAX_LABEL_BYTES, MAX_OUTCOME_ROUTES_PER_CLASS, MAX_RETAINED_COUNT_ROWS, RETENTION_MS } from "./limits.ts";
import { COUNT_OUTCOMES, EXCLUDED_OUTCOMES, OPERATION, OTHER_ROUTE, VERSION, utf8Length, type CountDelta, type Stage } from "./model.ts";
import type { SampledPolicy } from "./sampling.ts";
import type { SqlDatabase, SqlValue } from "./store.ts";

export const SAMPLING_COUNTERS = ["untraced", "flush"] as const;
export type SamplingCounter = typeof SAMPLING_COUNTERS[number];

export const COUNT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS observe_counts (
    bucket_at INTEGER NOT NULL,
    version TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('worker', 'object')),
    outcome TEXT NOT NULL CHECK (outcome IN (${COUNT_OUTCOMES.map(outcome => `'${outcome}'`).join(", ")})),
    route TEXT NOT NULL,
    operation TEXT NOT NULL,
    kept INTEGER NOT NULL,
    sampled_out INTEGER NOT NULL,
    cpu_ms_sum INTEGER NOT NULL,
    wall_ms_sum INTEGER NOT NULL,
    PRIMARY KEY (bucket_at, version, stage, outcome, route, operation)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS observe_sampling_events (
    bucket_at INTEGER NOT NULL,
    counter TEXT NOT NULL CHECK (counter IN (${SAMPLING_COUNTERS.map(counter => `'${counter}'`).join(", ")})),
    count INTEGER NOT NULL,
    PRIMARY KEY (bucket_at, counter)
  ) WITHOUT ROWID`
];

export function countBucket(eventAtMs: number, nowMs: number): number {
  const at = Math.min(eventAtMs, nowMs);
  return at - (at % COUNT_BUCKET_MS);
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
    cpuMsSum: existing.cpuMsSum + delta.cpuMsSum,
    wallMsSum: existing.wallMsSum + delta.wallMsSum
  });
}

function wellFormed(delta: CountDelta): boolean {
  const integers = [delta.kept, delta.sampledOut, delta.cpuMsSum, delta.wallMsSum];
  return Number.isSafeInteger(delta.bucketAt) && delta.bucketAt > 0 && delta.bucketAt % COUNT_BUCKET_MS === 0
    && integers.every(value => Number.isSafeInteger(value) && value >= 0) && delta.kept + delta.sampledOut > 0
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

export function recordCounts(db: SqlDatabase, nowMs: number, deltas: readonly CountDelta[]): CountsRecorded {
  let invalid = 0;
  let expired = 0;
  if (deltas.length === 0) return { invalid, expired };
  const newest = countBucket(nowMs, nowMs);
  const oldest = nowMs - RETENTION_MS;
  const routes = new Map<string, Set<string>>();
  const merged = new Map<string, CountDelta>();
  for (const delta of deltas) {
    if (!wellFormed(delta)) { invalid++; continue; }
    if (delta.bucketAt + COUNT_BUCKET_MS <= oldest) { expired++; continue; }
    const bucketAt = Math.min(delta.bucketAt, newest);
    const group = [bucketAt, delta.version, delta.stage, delta.outcome].join("\u0000");
    let known = routes.get(group);
    if (known === undefined) {
      known = new Set(db.rows<{ route: string }>("SELECT DISTINCT route FROM observe_counts WHERE bucket_at = ? AND version = ? AND stage = ? AND outcome = ?", bucketAt, delta.version, delta.stage, delta.outcome).map(row => row.route));
      routes.set(group, known);
    }
    const route = known.has(delta.route) || known.size < MAX_OUTCOME_ROUTES_PER_CLASS ? delta.route : OTHER_ROUTE;
    known.add(route);
    addCount(merged, { ...delta, bucketAt, route });
  }
  for (const delta of merged.values()) {
    db.run(
      `INSERT INTO observe_counts (bucket_at, version, stage, outcome, route, operation, kept, sampled_out, cpu_ms_sum, wall_ms_sum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bucket_at, version, stage, outcome, route, operation) DO UPDATE SET kept = kept + excluded.kept, sampled_out = sampled_out + excluded.sampled_out,
         cpu_ms_sum = cpu_ms_sum + excluded.cpu_ms_sum, wall_ms_sum = wall_ms_sum + excluded.wall_ms_sum`,
      delta.bucketAt, delta.version, delta.stage, delta.outcome, delta.route, delta.operation, delta.kept, delta.sampledOut, delta.cpuMsSum, delta.wallMsSum
    );
  }
  return { invalid, expired };
}

export function recordSamplingEvents(db: SqlDatabase, nowMs: number, counts: Readonly<Record<SamplingCounter, number>>): void {
  for (const counter of SAMPLING_COUNTERS) {
    if (counts[counter] === 0) continue;
    db.run(
      `INSERT INTO observe_sampling_events (bucket_at, counter, count) VALUES (?, ?, ?)
       ON CONFLICT (bucket_at, counter) DO UPDATE SET count = count + excluded.count`,
      nowMs - (nowMs % HEALTH_BUCKET_MS), counter, counts[counter]
    );
  }
}

export function cleanupCounts(db: SqlDatabase, cutoff: number, batch: number): number {
  db.run("DELETE FROM observe_counts WHERE bucket_at <= ?", cutoff - COUNT_BUCKET_MS);
  db.run("DELETE FROM observe_sampling_events WHERE bucket_at + ? <= ?", HEALTH_BUCKET_MS, cutoff);
  const excess = Math.min((db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_counts")[0]?.n ?? 0) - MAX_RETAINED_COUNT_ROWS, batch);
  if (excess > 0) {
    db.run(
      "DELETE FROM observe_counts WHERE (bucket_at, version, stage, outcome, route, operation) IN (SELECT bucket_at, version, stage, outcome, route, operation FROM observe_counts ORDER BY bucket_at LIMIT ?)",
      excess
    );
  }
  return Math.max(excess, 0);
}

export function oldestCountExpiryMs(db: SqlDatabase): number | null {
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
}

const WINDOW = "bucket_at >= ? AND bucket_at < ?";

function windowParams(fromMs: number, toMs: number): [number, number] {
  return [fromMs - (fromMs % COUNT_BUCKET_MS), toMs];
}

export function samplingSummary(db: SqlDatabase, policy: SampledPolicy, fromMs: number, toMs: number, stage: Stage | null = null): SamplingSummary {
  const row = db.rows<{ kept: number | null; observed: number | null }>(
    `SELECT SUM(kept) AS kept, SUM(kept + sampled_out) AS observed FROM observe_counts WHERE ${WINDOW} AND outcome IN ('ok', 'failed') AND (? IS NULL OR stage = ?)`,
    ...windowParams(fromMs, toMs), stage, stage
  )[0];
  return { keepPerMillion: policy.keepPerMillion, kept: row?.kept ?? 0, observed: row?.observed ?? 0 };
}

export function observedByRoute(db: SqlDatabase, fromMs: number, toMs: number, stage: Stage): ReadonlyMap<string, number> {
  const rows = db.rows<{ route: string; observed: number }>(
    `SELECT route, SUM(kept + sampled_out) AS observed FROM observe_counts WHERE ${WINDOW} AND outcome IN ('ok', 'failed') AND stage = ? GROUP BY route`,
    ...windowParams(fromMs, toMs), stage
  );
  return new Map(rows.map(row => [row.route, row.observed]));
}

export function samplingHealth(db: SqlDatabase, nowMs: number, policy: SampledPolicy): SamplingHealth {
  const cutoff = nowMs - RETENTION_MS;
  const totals = db.rows<{ kept: number | null; sampled_out: number | null; excluded: number | null }>(
    `SELECT SUM(CASE WHEN outcome IN ('ok', 'failed') THEN kept ELSE 0 END) AS kept,
       SUM(CASE WHEN outcome IN ('ok', 'failed') THEN sampled_out ELSE 0 END) AS sampled_out,
       SUM(CASE WHEN outcome IN ('ok', 'failed') THEN 0 ELSE sampled_out END) AS excluded
     FROM observe_counts WHERE bucket_at + ? > ?`,
    COUNT_BUCKET_MS, cutoff
  )[0];
  const events = new Map(db.rows<{ counter: SamplingCounter; count: number }>(
    "SELECT counter, SUM(count) AS count FROM observe_sampling_events WHERE bucket_at + ? > ? GROUP BY counter", HEALTH_BUCKET_MS, cutoff
  ).map(row => [row.counter, row.count]));
  return { policy, kept: totals?.kept ?? 0, sampledOut: totals?.sampled_out ?? 0, excluded: totals?.excluded ?? 0, untraced: events.get("untraced") ?? 0, flushes: events.get("flush") ?? 0 };
}

export interface CountWindow {
  readonly invocations: readonly { readonly bucketAt: number; readonly version: string; readonly stage: Stage; readonly count: number }[];
  readonly excluded: readonly { readonly bucketAt: number; readonly version: string; readonly stage: Stage; readonly outcome: typeof EXCLUDED_OUTCOMES[number]; readonly count: number }[];
}

export function countWindow(db: SqlDatabase, fromMs: number, toMs: number): CountWindow {
  const params: SqlValue[] = [...windowParams(fromMs, toMs)];
  const invocations = db.rows<{ bucket_at: number; version: string; stage: Stage; count: number }>(
    `SELECT bucket_at, version, stage, SUM(kept + sampled_out) AS count FROM observe_counts WHERE ${WINDOW} AND outcome IN ('ok', 'failed')
     GROUP BY bucket_at, version, stage ORDER BY bucket_at, version, stage`, ...params
  ).map(row => ({ bucketAt: row.bucket_at, version: row.version, stage: row.stage, count: row.count }));
  const excluded = db.rows<{ bucket_at: number; version: string; stage: Stage; outcome: typeof EXCLUDED_OUTCOMES[number]; count: number }>(
    `SELECT bucket_at, version, stage, outcome, SUM(sampled_out) AS count FROM observe_counts WHERE ${WINDOW} AND outcome NOT IN ('ok', 'failed')
     GROUP BY bucket_at, version, stage, outcome ORDER BY bucket_at, version, stage, outcome`, ...params
  ).map(row => ({ bucketAt: row.bucket_at, version: row.version, stage: row.stage, outcome: row.outcome, count: row.count }));
  return { invocations, excluded };
}

export function versionRequests(db: SqlDatabase, nowMs: number, versions: readonly string[]): ReadonlyMap<string, { readonly requests: number; readonly failed: number }> {
  const rows = db.rows<{ version: string; requests: number; failed: number }>(
    `SELECT version, SUM(kept + sampled_out) AS requests, SUM(CASE WHEN outcome = 'failed' THEN kept + sampled_out ELSE 0 END) AS failed FROM observe_counts
     WHERE stage = 'worker' AND outcome IN ('ok', 'failed') AND bucket_at + ? > ? AND version IN (SELECT value FROM json_each(?)) GROUP BY version`,
    COUNT_BUCKET_MS, nowMs - RETENTION_MS, JSON.stringify(versions)
  );
  return new Map(rows.map(row => [row.version, row]));
}
