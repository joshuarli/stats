import type { SqlStatements } from "../../core/sql.ts";
import { aggregateMeasures, measureColumns, scalarMeasures } from "./measures.ts";
import { APPLICATION_ROLLUP_TABLE, APPLICATION_SUMMARY_TABLE } from "./schema.ts";
import { eventWindow, openIssueCount } from "../core/store.ts";
import { PROVENANCE, type ExternalEvent, type ExternalEventRecord, type ExternalFilter } from "../ingest/model.ts";

export interface ApplicationTotals {
  readonly events: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly requests: number;
  readonly requestDurationMsSum: number;
  readonly requestDurationMsMax: number;
  readonly status2xx: number;
  readonly status3xx: number;
  readonly status4xx: number;
  readonly status5xx: number;
  readonly durationMsSum: number;
  readonly durationMsMax: number;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
}

export interface ApplicationSummary {
  readonly provenance: "application";
  readonly fromMs: number;
  readonly toMs: number;
  readonly stepMs: number;
  readonly totals: ApplicationTotals | null;
  readonly openIssues: number;
  readonly buckets: readonly (ApplicationTotals & { readonly atMs: number })[];
  readonly operations: readonly (ApplicationTotals & { readonly operation: string })[];
  readonly moreOperations: boolean;
}

export interface ApplicationTelemetry extends ApplicationSummary {
  readonly recent: readonly ExternalEventRecord[];
  readonly moreRecent: boolean;
}

export interface ApplicationSummaryRead {
  readonly data: ApplicationSummary;
  readonly queryMs: number;
  readonly issuesMs: number;
  readonly readMs: number;
}

interface ReadClock {
  readonly now: () => number;
  queryMs: number;
  issuesMs: number;
}

type SummaryInterval = readonly [resolution: 0 | 1000 | 60000, fromMs: number, toMs: number, bucketAtMs: number];
const SUMMARY_RESOLUTIONS = [60000, 1000] as const;
// SQLite-backed Durable Objects allow 100 bound parameters: https://developers.cloudflare.com/durable-objects/platform/limits/
const SUMMARY_SQL = `SELECT * FROM (WITH ranges AS MATERIALIZED (
      SELECT json_extract(value, '$[0]') AS resolution, json_extract(value, '$[1]') AS lo, json_extract(value, '$[2]') AS hi, json_extract(value, '$[3]') AS atMs FROM json_each(?)
    ), events AS MATERIALIZED (
      SELECT r.atMs, CASE WHEN v.operation_present = 1 THEN v.operation END AS operation, ${measureColumns.split(", ").map(name => `v.${name}`).join(", ")}
      FROM ranges r CROSS JOIN ${APPLICATION_ROLLUP_TABLE} v WHERE r.resolution IN (1000, 60000) AND v.service = ? AND v.resolution = r.resolution AND v.bucket >= r.lo AND v.bucket < r.hi
      UNION ALL
      SELECT r.atMs, p.operation, ${scalarMeasures("p")} FROM ranges r CROSS JOIN ${APPLICATION_SUMMARY_TABLE} p WHERE r.resolution = 0 AND p.service = ? AND p.event_at >= r.lo AND p.event_at < r.hi
    ), buckets AS (
      SELECT 0 AS kind, atMs, NULL AS operation, ${aggregateMeasures("events")} FROM events GROUP BY atMs
    ), operations AS (
      SELECT 1 AS kind, NULL AS atMs, operation, ${aggregateMeasures("events")} FROM events GROUP BY operation ORDER BY events DESC, operation LIMIT 21
    ) SELECT * FROM buckets UNION ALL SELECT * FROM operations) ORDER BY kind, atMs, events DESC, operation`;

type SummaryRow = ApplicationTotals & (
  | { readonly kind: 0; readonly atMs: number; readonly operation: null }
  | { readonly kind: 1; readonly atMs: null; readonly operation: string }
);

function checked(row: ApplicationTotals): ApplicationTotals {
  for (const value of Object.values(row)) {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("application telemetry exceeds exact numeric bounds");
  }
  return row;
}

function windowTotals(buckets: readonly ApplicationTotals[]): ApplicationTotals | null {
  const first = buckets[0];
  if (first === undefined) return null;
  const total = { events: 0, failed: 0, cancelled: 0, requests: 0, requestDurationMsSum: 0, requestDurationMsMax: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, durationMsSum: 0, durationMsMax: 0, firstAtMs: first.firstAtMs, lastAtMs: first.lastAtMs };
  for (const bucket of buckets) {
    for (const key of ["events", "failed", "cancelled", "requests", "requestDurationMsSum", "status2xx", "status3xx", "status4xx", "status5xx", "durationMsSum"] as const) total[key] += bucket[key];
    total.requestDurationMsMax = Math.max(total.requestDurationMsMax, bucket.requestDurationMsMax);
    total.durationMsMax = Math.max(total.durationMsMax, bucket.durationMsMax);
    total.firstAtMs = Math.min(total.firstAtMs, bucket.firstAtMs);
    total.lastAtMs = Math.max(total.lastAtMs, bucket.lastAtMs);
  }
  return checked(total);
}

function summarize(db: SqlStatements, service: string, nowMs: number, filter: Pick<ExternalFilter, "fromMs" | "toMs">, clock?: ReadClock): ApplicationSummary {
  const { fromMs, toMs } = eventWindow(nowMs, filter.fromMs, filter.toMs);
  const stepMs = Math.max(1000, Math.ceil((toMs - fromMs) / 120_000) * 1000);
  // OpenOrange 1.0.2 treats a leading WITH as a write turn. Keep SELECT first until its read classifier supports CTEs.
  const queryStarted = clock?.now();
  const intervals: SummaryInterval[] = [];
  const split = (lo: number, hi: number, level: number, atMs: number): void => {
    if (lo >= hi) return;
    const unit = SUMMARY_RESOLUTIONS[level];
    if (unit === undefined) { intervals.push([0, lo, hi, atMs]); return; }
    const first = Math.ceil(lo / unit) * unit, last = Math.floor(hi / unit) * unit;
    if (first < last) { split(lo, first, level + 1, atMs); intervals.push([unit, first, last, atMs]); split(last, hi, level + 1, atMs); }
    else split(lo, hi, level + 1, atMs);
  };
  for (let atMs = fromMs; atMs < toMs; atMs += stepMs) split(atMs, Math.min(toMs, atMs + stepMs), 0, atMs);
  const rows = db.rows<SummaryRow>(
    SUMMARY_SQL,
    JSON.stringify(intervals), service, service
  );
  if (clock !== undefined) clock.queryMs = clock.now() - queryStarted!;
  const buckets: (ApplicationTotals & { readonly atMs: number })[] = [];
  const operations: (ApplicationTotals & { readonly operation: string })[] = [];
  for (const { kind, atMs, operation, ...totals } of rows) {
    if (kind === 0) buckets.push({ ...checked(totals), atMs });
    else operations.push({ ...checked(totals), operation });
  }
  const issuesStarted = clock?.now();
  const openIssues = openIssueCount(db, nowMs);
  if (clock !== undefined) clock.issuesMs = clock.now() - issuesStarted!;
  return {
    provenance: PROVENANCE, fromMs, toMs, stepMs,
    totals: windowTotals(buckets),
    openIssues,
    buckets,
    operations: operations.slice(0, 20),
    moreOperations: operations.length > 20,
  };
}

export function readApplicationSummary(db: SqlStatements, service: string, nowMs: number, filter: Pick<ExternalFilter, "fromMs" | "toMs">): ApplicationSummary {
  return summarize(db, service, nowMs, filter);
}

export function readApplicationSummaryTimed(db: SqlStatements, service: string, nowMs: number, filter: Pick<ExternalFilter, "fromMs" | "toMs">, monotonic: () => number): ApplicationSummaryRead {
  const started = monotonic();
  const clock: ReadClock = { now: monotonic, queryMs: 0, issuesMs: 0 };
  const data = summarize(db, service, nowMs, filter, clock);
  return { data, queryMs: clock.queryMs, issuesMs: clock.issuesMs, readMs: monotonic() - started };
}

export function readApplicationTelemetry(db: SqlStatements, service: string, nowMs: number, filter: Pick<ExternalFilter, "fromMs" | "toMs">): ApplicationTelemetry {
  const summary = readApplicationSummary(db, service, nowMs, filter);
  const recent = db.rows<{ event_id: string; service: string; received_at: number; payload: string }>(
    "SELECT event_id, service, received_at, payload FROM observe_external_events WHERE service = ? AND event_at >= ? AND event_at < ? ORDER BY event_at DESC, event_id DESC LIMIT 51", service, summary.fromMs, summary.toMs
  );
  return {
    ...summary,
    recent: recent.slice(0, 50).map(row => ({ eventId: row.event_id, service: row.service, receivedAtMs: row.received_at, provenance: PROVENANCE, event: JSON.parse(row.payload) as ExternalEvent })),
    moreRecent: recent.length > 50
  };
}
