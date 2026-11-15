import type { SqlStatements } from "../../core/sql.ts";
import { APPLICATION_SUMMARY_TABLE } from "./schema.ts";
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

const MEASURES = `COUNT(*) AS events,
  SUM(outcome <> 'ok') AS failed,
  SUM(outcome = 'cancelled') AS cancelled,
  SUM(http_status IS NOT NULL) AS requests,
  SUM(CASE WHEN http_status IS NOT NULL THEN duration_ms ELSE 0 END) AS requestDurationMsSum,
  MAX(CASE WHEN http_status IS NOT NULL THEN duration_ms ELSE 0 END) AS requestDurationMsMax,
  SUM(CASE WHEN http_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS status2xx,
  SUM(CASE WHEN http_status BETWEEN 300 AND 399 THEN 1 ELSE 0 END) AS status3xx,
  SUM(CASE WHEN http_status BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS status4xx,
  SUM(CASE WHEN http_status BETWEEN 500 AND 599 THEN 1 ELSE 0 END) AS status5xx,
  SUM(duration_ms) AS durationMsSum,
  MAX(duration_ms) AS durationMsMax,
  MIN(event_at) AS firstAtMs, MAX(event_at) AS lastAtMs`;

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
  const rows = db.rows<SummaryRow>(
    `SELECT * FROM (WITH events AS MATERIALIZED (
      SELECT event_at, operation, outcome, duration_ms, NULLIF(http_status, 0) AS http_status
      FROM ${APPLICATION_SUMMARY_TABLE} WHERE service = ? AND event_at >= ? AND event_at < ?
    ), buckets AS (
      SELECT 0 AS kind, CAST((event_at - ?) / ? AS INTEGER) * ? + ? AS atMs,
        NULL AS operation, ${MEASURES}
      FROM events GROUP BY atMs
    ), operations AS (
      SELECT 1 AS kind, NULL AS atMs, operation, ${MEASURES}
      FROM events GROUP BY operation ORDER BY events DESC, operation LIMIT 21
    )
    SELECT * FROM buckets UNION ALL SELECT * FROM operations)
    ORDER BY kind, atMs, events DESC, operation`,
    service, fromMs, toMs, fromMs, stepMs, stepMs, fromMs
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
