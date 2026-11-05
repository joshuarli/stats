import { CLEANUP_BATCH, HEALTH_BUCKET_MS, MAX_FUTURE_SKEW_MS, MAX_ISSUES, MAX_PAGE_SIZE, MAX_RETAINED_INVOCATIONS, MAX_RETAINED_OCCURRENCES, MAX_TRACE_INVOCATIONS, RETENTION_MS, CLEANUP_INTERVAL_MS, ROLLOUT_RETENTION_MS, MAX_ARTIFACTS } from "./limits.ts";
import type { InvocationKind, Preparation, PreparedError, PreparedInvocation, RolloutPreparation, Stage, VersionLabel } from "./model.ts";
import { formatFrames, readFrames, type StackFrame, type SymbolicatedFrame } from "./stack.ts";
import { representativeFrame } from "./grouping.ts";

export type SqlValue = string | number | null;

export interface SqlDatabase {
  rows<T>(query: string, ...params: SqlValue[]): T[];
  run(query: string, ...params: SqlValue[]): void;
  transaction<T>(fn: () => T): T;
  /** Cumulative rows the backend reports written by `run`, as the backend bills them. */
  rowsWritten(): number;
}

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
}

export interface Occurrence {
  readonly id: number;
  readonly invocationKey: string;
  readonly traceId: string | null;
  readonly atMs: number;
  readonly version: string | null;
  readonly source: PreparedError["source"];
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
  readonly p50WallMs: number;
  readonly p95WallMs: number;
  readonly p99WallMs: number;
  readonly p50CpuMs: number;
  readonly p95CpuMs: number;
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
}

export interface ObjectMethods {
  readonly fromMs: number;
  readonly toMs: number;
  readonly methods: readonly ObjectMethodStats[];
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
  `CREATE TABLE IF NOT EXISTS observe_occurrences (
    id INTEGER PRIMARY KEY,
    invocation_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    trace_id TEXT,
    version TEXT,
    has_stack INTEGER NOT NULL CHECK (has_stack IN (0, 1)),
    propagated INTEGER NOT NULL CHECK (propagated IN (0, 1)),
    source TEXT NOT NULL CHECK (source IN ('uncaught', 'caught')),
    operation TEXT,
    name TEXT NOT NULL,
    message TEXT,
    frames TEXT NOT NULL,
    UNIQUE (invocation_key, ordinal)
  )`,
  "CREATE INDEX IF NOT EXISTS observe_occurrences_issue ON observe_occurrences (fingerprint, observed_at)",
  "CREATE INDEX IF NOT EXISTS observe_occurrences_time ON observe_occurrences (observed_at)",
  "CREATE INDEX IF NOT EXISTS observe_occurrences_trace ON observe_occurrences (trace_id) WHERE trace_id IS NOT NULL",
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
  `CREATE TABLE IF NOT EXISTS observe_write_cost (
    bucket_at INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('ingest', 'cleanup')),
    runs INTEGER NOT NULL,
    invocations INTEGER NOT NULL,
    rows_written INTEGER NOT NULL,
    PRIMARY KEY (bucket_at, phase)
  ) WITHOUT ROWID`
];

export function initializeStore(db: SqlDatabase): void {
  db.transaction(() => {
    for (const statement of STATEMENTS) db.run(statement);
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

export function recordRollouts(db: SqlDatabase, preparations: readonly RolloutPreparation[], labels: readonly VersionLabel[], nowMs: number): RolloutResult {
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

export function ingest(db: SqlDatabase, preparations: readonly Preparation[], nowMs: number): IngestResult {
  const result: IngestResult = { accepted: 0, duplicate: 0, conflict: 0, expired: 0, future: 0, rejected: 0, issueCapacity: 0 };
  const events: HealthEvent[] = [];
  const cutoff = nowMs - RETENTION_MS;
  db.transaction(() => {
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
      for (const error of invocation.errors) {
        if (!insertOccurrence(db, invocation, error, observedAt, cutoff)) { result.issueCapacity++; events.push({ counter: "issue_capacity", reason: "issues_full", example: error.name }); }
      }
      result.accepted++;
    }
    recordHealth(db, nowMs, events);
    recordWriteCost(db, nowMs, "ingest", result.accepted, db.rowsWritten() - writtenBefore);
  });
  return result;
}

const CLIENT_ENDED_OUTCOMES: ReadonlySet<string> = new Set(["canceled", "responseStreamDisconnected"]);

function isFailed(invocation: PreparedInvocation): boolean {
  if (invocation.errorCount > 0 || (invocation.status !== null && invocation.status >= 500)) return true;
  if (invocation.outcome === "ok") return false;
  return !(CLIENT_ENDED_OUTCOMES.has(invocation.outcome) && invocation.status !== null);
}

function insertInvocation(db: SqlDatabase, invocation: PreparedInvocation, observedAt: number): void {
  db.run(
    "INSERT INTO observe_invocations (key, digest, observed_at, event_at, trace_id, stage, kind, label, object_id, version, status, outcome, failed, cpu_ms, wall_ms, error_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    invocation.key, invocation.digest, observedAt, invocation.eventAtMs, invocation.trace?.traceId ?? null, invocation.stage, invocation.kind, invocation.label,
    invocation.objectId, invocation.version, invocation.status, invocation.outcome, isFailed(invocation) ? 1 : 0, invocation.cpuMs, invocation.wallMs, invocation.errorCount
  );
}

function insertOccurrence(db: SqlDatabase, invocation: PreparedInvocation, error: PreparedError, observedAt: number, cutoff: number): boolean {
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
    db.run(`UPDATE observe_occurrences SET propagated = 1 WHERE ${sameError} AND has_stack = 0 AND propagated = 0`, traceId, error.name, error.message, cutoff);
  }
  if (propagated) return true;
  return upsertIssue(db, error, observedAt);
}

function upsertIssue(db: SqlDatabase, error: PreparedError, observedAt: number): boolean {
  const issue = db.rows<{ state: IssueState; state_at: number }>("SELECT state, state_at FROM observe_issues WHERE fingerprint = ?", error.fingerprint)[0];
  if (issue === undefined) {
    const count = db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_issues")[0]?.n ?? 0;
    if (count >= MAX_ISSUES) return false;
    db.run("INSERT INTO observe_issues (fingerprint, name, operation, frame, state, state_at) VALUES (?, ?, ?, ?, 'open', ?)", error.fingerprint, error.name, error.operation, representativeFrame(error.frames), observedAt);
    return true;
  }
  if (issue.state === "resolved" && observedAt > issue.state_at) {
    db.run("UPDATE observe_issues SET state = 'open', state_at = ? WHERE fingerprint = ?", observedAt, error.fingerprint);
  }
  return true;
}

function healthBucket(nowMs: number): number {
  return nowMs - (nowMs % HEALTH_BUCKET_MS);
}

function recordHealth(db: SqlDatabase, nowMs: number, events: readonly HealthEvent[]): void {
  const grouped = new Map<string, { event: HealthEvent; count: number }>();
  for (const event of events) {
    const key = `${event.counter}\u0000${event.reason}`;
    const entry = grouped.get(key);
    if (entry === undefined) grouped.set(key, { event, count: 1 });
    else entry.count++;
  }
  for (const { event, count } of grouped.values()) {
    db.run(
      `INSERT INTO observe_health_events (bucket_at, counter, reason, count, example) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (bucket_at, counter, reason) DO UPDATE SET count = count + excluded.count`,
      healthBucket(nowMs), event.counter, event.reason, count, event.example
    );
  }
}

function recordWriteCost(db: SqlDatabase, nowMs: number, phase: "ingest" | "cleanup", invocations: number, rowsWritten: number): void {
  if (invocations === 0 && rowsWritten === 0) return;
  db.run(
    `INSERT INTO observe_write_cost (bucket_at, phase, runs, invocations, rows_written) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (bucket_at, phase) DO UPDATE SET runs = runs + 1, invocations = invocations + excluded.invocations, rows_written = rows_written + excluded.rows_written`,
    healthBucket(nowMs), phase, invocations, rowsWritten
  );
}

export function cleanup(db: SqlDatabase, nowMs: number): CleanupResult {
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
    const rolloutCutoff = nowMs - ROLLOUT_RETENTION_MS;
    const baseline = "SELECT id FROM observe_rollouts WHERE at_ms <= ? ORDER BY at_ms DESC, id DESC LIMIT 1";
    db.run(`DELETE FROM observe_rollout_shares WHERE rollout_id IN (SELECT id FROM observe_rollouts WHERE at_ms <= ? AND id NOT IN (${baseline}))`, rolloutCutoff, rolloutCutoff);
    db.run(`DELETE FROM observe_rollouts WHERE at_ms <= ? AND id NOT IN (${baseline})`, rolloutCutoff, rolloutCutoff);
    db.run("DELETE FROM observe_version_labels WHERE updated_at <= ? AND version NOT IN (SELECT version FROM observe_rollout_shares)", rolloutCutoff);
    db.run("DELETE FROM observe_artifacts WHERE rowid NOT IN (SELECT rowid FROM observe_artifacts ORDER BY uploaded_at DESC, version DESC, file DESC LIMIT ?)", MAX_ARTIFACTS);
    const evicted = evict(db);
    recordHealth(db, nowMs, [
      ...Array.from({ length: evicted.invocations }, (): HealthEvent => ({ counter: "evicted", reason: "invocations", example: null })),
      ...Array.from({ length: evicted.occurrences }, (): HealthEvent => ({ counter: "evicted", reason: "occurrences", example: null }))
    ]);
    recordWriteCost(db, nowMs, "cleanup", Math.min(expiredInvocations, CLEANUP_BATCH) + evicted.invocations, db.rowsWritten() - writtenBefore);
    const deleted = Math.min(expiredInvocations, CLEANUP_BATCH) + Math.min(expiredOccurrences, CLEANUP_BATCH);
    return { deleted, evicted: evicted.invocations + evicted.occurrences, more: expiredInvocations > CLEANUP_BATCH || expiredOccurrences > CLEANUP_BATCH };
  });
}

function evict(db: SqlDatabase): { readonly invocations: number; readonly occurrences: number } {
  const invocationExcess = Math.min(count(db, "SELECT COUNT(*) AS n FROM observe_invocations") - MAX_RETAINED_INVOCATIONS, CLEANUP_BATCH);
  if (invocationExcess > 0) db.run("DELETE FROM observe_invocations WHERE key IN (SELECT key FROM observe_invocations WHERE failed = 0 ORDER BY observed_at LIMIT ?)", invocationExcess);
  const occurrenceExcess = Math.min(count(db, "SELECT COUNT(*) AS n FROM observe_occurrences") - MAX_RETAINED_OCCURRENCES, CLEANUP_BATCH);
  if (occurrenceExcess > 0) db.run("DELETE FROM observe_occurrences WHERE id IN (SELECT id FROM observe_occurrences ORDER BY observed_at LIMIT ?)", occurrenceExcess);
  return { invocations: Math.max(invocationExcess, 0), occurrences: Math.max(occurrenceExcess, 0) };
}

export function nextCleanupAt(db: SqlDatabase, nowMs: number, cleaned: CleanupResult): number | null {
  if (cleaned.more) return nowMs;
  const oldest = db.rows<{ at: number | null }>("SELECT MIN(at) AS at FROM (SELECT MIN(observed_at) AS at FROM observe_invocations UNION ALL SELECT MIN(observed_at) FROM observe_occurrences)")[0]?.at ?? null;
  if (oldest === null) return null;
  return Math.max(oldest + RETENTION_MS, nowMs + CLEANUP_INTERVAL_MS);
}

function count(db: SqlDatabase, query: string, ...params: SqlValue[]): number {
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

export function listIssues(db: SqlDatabase, nowMs: number, filter: { readonly state?: IssueState; readonly introducedIn?: string; readonly fingerprint?: string; readonly cursor?: string; readonly limit?: number } = {}): Page<IssueSummary> {
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

export function recordArtifact(db: SqlDatabase, artifact: { readonly version: string; readonly file: string; readonly map: string; readonly digest: string }, nowMs: number): ArtifactResult {
  return db.transaction(() => {
    const existing = db.rows<{ digest: string }>("SELECT digest FROM observe_artifacts WHERE version = ? AND file = ?", artifact.version, artifact.file)[0];
    if (existing !== undefined) return existing.digest === artifact.digest ? "duplicate" : "conflict";
    db.run("INSERT INTO observe_artifacts (version, file, digest, map, uploaded_at) VALUES (?, ?, ?, ?, ?)", artifact.version, artifact.file, artifact.digest, artifact.map, nowMs);
    return "accepted";
  });
}

export function readArtifact(db: SqlDatabase, version: string, file: string): string | null {
  return db.rows<{ map: string }>("SELECT map FROM observe_artifacts WHERE version = ? AND file = ?", version, file)[0]?.map ?? null;
}

export function latestFrames(db: SqlDatabase, nowMs: number, fingerprint: string): { readonly version: string | null; readonly frames: readonly StackFrame[] } | null {
  const row = db.rows<{ version: string | null; frames: string }>(
    "SELECT version, frames FROM observe_occurrences WHERE fingerprint = ? AND propagated = 0 AND observed_at > ? ORDER BY observed_at DESC, id DESC LIMIT 1",
    fingerprint, nowMs - RETENTION_MS
  )[0];
  return row === undefined ? null : { version: row.version, frames: readFrames(row.frames) };
}

export function readIssue(db: SqlDatabase, nowMs: number, fingerprint: string): IssueSummary | null {
  return listIssues(db, nowMs, { fingerprint, limit: 1 }).items[0] ?? null;
}

function versionLabels(db: SqlDatabase, versions: readonly (string | null)[]): Map<string, string> {
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

function routeComparisons(db: SqlDatabase, cutoff: number, versions: readonly string[]): RouteComparison[] {
  const grouped = (column: "cpu_ms" | "wall_ms") => db.rows<{ stage: Stage; label: string; version: string; value: number; n: number }>(
    `SELECT stage, label, version, ${column} AS value, COUNT(*) AS n FROM observe_invocations
     WHERE observed_at > ? AND version IN (SELECT value FROM json_each(?)) GROUP BY stage, label, version, ${column} ORDER BY value`,
    cutoff, JSON.stringify(versions)
  );
  const collect = (rows: ReturnType<typeof grouped>) => {
    const byRoute = new Map<string, Map<string, [number, number][]>>();
    for (const row of rows) {
      const route = `${row.stage}\u0000${row.label}`;
      const perVersion = byRoute.get(route) ?? new Map<string, [number, number][]>();
      byRoute.set(route, perVersion);
      perVersion.set(row.version, [...perVersion.get(row.version) ?? [], [row.value, row.n]]);
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

export function rolloutImpact(db: SqlDatabase, nowMs: number, rolloutId: string): RolloutImpact | null {
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
  const counts = new Map(db.rows<{ version: string; requests: number; failed: number }>(
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
  source: PreparedError["source"]; operation: string | null; name: string; message: string | null; frames: string;
}

const OCCURRENCE_COLUMNS = "id, invocation_key, trace_id, observed_at, version, source, operation, name, message, frames";

function occurrence(row: OccurrenceRow): Occurrence {
  return {
    id: row.id, invocationKey: row.invocation_key, traceId: row.trace_id, atMs: row.observed_at, version: row.version,
    source: row.source, operation: row.operation, name: row.name, message: row.message, frames: readFrames(row.frames).map(frame => ({ ...frame, original: null }))
  };
}

export function issueOccurrences(db: SqlDatabase, nowMs: number, fingerprint: string, filter: { readonly cursor?: string; readonly limit?: number } = {}): Page<Occurrence> {
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

export function setIssueState(db: SqlDatabase, nowMs: number, fingerprint: string, state: IssueState): boolean {
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

function window(nowMs: number, fromMs: number | undefined, toMs: number | undefined): { fromMs: number; toMs: number } {
  const from = Math.max(fromMs ?? nowMs - RETENTION_MS, nowMs - RETENTION_MS);
  const to = Math.min(toMs ?? nowMs, nowMs);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw new RangeError("invalid time window");
  return { fromMs: from, toMs: to };
}

export function listTraces(db: SqlDatabase, nowMs: number, filter: TraceFilter = {}): Page<TraceSummary> {
  const cutoff = nowMs - RETENTION_MS;
  const { fromMs, toMs } = window(nowMs, filter.fromMs, filter.toMs);
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

export function explore(db: SqlDatabase, nowMs: number, filter: { readonly fromMs?: number; readonly toMs?: number; readonly route?: string } = {}): Exploration {
  const cutoff = nowMs - RETENTION_MS;
  const { fromMs, toMs } = window(nowMs, filter.fromMs, filter.toMs);
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

export function objectMethods(db: SqlDatabase, nowMs: number, filter: { readonly fromMs?: number; readonly toMs?: number } = {}): ObjectMethods {
  const cutoff = nowMs - RETENTION_MS;
  const { fromMs, toMs } = window(nowMs, filter.fromMs, filter.toMs);
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

export function readTrace(db: SqlDatabase, nowMs: number, traceId: string): TraceDetail | null {
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

export function health(db: SqlDatabase, nowMs: number): Health {
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
    writes: { ingestBatches: ingestCost?.runs ?? 0, accepted: ingestCost?.invocations ?? 0, ingestRows: ingestCost?.rows_written ?? 0, cleanupRows: cleanupCost?.rows_written ?? 0 }
  };
}
