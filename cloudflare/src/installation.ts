import { DurableObject } from "cloudflare:workers";
import { bearerToken, constantTimeEqual, generateHostId, generateToken, tokenHash } from "./auth";
import { canonicalJson, type Sample, type SystemInfo } from "./protocol";
import { decodeFrame } from "./ingest/frame.ts";
import { validateSample, normalizeSystem } from "./ingest/sample.ts";
import { ACK_MEDIA_TYPE, encodeAck } from "./ingest/ack.ts";
import type { SampleRejection } from "./observe/producer/channel.ts";
import { mediaProblem } from "./ingest/http.ts";
import { computeDelta, parseDelta } from "./delta";
import { combineRollups, downsample, historyQuery, kindValue, kindsValue, pointsFromRows, rollupPoints, rollupFromRaw, rowPoints, type HistoryPoints, type HistoryQuery, type RawRow, type RollupPayload, type RowPoints } from "./aggregate";
import { HISTORY_CONTENT_TYPE } from "./binary/history";
import { encodeHostBundle, encodeHostHistory, encodeProjectBundle, encodeProjectHistory, hostHistoryColumns, type HostHistory, type HostHistoryColumns } from "./history-frame";
import { HOUR_MS, HOUR_RETENTION_MS, MAX_BODY_BYTES, MAX_POINTS, MINUTE_MS, MINUTE_RETENTION_MS, RAW_HISTORY_SPAN_MS, RAW_RETENTION_MS, RAW_STEP_MS, RANGE_MS, type HistoryKind, type RangeKey } from "./limits";
import type { ErrorCode } from "./codes";
import { parseProjects, type ProjectConfig } from "./projects/config";
import { latestCollectorRunId, projectHistorySource, projectKind, type ProjectKind, projectKindsValue, readProjectHistories, summarizeCollector } from "./projects/history";
import { collectedPoints, PROJECT_STATEMENTS, purgeExpired, recordRun, upsertPoints, type CollectorRun } from "./projects/store";
import { readLimitedBytes } from "./body";
import { reportError } from "./observe/producer/report";
import { hostHistoryClass, hostHistoryExtent, isSyntheticHost, OperationRun, projectHistoryClass, projectHistoryExtent, rowsWrittenBy, type HostHistoryResolution } from "./operations";
import type { SqlDatabase } from "./core/sql.ts";
import { CloudflareSql } from "./cloudflare/sql.ts";
import { cloudflareOperations } from "./cloudflare/operations.ts";

export const ONLINE_WINDOW_MS = 45_000;
export const WINDOW_MS = 60_000;
export const MAX_REQUESTS_PER_WINDOW = 6;

type HostRow = {
  readonly host_id: string;
  readonly name: string;
  readonly token_hash: string;
  readonly created_at_ms: number;
  readonly revoked_at_ms: number | null;
  readonly last_received_at_ms: number | null;
  readonly window_start_ms: number;
  readonly window_count: number;
};

type SampleRow = {
  readonly mono_ms: number;
  readonly at_ms: number;
  readonly payload: string;
  readonly seq: string;
};

export interface HostSummary {
  readonly hostId: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly revoked: boolean;
  readonly lastReceivedAtMs: number | null;
  readonly online: boolean;
}

export interface LatestSample {
  readonly hostId: string;
  readonly receivedAtMs: number;
  readonly sample: Sample;
}

export type AdminResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: 400 | 404; readonly code: "invalid_request" | "not_found"; readonly message: string };

const HOSTS = `CREATE TABLE IF NOT EXISTS hosts (
  host_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  last_received_at_ms INTEGER,
  window_start_ms INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0
) STRICT`;
const SAMPLES = `CREATE TABLE IF NOT EXISTS samples (
  host_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  seq TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  mono_ms INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  delta TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL,
  PRIMARY KEY (host_id, boot_id, seq)
) STRICT`;
const SAMPLE_TIME = "CREATE INDEX IF NOT EXISTS samples_by_time ON samples (host_id, at_ms)";
const SAMPLE_MONO = "CREATE INDEX IF NOT EXISTS samples_by_mono ON samples (host_id, boot_id, mono_ms)";
const ROLLUPS = `CREATE TABLE IF NOT EXISTS rollups (
  host_id TEXT NOT NULL,
  resolution TEXT NOT NULL,
  bucket_ms INTEGER NOT NULL,
  coverage_ms INTEGER NOT NULL,
  partial INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (host_id, resolution, bucket_ms)
) STRICT`;
const ROLLUP_TIME = "CREATE INDEX IF NOT EXISTS rollups_by_time ON rollups (host_id, resolution, bucket_ms)";
const SAMPLE_EXPIRY = "CREATE INDEX IF NOT EXISTS samples_by_received ON samples (received_at_ms)";
const ROLLUP_EXPIRY = "CREATE INDEX IF NOT EXISTS rollups_by_expiry ON rollups (resolution, bucket_ms)";
const HOST_SYSTEM = `CREATE TABLE IF NOT EXISTS host_system (
  host_id TEXT PRIMARY KEY,
  reported_at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT`;
const HOST_HISTORY_VERSIONS = `CREATE TABLE IF NOT EXISTS host_history_versions (
  host_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL
) STRICT`;
const UPSERT_ROLLUP = `INSERT INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (host_id, resolution, bucket_ms) DO UPDATE SET coverage_ms = excluded.coverage_ms, partial = excluded.partial, payload = excluded.payload`;
const SCHEMA_VERSION = "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)";

const WEIGHTED_HISTORY_ENDS_MS = 1793565600000;
const WEIGHTED_METRICS = `(metric LIKE 'worker.%' AND metric <> 'worker.cpuMsMax') OR metric LIKE 'route.%' OR metric LIKE 'r2.%.ops.%' OR metric IN ('d1.queries', 'd1.rowsRead', 'd1.rowsWritten') OR metric LIKE 'd1q.%'`;
const PURGE_WEIGHTED_PROJECT_HISTORY: readonly string[] = [
  `DELETE FROM project_samples WHERE bucket_ms < ${WEIGHTED_HISTORY_ENDS_MS} AND (${WEIGHTED_METRICS})`,
  `DELETE FROM project_hours WHERE hour_ms < ${WEIGHTED_HISTORY_ENDS_MS} AND (${WEIGHTED_METRICS})`
];

const UNCORRECTED_RUNS_END_MS = 1793571049204;
const FORGET_UNCORRECTED_RUNS: readonly string[] = [
  `DELETE FROM collector_runs WHERE at_ms < ${UNCORRECTED_RUNS_END_MS}`
];

interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

const RETENTION_BACKLOG_ROWS = 1000;

const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: [HOSTS, SAMPLES, SAMPLE_TIME, SAMPLE_MONO, ROLLUPS, ROLLUP_TIME] },
  { version: 2, statements: [SAMPLE_EXPIRY, ROLLUP_EXPIRY] },
  { version: 3, statements: [HOST_SYSTEM] },
  { version: 4, statements: PROJECT_STATEMENTS },
  { version: 5, statements: PURGE_WEIGHTED_PROJECT_HISTORY },
  { version: 6, statements: FORGET_UNCORRECTED_RUNS },
  { version: 7, statements: [HOST_HISTORY_VERSIONS, "INSERT OR IGNORE INTO host_history_versions (host_id, version) SELECT host_id, 0 FROM hosts"] }
];

export function retentionDelayMs(deleted: { readonly raw: number; readonly minute: number; readonly hour: number; readonly project?: number }): number {
  return Math.max(deleted.raw, deleted.minute, deleted.hour, deleted.project ?? 0) >= 1000 ? 60_000 : 600_000;
}

export function migrate(sql: SqlDatabase): void {
  sql.run(SCHEMA_VERSION);
  const row = sql.rows<{ version: number }>("SELECT version FROM schema_version LIMIT 1")[0];
  let current = row?.version ?? 0;
  let hasRow = row !== undefined;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    sql.transaction(() => {
      for (const statement of migration.statements) sql.run(statement);
      if (hasRow) sql.run("UPDATE schema_version SET version = ?", migration.version);
      else sql.run("INSERT INTO schema_version (version) VALUES (?)", migration.version);
    });
    current = migration.version;
    hasRow = true;
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function opaqueTag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

function etagMatches(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) return false;
  return header.split(",").some(value => value.trim() === "*" || opaqueTag(value) === etag);
}

function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { ETag: etag } });
}

function historyEtag(scope: string, version: number | null, window: string, kinds: string): string {
  return `"${scope}:${version ?? "none"}:${window}:${kinds}:stc1"`;
}

function frameResponse(frame: Uint8Array<ArrayBuffer>, etag: string): Response {
  return new Response(frame, { headers: { "Content-Type": HISTORY_CONTENT_TYPE, ETag: etag } });
}

function historyWindowKey(query: HistoryQuery): string {
  return "range" in query ? `range=${query.range}` : `from=${query.fromMs}&to=${query.toMs}`;
}

function failure(code: ErrorCode, message: string, status: number, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, headers);
}

function validName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 0x7f) return false;
  }
  return true;
}

const HISTORY_WINDOWS_KEPT = 4;
const CACHED_RAW_ROWS_KEPT = 16_000;

interface CachedRow {
  readonly atMs: number;
  readonly monoMs: number;
  readonly points: RowPoints;
}

interface HostRawRows {
  fromMs: number;
  readonly rows: CachedRow[];
}

type RawSampleRow = {
  readonly rowid: number;
  readonly host_id: string;
  readonly payload: string;
  readonly delta: string;
  readonly at_ms: number;
  readonly mono_ms: number;
};

function cachedRow(row: RawSampleRow): CachedRow {
  const raw: RawRow = { sample: JSON.parse(row.payload) as Sample, delta: parseDelta(row.delta) };
  return { atMs: row.at_ms, monoMs: row.mono_ms, points: rowPoints(raw) };
}

function rowOrder(left: CachedRow, right: CachedRow): number {
  return left.atMs - right.atMs || left.monoMs - right.monoMs;
}

function firstAtOrAfter(rows: readonly CachedRow[], atMs: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle]!.atMs < atMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

export class Installation extends DurableObject<Env> {
  private readonly historyCache = new Map<string, (kind: HistoryKind) => HostHistoryColumns>();
  private readonly rawRows = new Map<string, HostRawRows>();
  private rawRowsThrough = 0;

  private invalidateHistory(): void {
    this.historyCache.clear();
    this.rawRows.clear();
    this.rawRowsThrough = 0;
  }

  private rawRowsBetween(sql: SqlDatabase, hostId: string, fromMs: number, toMs: number, now: number): readonly CachedRow[] {
    const latest = sql.rows<{ rowid: number | null }>("SELECT MAX(rowid) AS rowid FROM samples")[0]?.rowid ?? 0;
    if (latest > this.rawRowsThrough && this.rawRows.size > 0) {
      for (const row of sql.rows<RawSampleRow>("SELECT rowid, host_id, payload, delta, at_ms, mono_ms FROM samples WHERE rowid > ? ORDER BY rowid", this.rawRowsThrough)) {
        const cached = this.rawRows.get(row.host_id);
        if (cached === undefined || row.at_ms < cached.fromMs) continue;
        const entry = cachedRow(row);
        const last = cached.rows.at(-1);
        if (last === undefined || rowOrder(last, entry) <= 0) cached.rows.push(entry);
        else cached.rows.splice(cached.rows.findIndex(existing => rowOrder(existing, entry) > 0), 0, entry);
      }
    }
    this.rawRowsThrough = latest;
    let cached = this.rawRows.get(hostId);
    if (cached === undefined || fromMs < cached.fromMs) {
      const rows = sql.rows<RawSampleRow>("SELECT rowid, host_id, payload, delta, at_ms, mono_ms FROM samples WHERE host_id = ? AND at_ms >= ? AND rowid <= ? ORDER BY at_ms ASC, mono_ms ASC", hostId, fromMs, this.rawRowsThrough);
      cached = { fromMs, rows: rows.map(cachedRow) };
      this.rawRows.set(hostId, cached);
    }
    const expired = firstAtOrAfter(cached.rows, now - RAW_RETENTION_MS);
    if (expired > 0) {
      cached.rows.splice(0, expired);
      cached.fromMs = Math.max(cached.fromMs, now - RAW_RETENTION_MS);
    }
    this.rawRows.delete(hostId);
    this.rawRows.set(hostId, cached);
    let total = [...this.rawRows.values()].reduce((sum, entry) => sum + entry.rows.length, 0);
    for (const [otherId, other] of this.rawRows) {
      if (total <= CACHED_RAW_ROWS_KEPT || otherId === hostId) break;
      this.rawRows.delete(otherId);
      total -= other.rows.length;
    }
    return cached.rows.slice(firstAtOrAfter(cached.rows, fromMs), firstAtOrAfter(cached.rows, toMs + 1));
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrate(new CloudflareSql(this.ctx.storage));
    });
  }

  private now(): number {
    if (this.env.ENVIRONMENT === "test" && this.env.TEST_NOW_MS !== undefined) {
      const value = Number(this.env.TEST_NOW_MS);
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
    return Date.now();
  }

  protected operationRun(): OperationRun {
    return new OperationRun(new CloudflareSql(this.ctx.storage), cloudflareOperations);
  }

  private unpublished(): SqlDatabase {
    return new CloudflareSql(this.ctx.storage);
  }

  private host(sql: SqlDatabase, hostId: string): HostRow | undefined {
    return sql.rows<HostRow>("SELECT * FROM hosts WHERE host_id = ?", hostId)[0];
  }

  private historyVersion(sql: SqlDatabase, hostId: string): number {
    return sql.rows<{ version: number }>("SELECT version FROM host_history_versions WHERE host_id = ?", hostId)[0]?.version ?? 0;
  }

  async createHost(name: string): Promise<AdminResult<{ hostId: string; name: string; token: string }>> {
    const trimmed = name.trim();
    if (!validName(trimmed)) return { ok: false, status: 400, code: "invalid_request", message: "host name must be 1-64 printable characters" };
    const hostId = generateHostId();
    const token = generateToken();
    const hash = await tokenHash(token);
    this.unpublished().run("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES (?, ?, ?, ?)", hostId, trimmed, hash, this.now());
    return { ok: true, value: { hostId, name: trimmed, token } };
  }

  async rotateHost(hostId: string): Promise<AdminResult<{ hostId: string; token: string }>> {
    const host = this.host(this.unpublished(), hostId);
    if (host === undefined) return { ok: false, status: 404, code: "not_found", message: "host not found" };
    const token = generateToken();
    const hash = await tokenHash(token);
    this.unpublished().run("UPDATE hosts SET token_hash = ?, revoked_at_ms = NULL WHERE host_id = ?", hash, hostId);
    return { ok: true, value: { hostId, token } };
  }

  async revokeHost(hostId: string): Promise<boolean> {
    const host = this.host(this.unpublished(), hostId);
    if (host === undefined) return false;
    this.unpublished().run("UPDATE hosts SET revoked_at_ms = ? WHERE host_id = ?", this.now(), hostId);
    return true;
  }

  async purgeHost(hostId: string): Promise<boolean> {
    if (this.host(this.unpublished(), hostId) === undefined) return false;
    const sql = this.unpublished();
    sql.transaction(() => {
      sql.run("DELETE FROM samples WHERE host_id = ?", hostId);
      sql.run("DELETE FROM rollups WHERE host_id = ?", hostId);
      sql.run("DELETE FROM host_system WHERE host_id = ?", hostId);
      sql.run("DELETE FROM host_history_versions WHERE host_id = ?", hostId);
      sql.run("DELETE FROM hosts WHERE host_id = ?", hostId);
      this.invalidateHistory();
    });
    return true;
  }

  async listHosts(): Promise<HostSummary[]> {
    const now = this.now();
    return this.unpublished().rows<HostRow>("SELECT * FROM hosts ORDER BY host_id").map(host => ({
      hostId: host.host_id,
      name: host.name,
      createdAtMs: host.created_at_ms,
      revoked: host.revoked_at_ms !== null,
      lastReceivedAtMs: host.last_received_at_ms,
      online: host.revoked_at_ms === null && host.last_received_at_ms !== null && now - host.last_received_at_ms <= ONLINE_WINDOW_MS
    }));
  }

  async latest(hostId: string): Promise<LatestSample | null> {
    const row = this.unpublished().rows<{ payload: string; received_at_ms: number }>("SELECT payload, received_at_ms FROM samples WHERE host_id = ? ORDER BY at_ms DESC, received_at_ms DESC LIMIT 1", hostId)[0];
    if (row === undefined) return null;
    return { hostId, receivedAtMs: row.received_at_ms, sample: JSON.parse(row.payload) as Sample };
  }

  async system(hostId: string): Promise<{ hostId: string; reportedAtMs: number; system: SystemInfo } | null> {
    const row = this.unpublished().rows<{ reported_at_ms: number; payload: string }>("SELECT reported_at_ms, payload FROM host_system WHERE host_id = ?", hostId)[0];
    return row === undefined ? null : { hostId, reportedAtMs: row.reported_at_ms, system: JSON.parse(row.payload) as SystemInfo };
  }

  private rebuildMinute(sql: SqlDatabase, hostId: string, bucketMs: number): void {
    const rows = sql.rows<{ payload: string; delta: string }>("SELECT payload, delta FROM samples WHERE host_id = ? AND at_ms >= ? AND at_ms < ? ORDER BY mono_ms", hostId, bucketMs, bucketMs + MINUTE_MS);
    if (rows.length === 0) {
      sql.run("DELETE FROM rollups WHERE host_id = ? AND resolution = '1m' AND bucket_ms = ?", hostId, bucketMs);
      return;
    }
    const raw: RawRow[] = rows.map(row => ({ sample: JSON.parse(row.payload) as Sample, delta: parseDelta(row.delta) }));
    const payload = rollupFromRaw(raw, bucketMs, MINUTE_MS);
    if (payload === null) {
      sql.run("DELETE FROM rollups WHERE host_id = ? AND resolution = '1m' AND bucket_ms = ?", hostId, bucketMs);
      return;
    }
    sql.run(UPSERT_ROLLUP, hostId, "1m", bucketMs, payload.coverageMs, payload.partial ? 1 : 0, JSON.stringify(payload));
  }

  private rebuildHour(sql: SqlDatabase, hostId: string, hourMs: number): void {
    const rows = sql.rows<{ payload: string }>("SELECT payload FROM rollups WHERE host_id = ? AND resolution = '1m' AND bucket_ms >= ? AND bucket_ms < ?", hostId, hourMs, hourMs + HOUR_MS);
    const payloads = rows.map(row => JSON.parse(row.payload) as RollupPayload);
    const payload = combineRollups(payloads, hourMs, HOUR_MS);
    if (payload === null) {
      sql.run("DELETE FROM rollups WHERE host_id = ? AND resolution = '1h' AND bucket_ms = ?", hostId, hourMs);
      return;
    }
    sql.run(UPSERT_ROLLUP, hostId, "1h", hourMs, payload.coverageMs, payload.partial ? 1 : 0, JSON.stringify(payload));
  }

  private rebuildRollups(sql: SqlDatabase, hostId: string, minutes: readonly number[]): void {
    const unique = [...new Set(minutes)].sort((left, right) => left - right);
    for (const minute of unique) this.rebuildMinute(sql, hostId, minute);
    for (const hour of new Set(unique.map(minute => Math.floor(minute / HOUR_MS) * HOUR_MS))) this.rebuildHour(sql, hostId, hour);
  }

  private historyShape(query: HistoryQuery, now: number): { fromMs: number; toMs: number; resolution: HostHistoryResolution; range: { range?: RangeKey } } {
    const at = Math.floor(now / RAW_STEP_MS) * RAW_STEP_MS;
    const toMs = "range" in query ? at : query.toMs;
    const fromMs = "range" in query ? at - RANGE_MS[query.range] : query.fromMs;
    const range = "range" in query ? { range: query.range } : {};
    const rawRange = fromMs >= now - RAW_RETENTION_MS && toMs - fromMs <= RAW_HISTORY_SPAN_MS;
    const resolution: HostHistoryResolution = rawRange ? "raw" : fromMs >= now - MINUTE_RETENTION_MS ? "1m" : "1h";
    return { fromMs, toMs, resolution, range };
  }

  private historyWindow(sql: SqlDatabase, hostId: string, query: HistoryQuery): ((kind: HistoryKind) => HostHistoryColumns) | null {
    if (this.host(sql, hostId) === undefined) return null;
    const now = this.now();
    const { fromMs, toMs, resolution, range } = this.historyShape(query, now);
    const key = `${hostId}|${this.historyVersion(sql, hostId)}|${resolution}|${fromMs}|${toMs}`;
    let build = this.historyCache.get(key);
    if (build === undefined) {
      build = this.historyBuilder(sql, hostId, fromMs, toMs, range, resolution, now);
      this.historyCache.set(key, build);
      if (this.historyCache.size > HISTORY_WINDOWS_KEPT) this.historyCache.delete(this.historyCache.keys().next().value!);
    }
    return build;
  }

  private historyBuilder(sql: SqlDatabase, hostId: string, fromMs: number, toMs: number, range: { range?: RangeKey }, resolution: HostHistoryResolution, now: number): (kind: HistoryKind) => HostHistoryColumns {
    const bucketMs = resolution === "raw" ? RAW_STEP_MS : resolution === "1m" ? MINUTE_MS : HOUR_MS;
    let pointsFor: (kind: HistoryKind) => HistoryPoints;
    if (resolution === "raw") {
      const rows = this.rawRowsBetween(sql, hostId, fromMs, toMs, now).map(row => row.points);
      pointsFor = kind => pointsFromRows(rows, kind);
    } else {
      const rows = sql.rows<{ payload: string; bucket_ms: number }>("SELECT payload, bucket_ms FROM rollups WHERE host_id = ? AND resolution = ? AND bucket_ms >= ? AND bucket_ms <= ? ORDER BY bucket_ms ASC", hostId, resolution, fromMs, toMs);
      const payloads = rows.map(row => JSON.parse(row.payload) as RollupPayload);
      pointsFor = kind => rollupPoints(payloads, kind);
    }
    const built = new Map<HistoryKind, HostHistoryColumns>();
    return kind => {
      const existing = built.get(kind);
      if (existing !== undefined) return existing;
      const points = pointsFor(kind);
      let history: HostHistory;
      if (kind === "summary") {
        const sampled = downsample(points as Parameters<typeof downsample>[0]);
        history = { hostId, ...range, kind, fromMs, toMs, resolution, stepMs: bucketMs * sampled.stride, points: sampled.items } as HostHistory;
      } else {
        const series = points as { id: string; name?: string; points: unknown[] }[];
        const longest = series.reduce((maximum, entry) => Math.max(maximum, entry.points.length), 0);
        const stride = Math.max(1, Math.ceil(longest / MAX_POINTS));
        history = {
          hostId, ...range, kind, fromMs, toMs, resolution, stepMs: bucketMs * stride,
          series: series.map(entry => ({ ...entry, points: entry.points.filter((_, index) => index % stride === 0) }))
        } as HostHistory;
      }
      const columns = hostHistoryColumns(history);
      built.set(kind, columns);
      return columns;
    };
  }

  private projectRegistry(): ProjectConfig[] | Response {
    try {
      return parseProjects(this.env.PROJECTS);
    } catch (error) {
      reportError("projects.config", error);
      console.error(JSON.stringify({ event: "projects_config_invalid" }));
      return json({ error: { code: "unavailable", message: "project configuration is invalid" } }, 503);
    }
  }

  private projectList(sql: SqlDatabase): Response {
    const projects = this.projectRegistry();
    if (projects instanceof Response) return projects;
    const collector = summarizeCollector(sql, this.now());
    return json(projects.map(project => ({ ...project, collector })));
  }

  private projectHistory(run: OperationRun, projectId: string, params: URLSearchParams, request: Request): Response {
    const projects = this.projectRegistry();
    if (projects instanceof Response) return projects;
    const project = projects.find(candidate => candidate.id === projectId);
    if (project === undefined) return failure("not_found", "project not found", 404);
    const query = params.has("range") || params.has("from") || params.has("to") ? historyQuery(params) : null;
    const now = this.now();
    if (query === null || ("fromMs" in query && query.fromMs >= now)) return failure("invalid_request", "a range or a from and to window, and a kind, are required and must be supported", 400);
    const sql = run.sql;
    const kindsParam = params.get("kinds");
    const kindParam = params.get("kind");
    const version = latestCollectorRunId(sql);
    const windowKey = historyWindowKey(query);
    let kinds: ProjectKind[];
    if (kindsParam !== null) {
      if (kindParam !== null) return failure("invalid_request", "kind and kinds cannot be combined", 400);
      const requested = projectKindsValue(kindsParam);
      if (requested === null) return failure("invalid_request", "kinds must be supported project kinds", 400);
      kinds = requested;
    } else {
      const kind = projectKind(kindParam);
      if (kind === null) return failure("invalid_request", "a range or a from and to window, and a kind, are required and must be supported", 400);
      kinds = [kind];
    }
    const workloadClass = projectHistoryClass(projectHistorySource(query, kinds, now), kinds);
    const etag = historyEtag(`project:${project.id}`, version, windowKey, kinds.join("+"));
    if (etagMatches(request, etag)) {
      run.describe(() => ({ operation: "project.history", synthetic: false, workloadClass, work: { points: 0, cells: 0, outputBytes: 0, cache: "hit-304" } }));
      return notModified(etag);
    }
    const { histories } = readProjectHistories(sql, project, query, kinds, now);
    const built = kinds.map(kind => histories[kind]!);
    const frame = kindsParam !== null ? encodeProjectBundle(project.id, built) : encodeProjectHistory(built[0]!);
    const extent = projectHistoryExtent(built);
    run.describe(() => ({ operation: "project.history", synthetic: false, workloadClass, work: { ...extent, outputBytes: frame.byteLength, cache: "rebuilt" } }));
    return frameResponse(frame, etag);
  }

  private async ensureAlarm(now: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(now + 10 * 60 * 1000);
  }

  async recordCollectorRun(run: CollectorRun): Promise<{ metricRowsWritten: number }> {
    const operation = this.operationRun();
    try {
      return await this.storeCollectorRun(operation, run);
    } finally {
      operation.finish();
    }
  }

  protected async storeCollectorRun(operation: OperationRun, run: CollectorRun): Promise<{ metricRowsWritten: number }> {
    const sql = operation.sql;
    let metricRowsWritten = 0;
    let metricRows = 0;
    let hourRollups = 0;
    operation.describe(() => ({ operation: "collector.record", synthetic: false, work: { runs: run.ok ? 1 : 0, metricRows, hourRollups, upstreamQueries: run.upstreamQueries } }));
    sql.transaction(() => {
      let written = 0;
      let samples = 0;
      let hours = 0;
      if (run.ok) {
        for (const entry of collectedPoints(run, sql.databaseBytes())) {
          const upserted = upsertPoints(sql, entry.project, entry.points);
          written += upserted.rowsWritten;
          samples += upserted.samples;
          hours += upserted.hours;
        }
      }
      recordRun(sql, run);
      metricRowsWritten = written;
      metricRows = samples;
      hourRollups = hours;
    });
    await this.ensureAlarm(this.now());
    return { metricRowsWritten };
  }

  override async alarm(): Promise<void> {
    const operation = this.operationRun();
    try {
      await this.retain(operation);
    } finally {
      operation.finish();
    }
  }

  protected async retain(operation: OperationRun): Promise<void> {
    const sql = operation.sql;
    let expired = 0;
    let backlog = 0;
    operation.describe(() => ({ operation: "cleanup.retention", synthetic: false, work: { expired, backlog } }));
    try {
      const now = this.now();
      const raw = rowsWrittenBy(sql, "DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE received_at_ms < ? LIMIT 1000)", now - RAW_RETENTION_MS);
      const minute = rowsWrittenBy(sql, "DELETE FROM rollups WHERE rowid IN (SELECT rowid FROM rollups WHERE resolution = '1m' AND bucket_ms < ? LIMIT 1000)", now - MINUTE_RETENTION_MS);
      const hour = rowsWrittenBy(sql, "DELETE FROM rollups WHERE rowid IN (SELECT rowid FROM rollups WHERE resolution = '1h' AND bucket_ms < ? LIMIT 1000)", now - HOUR_RETENTION_MS);
      const projectRows = purgeExpired(sql, now);
      const project = Math.max(projectRows.samples, projectRows.hours);
      expired = raw + minute + hour + projectRows.samples + projectRows.hours;
      backlog = [raw, minute, hour, projectRows.samples, projectRows.hours].filter(deleted => deleted >= RETENTION_BACKLOG_ROWS).length;
      if (raw + minute + hour > 0) {
        sql.run("UPDATE host_history_versions SET version = version + 1");
        this.invalidateHistory();
      }
      await this.ctx.storage.setAlarm(now + retentionDelayMs({ raw, minute, hour, project }));
    } catch (error) {
      console.error(JSON.stringify({ event: "alarm_failed", code: "internal" }));
      throw error;
    }
  }

  private authorize(sql: SqlDatabase, hostId: string, hash: string): { host: HostRow } | { code: "unauthorized" | "forbidden"; status: number } {
    const host = this.host(sql, hostId);
    if (host === undefined || host.revoked_at_ms !== null || !constantTimeEqual(host.token_hash, hash)) return { code: "unauthorized", status: 401 };
    return { host };
  }

  private reject(code: ErrorCode, message: string, status: number, hostId?: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Response {
    console.error(JSON.stringify({ event: "ingest_rejected", ...(hostId === undefined ? {} : { hostId }), code }));
    return json({ error: { code, message }, ...extra }, status, headers);
  }

  async ingest(request: Request, operation: OperationRun): Promise<Response> {
    const sql = operation.sql;
    let synthetic = false;
    let received = 0;
    let inputBytes = 0;
    let persisted = 0;
    let duplicate = 0;
    const tally: Record<SampleRejection, number> = { invalid_sample: 0, too_old: 0, conflict: 0 };
    operation.describe(() => ({ operation: "host.ingest", synthetic, work: { received, persisted, duplicate, rejected: { ...tally }, inputBytes } }));
    if (request.method !== "POST") return this.reject("invalid_request", "POST required", 405);
    const media = mediaProblem(request.headers);
    if (media !== null) return this.reject("invalid_request", media, 415);
    const body = await readLimitedBytes(request, MAX_BODY_BYTES);
    if (body === null) return this.reject("too_large", "batch exceeds the body cap", 413);
    inputBytes = body.byteLength;
    const decoded = decodeFrame(body);
    if (!decoded.ok) return this.reject(decoded.code, decoded.message, 400);
    const parsed = decoded.batch;
    const token = bearerToken(request.headers.get("authorization"));
    if (token === null) return this.reject("unauthorized", "a host bearer token is required", 401);
    const hash = await tokenHash(token);
    const authorized = this.authorize(sql, parsed.hostId, hash);
    if ("code" in authorized) return this.reject(authorized.code, "host credential rejected", authorized.status, parsed.hostId);
    synthetic = isSyntheticHost(authorized.host.name);

    const now = this.now();
    const window = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    let limited = false;
    let rejectedCredential = false;
    let count = 0;
    sql.transaction(() => {
      const current = this.host(sql, parsed.hostId);
      if (current === undefined || current.revoked_at_ms !== null || !constantTimeEqual(current.token_hash, hash)) {
        rejectedCredential = true;
        return;
      }
      if (current.window_start_ms === window && current.window_count >= MAX_REQUESTS_PER_WINDOW) {
        limited = true;
        return;
      }
      count = current.window_start_ms === window ? current.window_count + 1 : 1;
    });
    if (rejectedCredential) return this.reject("unauthorized", "host credential rejected", 401, parsed.hostId);
    if (limited) return this.reject("rate_limited", "host request rate exceeded", 429, parsed.hostId, { "Retry-After": "60" });

    received = parsed.samples.length;
    const rejected: { seq: string; code: SampleRejection }[] = [];
    const affectedMinutes: number[] = [];
    let accepted = 0;
    let duplicates = 0;
    sql.transaction(() => {
      const valid: { sample: Sample; seq: string; at: number; mono: number }[] = [];
      for (const result of parsed.samples.map(validateSample)) {
        if (!result.ok) {
          rejected.push({ seq: result.seq, code: "invalid_sample" });
          continue;
        }
        const at = result.atMs;
        const mono = result.monoMs;
        if (at > now + 300_000) {
          rejected.push({ seq: result.sample.seq, code: "invalid_sample" });
          continue;
        }
        if (at < now - RAW_RETENTION_MS) {
          rejected.push({ seq: result.sample.seq, code: "too_old" });
          continue;
        }
        valid.push({ sample: result.sample, seq: result.sample.seq, at, mono });
      }
      valid.sort((left, right) => left.mono - right.mono);
      for (const entry of valid) {
        const existing = sql.rows<{ payload: string }>("SELECT payload FROM samples WHERE host_id = ? AND boot_id = ? AND seq = ?", parsed.hostId, parsed.bootId, entry.seq)[0];
        if (existing !== undefined) {
          if (existing.payload === canonicalJson(entry.sample)) duplicates += 1;
          else rejected.push({ seq: entry.seq, code: "conflict" });
          continue;
        }
        const same = sql.rows<{ seq: string }>("SELECT seq FROM samples WHERE host_id = ? AND boot_id = ? AND mono_ms = ? LIMIT 1", parsed.hostId, parsed.bootId, entry.mono)[0];
        if (same !== undefined) {
          rejected.push({ seq: entry.seq, code: "invalid_sample" });
          continue;
        }
        const previous = sql.rows<SampleRow>("SELECT mono_ms, at_ms, payload, seq FROM samples WHERE host_id = ? AND boot_id = ? AND mono_ms < ? ORDER BY mono_ms DESC LIMIT 1", parsed.hostId, parsed.bootId, entry.mono)[0];
        const next = sql.rows<SampleRow>("SELECT mono_ms, at_ms, payload, seq FROM samples WHERE host_id = ? AND boot_id = ? AND mono_ms > ? ORDER BY mono_ms ASC LIMIT 1", parsed.hostId, parsed.bootId, entry.mono)[0];
        const elapsed = previous === undefined ? 0 : entry.mono - previous.mono_ms;
        const delta = computeDelta(previous === undefined ? undefined : JSON.parse(previous.payload) as Sample, entry.sample, elapsed);
        sql.run("INSERT INTO samples (host_id, boot_id, seq, at_ms, received_at_ms, mono_ms, elapsed_ms, delta, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", parsed.hostId, parsed.bootId, entry.seq, entry.at, now, entry.mono, elapsed, JSON.stringify(delta), canonicalJson(entry.sample));
        affectedMinutes.push(Math.floor(entry.at / MINUTE_MS) * MINUTE_MS);
        if (next !== undefined) {
          const nextDelta = computeDelta(entry.sample, JSON.parse(next.payload) as Sample, next.mono_ms - entry.mono);
          sql.run("UPDATE samples SET elapsed_ms = ?, delta = ? WHERE host_id = ? AND boot_id = ? AND seq = ?", next.mono_ms - entry.mono, JSON.stringify(nextDelta), parsed.hostId, parsed.bootId, next.seq);
          this.rawRows.delete(parsed.hostId);
          affectedMinutes.push(Math.floor(next.at_ms / MINUTE_MS) * MINUTE_MS);
        }
        accepted += 1;
      }
      if (accepted + duplicates === 0) sql.run("UPDATE hosts SET window_start_ms = ?, window_count = ? WHERE host_id = ?", window, count, parsed.hostId);
      else {
        sql.run("UPDATE hosts SET window_start_ms = ?, window_count = ?, last_received_at_ms = ? WHERE host_id = ?", window, count, now, parsed.hostId);
        sql.run("INSERT INTO host_history_versions (host_id, version) VALUES (?, 1) ON CONFLICT(host_id) DO UPDATE SET version = version + 1", parsed.hostId);
      }
      if (accepted + duplicates > 0 && parsed.system !== undefined) sql.run("INSERT OR REPLACE INTO host_system (host_id, reported_at_ms, payload) VALUES (?, ?, ?)", parsed.hostId, now, canonicalJson(normalizeSystem(parsed.system)));
      if (affectedMinutes.length > 0) this.rebuildRollups(sql, parsed.hostId, affectedMinutes);
    });
    persisted = accepted;
    duplicate = duplicates;
    for (const entry of rejected) tally[entry.code] += 1;

    if (accepted === 0 && duplicates === 0) {
      const code = rejected[0]?.code ?? "invalid_sample";
      return this.reject(code, "no samples were accepted", 400, parsed.hostId, {}, { rejected });
    }
    await this.ensureAlarm(now);
    return new Response(encodeAck({ accepted, duplicates, rejected: rejected.map(entry => ({ seq: BigInt(entry.seq), code: entry.code })) }), { headers: { "Content-Type": ACK_MEDIA_TYPE } });
  }

  override async fetch(request: Request): Promise<Response> {
    const operation = this.operationRun();
    try {
      return await this.route(request, operation);
    } finally {
      operation.finish();
    }
  }

  private async route(request: Request, operation: OperationRun): Promise<Response> {
    const path = new URL(request.url).pathname;
    const sql = operation.sql;
    try {
      if (path === "/ingest") return await this.ingest(request, operation);
      if (path === "/hosts" && request.method === "GET") return json({ hosts: await this.listHosts() });
      const latest = /^\/hosts\/(h_[0-9a-f]{32})\/latest$/u.exec(path);
      if (latest !== null && request.method === "GET") {
        const sample = await this.latest(latest[1]!);
        return sample === null ? failure("not_found", "no samples for host", 404) : json(sample);
      }
      const system = /^\/hosts\/(h_[0-9a-f]{32})\/system$/u.exec(path);
      if (system !== null && request.method === "GET") {
        const found = await this.system(system[1]!);
        return found === null ? failure("not_found", "no system details for host", 404) : json(found);
      }
      const history = /^\/hosts\/(h_[0-9a-f]{32})\/history$/u.exec(path);
      if (history !== null && request.method === "GET") {
        const url = new URL(request.url);
        const query = historyQuery(url.searchParams);
        if (query === null) return failure("invalid_request", "range, from and to, or kind is not supported", 400);
        const found = this.host(sql, history[1]!);
        if (found === undefined) return failure("not_found", "host not found", 404);
        const kindsParam = url.searchParams.get("kinds");
        const kindParam = url.searchParams.get("kind");
        let kinds: HistoryKind[];
        if (kindsParam !== null) {
          if (kindParam !== null) return failure("invalid_request", "kind and kinds cannot be combined", 400);
          const requested = kindsValue(kindsParam);
          if (requested === null) return failure("invalid_request", "kinds must be supported history kinds", 400);
          kinds = requested;
        } else {
          const kind = kindParam === null ? "summary" : kindValue(kindParam);
          if (kind === null) return failure("invalid_request", "range, from and to, or kind is not supported", 400);
          kinds = [kind];
        }
        const synthetic = isSyntheticHost(found.name);
        const workloadClass = hostHistoryClass(this.historyShape(query, this.now()).resolution, kinds);
        const etag = historyEtag(`host:${found.host_id}`, this.historyVersion(sql, found.host_id), historyWindowKey(query), kinds.join("+"));
        if (etagMatches(request, etag)) {
          operation.describe(() => ({ operation: "host.history", synthetic, workloadClass, work: { points: 0, cells: 0, outputBytes: 0, cache: "hit-304" } }));
          return notModified(etag);
        }
        const build = this.historyWindow(sql, found.host_id, query);
        if (build === null) return failure("not_found", "host not found", 404);
        const columns = kinds.map(build);
        const frame = kindsParam !== null ? encodeHostBundle(found.host_id, columns) : encodeHostHistory(columns[0]!);
        const extent = hostHistoryExtent(columns);
        operation.describe(() => ({ operation: "host.history", synthetic, workloadClass, work: { ...extent, outputBytes: frame.byteLength, cache: "rebuilt" } }));
        return frameResponse(frame, etag);
      }
      if (path === "/projects" && request.method === "GET") return this.projectList(sql);
      const projectHistory = /^\/projects\/([a-z][a-z0-9-]{0,31})\/history$/u.exec(path);
      if (projectHistory !== null && request.method === "GET") return this.projectHistory(operation, projectHistory[1]!, new URL(request.url).searchParams, request);
      if (path === "/admin/hosts" && request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return failure("invalid_request", "body must be valid JSON", 400);
        }
        if (typeof body !== "object" || body === null || !("name" in body) || typeof body.name !== "string") return failure("invalid_request", "name is required", 400);
        const result = await this.createHost(body.name);
        return result.ok ? json(result.value, 201) : failure(result.code, result.message, result.status);
      }
      if (path === "/admin/hosts" && request.method === "GET") return json({ hosts: await this.listHosts() });
      const rotate = /^\/admin\/hosts\/(h_[0-9a-f]{32})\/rotate$/u.exec(path);
      if (rotate !== null && request.method === "POST") {
        const result = await this.rotateHost(rotate[1]!);
        return result.ok ? json(result.value) : failure(result.code, result.message, result.status);
      }
      const revoke = /^\/admin\/hosts\/(h_[0-9a-f]{32})$/u.exec(path);
      if (revoke !== null && request.method === "DELETE") return (await this.revokeHost(revoke[1]!)) ? new Response(null, { status: 204 }) : failure("not_found", "host not found", 404);
      const purge = /^\/admin\/hosts\/(h_[0-9a-f]{32})\/purge$/u.exec(path);
      if (purge !== null && request.method === "DELETE") return (await this.purgeHost(purge[1]!)) ? new Response(null, { status: 204 }) : failure("not_found", "host not found", 404);
      return failure("not_found", "unknown object route", 404);
    } catch (error) {
      reportError("installation.request", error);
      console.error(JSON.stringify({ event: "request_failed", code: "internal" }));
      return failure("internal", "internal error", 500);
    }
  }
}
