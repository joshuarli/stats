import { CLEANUP_BATCH, HEALTH_BUCKET_MS, MAX_FUTURE_SKEW_MS, MAX_ISSUES, MAX_PAGE_SIZE, MAX_RETAINED_INVOCATIONS, MAX_RETAINED_OCCURRENCES, MAX_TRACE_INVOCATIONS, RETENTION_MS, CLEANUP_INTERVAL_MS, ROLLOUT_RETENTION_MS, MAX_ARTIFACTS, OPERATION_BUCKET_MS, MAX_RETAINED_OPERATION_ROWS, OUTCOME_BUCKET_MS, MAX_RETAINED_OUTCOME_ROWS, MAX_OUTCOME_ROUTES_PER_CLASS, OBSERVE_FILTER_REVISION } from "./limits.ts";
import { isFailedInvocation, NOTHING_UNSENT, OCCURRENCE_SOURCES, OTHER_ROUTE, OUTCOME_CLASSES, summaryTotals, type CountDelta, type Flush, type UnsentTally, type InvocationKind, type OccurrenceSource, type OutcomeEvent, type Preparation, type PreparedError, type PreparedInvocation, type RolloutPreparation, type Stage, type VersionLabel } from "./model.ts";
import { formatFrames, readFrames, type StackFrame, type SymbolicatedFrame } from "./stack.ts";
import { representativeFrame } from "./grouping.ts";
import { cleanupCounts, COUNT_STATEMENTS, upgradeCountEntriesView, countBucket, eventBucket, oldestCountExpiryMs, recordCounts, samplingHealth, countWindow, countedRoutes, versionRequests, type CountedRoute, type SamplingHealth, type SamplingSummary } from "./counts.ts";
import { KEEP_ALL, type Sampling } from "./sampling.ts";
import { OPERATION_IDS, type OperationId, type OperationSummary } from "../producer/channel.ts";
import { cleanupProfile, PROFILE_STATEMENTS, recordProfile } from "./profile.ts";
import { encodeEvent } from "../ingest/codec.ts";
import { MAX_BATCHES_PER_WINDOW, PROVENANCE, RATE_LIMIT_WINDOW_MS, type ApplicationFailure, type ExternalEvent, type ExternalEventRecord, type ExternalFilter, type ExternalIngest, type ReceivedEvent } from "../ingest/model.ts";
import type { SqlStatements, SqlValue } from "../../core/sql.ts";

export type IssueState = "open" | "resolved";

export interface IngestResult {
  accepted: number;
  duplicate: number;
  conflict: number;
  expired: number;
  future: number;
  rejected: number;
  issueCapacity: number;
}

export interface CleanupResult {
  readonly deleted: number;
  readonly evicted: number;
  readonly more: boolean;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

export interface IssueSummary {
  readonly fingerprint: string;
  readonly name: string;
  readonly operation: string | null;
  readonly frame: string | null;
  readonly state: IssueState;
  readonly occurrences: number;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
  readonly lastVersion: string | null;
  readonly versions: number;
  readonly firstVersion: string | null;
  readonly firstVersionLabel: string | null;
}

export interface RolloutResult {
  accepted: number;
  duplicate: number;
  conflict: number;
  expired: number;
  rejected: number;
}

export interface IssueRef {
  readonly fingerprint: string;
  readonly name: string;
  readonly operation: string | null;
  readonly frame: string | null;
  readonly occurrences: number;
  readonly firstAtMs: number;
}

export interface VersionStats {
  readonly version: string;
  readonly label: string | null;
  readonly introduced: boolean;
  readonly requests: number;
  readonly failed: number;
}

export interface RouteVersionStats {
  readonly version: string;
  readonly requests: number;
  readonly cpuMeanMs: number | null;
  readonly cpuStdErrMs: number | null;
  readonly p50CpuMs: number | null;
  readonly p95CpuMs: number | null;
  readonly p50WallMs: number | null;
  readonly p95WallMs: number | null;
}

export interface RouteComparison {
  readonly stage: Stage;
  readonly label: string;
  readonly versions: readonly RouteVersionStats[];
}

export type ImpactState = "measured" | "expired";

export interface RolloutImpact {
  readonly rolloutId: string;
  readonly atMs: number;
  readonly previousRolloutId: string | null;
  readonly introduced: readonly string[];
  readonly state: ImpactState;
  readonly baselineMs: number;
  readonly newIssues: readonly IssueRef[];
  readonly regressions: readonly IssueRef[];
  readonly versions: readonly VersionStats[];
  readonly routes: readonly RouteComparison[];
  readonly sampling?: SamplingSummary;
}

export interface Occurrence {
  readonly id: number;
  readonly invocationKey: string;
  readonly traceId: string | null;
  readonly atMs: number;
  readonly version: string | null;
  readonly source: OccurrenceSource;
  readonly operation: string | null;
  readonly name: string;
  readonly message: string | null;
  readonly frames: readonly SymbolicatedFrame[];
}

export type ArtifactResult = "accepted" | "duplicate" | "conflict";

export interface InvocationSummary {
  readonly key: string;
  readonly traceId: string | null;
  readonly stage: Stage;
  readonly kind: InvocationKind;
  readonly label: string;
  readonly objectId: string | null;
  readonly status: number | null;
  readonly outcome: string;
  readonly failed: boolean;
  readonly cpuMs: number;
  readonly wallMs: number;
  readonly atMs: number;
  readonly version: string | null;
  readonly errorCount: number;
}

export interface TracePage extends Page<TraceSummary> {
  readonly sampling?: SamplingSummary;
}

export interface TraceSummary extends InvocationSummary {
  readonly objectInvocations: number;
  readonly objectCpuMs: number;
}

export interface TraceDetail {
  readonly traceId: string;
  readonly rootPresent: boolean;
  readonly truncated: boolean;
  readonly invocations: readonly InvocationSummary[];
  readonly occurrences: readonly Occurrence[];
  readonly sampling?: SamplingSummary;
}

export type TraceOrder = "recent" | "slowest";

export interface TraceFilter {
  readonly label?: string;
  readonly version?: string;
  readonly failed?: boolean;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly minWallMs?: number;
  readonly maxWallMs?: number;
  readonly order?: TraceOrder;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RouteStats {
  readonly label: string;
  readonly requests: number;
  readonly failed: number;
  readonly cpuMs: number;
  readonly p50WallMs: number | null;
  readonly p95WallMs: number | null;
  readonly p99WallMs: number | null;
  readonly p50CpuMs: number | null;
  readonly p95CpuMs: number | null;
  readonly observed?: number;
  readonly unmeasured?: "sampled-out";
}

export interface ObjectMethodStats {
  readonly label: string;
  readonly requests: number;
  readonly failed: number;
  readonly cpuMs: number;
  readonly wallMs: number;
  readonly p50WallMs: number;
  readonly p95WallMs: number;
}

export interface Heatmap {
  readonly fromMs: number;
  readonly bucketMs: number;
  readonly edges: readonly number[];
  readonly cells: readonly (readonly number[])[];
  readonly failed: readonly number[];
  readonly p95WallMs: readonly (number | null)[];
}

export interface Exploration {
  readonly fromMs: number;
  readonly toMs: number;
  readonly route: string | null;
  readonly routes: readonly RouteStats[];
  readonly heatmap: Heatmap;
  readonly sampling?: SamplingSummary;
}

export interface ObjectMethods {
  readonly fromMs: number;
  readonly toMs: number;
  readonly methods: readonly ObjectMethodStats[];
  readonly sampling?: SamplingSummary;
}

export const DURATION_EDGES: readonly number[] = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const HEATMAP_BUCKETS = 60;
const MIN_PERCENTILE_SAMPLES = 5;

export const HEALTH_COUNTERS = ["duplicate", "conflict", "expired", "future", "rejected", "issue_capacity", "evicted"] as const;
export type HealthCounter = typeof HEALTH_COUNTERS[number];

export interface HealthReason {
  readonly counter: HealthCounter;
  readonly reason: string;
  readonly count: number;
  readonly example: string | null;
}

export interface WriteCost {
  readonly ingestBatches: number;
  readonly accepted: number;
  readonly ingestRows: number;
  readonly cleanupRows: number;
}

const MAX_HEALTH_REASONS = 20;

export interface Health {
  readonly newestAtMs: number | null;
  readonly oldestAtMs: number | null;
  readonly liveInvocations: number;
  readonly cleanupBacklog: number;
  readonly cleanupLagMs: number;
  readonly openIssues: number;
  readonly duplicate: number;
  readonly conflict: number;
  readonly expired: number;
  readonly future: number;
  readonly rejected: number;
  readonly issueCapacity: number;
  readonly evicted: number;
  readonly reasons: readonly HealthReason[];
  readonly writes: WriteCost;
  readonly sampling?: SamplingHealth;
}

const OPERATION_WORK_COLUMNS = [
  "received", "persisted", "duplicate", "rejected_invalid_sample", "rejected_too_old", "rejected_conflict", "input_bytes",
  "points", "cells", "output_bytes", "cache_hit_304", "cache_rebuilt",
  "runs", "metric_rows", "hour_rollups", "upstream_queries", "expired", "backlog_remaining"
] as const;

type OperationWorkColumn = typeof OPERATION_WORK_COLUMNS[number];

const OCCURRENCE_SOURCE_CHECK = `source IN (${OCCURRENCE_SOURCES.map(source => `'${source}'`).join(", ")})`;
const OCCURRENCE_COPIED_COLUMNS = "id, invocation_key, ordinal, fingerprint, observed_at, trace_id, version, has_stack, propagated, source, operation, name, message, frames";

function occurrencesTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY,
    invocation_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    trace_id TEXT,
    version TEXT,
    has_stack INTEGER NOT NULL CHECK (has_stack IN (0, 1)),
    propagated INTEGER NOT NULL CHECK (propagated IN (0, 1)),
    source TEXT NOT NULL CHECK (${OCCURRENCE_SOURCE_CHECK}),
    operation TEXT,
    name TEXT NOT NULL,
    message TEXT,
    frames TEXT NOT NULL,
    UNIQUE (invocation_key, ordinal)
  )`;
}

const OCCURRENCE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS observe_occurrences_issue ON observe_occurrences (fingerprint, observed_at)",
  "CREATE INDEX IF NOT EXISTS observe_occurrences_time ON observe_occurrences (observed_at)",
  "CREATE INDEX IF NOT EXISTS observe_occurrences_trace ON observe_occurrences (trace_id) WHERE trace_id IS NOT NULL"
];

function upgradeOccurrenceSources(db: SqlStatements): void {
  const table = db.rows<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observe_occurrences'")[0];
  if (table === undefined || table.sql.includes(OCCURRENCE_SOURCE_CHECK)) return;
  db.run(occurrencesTable("observe_occurrences_next"));
  db.run(`INSERT INTO observe_occurrences_next (${OCCURRENCE_COPIED_COLUMNS}) SELECT ${OCCURRENCE_COPIED_COLUMNS} FROM observe_occurrences`);
  db.run("DROP TABLE observe_occurrences");
  db.run("ALTER TABLE observe_occurrences_next RENAME TO observe_occurrences");
  for (const index of OCCURRENCE_INDEXES) db.run(index);
}

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS observe_invocations (
    key TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    event_at INTEGER NOT NULL,
    trace_id TEXT,
    stage TEXT NOT NULL CHECK (stage IN ('worker', 'object')),
    kind TEXT NOT NULL CHECK (kind IN ('fetch', 'rpc', 'alarm', 'scheduled')),
    label TEXT NOT NULL,
    object_id TEXT,
    version TEXT,
    status INTEGER,
    outcome TEXT NOT NULL,
    failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
    cpu_ms INTEGER NOT NULL,
    wall_ms INTEGER NOT NULL,
    error_count INTEGER NOT NULL
  ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS observe_invocations_time ON observe_invocations (observed_at)",
  "CREATE INDEX IF NOT EXISTS observe_invocations_trace ON observe_invocations (trace_id) WHERE trace_id IS NOT NULL",
  occurrencesTable("observe_occurrences"),
  ...OCCURRENCE_INDEXES,
  `CREATE TABLE IF NOT EXISTS observe_issues (
    fingerprint TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    operation TEXT,
    frame TEXT,
    state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
    state_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS observe_rollouts (
    id TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    source TEXT NOT NULL,
    message TEXT
  ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS observe_rollouts_time ON observe_rollouts (at_ms)",
  `CREATE TABLE IF NOT EXISTS observe_rollout_shares (
    rollout_id TEXT NOT NULL,
    version TEXT NOT NULL,
    percent REAL NOT NULL,
    PRIMARY KEY (rollout_id, version)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS observe_version_labels (
    version TEXT PRIMARY KEY,
    label TEXT,
    message TEXT,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS observe_artifacts (
    version TEXT NOT NULL,
    file TEXT NOT NULL,
    digest TEXT NOT NULL,
    map TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL,
    PRIMARY KEY (version, file)
  )`,
  `CREATE TABLE IF NOT EXISTS observe_health_events (
    bucket_at INTEGER NOT NULL,
    counter TEXT NOT NULL CHECK (counter IN (${HEALTH_COUNTERS.map(counter => `'${counter}'`).join(", ")})),
    reason TEXT NOT NULL,
    count INTEGER NOT NULL,
    example TEXT,
    PRIMARY KEY (bucket_at, counter, reason)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS observe_applied_flushes (
    flush_id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS observe_write_cost (
    bucket_at INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('ingest', 'cleanup')),
    runs INTEGER NOT NULL,
    invocations INTEGER NOT NULL,
    rows_written INTEGER NOT NULL,
    PRIMARY KEY (bucket_at, phase)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS observe_operations (
    bucket_at INTEGER NOT NULL,
    version TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN (${OPERATION_IDS.map(id => `'${id}'`).join(", ")})),
    workload_class TEXT NOT NULL,
    synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
    count INTEGER NOT NULL,
    lag_count INTEGER NOT NULL DEFAULT 0,
    lag_ms_max INTEGER NOT NULL DEFAULT 0,
    lag_ms_sum INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL,
    cpu_ms_sum INTEGER NOT NULL,
    wall_ms_sum INTEGER NOT NULL,
    rows_read INTEGER NOT NULL,
    rows_written INTEGER NOT NULL,
    statements INTEGER NOT NULL,
    ${OPERATION_WORK_COLUMNS.map(column => `${column} INTEGER NOT NULL DEFAULT 0`).join(",\n    ")},
    PRIMARY KEY (bucket_at, version, operation, workload_class, synthetic)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS observe_outcomes (
    bucket_at INTEGER NOT NULL,
    version TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('worker', 'object', 'unknown')),
    outcome TEXT NOT NULL CHECK (outcome IN (${OUTCOME_CLASSES.map(outcome => `'${outcome}'`).join(", ")})),
    route TEXT NOT NULL,
    count INTEGER NOT NULL,
    lag_count INTEGER NOT NULL,
    lag_ms_max INTEGER NOT NULL,
    lag_ms_sum INTEGER NOT NULL,
    filter_revision INTEGER NOT NULL,
    PRIMARY KEY (bucket_at, version, stage, outcome, route)
  ) WITHOUT ROWID`,
  ...COUNT_STATEMENTS,
  ...PROFILE_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS observe_external_events (
    service TEXT NOT NULL,
    event_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    event_at INTEGER NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance = '${PROVENANCE}'),
    payload TEXT NOT NULL,
    PRIMARY KEY (service, event_id)
  ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS observe_external_events_time ON observe_external_events (service, event_at)",
  "CREATE INDEX IF NOT EXISTS observe_external_events_event_at ON observe_external_events (event_at)",
  "CREATE INDEX IF NOT EXISTS observe_external_events_received_at ON observe_external_events (received_at)",
  `CREATE TABLE IF NOT EXISTS observe_ingest_windows (
    service TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (service, window_start)
  ) WITHOUT ROWID`
];

export function initializeStore(db: SqlStatements): void {
  db.transaction(() => {
    for (const statement of STATEMENTS) db.run(statement);
    upgradeCountEntriesView(db);
    upgradeOccurrenceSources(db);
    if (!db.rows<{ name: string }>("PRAGMA table_info(observe_issues)").some(column => column.name === "resolved_at")) {
      db.run("ALTER TABLE observe_issues ADD COLUMN resolved_at INTEGER");
    }
    if (db.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'observe_health'").length > 0) {
      for (const counter of HEALTH_COUNTERS) {
        db.run(`INSERT INTO observe_health_events (bucket_at, counter, reason, count, example) SELECT bucket_at, '${counter}', 'unrecorded', ${counter}, NULL FROM observe_health WHERE ${counter} > 0`);
      }
      db.run("DROP TABLE observe_health");
    }
  });
}

const LABEL_REFRESH_MS = 24 * 60 * 60 * 1000;

export function recordRollouts(db: SqlStatements, preparations: readonly RolloutPreparation[], labels: readonly VersionLabel[], nowMs: number): RolloutResult {
  const result: RolloutResult = { accepted: 0, duplicate: 0, conflict: 0, expired: 0, rejected: 0 };
  db.transaction(() => {
    for (const preparation of preparations) {
      if (!preparation.ok) { result.rejected++; continue; }
      const rollout = preparation.rollout;
      if (rollout.atMs <= nowMs - ROLLOUT_RETENTION_MS || rollout.atMs > nowMs + MAX_FUTURE_SKEW_MS) { result.expired++; continue; }
      const existing = db.rows<{ digest: string }>("SELECT digest FROM observe_rollouts WHERE id = ?", rollout.id)[0];
      if (existing !== undefined) {
        if (existing.digest === rollout.digest) result.duplicate++;
        else result.conflict++;
        continue;
      }
      db.run("INSERT INTO observe_rollouts (id, digest, at_ms, source, message) VALUES (?, ?, ?, ?, ?)", rollout.id, rollout.digest, rollout.atMs, rollout.source, rollout.message);
      for (const share of rollout.shares) db.run("INSERT INTO observe_rollout_shares (rollout_id, version, percent) VALUES (?, ?, ?)", rollout.id, share.version, share.percent);
      result.accepted++;
    }
    for (const label of labels) {
      db.run(
        `INSERT INTO observe_version_labels (version, label, message, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (version) DO UPDATE SET label = excluded.label, message = excluded.message, updated_at = excluded.updated_at
         WHERE label IS NOT excluded.label OR message IS NOT excluded.message OR updated_at < ?`,
        label.version, label.label, label.message, nowMs, nowMs - LABEL_REFRESH_MS
      );
    }
  });
  return result;
}

interface HealthEvent {
  readonly counter: HealthCounter;
  readonly reason: string;
  readonly example: string | null;
}

type StoredColumns = Record<typeof COMPARED_COLUMNS[number], SqlValue>;

const COMPARED_COLUMNS = ["event_at", "trace_id", "stage", "kind", "label", "object_id", "version", "status", "outcome", "cpu_ms", "wall_ms", "error_count"] as const;

function differingColumns(stored: StoredColumns, invocation: PreparedInvocation): string {
  const incoming: StoredColumns = {
    event_at: invocation.eventAtMs, trace_id: invocation.trace?.traceId ?? null, stage: invocation.stage, kind: invocation.kind, label: invocation.label, object_id: invocation.objectId,
    version: invocation.version, status: invocation.status, outcome: invocation.outcome, cpu_ms: invocation.cpuMs, wall_ms: invocation.wallMs, error_count: invocation.errorCount
  };
  const differing = COMPARED_COLUMNS.filter(column => stored[column] !== incoming[column]);
  return differing.length === 0 ? "errors" : differing.sort().join(", ");
}

export interface CountingPolicy {
  readonly sampling: Sampling;
  readonly routesPerClass: number;
}

export const KEEP_ALL_COUNTING: CountingPolicy = { sampling: KEEP_ALL, routesPerClass: MAX_OUTCOME_ROUTES_PER_CLASS };

export interface Counting extends CountingPolicy {
  readonly counts: readonly unknown[];
}

const NOT_COUNTED: Counting = { ...KEEP_ALL_COUNTING, counts: [] };

const FLUSH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UNSENT_FIELDS = Object.keys(NOTHING_UNSENT) as (keyof UnsentTally)[];

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function decodeFlush(value: unknown): Flush | null {
  if (value === undefined || value === null) return null;
  const { id, unsent, ambiguousMarks } = fieldsOf(value);
  const tally = fieldsOf(unsent);
  if (typeof id !== "string" || !FLUSH_ID.test(id) || !UNSENT_FIELDS.every(key => isCount(tally[key])) || !isCount(ambiguousMarks)) {
    throw new TypeError("malformed flush: needs a UUID id, a non-negative unsent tally, and a non-negative ambiguousMarks");
  }
  return { id, unsent: Object.fromEntries(UNSENT_FIELDS.map(key => [key, tally[key]])) as Record<keyof UnsentTally, number>, ambiguousMarks };
}

const UNSENT_REASONS: Readonly<Record<keyof UnsentTally, string>> = { batches: "unsent_batches", invocations: "unsent_invocations", outcomes: "unsent_outcomes", countedEvents: "unsent_counted_events" };

function claimFlush(db: SqlStatements, nowMs: number, flush: Flush): boolean {
  if (db.rows<{ flush_id: string }>("SELECT flush_id FROM observe_applied_flushes WHERE flush_id = ?", flush.id).length > 0) {
    recordHealth(db, nowMs, [{ counter: "duplicate", reason: "flush", example: null }]);
    return false;
  }
  db.run("INSERT INTO observe_applied_flushes (flush_id, applied_at) VALUES (?, ?)", flush.id, nowMs);
  recordHealthTallies(db, nowMs, [
    ...UNSENT_FIELDS.filter(key => flush.unsent[key] > 0).map(key => ({ counter: "evicted" as const, reason: UNSENT_REASONS[key], example: null, count: flush.unsent[key] })),
    ...(flush.ambiguousMarks > 0 ? [{ counter: "rejected" as const, reason: "ambiguous_invocation_mark", example: null, count: flush.ambiguousMarks }] : [])
  ]);
  return true;
}

export function ingest(db: SqlStatements, preparations: readonly Preparation[], nowMs: number, outcomes: readonly OutcomeEvent[] = [], counting: Counting = NOT_COUNTED, flush: Flush | null = null, captureOperations = false): IngestResult {
  const result: IngestResult = { accepted: 0, duplicate: 0, conflict: 0, expired: 0, future: 0, rejected: 0, issueCapacity: 0 };
  const events: HealthEvent[] = [];
  const counts: unknown[] = [...counting.counts];
  const captured: PreparedInvocation[] = [];
  let untraced = 0;
  const operations = new Map<string, OperationBucket>();
  const cutoff = nowMs - RETENTION_MS;
  db.transaction(() => {
    if (flush !== null && !claimFlush(db, nowMs, flush)) return;
    const writtenBefore = db.rowsWritten();
    for (const preparation of preparations) {
      if (!preparation.ok) { result.rejected++; events.push({ counter: "rejected", reason: preparation.reason, example: null }); continue; }
      const invocation = preparation.invocation;
      const described = `${invocation.kind} ${invocation.label}`;
      const observedAt = Math.min(invocation.eventAtMs, nowMs);
      if (invocation.eventAtMs > nowMs + MAX_FUTURE_SKEW_MS) { result.future++; events.push({ counter: "future", reason: invocation.kind, example: described }); continue; }
      if (observedAt <= cutoff) { result.expired++; events.push({ counter: "expired", reason: invocation.kind, example: described }); continue; }
      const existing = db.rows<StoredColumns & { digest: string }>(`SELECT digest, ${COMPARED_COLUMNS.join(", ")} FROM observe_invocations WHERE key = ?`, invocation.key)[0];
      if (existing !== undefined) {
        if (existing.digest === invocation.digest) {
          result.duplicate++;
          events.push({ counter: "duplicate", reason: invocation.keySource, example: described });
        } else {
          result.conflict++;
          events.push({ counter: "conflict", reason: invocation.keySource, example: `${described}; differs: ${differingColumns(existing, invocation)}` });
        }
        continue;
      }
      insertInvocation(db, invocation, observedAt);
      if (captureOperations) captured.push(invocation);
      if (counting.sampling.kind === "sampled") {
        counts.push(keptCount(invocation, nowMs));
        if (invocation.trace === null) untraced++;
      }
      if (invocation.operation !== undefined) accumulateOperation(operations, invocation, invocation.operation, nowMs);
      for (const error of invocation.errors) {
        if (!insertOccurrence(db, invocation, error, observedAt, cutoff)) { result.issueCapacity++; events.push({ counter: "issue_capacity", reason: "issues_full", example: error.name }); }
      }
      result.accepted++;
    }
    if (captured.length > 0) recordProfile(db, captured, nowMs);
    recordOperations(db, operations);
    recordOutcomes(db, nowMs, outcomes);
    const recorded = recordCounts(db, nowMs, counts, { untraced, flush: counting.counts.length > 0 ? 1 : 0 }, counting.routesPerClass);
    for (let n = 0; n < recorded.invalid; n++) events.push({ counter: "rejected", reason: "invalid_count", example: null });
    for (let n = 0; n < recorded.expired; n++) events.push({ counter: "expired", reason: "counts", example: null });
    recordHealth(db, nowMs, events);
    recordWriteCost(db, nowMs, "ingest", result.accepted, db.rowsWritten() - writtenBefore);
  });
  return result;
}

function eventIdentity(event: ExternalEvent): string {
  const identity = { ...event };
  delete identity.delivery;
  return encodeEvent(identity);
}

export function ingestExternal(db: SqlStatements, service: string, received: readonly ReceivedEvent[], nowMs: number): ExternalIngest {
  const windowStart = nowMs - (nowMs % RATE_LIMIT_WINDOW_MS);
  return db.transaction((): ExternalIngest => {
    const count = db.rows<{ count: number }>("SELECT count FROM observe_ingest_windows WHERE service = ? AND window_start = ?", service, windowStart)[0]?.count ?? 0;
    if (count >= MAX_BATCHES_PER_WINDOW) return { ok: false, code: "rate_limited" };
    db.run(
      "INSERT INTO observe_ingest_windows (service, window_start, count) VALUES (?, ?, 1) ON CONFLICT (service, window_start) DO UPDATE SET count = count + 1",
      service, windowStart
    );
    const stored = db.rows<{ event_id: string; payload: string }>(
      "SELECT event_id, payload FROM observe_external_events WHERE service = ? AND event_id IN (SELECT value FROM json_each(?))",
      service, JSON.stringify(received.map(({ event }) => event.eventId))
    );
    const prior = new Map(stored.map(row => [row.event_id, row.payload]));
    for (const { event } of received) {
      const previous = prior.get(event.eventId);
      if (previous !== undefined && eventIdentity(JSON.parse(previous) as ExternalEvent) !== eventIdentity(event)) return { ok: false, code: "event_conflict" };
    }
    const writtenBefore = db.rowsWritten();
    let accepted = 0;
    let duplicate = 0;
    const capacity: HealthEvent[] = [];
    for (const { event, failure } of received) {
      if (prior.has(event.eventId)) {
        duplicate += 1;
        continue;
      }
      db.run(
        "INSERT INTO observe_external_events (event_id, service, received_at, event_at, provenance, payload) VALUES (?, ?, ?, ?, ?, ?)",
        event.eventId, service, nowMs, event.atMs, PROVENANCE, encodeEvent(event)
      );
      if (failure !== null && !insertApplicationOccurrence(db, event, failure, Math.min(event.atMs, nowMs))) {
        capacity.push({ counter: "issue_capacity", reason: "issues_full", example: failure.code });
      }
      accepted += 1;
    }
    recordHealth(db, nowMs, capacity);
    recordWriteCost(db, nowMs, "ingest", accepted, db.rowsWritten() - writtenBefore);
    return { ok: true, accepted, duplicate };
  });
}

export function readExternalEvents(db: SqlStatements, service: string, nowMs: number, filter: ExternalFilter = {}): readonly ExternalEventRecord[] {
  const { fromMs, toMs } = eventWindow(nowMs, filter.fromMs, filter.toMs);
  const limit = Math.min(Math.max(filter.limit ?? 1000, 1), 5000);
  return db.rows<{ event_id: string; service: string; received_at: number; payload: string }>(
    "SELECT event_id, service, received_at, payload FROM observe_external_events WHERE service = ? AND event_at >= ? AND event_at <= ? ORDER BY event_at, event_id LIMIT ?",
    service, fromMs, toMs, limit
  ).map(row => ({
    eventId: row.event_id,
    service: row.service,
    receivedAtMs: row.received_at,
    provenance: PROVENANCE,
    event: JSON.parse(row.payload) as ExternalEvent
  }));
}

export interface ExternalOperationTotals {
  readonly operation: string;
  readonly events: number;
  readonly failed: number;
  readonly durationMsSum: number;
  readonly durationMsMax: number;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
}

export interface ExternalOperationsWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly operations: readonly ExternalOperationTotals[];
}

export function summarizeExternalOperations(db: SqlStatements, service: string, nowMs: number, filter: Pick<ExternalFilter, "fromMs" | "toMs"> = {}): ExternalOperationsWindow {
  const { fromMs, toMs } = eventWindow(nowMs, filter.fromMs, filter.toMs);
  const operations = db.rows<{ operation: string; events: number; failed: number; duration_sum: number; duration_max: number; first_at: number; last_at: number }>(
    `SELECT json_extract(payload, '$.operation') AS operation, COUNT(*) AS events,
       SUM(json_extract(payload, '$.outcome') <> 'ok') AS failed,
       SUM(json_extract(payload, '$.durationMs')) AS duration_sum, MAX(json_extract(payload, '$.durationMs')) AS duration_max,
       MIN(event_at) AS first_at, MAX(event_at) AS last_at
     FROM observe_external_events WHERE service = ? AND event_at >= ? AND event_at < ?
     GROUP BY operation ORDER BY events DESC, operation`,
    service, fromMs, toMs
  ).map(row => ({ operation: row.operation, events: row.events, failed: row.failed, durationMsSum: row.duration_sum, durationMsMax: row.duration_max, firstAtMs: row.first_at, lastAtMs: row.last_at }));
  return { fromMs, toMs, operations };
}

function keptCount(invocation: PreparedInvocation, nowMs: number): CountDelta {
  return {
    bucketAt: countBucket(invocation.eventAtMs, nowMs), version: invocation.version ?? "", stage: invocation.stage, route: invocation.label, operation: invocation.serviceOperation?.name ?? "",
    outcome: isFailed(invocation) ? "failed" : "ok", kept: 1, sampledOut: 0, capped: 0, cpuMsSum: invocation.cpuMs, wallMsSum: invocation.wallMs, ...summaryTotals(invocation.serviceOperation)
  };
}

interface OutcomeBucket {
  readonly bucketAt: number;
  readonly event: OutcomeEvent;
  count: number;
  lagCount: number;
  lagMax: number;
  lagSum: number;
}

export function recordOutcomes(db: SqlStatements, nowMs: number, events: readonly OutcomeEvent[]): void {
  if (events.length === 0) return;
  const routes = new Map<string, Set<string>>();
  const buckets = new Map<string, OutcomeBucket>();
  for (const event of events) {
    const bucketAt = eventBucket(event.eventAtMs, nowMs, OUTCOME_BUCKET_MS);
    const group = [bucketAt, event.version, event.stage, event.outcome].join("\u0000");
    let known = routes.get(group);
    if (known === undefined) {
      known = new Set(db.rows<{ route: string }>("SELECT route FROM observe_outcomes WHERE bucket_at = ? AND version = ? AND stage = ? AND outcome = ?", bucketAt, event.version, event.stage, event.outcome).map(row => row.route));
      routes.set(group, known);
    }
    const route = known.has(event.route) || known.size < MAX_OUTCOME_ROUTES_PER_CLASS ? event.route : OTHER_ROUTE;
    known.add(route);
    const key = `${group}\u0000${route}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { bucketAt, event: { ...event, route }, count: 0, lagCount: 0, lagMax: 0, lagSum: 0 };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (event.eventAtMs !== null) {
      const lag = Math.max(0, nowMs - event.eventAtMs);
      bucket.lagCount++;
      bucket.lagMax = Math.max(bucket.lagMax, lag);
      bucket.lagSum += lag;
    }
  }
  for (const { bucketAt, event, count, lagCount, lagMax, lagSum } of buckets.values()) {
    db.run(
      `INSERT INTO observe_outcomes (bucket_at, version, stage, outcome, route, count, lag_count, lag_ms_max, lag_ms_sum, filter_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bucket_at, version, stage, outcome, route) DO UPDATE SET count = count + excluded.count, lag_count = lag_count + excluded.lag_count,
         lag_ms_max = MAX(lag_ms_max, excluded.lag_ms_max), lag_ms_sum = lag_ms_sum + excluded.lag_ms_sum, filter_revision = excluded.filter_revision`,
      bucketAt, event.version, event.stage, event.outcome, event.route, count, lagCount, lagMax, lagSum, OBSERVE_FILTER_REVISION
    );
  }
}

interface OperationBucket {
  readonly bucketAt: number;
  readonly version: string;
  readonly summary: OperationSummary;
  count: number;
  lagMax: number;
  lagSum: number;
  failed: number;
  cpuMs: number;
  wallMs: number;
  rowsRead: number;
  rowsWritten: number;
  statements: number;
  work: Record<OperationWorkColumn, number>;
}

function workloadClass(summary: OperationSummary): string {
  return "workloadClass" in summary ? summary.workloadClass : "";
}

function operationWork(summary: OperationSummary): Partial<Record<OperationWorkColumn, number>> {
  switch (summary.operation) {
    case "host.ingest": {
      const { received, persisted, duplicate, rejected, inputBytes } = summary.work;
      return { received, persisted, duplicate, rejected_invalid_sample: rejected.invalid_sample, rejected_too_old: rejected.too_old, rejected_conflict: rejected.conflict, input_bytes: inputBytes };
    }
    case "host.history":
    case "project.history": {
      const { points, cells, outputBytes, cache } = summary.work;
      return { points, cells, output_bytes: outputBytes, cache_hit_304: cache === "hit-304" ? 1 : 0, cache_rebuilt: cache === "rebuilt" ? 1 : 0 };
    }
    case "collector.record": {
      const { runs, metricRows, hourRollups, upstreamQueries } = summary.work;
      return { runs, metric_rows: metricRows, hour_rollups: hourRollups, upstream_queries: upstreamQueries };
    }
    case "cleanup.retention":
      return { expired: summary.work.expired, backlog_remaining: summary.work.backlog };
    case "deployments.poll":
      return {};
  }
}

function accumulateOperation(buckets: Map<string, OperationBucket>, invocation: PreparedInvocation, summary: OperationSummary, nowMs: number): void {
  const version = invocation.version ?? "";
  const bucketAt = eventBucket(invocation.eventAtMs, nowMs, OPERATION_BUCKET_MS);
  const key = [bucketAt, version, summary.operation, workloadClass(summary), summary.synthetic ? 1 : 0].join("\u0000");
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = { bucketAt, version, summary, count: 0, lagMax: 0, lagSum: 0, failed: 0, cpuMs: 0, wallMs: 0, rowsRead: 0, rowsWritten: 0, statements: 0, work: Object.fromEntries(OPERATION_WORK_COLUMNS.map(column => [column, 0])) as Record<OperationWorkColumn, number> };
    buckets.set(key, bucket);
  }
  const lag = Math.max(0, nowMs - invocation.eventAtMs);
  bucket.count++;
  bucket.lagMax = Math.max(bucket.lagMax, lag);
  bucket.lagSum += lag;
  bucket.failed += isFailed(invocation) ? 1 : 0;
  bucket.cpuMs += invocation.cpuMs;
  bucket.wallMs += invocation.wallMs;
  bucket.rowsRead += summary.rows.read;
  bucket.rowsWritten += summary.rows.written;
  bucket.statements += summary.rows.statements;
  for (const [column, value] of Object.entries(operationWork(summary))) bucket.work[column as OperationWorkColumn] += value;
}

function recordOperations(db: SqlStatements, buckets: ReadonlyMap<string, OperationBucket>): void {
  const additions = ["count", "lag_count", "lag_ms_sum", "failed", "cpu_ms_sum", "wall_ms_sum", "rows_read", "rows_written", "statements", ...OPERATION_WORK_COLUMNS];
  const update = [...additions.map(column => `${column} = ${column} + excluded.${column}`), "lag_ms_max = MAX(lag_ms_max, excluded.lag_ms_max)"].join(", ");
  for (const bucket of buckets.values()) {
    const values = [bucket.count, bucket.count, bucket.lagSum, bucket.failed, bucket.cpuMs, bucket.wallMs, bucket.rowsRead, bucket.rowsWritten, bucket.statements, ...OPERATION_WORK_COLUMNS.map(column => bucket.work[column])];
    db.run(
      `INSERT INTO observe_operations (bucket_at, version, operation, workload_class, synthetic, lag_ms_max, ${additions.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ${additions.map(() => "?").join(", ")})
       ON CONFLICT (bucket_at, version, operation, workload_class, synthetic) DO UPDATE SET ${update}`,
      bucket.bucketAt, bucket.version, bucket.summary.operation, workloadClass(bucket.summary), bucket.summary.synthetic ? 1 : 0, bucket.lagMax, ...values
    );
  }
}

function isFailed(invocation: PreparedInvocation): boolean {
  return isFailedInvocation(invocation);
}

function insertInvocation(db: SqlStatements, invocation: PreparedInvocation, observedAt: number): void {
  db.run(
    "INSERT INTO observe_invocations (key, digest, observed_at, event_at, trace_id, stage, kind, label, object_id, version, status, outcome, failed, cpu_ms, wall_ms, error_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    invocation.key, invocation.digest, observedAt, invocation.eventAtMs, invocation.trace?.traceId ?? null, invocation.stage, invocation.kind, invocation.label,
    invocation.objectId, invocation.version, invocation.status, invocation.outcome, isFailed(invocation) ? 1 : 0, invocation.cpuMs, invocation.wallMs, invocation.errorCount
  );
}

function insertOccurrence(db: SqlStatements, invocation: PreparedInvocation, error: PreparedError, observedAt: number, cutoff: number): boolean {
  const traceId = invocation.trace?.traceId ?? null;
  const hasStack = error.frames.length > 0;
  const sameError = "trace_id = ? AND name = ? AND message IS ? AND observed_at > ?";
  const propagated = traceId !== null && !hasStack
    && db.rows<{ one: number }>(`SELECT 1 AS one FROM observe_occurrences WHERE ${sameError} AND has_stack = 1 LIMIT 1`, traceId, error.name, error.message, cutoff).length > 0;
  db.run(
    "INSERT INTO observe_occurrences (invocation_key, ordinal, fingerprint, observed_at, trace_id, version, has_stack, propagated, source, operation, name, message, frames) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    invocation.key, error.ordinal, error.fingerprint, observedAt, traceId, invocation.version, hasStack ? 1 : 0, propagated ? 1 : 0,
    error.source, error.operation, error.name, error.message, formatFrames(error.frames)
  );
  if (traceId !== null && hasStack) {
    db.run(`UPDATE observe_occurrences SET propagated = 1 WHERE ${sameError} AND has_stack = 0 AND propagated = 0 AND source <> 'application'`, traceId, error.name, error.message, cutoff);
  }
  if (propagated) return true;
  return upsertIssue(db, { fingerprint: error.fingerprint, name: error.name, operation: error.operation, frame: representativeFrame(error.frames) }, observedAt);
}

interface IssueGroup {
  readonly fingerprint: string;
  readonly name: string;
  readonly operation: string | null;
  readonly frame: string | null;
}

function upsertIssue(db: SqlStatements, group: IssueGroup, observedAt: number): boolean {
  const issue = db.rows<{ state: IssueState; state_at: number }>("SELECT state, state_at FROM observe_issues WHERE fingerprint = ?", group.fingerprint)[0];
  if (issue === undefined) {
    const count = db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_issues")[0]?.n ?? 0;
    if (count >= MAX_ISSUES) return false;
    db.run("INSERT INTO observe_issues (fingerprint, name, operation, frame, state, state_at) VALUES (?, ?, ?, ?, 'open', ?)", group.fingerprint, group.name, group.operation, group.frame, observedAt);
    return true;
  }
  if (issue.state === "resolved" && observedAt > issue.state_at) {
    db.run("UPDATE observe_issues SET state = 'open', state_at = ? WHERE fingerprint = ?", observedAt, group.fingerprint);
  }
  return true;
}

function insertApplicationOccurrence(db: SqlStatements, event: ExternalEvent, failure: ApplicationFailure, observedAt: number): boolean {
  const prepared = failure.prepared;
  const frames = prepared?.frames ?? [];
  const name = prepared?.name ?? failure.code;
  db.run(
    "INSERT INTO observe_occurrences (invocation_key, ordinal, fingerprint, observed_at, trace_id, version, has_stack, propagated, source, operation, name, message, frames) VALUES (?, 0, ?, ?, ?, ?, ?, 0, 'application', ?, ?, ?, ?)",
    failure.invocationKey, failure.fingerprint, observedAt, event.trace?.traceId ?? null, event.release, frames.length > 0 ? 1 : 0, event.operation, name, prepared?.message ?? null, formatFrames(frames)
  );
  return upsertIssue(db, { fingerprint: failure.fingerprint, name, operation: event.operation, frame: representativeFrame(frames) }, observedAt);
}

function healthBucket(nowMs: number): number {
  return nowMs - (nowMs % HEALTH_BUCKET_MS);
}

function recordHealth(db: SqlStatements, nowMs: number, events: readonly HealthEvent[]): void {
  const grouped = new Map<string, HealthEvent & { count: number }>();
  for (const event of events) {
    const key = `${event.counter}\u0000${event.reason}`;
    const entry = grouped.get(key);
    if (entry === undefined) grouped.set(key, { ...event, count: 1 });
    else entry.count++;
  }
  recordHealthTallies(db, nowMs, [...grouped.values()]);
}

function recordHealthTallies(db: SqlStatements, nowMs: number, tallies: readonly (HealthEvent & { readonly count: number })[]): void {
  for (const { count, ...event } of tallies) {
    db.run(
      `INSERT INTO observe_health_events (bucket_at, counter, reason, count, example) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (bucket_at, counter, reason) DO UPDATE SET count = count + excluded.count`,
      healthBucket(nowMs), event.counter, event.reason, count, event.example
    );
  }
}

function recordWriteCost(db: SqlStatements, nowMs: number, phase: "ingest" | "cleanup", invocations: number, rowsWritten: number): void {
  if (invocations === 0 && rowsWritten === 0) return;
  db.run(
    `INSERT INTO observe_write_cost (bucket_at, phase, runs, invocations, rows_written) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (bucket_at, phase) DO UPDATE SET runs = runs + 1, invocations = invocations + excluded.invocations, rows_written = rows_written + excluded.rows_written`,
    healthBucket(nowMs), phase, invocations, rowsWritten
  );
}

export function cleanup(db: SqlStatements, nowMs: number): CleanupResult {
  const cutoff = nowMs - RETENTION_MS;
  return db.transaction(() => {
    const writtenBefore = db.rowsWritten();
    const expiredInvocations = count(db, "SELECT COUNT(*) AS n FROM observe_invocations WHERE observed_at <= ?", cutoff);
    const expiredOccurrences = count(db, "SELECT COUNT(*) AS n FROM observe_occurrences WHERE observed_at <= ?", cutoff);
    db.run("DELETE FROM observe_invocations WHERE key IN (SELECT key FROM observe_invocations WHERE observed_at <= ? ORDER BY observed_at LIMIT ?)", cutoff, CLEANUP_BATCH);
    db.run("DELETE FROM observe_occurrences WHERE id IN (SELECT id FROM observe_occurrences WHERE observed_at <= ? ORDER BY observed_at LIMIT ?)", cutoff, CLEANUP_BATCH);
    db.run("DELETE FROM observe_issues WHERE NOT EXISTS (SELECT 1 FROM observe_occurrences o WHERE o.fingerprint = observe_issues.fingerprint AND o.observed_at > ?)", cutoff);
    db.run("DELETE FROM observe_health_events WHERE bucket_at + ? <= ?", HEALTH_BUCKET_MS, cutoff);
    db.run("DELETE FROM observe_write_cost WHERE bucket_at + ? <= ?", HEALTH_BUCKET_MS, cutoff);
    db.run("DELETE FROM observe_operations WHERE bucket_at <= ?", cutoff - OPERATION_BUCKET_MS);
    const operationExcess = Math.min(count(db, "SELECT COUNT(*) AS n FROM observe_operations") - MAX_RETAINED_OPERATION_ROWS, CLEANUP_BATCH);
    if (operationExcess > 0) {
      db.run("DELETE FROM observe_operations WHERE (bucket_at, version, operation, workload_class, synthetic) IN (SELECT bucket_at, version, operation, workload_class, synthetic FROM observe_operations ORDER BY bucket_at LIMIT ?)", operationExcess);
    }
    db.run("DELETE FROM observe_outcomes WHERE bucket_at <= ?", cutoff - OUTCOME_BUCKET_MS);
    const outcomeExcess = Math.min(count(db, "SELECT COUNT(*) AS n FROM observe_outcomes") - MAX_RETAINED_OUTCOME_ROWS, CLEANUP_BATCH);
    if (outcomeExcess > 0) {
      db.run("DELETE FROM observe_outcomes WHERE (bucket_at, version, stage, outcome, route) IN (SELECT bucket_at, version, stage, outcome, route FROM observe_outcomes ORDER BY bucket_at LIMIT ?)", outcomeExcess);
    }
    cleanupCounts(db, cutoff);
    cleanupProfile(db, cutoff);
    db.run("DELETE FROM observe_applied_flushes WHERE applied_at <= ?", cutoff);
    const rolloutCutoff = nowMs - ROLLOUT_RETENTION_MS;
    const baseline = "SELECT id FROM observe_rollouts WHERE at_ms <= ? ORDER BY at_ms DESC, id DESC LIMIT 1";
    db.run(`DELETE FROM observe_rollout_shares WHERE rollout_id IN (SELECT id FROM observe_rollouts WHERE at_ms <= ? AND id NOT IN (${baseline}))`, rolloutCutoff, rolloutCutoff);
    db.run(`DELETE FROM observe_rollouts WHERE at_ms <= ? AND id NOT IN (${baseline})`, rolloutCutoff, rolloutCutoff);
    db.run("DELETE FROM observe_version_labels WHERE updated_at <= ? AND version NOT IN (SELECT version FROM observe_rollout_shares)", rolloutCutoff);
    db.run("DELETE FROM observe_artifacts WHERE rowid NOT IN (SELECT rowid FROM observe_artifacts ORDER BY uploaded_at DESC, version DESC, file DESC LIMIT ?)", MAX_ARTIFACTS);
    const expiredExternal = count(db, "SELECT COUNT(*) AS n FROM (SELECT 1 FROM observe_external_events WHERE received_at <= ? OR event_at <= ? LIMIT ?)", cutoff, cutoff, CLEANUP_BATCH + 1);
    db.run(
      "DELETE FROM observe_external_events WHERE (service, event_id) IN (SELECT service, event_id FROM observe_external_events WHERE received_at <= ? OR event_at <= ? LIMIT ?)",
      cutoff, cutoff, CLEANUP_BATCH
    );
    db.run("DELETE FROM observe_ingest_windows WHERE window_start < ?", nowMs - 2 * RATE_LIMIT_WINDOW_MS);
    const evicted = evict(db);
    recordHealth(db, nowMs, [
      ...Array.from({ length: evicted.invocations }, (): HealthEvent => ({ counter: "evicted", reason: "invocations", example: null })),
      ...Array.from({ length: evicted.occurrences }, (): HealthEvent => ({ counter: "evicted", reason: "occurrences", example: null })),
      ...Array.from({ length: Math.max(operationExcess, 0) }, (): HealthEvent => ({ counter: "evicted", reason: "operations", example: null })),
      ...Array.from({ length: Math.max(outcomeExcess, 0) }, (): HealthEvent => ({ counter: "evicted", reason: "outcomes", example: null }))
    ]);
    recordWriteCost(db, nowMs, "cleanup", Math.min(expiredInvocations, CLEANUP_BATCH) + evicted.invocations, db.rowsWritten() - writtenBefore);
    const deleted = Math.min(expiredInvocations, CLEANUP_BATCH) + Math.min(expiredOccurrences, CLEANUP_BATCH) + Math.min(expiredExternal, CLEANUP_BATCH);
    return { deleted, evicted: evicted.invocations + evicted.occurrences, more: expiredInvocations > CLEANUP_BATCH || expiredOccurrences > CLEANUP_BATCH || expiredExternal > CLEANUP_BATCH };
  });
}

function evict(db: SqlStatements): { readonly invocations: number; readonly occurrences: number } {
  const invocationExcess = Math.min(count(db, "SELECT COUNT(*) AS n FROM observe_invocations") - MAX_RETAINED_INVOCATIONS, CLEANUP_BATCH);
  if (invocationExcess > 0) db.run("DELETE FROM observe_invocations WHERE key IN (SELECT key FROM observe_invocations WHERE failed = 0 ORDER BY observed_at LIMIT ?)", invocationExcess);
  const occurrenceExcess = Math.min(count(db, "SELECT COUNT(*) AS n FROM observe_occurrences") - MAX_RETAINED_OCCURRENCES, CLEANUP_BATCH);
  if (occurrenceExcess > 0) db.run("DELETE FROM observe_occurrences WHERE id IN (SELECT id FROM observe_occurrences ORDER BY observed_at LIMIT ?)", occurrenceExcess);
  return { invocations: Math.max(invocationExcess, 0), occurrences: Math.max(occurrenceExcess, 0) };
}

export function nextCleanupAt(db: SqlStatements, nowMs: number, cleaned: CleanupResult): number | null {
  if (cleaned.more) return nowMs;
  const oldest = db.rows<{ at: number | null }>("SELECT MIN(at) AS at FROM (SELECT MIN(observed_at) AS at FROM observe_invocations UNION ALL SELECT MIN(observed_at) FROM observe_occurrences UNION ALL SELECT MIN(event_at) FROM observe_external_events UNION ALL SELECT MIN(received_at) FROM observe_external_events)")[0]?.at ?? null;
  const flushed = db.rows<{ at: number | null }>("SELECT MIN(applied_at) AS at FROM observe_applied_flushes")[0]?.at ?? null;
  const expiries = [oldest === null ? null : oldest + RETENTION_MS, oldestCountExpiryMs(db), flushed === null ? null : flushed + RETENTION_MS].filter(at => at !== null);
  const expiry = expiries.length === 0 ? null : Math.min(...expiries);
  if (expiry === null) return null;
  return Math.max(expiry, nowMs + CLEANUP_INTERVAL_MS);
}

function count(db: SqlStatements, query: string, ...params: SqlValue[]): number {
  return db.rows<{ n: number }>(query, ...params)[0]?.n ?? 0;
}

const KEYSET = /^(\d{1,16})\.([0-9a-f]{1,64})$/u;

function parseCursor(cursor: string | undefined): { at: number; key: string } | null {
  if (cursor === undefined) return null;
  const match = KEYSET.exec(cursor);
  if (match === null) throw new RangeError("invalid cursor");
  return { at: Number(match[1]), key: match[2] ?? "" };
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return MAX_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("invalid page size");
  return Math.min(limit, MAX_PAGE_SIZE);
}

function page<T>(rows: readonly T[], size: number, cursorOf: (row: T) => string): Page<T> {
  const items = rows.slice(0, size);
  const last = items.at(-1);
  return { items, next: rows.length > size && last !== undefined ? cursorOf(last) : null };
}

interface IssueRow {
  fingerprint: string; name: string; operation: string | null; frame: string | null; state: IssueState;
  occurrences: number; first_at: number; last_at: number; last_version: string | null; versions: number; first_version: string | null; first_version_label: string | null;
}

export function listIssues(db: SqlStatements, nowMs: number, filter: { readonly state?: IssueState; readonly introducedIn?: string; readonly fingerprint?: string; readonly cursor?: string; readonly limit?: number } = {}): Page<IssueSummary> {
  const cutoff = nowMs - RETENTION_MS;
  const size = pageSize(filter.limit);
  const cursor = parseCursor(filter.cursor);
  const rows = db.rows<IssueRow>(
    `SELECT i.fingerprint, i.name, i.operation, i.frame, i.state, COUNT(*) AS occurrences, MIN(o.observed_at) AS first_at, MAX(o.observed_at) AS last_at,
       COUNT(DISTINCT o.version) AS versions,
       (SELECT l.version FROM observe_occurrences l WHERE l.fingerprint = i.fingerprint AND l.propagated = 0 AND l.observed_at > ? ORDER BY l.observed_at DESC, l.id DESC LIMIT 1) AS last_version,
       (SELECT f.version FROM observe_occurrences f WHERE f.fingerprint = i.fingerprint AND f.propagated = 0 AND f.observed_at > ? ORDER BY f.observed_at, f.id LIMIT 1) AS first_version
     FROM observe_issues i JOIN observe_occurrences o ON o.fingerprint = i.fingerprint AND o.propagated = 0 AND o.observed_at > ?
     WHERE (? IS NULL OR i.state = ?) AND (? IS NULL OR i.fingerprint = ?)
     GROUP BY i.fingerprint
     HAVING (? IS NULL OR first_version = ?) AND (? IS NULL OR MAX(o.observed_at) < ? OR (MAX(o.observed_at) = ? AND i.fingerprint < ?))
     ORDER BY last_at DESC, i.fingerprint DESC LIMIT ?`,
    cutoff, cutoff, cutoff, filter.state ?? null, filter.state ?? null, filter.fingerprint ?? null, filter.fingerprint ?? null, filter.introducedIn ?? null, filter.introducedIn ?? null,
    cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.key ?? null, size + 1
  );
  const labels = versionLabels(db, rows.map(row => row.first_version));
  const issues = rows.map(row => ({
    fingerprint: row.fingerprint, name: row.name, operation: row.operation, frame: row.frame, state: row.state,
    occurrences: row.occurrences, firstAtMs: row.first_at, lastAtMs: row.last_at, lastVersion: row.last_version, versions: row.versions,
    firstVersion: row.first_version, firstVersionLabel: row.first_version === null ? null : labels.get(row.first_version) ?? null
  }));
  return page(issues, size, issue => `${issue.lastAtMs}.${issue.fingerprint}`);
}

export function recordArtifact(db: SqlStatements, artifact: { readonly version: string; readonly file: string; readonly map: string; readonly digest: string }, nowMs: number): ArtifactResult {
  return db.transaction(() => {
    const existing = db.rows<{ digest: string }>("SELECT digest FROM observe_artifacts WHERE version = ? AND file = ?", artifact.version, artifact.file)[0];
    if (existing !== undefined) return existing.digest === artifact.digest ? "duplicate" : "conflict";
    db.run("INSERT INTO observe_artifacts (version, file, digest, map, uploaded_at) VALUES (?, ?, ?, ?, ?)", artifact.version, artifact.file, artifact.digest, artifact.map, nowMs);
    return "accepted";
  });
}

export function readArtifact(db: SqlStatements, version: string, file: string): string | null {
  return db.rows<{ map: string }>("SELECT map FROM observe_artifacts WHERE version = ? AND file = ?", version, file)[0]?.map ?? null;
}

export function latestFrames(db: SqlStatements, nowMs: number, fingerprint: string): { readonly version: string | null; readonly frames: readonly StackFrame[] } | null {
  const row = db.rows<{ version: string | null; frames: string }>(
    "SELECT version, frames FROM observe_occurrences WHERE fingerprint = ? AND propagated = 0 AND observed_at > ? ORDER BY observed_at DESC, id DESC LIMIT 1",
    fingerprint, nowMs - RETENTION_MS
  )[0];
  return row === undefined ? null : { version: row.version, frames: readFrames(row.frames) };
}

export function readIssue(db: SqlStatements, nowMs: number, fingerprint: string): IssueSummary | null {
  return listIssues(db, nowMs, { fingerprint, limit: 1 }).items[0] ?? null;
}

function versionLabels(db: SqlStatements, versions: readonly (string | null)[]): Map<string, string> {
  const wanted = [...new Set(versions.filter((version): version is string => version !== null))];
  if (wanted.length === 0) return new Map();
  const rows = db.rows<{ version: string; label: string | null }>("SELECT version, label FROM observe_version_labels WHERE version IN (SELECT value FROM json_each(?))", JSON.stringify(wanted));
  return new Map(rows.flatMap(row => row.label === null ? [] : [[row.version, row.label] as [string, string]]));
}

const IMPACT_ISSUES = 50;
const IMPACT_ROUTES = 20;

type ValueCounts = readonly (readonly [value: number, count: number])[];

function weightedPercentile(sorted: ValueCounts, total: number, fraction: number): number | null {
  if (total === 0) return null;
  const rank = Math.min(total, Math.max(1, Math.ceil(fraction * total)));
  let seen = 0;
  for (const [value, count] of sorted) {
    seen += count;
    if (seen >= rank) return value;
  }
  return sorted.at(-1)?.[0] ?? null;
}

function routeVersionStats(version: string, cpu: ValueCounts, wall: ValueCounts): RouteVersionStats {
  const requests = cpu.reduce((sum, [, count]) => sum + count, 0);
  if (requests === 0) return { version, requests, cpuMeanMs: null, cpuStdErrMs: null, p50CpuMs: null, p95CpuMs: null, p50WallMs: null, p95WallMs: null };
  const mean = cpu.reduce((sum, [value, count]) => sum + value * count, 0) / requests;
  const squares = cpu.reduce((sum, [value, count]) => sum + count * (value - mean) ** 2, 0);
  return {
    version, requests, cpuMeanMs: mean, cpuStdErrMs: requests < 2 ? null : Math.sqrt(squares / (requests - 1) / requests),
    p50CpuMs: weightedPercentile(cpu, requests, 0.5), p95CpuMs: weightedPercentile(cpu, requests, 0.95),
    p50WallMs: weightedPercentile(wall, requests, 0.5), p95WallMs: weightedPercentile(wall, requests, 0.95)
  };
}

function routeComparisons(db: SqlStatements, cutoff: number, versions: readonly string[]): RouteComparison[] {
  const grouped = (column: "cpu_ms" | "wall_ms") => db.rows<{ stage: Stage; label: string; version: string; value: number; n: number }>(
    `SELECT stage, label, version, ${column} AS value, COUNT(*) AS n FROM observe_invocations
     WHERE observed_at > ? AND version IN (SELECT value FROM json_each(?)) GROUP BY stage, label, version, ${column} ORDER BY value`,
    cutoff, JSON.stringify(versions)
  );
  const collect = (rows: ReturnType<typeof grouped>) => {
    const byRoute = new Map<string, Map<string, [number, number][]>>();
    for (const row of rows) {
      const route = `${row.stage}\u0000${row.label}`;
      let perVersion = byRoute.get(route);
      if (perVersion === undefined) {
        perVersion = new Map<string, [number, number][]>();
        byRoute.set(route, perVersion);
      }
      const values = perVersion.get(row.version);
      if (values === undefined) perVersion.set(row.version, [[row.value, row.n]]);
      else values.push([row.value, row.n]);
    }
    return byRoute;
  };
  const cpu = collect(grouped("cpu_ms"));
  const wall = collect(grouped("wall_ms"));
  return [...cpu].map(([route, perVersion]) => {
    const [stage, label] = route.split("\u0000") as [Stage, string];
    return { stage, label, versions: versions.map(version => routeVersionStats(version, perVersion.get(version) ?? [], wall.get(route)?.get(version) ?? [])) };
  })
    .sort((a, b) => b.versions.reduce((sum, version) => sum + version.requests, 0) - a.versions.reduce((sum, version) => sum + version.requests, 0) || a.stage.localeCompare(b.stage) || a.label.localeCompare(b.label))
    .slice(0, IMPACT_ROUTES);
}

export function rolloutImpact(db: SqlStatements, nowMs: number, rolloutId: string, sampling: Sampling = KEEP_ALL): RolloutImpact | null {
  const rollout = db.rows<{ id: string; at_ms: number }>("SELECT id, at_ms FROM observe_rollouts WHERE id = ?", rolloutId)[0];
  if (rollout === undefined) return null;
  const cutoff = nowMs - RETENTION_MS;
  const sharesOf = (id: string) => db.rows<{ version: string }>("SELECT version FROM observe_rollout_shares WHERE rollout_id = ? AND percent > 0 ORDER BY version", id).map(row => row.version);
  const previous = db.rows<{ id: string }>("SELECT id FROM observe_rollouts WHERE at_ms < ? OR (at_ms = ? AND id < ?) ORDER BY at_ms DESC, id DESC LIMIT 1", rollout.at_ms, rollout.at_ms, rollout.id)[0] ?? null;
  const current = sharesOf(rollout.id);
  const previousShares = previous === null ? [] : sharesOf(previous.id);
  const before = new Set([
    ...previousShares,
    ...db.rows<{ version: string }>("SELECT DISTINCT version FROM observe_invocations WHERE observed_at > ? AND observed_at < ? AND version IS NOT NULL", cutoff, rollout.at_ms).map(row => row.version)
  ]);
  const introduced = current.filter(version => !before.has(version));
  const oldest = db.rows<{ at: number | null }>("SELECT MIN(observed_at) AS at FROM observe_invocations WHERE observed_at > ?", cutoff)[0]?.at ?? null;
  const baselineMs = oldest === null ? 0 : Math.max(0, rollout.at_ms - Math.max(cutoff, oldest));
  const state: ImpactState = rollout.at_ms <= cutoff ? "expired" : "measured";
  const introducedJson = JSON.stringify(introduced);
  const beforeJson = JSON.stringify([...before]);
  const issueRef = (row: { fingerprint: string; name: string; operation: string | null; frame: string | null; occurrences: number; first_at: number }): IssueRef =>
    ({ fingerprint: row.fingerprint, name: row.name, operation: row.operation, frame: row.frame, occurrences: row.occurrences, firstAtMs: row.first_at });
  type IssueRefRow = Parameters<typeof issueRef>[0];
  const measured = state === "measured" && introduced.length > 0;
  const newIssues = !measured ? [] : db.rows<IssueRefRow>(
    `SELECT i.fingerprint, i.name, i.operation, i.frame, COUNT(*) AS occurrences, MIN(o.observed_at) AS first_at
     FROM observe_issues i JOIN observe_occurrences o ON o.fingerprint = i.fingerprint AND o.propagated = 0 AND o.observed_at > ?
     GROUP BY i.fingerprint
     HAVING SUM(o.observed_at >= ? AND o.version IN (SELECT value FROM json_each(?))) > 0
       AND SUM(o.observed_at < ? OR o.version IS NULL OR o.version IN (SELECT value FROM json_each(?))) = 0
     ORDER BY first_at, i.fingerprint LIMIT ?`,
    cutoff, rollout.at_ms, introducedJson, rollout.at_ms, beforeJson, IMPACT_ISSUES
  ).map(issueRef);
  const regressions = !measured ? [] : db.rows<IssueRefRow>(
    `SELECT i.fingerprint, i.name, i.operation, i.frame, COUNT(*) AS occurrences, MIN(o.observed_at) AS first_at
     FROM observe_issues i JOIN observe_occurrences o ON o.fingerprint = i.fingerprint AND o.propagated = 0 AND o.observed_at > ?
       AND o.observed_at >= ? AND o.observed_at > i.resolved_at AND o.version IN (SELECT value FROM json_each(?))
     WHERE i.resolved_at IS NOT NULL AND i.resolved_at < ?
     GROUP BY i.fingerprint
     ORDER BY first_at, i.fingerprint LIMIT ?`,
    cutoff, rollout.at_ms, introducedJson, rollout.at_ms, IMPACT_ISSUES
  ).map(issueRef);
  const compared = [...new Set([...previousShares, ...current])];
  const counts = sampling.kind === "sampled" ? versionRequests(db, nowMs, compared) : new Map(db.rows<{ version: string; requests: number; failed: number }>(
    "SELECT version, COUNT(*) AS requests, SUM(failed) AS failed FROM observe_invocations WHERE stage = 'worker' AND observed_at > ? AND version IN (SELECT value FROM json_each(?)) GROUP BY version",
    cutoff, JSON.stringify(compared)
  ).map(row => [row.version, row]));
  const labels = versionLabels(db, compared);
  const versions = compared.map(version => ({
    version, label: labels.get(version) ?? null, introduced: introduced.includes(version),
    requests: counts.get(version)?.requests ?? 0, failed: counts.get(version)?.failed ?? 0
  }));
  const routes = state === "measured" ? routeComparisons(db, cutoff, compared) : [];
  return { rolloutId: rollout.id, atMs: rollout.at_ms, previousRolloutId: previous?.id ?? null, introduced, state, baselineMs, newIssues, regressions, versions, routes };
}

interface OccurrenceRow {
  id: number; invocation_key: string; trace_id: string | null; observed_at: number; version: string | null;
  source: OccurrenceSource; operation: string | null; name: string; message: string | null; frames: string;
}

const OCCURRENCE_COLUMNS = "id, invocation_key, trace_id, observed_at, version, source, operation, name, message, frames";

function occurrence(row: OccurrenceRow): Occurrence {
  return {
    id: row.id, invocationKey: row.invocation_key, traceId: row.trace_id, atMs: row.observed_at, version: row.version,
    source: row.source, operation: row.operation, name: row.name, message: row.message, frames: readFrames(row.frames).map(frame => ({ ...frame, original: null }))
  };
}

export function issueOccurrences(db: SqlStatements, nowMs: number, fingerprint: string, filter: { readonly cursor?: string; readonly limit?: number } = {}): Page<Occurrence> {
  const size = pageSize(filter.limit);
  const cursor = parseCursor(filter.cursor);
  const rows = db.rows<OccurrenceRow>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM observe_occurrences
     WHERE fingerprint = ? AND propagated = 0 AND observed_at > ? AND (? IS NULL OR observed_at < ? OR (observed_at = ? AND id < ?))
     ORDER BY observed_at DESC, id DESC LIMIT ?`,
    fingerprint, nowMs - RETENTION_MS, cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor === null ? null : Number.parseInt(cursor.key, 16), size + 1
  );
  return page(rows.map(occurrence), size, item => `${item.atMs}.${item.id.toString(16)}`);
}

export function setIssueState(db: SqlStatements, nowMs: number, fingerprint: string, state: IssueState): boolean {
  return db.transaction(() => {
    const visible = db.rows<{ one: number }>(
      "SELECT 1 AS one FROM observe_issues i WHERE i.fingerprint = ? AND EXISTS (SELECT 1 FROM observe_occurrences o WHERE o.fingerprint = i.fingerprint AND o.propagated = 0 AND o.observed_at > ?)",
      fingerprint, nowMs - RETENTION_MS
    ).length > 0;
    if (visible) db.run("UPDATE observe_issues SET state = ?, state_at = ?, resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END WHERE fingerprint = ?", state, nowMs, state, nowMs, fingerprint);
    return visible;
  });
}

interface InvocationRow {
  key: string; trace_id: string | null; stage: Stage; kind: InvocationKind; label: string; object_id: string | null; status: number | null;
  outcome: string; failed: number; cpu_ms: number; wall_ms: number; event_at: number; version: string | null; error_count: number;
}

const INVOCATION_COLUMNS = "key, trace_id, stage, kind, label, object_id, status, outcome, failed, cpu_ms, wall_ms, event_at, version, error_count";

function invocationSummary(row: InvocationRow): InvocationSummary {
  return {
    key: row.key, traceId: row.trace_id, stage: row.stage, kind: row.kind, label: row.label, objectId: row.object_id, status: row.status,
    outcome: row.outcome, failed: row.failed === 1, cpuMs: row.cpu_ms, wallMs: row.wall_ms, atMs: row.event_at, version: row.version, errorCount: row.error_count
  };
}

export function eventWindow(nowMs: number, fromMs: number | undefined, toMs: number | undefined): { fromMs: number; toMs: number } {
  const from = Math.max(fromMs ?? nowMs - RETENTION_MS, nowMs - RETENTION_MS);
  const to = Math.min(toMs ?? nowMs, nowMs);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw new RangeError("invalid time window");
  return { fromMs: from, toMs: to };
}

export function listTraces(db: SqlStatements, nowMs: number, filter: TraceFilter = {}): Page<TraceSummary> {
  const cutoff = nowMs - RETENTION_MS;
  const { fromMs, toMs } = eventWindow(nowMs, filter.fromMs, filter.toMs);
  const size = pageSize(filter.limit);
  const cursor = parseCursor(filter.cursor);
  const failed = filter.failed === undefined ? null : filter.failed ? 1 : 0;
  const slowest = filter.order === "slowest";
  const keyset = slowest
    ? "(? IS NULL OR wall_ms < ? OR (wall_ms = ? AND key < ?))"
    : "(? IS NULL OR observed_at < ? OR (observed_at = ? AND key < ?))";
  const rows = db.rows<InvocationRow & { observed_at: number; object_invocations: number; object_cpu_ms: number | null }>(
    `SELECT ${INVOCATION_COLUMNS}, observed_at,
       (SELECT COUNT(*) FROM observe_invocations c WHERE c.trace_id = r.trace_id AND c.stage = 'object' AND c.observed_at > ?) AS object_invocations,
       (SELECT SUM(c.cpu_ms) FROM observe_invocations c WHERE c.trace_id = r.trace_id AND c.stage = 'object' AND c.observed_at > ?) AS object_cpu_ms
     FROM observe_invocations r
     WHERE stage = 'worker' AND observed_at > ? AND observed_at >= ? AND observed_at <= ?
       AND (? IS NULL OR label = ?) AND (? IS NULL OR version = ?) AND (? IS NULL OR failed = ?)
       AND (? IS NULL OR wall_ms >= ?) AND (? IS NULL OR wall_ms < ?) AND ${keyset}
     ORDER BY ${slowest ? "wall_ms DESC" : "observed_at DESC"}, key DESC LIMIT ?`,
    cutoff, cutoff, cutoff, fromMs, toMs, filter.label ?? null, filter.label ?? null, filter.version ?? null, filter.version ?? null, failed, failed,
    filter.minWallMs ?? null, filter.minWallMs ?? null, filter.maxWallMs ?? null, filter.maxWallMs ?? null,
    cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.key ?? null, size + 1
  );
  const traces = rows.map(row => ({ ...invocationSummary(row), observedAt: row.observed_at, objectInvocations: row.object_invocations, objectCpuMs: row.object_cpu_ms ?? 0 }));
  const result = page(traces, size, trace => `${slowest ? trace.wallMs : trace.observedAt}.${trace.key}`);
  return { items: result.items.map(({ observedAt: _observedAt, ...trace }) => trace), next: result.next };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
}

function durationBin(wallMs: number): number {
  const index = DURATION_EDGES.findIndex(edge => wallMs < edge);
  return index === -1 ? DURATION_EDGES.length : index;
}

export function explore(db: SqlStatements, nowMs: number, filter: { readonly fromMs?: number; readonly toMs?: number; readonly route?: string } = {}): Exploration {
  const cutoff = nowMs - RETENTION_MS;
  const { fromMs, toMs } = eventWindow(nowMs, filter.fromMs, filter.toMs);
  const rows = db.rows<{ label: string; observed_at: number; wall_ms: number; failed: number; cpu_ms: number }>(
    `SELECT r.label, r.observed_at, r.wall_ms, r.failed, r.cpu_ms + COALESCE(c.cpu_ms, 0) AS cpu_ms
     FROM observe_invocations r
     LEFT JOIN (SELECT trace_id, SUM(cpu_ms) AS cpu_ms FROM observe_invocations WHERE stage = 'object' AND observed_at > ? AND observed_at >= ? GROUP BY trace_id) c ON c.trace_id = r.trace_id
     WHERE r.stage = 'worker' AND r.observed_at > ? AND r.observed_at >= ? AND r.observed_at <= ?`,
    cutoff, fromMs - 60_000, cutoff, fromMs, toMs
  );
  const byRoute = new Map<string, typeof rows>();
  for (const row of rows) byRoute.set(row.label, [...byRoute.get(row.label) ?? [], row]);
  const routes = [...byRoute].map(([label, entries]) => {
    const walls = entries.map(entry => entry.wall_ms).sort((a, b) => a - b);
    const cpus = entries.map(entry => entry.cpu_ms).sort((a, b) => a - b);
    return {
      label, requests: entries.length, failed: entries.reduce((sum, entry) => sum + entry.failed, 0), cpuMs: cpus.reduce((sum, cpu) => sum + cpu, 0),
      p50WallMs: percentile(walls, 0.5), p95WallMs: percentile(walls, 0.95), p99WallMs: percentile(walls, 0.99), p50CpuMs: percentile(cpus, 0.5), p95CpuMs: percentile(cpus, 0.95)
    };
  }).sort((a, b) => b.cpuMs - a.cpuMs || a.label.localeCompare(b.label));
  const route = filter.route !== undefined && byRoute.has(filter.route) ? filter.route : null;
  const selected = route === null ? rows : byRoute.get(route) ?? [];
  const bucketMs = Math.max(1, Math.ceil((toMs - fromMs) / HEATMAP_BUCKETS));
  const cells = Array.from({ length: HEATMAP_BUCKETS }, () => Array.from({ length: DURATION_EDGES.length + 1 }, () => 0));
  const failed = Array.from({ length: HEATMAP_BUCKETS }, () => 0);
  const walls: number[][] = Array.from({ length: HEATMAP_BUCKETS }, () => []);
  for (const row of selected) {
    const bucket = Math.min(HEATMAP_BUCKETS - 1, Math.floor((row.observed_at - fromMs) / bucketMs));
    const cell = cells[bucket]!;
    const bin = durationBin(row.wall_ms);
    cell[bin] = (cell[bin] ?? 0) + 1;
    failed[bucket] = (failed[bucket] ?? 0) + row.failed;
    walls[bucket]!.push(row.wall_ms);
  }
  const p95WallMs = walls.map(values => values.length < MIN_PERCENTILE_SAMPLES ? null : percentile(values.sort((a, b) => a - b), 0.95));
  return { fromMs, toMs, route, routes, heatmap: { fromMs, bucketMs, edges: DURATION_EDGES, cells, failed, p95WallMs } };
}

export function objectMethods(db: SqlStatements, nowMs: number, filter: { readonly fromMs?: number; readonly toMs?: number } = {}): ObjectMethods {
  const cutoff = nowMs - RETENTION_MS;
  const { fromMs, toMs } = eventWindow(nowMs, filter.fromMs, filter.toMs);
  const objectRows = db.rows<{ label: string; wall_ms: number; failed: number; cpu_ms: number }>(
    "SELECT label, wall_ms, failed, cpu_ms FROM observe_invocations WHERE stage = 'object' AND observed_at > ? AND observed_at >= ? AND observed_at <= ?",
    cutoff, fromMs, toMs
  );
  const byMethod = new Map<string, typeof objectRows>();
  for (const row of objectRows) byMethod.set(row.label, [...byMethod.get(row.label) ?? [], row]);
  const methods = [...byMethod].map(([label, entries]) => {
    const walls = entries.map(entry => entry.wall_ms).sort((a, b) => a - b);
    return {
      label, requests: entries.length, failed: entries.reduce((sum, entry) => sum + entry.failed, 0),
      cpuMs: entries.reduce((sum, entry) => sum + entry.cpu_ms, 0), wallMs: walls.reduce((sum, wall) => sum + wall, 0),
      p50WallMs: percentile(walls, 0.5), p95WallMs: percentile(walls, 0.95)
    };
  }).sort((a, b) => b.wallMs - a.wallMs || a.label.localeCompare(b.label));
  return { fromMs, toMs, methods };
}

const TRACE_ID = /^[0-9a-f]{32}$/u;

export function readTrace(db: SqlStatements, nowMs: number, traceId: string): TraceDetail | null {
  if (!TRACE_ID.test(traceId)) throw new RangeError("invalid trace id");
  const cutoff = nowMs - RETENTION_MS;
  const rows = db.rows<InvocationRow>(
    `SELECT ${INVOCATION_COLUMNS} FROM observe_invocations WHERE trace_id = ? AND observed_at > ? ORDER BY stage = 'object', event_at, key LIMIT ?`,
    traceId, cutoff, MAX_TRACE_INVOCATIONS + 1
  );
  if (rows.length === 0) return null;
  const invocations = rows.slice(0, MAX_TRACE_INVOCATIONS).map(invocationSummary);
  const occurrences = db.rows<OccurrenceRow>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM observe_occurrences WHERE trace_id = ? AND observed_at > ? AND propagated = 0 ORDER BY observed_at, id`,
    traceId, cutoff
  ).map(occurrence);
  return { traceId, rootPresent: invocations.some(invocation => invocation.stage === "worker"), truncated: rows.length > MAX_TRACE_INVOCATIONS, invocations, occurrences };
}

export function health(db: SqlStatements, nowMs: number, sampling: Sampling = KEEP_ALL): Health {
  const cutoff = nowMs - RETENTION_MS;
  const live = db.rows<{ n: number; oldest: number | null; newest: number | null }>(
    "SELECT COUNT(*) AS n, MIN(observed_at) AS oldest, MAX(observed_at) AS newest FROM observe_invocations WHERE observed_at > ?", cutoff
  )[0];
  const backlog = db.rows<{ n: number; oldest: number | null }>("SELECT COUNT(*) AS n, MIN(observed_at) AS oldest FROM observe_invocations WHERE observed_at <= ?", cutoff)[0];
  const reasons = db.rows<HealthReason>(
    `SELECT counter, reason, SUM(count) AS count, MAX(example) AS example FROM observe_health_events WHERE bucket_at + ? > ?
     GROUP BY counter, reason ORDER BY count DESC, counter, reason`,
    HEALTH_BUCKET_MS, cutoff
  );
  const total = (counter: HealthCounter): number => reasons.reduce((sum, reason) => sum + (reason.counter === counter ? reason.count : 0), 0);
  const cost = db.rows<{ phase: "ingest" | "cleanup"; runs: number; invocations: number; rows_written: number }>(
    "SELECT phase, SUM(runs) AS runs, SUM(invocations) AS invocations, SUM(rows_written) AS rows_written FROM observe_write_cost WHERE bucket_at + ? > ? GROUP BY phase",
    HEALTH_BUCKET_MS, cutoff
  );
  const ingestCost = cost.find(row => row.phase === "ingest");
  const cleanupCost = cost.find(row => row.phase === "cleanup");
  const openIssues = count(db, `SELECT COUNT(*) AS n FROM observe_issues i WHERE i.state = 'open' AND EXISTS (SELECT 1 FROM observe_occurrences o WHERE o.fingerprint = i.fingerprint AND o.propagated = 0 AND o.observed_at > ?)`, cutoff);
  const oldestExpired = backlog?.oldest ?? null;
  return {
    newestAtMs: live?.newest ?? null,
    oldestAtMs: live?.oldest ?? null,
    liveInvocations: live?.n ?? 0,
    cleanupBacklog: backlog?.n ?? 0,
    cleanupLagMs: oldestExpired === null ? 0 : nowMs - (oldestExpired + RETENTION_MS),
    openIssues,
    duplicate: total("duplicate"),
    conflict: total("conflict"),
    expired: total("expired"),
    future: total("future"),
    rejected: total("rejected"),
    issueCapacity: total("issue_capacity"),
    evicted: total("evicted"),
    reasons: reasons.slice(0, MAX_HEALTH_REASONS).map(({ counter, reason, count, example }) => ({ counter, reason, count, example })),
    writes: { ingestBatches: ingestCost?.runs ?? 0, accepted: ingestCost?.invocations ?? 0, ingestRows: ingestCost?.rows_written ?? 0, cleanupRows: cleanupCost?.rows_written ?? 0 },
    ...(sampling.kind === "sampled" ? { sampling: samplingHealth(db, nowMs, sampling) } : {})
  };
}

const WORK_FIELDS = {
  received: "received", persisted: "persisted", duplicate: "duplicate",
  rejected_invalid_sample: "rejectedInvalidSample", rejected_too_old: "rejectedTooOld", rejected_conflict: "rejectedConflict", input_bytes: "inputBytes",
  points: "points", cells: "cells", output_bytes: "outputBytes", cache_hit_304: "cacheHit304", cache_rebuilt: "cacheRebuilt",
  runs: "runs", metric_rows: "metricRows", hour_rollups: "hourRollups", upstream_queries: "upstreamQueries", expired: "expired", backlog_remaining: "backlogRemaining"
} as const satisfies Record<OperationWorkColumn, string>;

export type OperationWorkField = typeof WORK_FIELDS[OperationWorkColumn];
export type OperationWorkTotals = Readonly<Record<OperationWorkField, number>>;

export interface WindowQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly operation?: OperationId;
  readonly workloadClass?: string;
}

export interface OperationWindowRow {
  readonly bucketAt: number;
  readonly version: string;
  readonly operation: OperationId;
  readonly workloadClass: string;
  readonly synthetic: boolean;
  readonly count: number;
  readonly failed: number;
  readonly cpuMsSum: number;
  readonly wallMsSum: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly statements: number;
  readonly lagCount: number;
  readonly lagMsMax: number;
  readonly lagMsSum: number;
  readonly work: OperationWorkTotals;
}

export interface OutcomeWindowRow {
  readonly bucketAt: number;
  readonly version: string;
  readonly stage: Stage | "unknown";
  readonly outcome: typeof OUTCOME_CLASSES[number];
  readonly count: number;
  readonly lagCount: number;
  readonly lagMsMax: number;
  readonly lagMsSum: number;
  readonly filterRevision: number;
}

export interface InvocationWindowRow {
  readonly bucketAt: number;
  readonly version: string;
  readonly stage: Stage;
  readonly count: number;
}

export interface LagTotals {
  readonly count: number;
  readonly maxMs: number;
  readonly sumMs: number;
}

export interface StatsWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly bucketMs: number;
  readonly operation: OperationId | null;
  readonly workloadClass: string | null;
  readonly filterRevision: number;
  readonly operations: readonly OperationWindowRow[];
  readonly outcomes: readonly OutcomeWindowRow[];
  readonly invocations: readonly InvocationWindowRow[];
  readonly lag: { readonly operations: LagTotals; readonly outcomes: LagTotals };
  readonly counts?: readonly CountedRoute[];
  readonly sampling?: SamplingSummary;
}

interface StoredOperationRow {
  bucket_at: number; version: string; operation: OperationId; workload_class: string; synthetic: number; count: number; failed: number;
  cpu_ms_sum: number; wall_ms_sum: number; rows_read: number; rows_written: number; statements: number; lag_count: number; lag_ms_max: number; lag_ms_sum: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lagTotals(rows: readonly { readonly lagCount: number; readonly lagMsMax: number; readonly lagMsSum: number }[]): LagTotals {
  return { count: rows.reduce((sum, row) => sum + row.lagCount, 0), maxMs: rows.reduce((max, row) => Math.max(max, row.lagMsMax), 0), sumMs: rows.reduce((sum, row) => sum + row.lagMsSum, 0) };
}

/** Exact half-open event-time window; no rollout or version history is consulted, so a reused version carries only what it produced inside the bounds. */
export function statsWindow(db: SqlStatements, query: WindowQuery, sampling: Sampling = KEEP_ALL): StatsWindow {
  const columns = Object.keys(WORK_FIELDS) as OperationWorkColumn[];
  const filters = ["bucket_at >= ?", "bucket_at < ?"];
  const params: SqlValue[] = [query.fromMs, query.toMs];
  if (query.operation !== undefined) {
    filters.push("operation = ?");
    params.push(query.operation);
    if (query.workloadClass !== undefined) {
      filters.push("workload_class = ?");
      params.push(query.workloadClass);
    }
  }
  const operations = db.rows<StoredOperationRow & Record<OperationWorkColumn, number>>(
    `SELECT bucket_at, version, operation, workload_class, synthetic, count, failed, cpu_ms_sum, wall_ms_sum, rows_read, rows_written, statements, lag_count, lag_ms_max, lag_ms_sum, ${columns.join(", ")}
     FROM observe_operations WHERE ${filters.join(" AND ")} ORDER BY bucket_at, version, operation, workload_class, synthetic`, ...params
  ).map((row): OperationWindowRow => ({
    bucketAt: row.bucket_at, version: row.version, operation: row.operation, workloadClass: row.workload_class, synthetic: row.synthetic === 1, count: row.count, failed: row.failed,
    cpuMsSum: row.cpu_ms_sum, wallMsSum: row.wall_ms_sum, rowsRead: row.rows_read, rowsWritten: row.rows_written, statements: row.statements,
    lagCount: row.lag_count, lagMsMax: row.lag_ms_max, lagMsSum: row.lag_ms_sum,
    work: Object.fromEntries(columns.map(column => [WORK_FIELDS[column], row[column]])) as OperationWorkTotals
  }));
  const outcomes = db.rows<{ bucket_at: number; version: string; stage: Stage | "unknown"; outcome: typeof OUTCOME_CLASSES[number]; count: number; lag_count: number; lag_ms_max: number; lag_ms_sum: number; filter_revision: number }>(
    `SELECT bucket_at, version, stage, outcome, SUM(count) AS count, SUM(lag_count) AS lag_count, MAX(lag_ms_max) AS lag_ms_max, SUM(lag_ms_sum) AS lag_ms_sum, filter_revision
     FROM observe_outcomes WHERE bucket_at >= ? AND bucket_at < ? GROUP BY bucket_at, version, stage, outcome, filter_revision ORDER BY bucket_at, version, stage, outcome, filter_revision`, query.fromMs, query.toMs
  ).map((row): OutcomeWindowRow => ({ bucketAt: row.bucket_at, version: row.version, stage: row.stage, outcome: row.outcome, count: row.count, lagCount: row.lag_count, lagMsMax: row.lag_ms_max, lagMsSum: row.lag_ms_sum, filterRevision: row.filter_revision }));
  const counted = sampling.kind === "sampled" ? countWindow(db, query.fromMs, query.toMs) : null;
  const invocations = counted !== null ? counted.invocations.map((row): InvocationWindowRow => ({ ...row })) : db.rows<{ bucket_at: number; version: string | null; stage: Stage; count: number }>(
    `SELECT observed_at - observed_at % ? AS bucket_at, COALESCE(version, '') AS version, stage, COUNT(*) AS count
     FROM observe_invocations WHERE observed_at >= ? AND observed_at < ? GROUP BY bucket_at, version, stage ORDER BY bucket_at, version, stage`, OPERATION_BUCKET_MS, query.fromMs, query.toMs
  ).map((row): InvocationWindowRow => ({ bucketAt: row.bucket_at, version: row.version ?? "", stage: row.stage, count: row.count }));
  const allOutcomes = counted === null ? outcomes : [...outcomes, ...counted.excluded.map((row): OutcomeWindowRow => ({ ...row, lagCount: 0, lagMsMax: 0, lagMsSum: 0, filterRevision: OBSERVE_FILTER_REVISION }))]
    .sort((a, b) => a.bucketAt - b.bucketAt || compareText(a.version, b.version) || compareText(a.stage, b.stage) || compareText(a.outcome, b.outcome) || a.filterRevision - b.filterRevision);
  return {
    fromMs: query.fromMs, toMs: query.toMs, bucketMs: OPERATION_BUCKET_MS, operation: query.operation ?? null, workloadClass: query.workloadClass ?? null,
    filterRevision: OBSERVE_FILTER_REVISION, operations, outcomes: allOutcomes, invocations, lag: { operations: lagTotals(operations), outcomes: lagTotals(allOutcomes) },
    ...(counted === null ? {} : { counts: countedRoutes(db, query.fromMs, query.toMs, query.operation) })
  };
}
