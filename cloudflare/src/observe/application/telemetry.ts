import type { SqlStatements } from "../../core/sql.ts";
import { eventWindow } from "../core/store.ts";
import { PROVENANCE, type ExternalEvent, type ExternalEventRecord, type ExternalFilter } from "../ingest/model.ts";

export interface ApplicationTotals {
  readonly events: number;
  readonly failed: number;
  readonly requests: number;
  readonly status2xx: number;
  readonly status3xx: number;
  readonly status4xx: number;
  readonly status5xx: number;
  readonly durationMsSum: number;
  readonly durationMsMax: number;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
}

export interface ApplicationTelemetry {
  readonly provenance: "application";
  readonly fromMs: number;
  readonly toMs: number;
  readonly stepMs: number;
  readonly totals: ApplicationTotals | null;
  readonly buckets: readonly (ApplicationTotals & { readonly atMs: number })[];
  readonly operations: readonly (ApplicationTotals & { readonly operation: string })[];
  readonly moreOperations: boolean;
  readonly recent: readonly ExternalEventRecord[];
  readonly moreRecent: boolean;
}

const HTTP_STATUS = "CASE WHEN json_type(payload, '$.work.http_status') = 'integer' AND json_extract(payload, '$.work.http_status') BETWEEN 100 AND 599 THEN json_extract(payload, '$.work.http_status') END";
const MEASURES = `COUNT(*) AS events,
  SUM(json_extract(payload, '$.outcome') <> 'ok') AS failed,
  SUM((${HTTP_STATUS}) IS NOT NULL) AS requests,
  SUM(CASE WHEN (${HTTP_STATUS}) BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS status2xx,
  SUM(CASE WHEN (${HTTP_STATUS}) BETWEEN 300 AND 399 THEN 1 ELSE 0 END) AS status3xx,
  SUM(CASE WHEN (${HTTP_STATUS}) BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS status4xx,
  SUM(CASE WHEN (${HTTP_STATUS}) BETWEEN 500 AND 599 THEN 1 ELSE 0 END) AS status5xx,
  SUM(json_extract(payload, '$.durationMs')) AS durationMsSum,
  MAX(json_extract(payload, '$.durationMs')) AS durationMsMax,
  MIN(event_at) AS firstAtMs, MAX(event_at) AS lastAtMs`;

function checked(row: ApplicationTotals): ApplicationTotals {
  for (const value of Object.values(row)) {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("application telemetry exceeds exact numeric bounds");
  }
  return row;
}

export function readApplicationTelemetry(db: SqlStatements, service: string, nowMs: number, filter: Pick<ExternalFilter, "fromMs" | "toMs">): ApplicationTelemetry {
  const { fromMs, toMs } = eventWindow(nowMs, filter.fromMs, filter.toMs);
  const stepMs = Math.max(1000, Math.ceil((toMs - fromMs) / 120_000) * 1000);
  const parameters = [service, fromMs, toMs];
  const where = "FROM observe_external_events WHERE service = ? AND event_at >= ? AND event_at < ?";
  const totals = db.rows<ApplicationTotals>(`SELECT ${MEASURES} ${where}`, ...parameters)[0]!;
  const buckets = db.rows<ApplicationTotals & { atMs: number }>(
    `SELECT CAST((event_at - ?) / ? AS INTEGER) * ? + ? AS atMs, ${MEASURES} ${where} GROUP BY atMs ORDER BY atMs`,
    fromMs, stepMs, stepMs, fromMs, ...parameters
  );
  const operations = db.rows<ApplicationTotals & { operation: string }>(
    `SELECT json_extract(payload, '$.operation') AS operation, ${MEASURES} ${where} GROUP BY operation ORDER BY events DESC, operation LIMIT 21`,
    ...parameters
  );
  const recent = db.rows<{ event_id: string; service: string; received_at: number; payload: string }>(
    `SELECT event_id, service, received_at, payload ${where} ORDER BY event_at DESC, event_id DESC LIMIT 51`, ...parameters
  );
  return {
    provenance: PROVENANCE, fromMs, toMs, stepMs,
    totals: totals.events === 0 ? null : checked(totals),
    buckets: buckets.map(row => ({ ...checked(row), atMs: row.atMs })),
    operations: operations.slice(0, 20).map(row => ({ ...checked(row), operation: row.operation })),
    moreOperations: operations.length > 20,
    recent: recent.slice(0, 50).map(row => ({ eventId: row.event_id, service: row.service, receivedAtMs: row.received_at, provenance: PROVENANCE, event: JSON.parse(row.payload) as ExternalEvent })),
    moreRecent: recent.length > 50
  };
}
