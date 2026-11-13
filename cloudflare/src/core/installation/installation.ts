import { bearerToken, constantTimeEqual, generateHostId, generateToken, tokenHash } from "../../auth.ts";
import { canonicalJson, type Sample, type SystemInfo } from "../../protocol.ts";
import { decodeFrame } from "../../ingest/frame.ts";
import { validateSample, normalizeSystem } from "../../ingest/sample.ts";
import { ACK_MEDIA_TYPE, encodeAck } from "../../ingest/ack.ts";
import type { SampleRejection } from "../../observe/producer/channel.ts";
import type { ExternalEventRecord } from "../../observe/ingest/model.ts";
import { mediaProblem } from "../../ingest/http.ts";
import { computeDelta, parseDelta } from "../../delta.ts";
import { combineRollups, downsample, historyQuery, kindValue, kindsValue, pointsFromRows, rollupPoints, rollupFromRaw, type HistoryPoints, type HistoryQuery, type RawRow, type RollupPayload } from "../../aggregate.ts";
import { encodeHostBundle, encodeHostHistory, encodeProjectBundle, encodeProjectHistory, hostHistoryColumns, type HostHistory, type HostHistoryColumns } from "../../history-frame.ts";
import { HOUR_MS, HOUR_RETENTION_MS, MAX_BODY_BYTES, MAX_POINTS, MINUTE_MS, MINUTE_RETENTION_MS, PROJECT_SETTLE_MS, RAW_HISTORY_SPAN_MS, RAW_RETENTION_MS, RAW_STEP_MS, RANGE_MS, type HistoryKind, type RangeKey } from "../../limits.ts";
import type { ErrorCode } from "../../codes.ts";
import { parseProjects, type ProjectConfig } from "../../projects/config.ts";
import { windowStartMs } from "../../projects/metrics.ts";
import { latestCollectorRunId, projectHistorySource, projectKind, type ProjectKind, projectKindsValue, readProjectHistories, summarizeCollector } from "../../projects/history.ts";
import { collectedPoints, purgeExpired, recordRun, upsertPoints, type CollectorRun } from "../../projects/store.ts";
import { COMPARISON_WINDOWS, compareDeployment, comparisonBounds, DEPLOYMENT_BUCKET_MS, isComparisonWindow, type MetricRow } from "../../deployments/compare.ts";
import { UUID, type DeploymentHistory, type DeploymentPoll } from "../../deployments/model.ts";
import { hasSettledWindow, rememberSettledWindow, initializeDeployments, purgeDeployments, readDeployments, readLatestDeployment, readDeploymentSync, readVersions, readVersionIds, saveDeploymentPoll } from "../../deployments/store.ts";
import { readLimitedBytes, readLimitedText } from "../../body.ts";
import { reportError } from "../../observe/producer/report.ts";
import { hostHistoryClass, hostHistoryExtent, isSyntheticHost, OperationRun, projectHistoryClass, projectHistoryExtent, affectedBy, type HostHistoryResolution, type OperationSink } from "../../operations.ts";
import type { Clock, Scheduler } from "../ports.ts";
import type { SqlDatabase, SqlScopes } from "../sql.ts";
import { RawRowCache } from "./raw-rows.ts";
import { etagMatches, failure, frameResponse, historyEtag, historyWindowKey, json, notModified, validName } from "./responses.ts";
import { migrate, retentionDelayMs, UPSERT_ROLLUP } from "./schema.ts";
import { authenticateDeployToken, authenticateIngestToken, createService, deleteService, listServices, MARKERS_LISTED, MAX_MARKER_BODY_BYTES, MAX_SERVICE_BODY_BYTES, purgeServiceDeployments, readService, readServiceDeployments, readLatestServiceDeployment, recordMarker, rotateServiceDeployToken, rotateServiceIngestToken, serviceProbeOwner } from "./services.ts";
import { compareServiceDeployment, SERVICE_PROBE_NAME, type MinuteRollup } from "../../deployments/service-compare.ts";
import { runProbes, type ProbeFetch } from "../../projects/probes.ts";

const ONLINE_WINDOW_MS = 45_000;
export const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 6;

const HISTORY_WINDOWS_KEPT = 4;
const RETENTION_BACKLOG_ROWS = 1000;
const PENDING_HOURS_PER_PASS = 1000;
const COMPARISON_METRICS_SQL = "SELECT metric, bucket_ms, value FROM project_samples WHERE project = ? AND bucket_ms >= ? AND bucket_ms < ? AND (metric IN ('worker.invocations', 'worker.cpuMsSum', 'worker.status.5xx', 'do.invocations', 'do.cpuMsSum', 'do.wallMsSum', 'd1.queries', 'd1.rowsRead', 'd1.rowsWritten') OR metric LIKE 'route.%.invocations' OR metric LIKE 'r2.%.ops.%' OR metric LIKE 'probe.%.up' OR metric LIKE 'probe.%.ms')";

export interface InstallationPorts {
  readonly sql: SqlScopes;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly operations: OperationSink;
  readonly probesServices: boolean;
  readonly readApplicationEvents?: (service: string, fromMs: number, toMs: number) => Promise<{ readonly events: readonly ExternalEventRecord[]; readonly truncated: boolean }>;
}

export interface InstallationConfig {
  projects(): string;
  deploymentsEnabled(): boolean;
}

function coverageSkippingFirstBucket(atMs: number): { fromMs: number; toMs: number } {
  return {
    fromMs: windowStartMs(atMs) + DEPLOYMENT_BUCKET_MS,
    toMs: Math.floor((atMs - PROJECT_SETTLE_MS) / DEPLOYMENT_BUCKET_MS) * DEPLOYMENT_BUCKET_MS
  };
}

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
  | { readonly ok: false; readonly status: 400 | 404 | 409; readonly code: "invalid_request" | "not_found" | "conflict"; readonly message: string };

export class InstallationCore {
  private readonly ports: InstallationPorts;
  private readonly config: InstallationConfig;
  private readonly historyCache = new Map<string, (kind: HistoryKind) => HostHistoryColumns>();
  private readonly rawRows = new RawRowCache();

  constructor(ports: InstallationPorts, config: InstallationConfig) {
    this.ports = ports;
    this.config = config;
  }

  initialize(): void {
    const sql = this.ports.sql.open();
    migrate(sql);
    initializeDeployments(sql);
  }

  private invalidateHistory(): void {
    this.historyCache.clear();
    this.rawRows.clear();
  }

  private now(): number {
    return this.ports.clock.now();
  }

  operationRun(): OperationRun {
    return new OperationRun(this.ports.sql.open(), this.ports.operations);
  }

  private unpublished(): SqlDatabase {
    return this.ports.sql.open();
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

  async purgeHost(hostId: string): Promise<AdminResult<null>> {
    const sql = this.unpublished();
    if (this.host(sql, hostId) === undefined) return { ok: false, status: 404, code: "not_found", message: "host not found" };
    const listedBy = listServices(sql).find(service => service.hostIds.includes(hostId));
    if (listedBy !== undefined) return { ok: false, status: 409, code: "conflict", message: `service ${listedBy.name} lists this host` };
    sql.transaction(() => {
      sql.run("DELETE FROM samples WHERE host_id = ?", hostId);
      sql.run("DELETE FROM rollups WHERE host_id = ?", hostId);
      sql.run("DELETE FROM rollup_pending_hours WHERE host_id = ?", hostId);
      sql.run("DELETE FROM host_system WHERE host_id = ?", hostId);
      sql.run("DELETE FROM host_history_versions WHERE host_id = ?", hostId);
      sql.run("DELETE FROM hosts WHERE host_id = ?", hostId);
      this.invalidateHistory();
    });
    return { ok: true, value: null };
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
    for (const hour of new Set(unique.map(minute => Math.floor(minute / HOUR_MS) * HOUR_MS))) {
      sql.run("INSERT OR IGNORE INTO rollup_pending_hours (host_id, hour_ms) VALUES (?, ?)", hostId, hour);
    }
  }

  private finalizeHours(sql: SqlDatabase, hostId: string | null): number {
    const pending = hostId === null
      ? sql.rows<{ host_id: string; hour_ms: number }>("SELECT host_id, hour_ms FROM rollup_pending_hours LIMIT ?", PENDING_HOURS_PER_PASS)
      : sql.rows<{ host_id: string; hour_ms: number }>("SELECT host_id, hour_ms FROM rollup_pending_hours WHERE host_id = ?", hostId);
    for (const row of pending) {
      this.rebuildHour(sql, row.host_id, row.hour_ms);
      sql.run("DELETE FROM rollup_pending_hours WHERE host_id = ? AND hour_ms = ?", row.host_id, row.hour_ms);
    }
    return pending.length;
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
      const rows = this.rawRows.between(sql, hostId, fromMs, toMs, now);
      pointsFor = kind => pointsFromRows(rows, kind);
    } else {
      if (resolution === "1h") sql.transaction(() => this.finalizeHours(sql, hostId));
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
      return parseProjects(this.config.projects());
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
    return json(projects.map(project => {
      try { return { ...project, collector, latestDeployment: readLatestDeployment(sql, project.id, project.worker, this.now()) }; }
      catch (error) { reportError("deployments.api", error); return { ...project, collector, latestDeployment: { status: "unavailable" } }; }
    }));
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
    const etag = historyEtag(`project:coverage-v2:${project.id}`, version, windowKey, kinds.join("+"));
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

  async armRetention(): Promise<void> {
    await this.ensureAlarm(this.now());
  }

  private async ensureAlarm(now: number): Promise<void> {
    const alarm = await this.ports.scheduler.pending();
    if (alarm === null) await this.ports.scheduler.at(now + 10 * 60 * 1000);
  }

  async knownDeploymentVersions(project: string, worker: string): Promise<readonly string[]> {
    const operation = this.operationRun();
    try {
      if (!parseProjects(this.config.projects()).some(item => item.id === project && item.worker === worker)) throw new Error("unknown deployment project");
      return readVersionIds(operation.sql, project, worker);
    } finally {
      operation.finish();
    }
  }

  async recordDeploymentPoll(poll: DeploymentPoll): Promise<void> {
    const operation = this.operationRun();
    operation.describe(() => ({ operation: "deployments.poll", synthetic: false }));
    try {
      if (!parseProjects(this.config.projects()).some(item => item.id === poll.project && item.worker === poll.worker)) throw new Error("unknown deployment project");
      if (!Number.isSafeInteger(poll.atMs) || poll.atMs < 0 || poll.deployments.length > 300 || poll.versions.length > 4) throw new Error("invalid deployment poll");
      saveDeploymentPoll(operation.sql, poll);
      if (await this.ports.scheduler.pending() === null) await this.ports.scheduler.at(this.now() + 600_000);
    } finally {
      operation.finish();
    }
  }

  async recordCollectorRun(run: CollectorRun): Promise<{ metricRowsWritten: number }> {
    const operation = this.operationRun();
    try {
      const result = await this.storeCollectorRun(operation, run);
      if (run.ok) {
        try {
          const projects = parseProjects(this.config.projects());
          operation.sql.transaction(() => {
            for (const entry of run.collected) {
              const project = projects.find(item => item.id === entry.project);
              if (project === undefined) continue;
              const coverage = coverageSkippingFirstBucket(run.atMs);
              rememberSettledWindow(operation.sql, project.id, project.worker, coverage.fromMs, coverage.toMs);
            }
          });
        } catch (error) {
          reportError("deployments.coverage", error);
          console.error(JSON.stringify({ event: "deployment_coverage_unrecorded" }));
        }
      }
      return result;
    } finally {
      operation.finish();
    }
  }

  private async storeCollectorRun(operation: OperationRun, run: CollectorRun): Promise<{ metricRowsWritten: number }> {
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

  async alarm(): Promise<void> {
    const operation = this.operationRun();
    try {
      try {
        purgeDeployments(operation.sql, this.now());
        purgeServiceDeployments(operation.sql, this.now());
      }
      catch (error) {
        reportError("deployments.retention", error);
        console.error(JSON.stringify({ event: "deployment_retention_failed" }));
      }
      await this.retain(operation);
    } finally {
      operation.finish();
    }
  }

  private async retain(operation: OperationRun): Promise<void> {
    const sql = operation.sql;
    let expired = 0;
    let backlog = 0;
    operation.describe(() => ({ operation: "cleanup.retention", synthetic: false, work: { expired, backlog } }));
    try {
      const now = this.now();
      const finalized = sql.transaction(() => this.finalizeHours(sql, null));
      const raw = affectedBy(sql, "DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE received_at_ms < ? LIMIT 1000)", now - RAW_RETENTION_MS);
      const minute = affectedBy(sql, "DELETE FROM rollups WHERE rowid IN (SELECT rowid FROM rollups WHERE resolution = '1m' AND bucket_ms < ? LIMIT 1000)", now - MINUTE_RETENTION_MS);
      const hour = affectedBy(sql, "DELETE FROM rollups WHERE rowid IN (SELECT rowid FROM rollups WHERE resolution = '1h' AND bucket_ms < ? LIMIT 1000)", now - HOUR_RETENTION_MS);
      const projectRows = purgeExpired(sql, now);
      const project = Math.max(projectRows.samples, projectRows.hours);
      expired = raw + minute + hour + projectRows.samples + projectRows.hours;
      backlog = [raw, minute, hour, projectRows.samples, projectRows.hours].filter(deleted => deleted >= RETENTION_BACKLOG_ROWS).length;
      if (raw + minute + hour > 0) {
        sql.run("UPDATE host_history_versions SET version = version + 1");
        this.invalidateHistory();
      }
      await this.ports.scheduler.at(now + retentionDelayMs({ raw, minute, hour, project, pendingHours: finalized }));
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
          this.rawRows.forget(parsed.hostId);
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const deployments = /^\/projects\/([a-z][a-z0-9-]{0,31})\/deployments(?:\/([0-9a-f-]{36})\/comparison)?$/i.exec(url.pathname);
    const operation = this.operationRun();
    try {
      if (deployments !== null) return await this.deploymentsApi(request, url, deployments, operation);
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
        const shape = this.historyShape(query, this.now());
        const workloadClass = hostHistoryClass(shape.resolution, kinds);
        const etag = historyEtag(`host:${found.host_id}`, this.historyVersion(sql, found.host_id), `${historyWindowKey(query)}&to=${shape.toMs}&res=${shape.resolution}`, kinds.join("+"));
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
      if (purge !== null && request.method === "DELETE") {
        const result = await this.purgeHost(purge[1]!);
        return result.ok ? new Response(null, { status: 204 }) : failure(result.code, result.message, result.status);
      }
      if (path === "/ingest/observe-auth" && request.method === "POST") {
        const service = request.headers.get("x-observe-service");
        if (service === null || !await authenticateIngestToken(sql, service, bearerToken(request.headers.get("authorization")))) return failure("unauthorized", "ingest credential rejected", 401);
        return new Response(null, { status: 204 });
      }
      if (path === "/admin/services" && request.method === "POST") {
        const result = await createService(sql, await readLimitedText(request, MAX_SERVICE_BODY_BYTES), this.now());
        return result.ok ? json(result.value, 201) : failure(result.code, result.message, result.status);
      }
      const rotateDeploy = /^\/admin\/services\/([^/]+)\/rotate$/u.exec(path);
      if (rotateDeploy !== null && request.method === "POST") {
        const result = await rotateServiceDeployToken(sql, rotateDeploy[1]!);
        return result.ok ? json(result.value) : failure(result.code, result.message, result.status);
      }
      const rotateIngest = /^\/admin\/services\/([^/]+)\/token\/rotate$/u.exec(path);
      if (rotateIngest !== null && request.method === "POST") {
        const result = await rotateServiceIngestToken(sql, rotateIngest[1]!);
        return result.ok ? json(result.value) : failure(result.code, result.message, result.status);
      }
      const removed = /^\/admin\/services\/([^/]+)$/u.exec(path);
      if (removed !== null && request.method === "DELETE") {
        return deleteService(sql, removed[1]!) ? new Response(null, { status: 204 }) : failure("not_found", "service not found", 404);
      }
      if (path === "/services" && request.method === "GET") return json({ services: listServices(sql).map(service => {
        try { return { ...service, latestDeployment: readLatestServiceDeployment(sql, service.name, this.now()) }; }
        catch (error) { reportError("deployments.api", error); return { ...service, latestDeployment: { status: "unavailable" } }; }
      }) });
      const comparison = /^\/services\/([^/]+)\/deployments\/([^/]+)\/comparison$/u.exec(path);
      if (comparison !== null) return await this.serviceComparison(request, sql, comparison[1]!, comparison[2]!);
      const service = /^\/services\/([^/]+)(\/deployments)?$/u.exec(path);
      if (service !== null) return await this.serviceRoute(request, sql, service[1]!, service[2] !== undefined);
      return failure("not_found", "unknown object route", 404);
    } catch (error) {
      reportError("installation.request", error);
      console.error(JSON.stringify({ event: "request_failed", code: "internal" }));
      return failure("internal", "internal error", 500);
    }
  }

  private async serviceRoute(request: Request, sql: SqlDatabase, name: string, deployments: boolean): Promise<Response> {
    if (deployments && request.method === "POST") return this.markDeployment(request, sql, name);
    if (request.method !== "GET") return failure("invalid_request", "method not allowed", 405);
    const service = readService(sql, name);
    if (service === null) return failure("not_found", "service not found", 404);
    if (!deployments) return json(service);
    if ([...new URL(request.url).searchParams].length !== 0) return failure("invalid_request", "unexpected query parameters", 400);
    return json(readServiceDeployments(sql, service, this.now()));
  }

  private async serviceComparison(request: Request, sql: SqlDatabase, name: string, deploymentId: string): Promise<Response> {
    if (request.method !== "GET") return failure("invalid_request", "method not allowed", 405);
    const service = readService(sql, name);
    if (service === null) return failure("not_found", "service not found", 404);
    if (!UUID.test(deploymentId)) return failure("invalid_request", "invalid deployment id", 400);
    const params = new URL(request.url).searchParams;
    const windows = params.getAll("window");
    if (windows.length > 1 || [...params.keys()].some(key => key !== "window")) return failure("invalid_request", "invalid comparison window", 400);
    const window = windows[0] ?? "1h";
    if (!isComparisonWindow(window)) return failure("invalid_request", `window must be one of ${Object.keys(COMPARISON_WINDOWS).join(", ")}`, 400);
    const now = this.now();
    const history = readServiceDeployments(sql, service, now);
    const deployment = history.deployments.find(item => item.id === deploymentId.toLowerCase());
    const marker = history.markers.find(item => item.deploymentId === deployment?.id);
    if (deployment === undefined || marker === undefined) return failure("not_found", "deployment not found", 404);
    const bounds = comparisonBounds(deployment.atMs, window);
    let applicationEvents: readonly ExternalEventRecord[] = [];
    let applicationTruncated = false;
    let applicationProblem: string | null = this.ports.readApplicationEvents === undefined ? "this target has no application telemetry reader" : null;
    if (this.ports.readApplicationEvents !== undefined) {
      try {
        const read = await this.ports.readApplicationEvents(name, Math.max(0, bounds.before.fromMs - DEPLOYMENT_BUCKET_MS), Math.min(now, bounds.after.toMs + DEPLOYMENT_BUCKET_MS));
        applicationEvents = read.events;
        applicationTruncated = read.truncated;
      } catch {
        applicationProblem = "the observe store did not answer";
      }
    }
    const hostRollups = (hostId: string): MinuteRollup[] => sql.rows<{ bucket_ms: number; payload: string }>(
      "SELECT bucket_ms, payload FROM rollups WHERE host_id = ? AND resolution = '1m' AND bucket_ms >= ? AND bucket_ms < ? ORDER BY bucket_ms", hostId, bounds.before.fromMs, bounds.after.toMs
    ).map(row => ({ bucketMs: row.bucket_ms, payload: JSON.parse(row.payload) as RollupPayload }));
    const probeRows = sql.rows<MetricRow>(
      "SELECT metric, bucket_ms, value FROM project_samples WHERE project = ? AND bucket_ms >= ? AND bucket_ms < ? AND metric IN (?, ?)",
      serviceProbeOwner(name), bounds.before.fromMs, bounds.after.toMs, `probe.${SERVICE_PROBE_NAME}.up`, `probe.${SERVICE_PROBE_NAME}.ms`
    );
    return json(compareServiceDeployment({ service: name, deployment, deployments: history.deployments, hostIds: marker.hostIds, hostRollups, probeRows, probeSource: service.healthUrl === null ? "no-health-url" : this.ports.probesServices ? "probed" : "not-probed", window, now, truncated: history.deployments.length >= MARKERS_LISTED, applicationEvents, applicationTruncated, applicationProblem }));
  }

  async collectServiceProbes(fetch: ProbeFetch): Promise<void> {
    const operation = this.operationRun();
    try {
      const now = this.now();
      const targets = listServices(operation.sql).flatMap(service => service.healthUrl === null ? [] : [{ name: service.name, url: service.healthUrl }]);
      const collected = await Promise.all(targets.map(async target => ({ name: target.name, points: await runProbes({ fetch, probes: [{ name: SERVICE_PROBE_NAME, url: target.url }], now, clock: () => this.now() }) })));
      operation.sql.transaction(() => {
        for (const entry of collected) upsertPoints(operation.sql, serviceProbeOwner(entry.name), entry.points);
      });
      await this.ensureAlarm(this.now());
    } finally {
      operation.finish();
    }
  }

  private async markDeployment(request: Request, sql: SqlDatabase, name: string): Promise<Response> {
    const rejected = (code: ErrorCode, message: string, status: number) => {
      console.error(JSON.stringify({ event: "deploy_mark_rejected", code }));
      return failure(code, message, status);
    };
    if (!await authenticateDeployToken(sql, name, bearerToken(request.headers.get("authorization")))) return rejected("unauthorized", "deploy credential rejected", 401);
    const result = await recordMarker(sql, name, await readLimitedText(request, MAX_MARKER_BODY_BYTES), this.now());
    if (!result.ok) return rejected(result.code, result.message, result.status);
    return json(result.value.marker, result.value.created ? 201 : 200);
  }

  private async deploymentsApi(request: Request, url: URL, match: RegExpExecArray, operation: OperationRun): Promise<Response> {
    try {
    const failure = (status: number, message: string) => Response.json({ error: { code: status === 404 ? "not_found" : status === 503 ? "unavailable" : "invalid_request", message } }, { status });
    if (request.method !== "GET") return failure(405, "method not allowed");
    let project;
    try { project = parseProjects(this.config.projects()).find(item => item.id === match[1]); }
    catch (error) {
      reportError("projects.config", error);
      return failure(503, "project configuration unavailable");
    }
    if (project === undefined) return failure(404, "project not found");
    const now = this.now();
    const sql = operation.sql;
    const deployments = readDeployments(sql, project.id, project.worker, now);
    const sync = readDeploymentSync(sql, project.id, project.worker);
    const enabled = this.config.deploymentsEnabled();
    if (match[2] === undefined) {
      if ([...url.searchParams].length !== 0) return failure(400, "unexpected query parameters");
      const history: DeploymentHistory = { projectId: project.id, worker: project.worker, enabled, sync, deployments, versions: readVersions(sql, project.id, project.worker) };
      return Response.json(history);
    }
    if (!UUID.test(match[2])) return failure(400, "invalid deployment id");
    const windows = url.searchParams.getAll("window");
    if (windows.length > 1 || [...url.searchParams.keys()].some(key => key !== "window")) return failure(400, "invalid comparison window");
    const window = windows[0] ?? "1h";
    if (!isComparisonWindow(window)) return failure(400, `window must be one of ${Object.keys(COMPARISON_WINDOWS).join(", ")}`);
    const deployment = deployments.find(item => item.id === match[2]?.toLowerCase());
    if (deployment === undefined) return failure(404, "deployment not found");
    const bounds = comparisonBounds(deployment.atMs, window);
    const rows = sql.rows<MetricRow>(
      COMPARISON_METRICS_SQL,
      project.id, bounds.before.fromMs, bounds.after.toMs,
    );
    return Response.json(compareDeployment({ deployment, deployments, rows, window, now, settleMs: PROJECT_SETTLE_MS, lastSuccessAtMs: sync?.lastSuccessAtMs ?? null, truncated: sync?.truncated ?? false, enabled, metricsSettled: hasSettledWindow(sql, project.id, project.worker, bounds.before.fromMs, bounds.before.toMs) && hasSettledWindow(sql, project.id, project.worker, bounds.after.fromMs, bounds.after.toMs), hasD1: project.d1Databases.length > 0, hasDurableObjects: project.durableObjectNamespaces.length > 0, buckets: project.buckets, probes: project.probes.map(probe => probe.name) }));
    } catch (error) {
      reportError("deployments.api", error);
      console.error(JSON.stringify({ event: "deployment_api_failed" }));
      return Response.json({ error: { code: "internal", message: "deployment history unavailable" } }, { status: 500 });
    }
  }
}
