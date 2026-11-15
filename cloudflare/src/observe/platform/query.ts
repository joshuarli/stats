import type { SqlStatements } from "../../core/sql.ts";
import { eventWindow } from "../core/store.ts";
import type { ExternalFilter } from "../ingest/model.ts";
import { DURATION_BOUNDS_US, PLATFORM_SERVICE, SQLITE_OPERATIONS, type PlatformDelivery, type PlatformOperation, type PlatformTelemetry } from "../../../../packages/platform-bridge/src/contract.ts";

const OPERATIONS = ["installation", "observation"].flatMap(actor => [`platform.${actor}.invoke`, ...SQLITE_OPERATIONS.map(operation => `platform.${actor}.sqlite.${operation}`)]);
const GROUP_LIMIT = 80;
type HistogramRow = { operation: string; release: string; last_at: number; upper_us: number; n: number; failed: number; sum_us: number; max_us: number };
function exact(value: number): number { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("platform telemetry exceeds exact bounds"); return value; }
function percentile(histogram: readonly { upperUs: number; count: number }[], count: number, fraction: number): number {
  let seen = 0;
  for (const bucket of histogram) { seen += bucket.count; if (seen >= Math.ceil(count * fraction)) return bucket.upperUs; }
  throw new RangeError("incomplete platform histogram");
}
export function readPlatformTelemetry(db: SqlStatements, service: string, nowMs: number, filter: Pick<ExternalFilter, "fromMs" | "toMs">): PlatformTelemetry {
  if (service !== PLATFORM_SERVICE) throw new RangeError("platform telemetry requires its dedicated sink");
  const { fromMs, toMs } = eventWindow(nowMs, filter.fromMs, filter.toMs);
  const bin = `CASE ${DURATION_BOUNDS_US.map(bound => `WHEN duration_us <= ${bound} THEN ${bound}`).join(" ")} END`;
  const rows = db.rows<HistogramRow>(
    `SELECT * FROM (WITH parsed AS MATERIALIZED (
      SELECT event_at, json_extract(payload, '$.operation') AS operation,
        json_extract(payload, '$.release') AS release, json_extract(payload, '$.outcome') AS outcome,
        json_extract(payload, '$.work.duration_us') AS duration_us
      FROM observe_external_events WHERE service = ? AND event_at >= ? AND event_at < ?
        AND json_type(payload, '$.work.duration_us') = 'integer'
    ), groups AS (
      SELECT operation, release, MAX(event_at) AS last_at FROM parsed
      WHERE operation IN (${OPERATIONS.map(() => "?").join(",")}) AND duration_us BETWEEN 0 AND 86400000000
      GROUP BY operation, release ORDER BY last_at DESC, operation, release LIMIT ?
    )
    SELECT p.operation, p.release, g.last_at, ${bin} AS upper_us, COUNT(*) AS n,
      SUM(outcome <> 'ok') AS failed, SUM(duration_us) AS sum_us, MAX(duration_us) AS max_us
    FROM parsed p JOIN groups g ON p.operation = g.operation AND p.release = g.release
    WHERE duration_us BETWEEN 0 AND 86400000000 GROUP BY p.operation, p.release, upper_us
    ORDER BY g.last_at DESC, p.operation, p.release, upper_us)`,
    service, fromMs, toMs, ...OPERATIONS, GROUP_LIMIT + 1
  );
  const grouped = new Map<string, { operation: string; release: string; count: number; failed: number; total: number; maximum: number; histogram: { upperUs: number; count: number }[] }>();
  for (const row of rows) {
    const key = `${row.operation}\n${row.release}`;
    let group = grouped.get(key);
    if (group === undefined) { group = { operation: row.operation, release: row.release, count: 0, failed: 0, total: 0, maximum: 0, histogram: [] }; grouped.set(key, group); }
    group.count = exact(group.count + exact(row.n));
    group.failed = exact(group.failed + exact(row.failed));
    group.total = exact(group.total + exact(row.sum_us));
    group.maximum = Math.max(group.maximum, exact(row.max_us));
    group.histogram.push({ upperUs: exact(row.upper_us), count: row.n });
  }
  const operations: PlatformOperation[] = [...grouped.values()].slice(0, GROUP_LIMIT).map(group => ({ operation: group.operation, release: group.release, count: group.count, failed: group.failed, meanUs: group.total / group.count, maxUs: group.maximum, p50UpperUs: percentile(group.histogram, group.count, 0.5), p95UpperUs: percentile(group.histogram, group.count, 0.95), histogram: group.histogram }));
  const latest = db.rows<{ payload: string }>("SELECT payload FROM observe_external_events WHERE service = ? AND event_at <= ? AND json_extract(payload, '$.operation') = 'platform.bridge' ORDER BY event_at DESC, event_id DESC LIMIT 1", service, nowMs)[0];
  let delivery: PlatformDelivery | null = null;
  if (latest !== undefined) {
    const event = JSON.parse(latest.payload) as { atMs: number; release: string; work: Record<string, number> };
    const w = event.work;
    if (["sample_ppm", "received", "admitted", "filtered", "invalid", "dropped", "queued", "sent"].every(key => Number.isSafeInteger(w[key]) && w[key]! >= 0) && w["sample_ppm"]! <= 1_000_000) delivery = { atMs: event.atMs, release: event.release, samplePpm: w["sample_ppm"]!, received: w["received"]!, admitted: w["admitted"]!, filtered: w["filtered"]!, invalid: w["invalid"]!, dropped: w["dropped"]!, queued: w["queued"]!, sent: w["sent"]!, exporterLoss: "unknown" };
  }
  return { fromMs, toMs, operations, delivery, truncated: grouped.size > GROUP_LIMIT, capabilities: { actorRequests: true, sqlite: true, outboundRpc: false, runtimeMetrics: false } };
}
