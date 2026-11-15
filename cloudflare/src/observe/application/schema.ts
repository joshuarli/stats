export const APPLICATION_SUMMARY_INDEX = "observe_external_events_covering";
const FIELDS = [
  ["json_extract(payload, '$.operation')", "operation"],
  ["json_extract(payload, '$.outcome')", "outcome"],
  ["json_extract(payload, '$.durationMs')", "duration_ms"],
  ["CASE WHEN json_type(payload, '$.work.http_status') = 'integer' AND json_extract(payload, '$.work.http_status') BETWEEN 100 AND 599 THEN json_extract(payload, '$.work.http_status') END", "http_status"]
] as const;
export const APPLICATION_SUMMARY_PROJECTION = `event_at, ${FIELDS.map(([expression, name]) => `${expression} AS ${name}`).join(", ")}`;
// SQLite still seeks the WITHOUT ROWID table for expression-only indexes. Including payload makes this index covering.
export const APPLICATION_SUMMARY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${APPLICATION_SUMMARY_INDEX} ON observe_external_events (service, event_at, ${FIELDS.map(([expression]) => expression).join(", ")}, payload)`;
