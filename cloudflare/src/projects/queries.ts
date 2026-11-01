type SqlValue = string | number | boolean | null;

export interface BoundQuery {
  readonly query: string;
  readonly params: Readonly<Record<string, SqlValue>>;
}

export const BUCKET_MS = 5 * 60_000;
export const MAX_BUCKETS_PER_PROJECT = 8;
export const MAX_NAMESPACES_PER_PROJECT = 8;
export const MAX_D1_DATABASES_PER_PROJECT = 8;
export const D1_STATEMENT_PREFIX_LENGTH = 160;

const ROW_LIMIT = 2000;

const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const NAMESPACE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const D1_DATABASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const WORKER_EVENT_LOG_TYPE = "cf-worker-event";

export function workerQuery(script: string, startMs: number): BoundQuery {
  return {
    query: [
      "SELECT toDate(timestamp) AS day, toHour(timestamp) AS hour,",
      "floor(toMinute(timestamp) / 5) AS slot, httpStatus,",
      "SUM(sampleInterval) AS invocations,",
      "SUM(cpuTimeMs * sampleInterval) AS cpu_sum,",
      "APPROX_MAX(cpuTimeMs) AS cpu_max",
      "FROM logs.workersLogs",
      `WHERE scriptName = $script AND logType = '${WORKER_EVENT_LOG_TYPE}' AND timestamp >= $start`,
      "GROUP BY toDate(timestamp), toHour(timestamp), floor(toMinute(timestamp) / 5), httpStatus",
      `LIMIT ${ROW_LIMIT}`,
    ].join(" "),
    params: { script, start: isoStart(startMs) },
  };
}

export function routeQuery(script: string, startMs: number): BoundQuery {
  return {
    query: [
      "SELECT toDate(timestamp) AS day, toHour(timestamp) AS hour,",
      "floor(toMinute(timestamp) / 5) AS slot, invocationLabel,",
      "SUM(sampleInterval) AS invocations,",
      "SUM(cpuTimeMs * sampleInterval) AS cpu_sum",
      "FROM logs.workersLogs",
      `WHERE scriptName = $script AND logType = '${WORKER_EVENT_LOG_TYPE}' AND timestamp >= $start`,
      "GROUP BY toDate(timestamp), toHour(timestamp), floor(toMinute(timestamp) / 5), invocationLabel",
      `ORDER BY cpu_sum DESC LIMIT ${ROW_LIMIT}`,
    ].join(" "),
    params: { script, start: isoStart(startMs) },
  };
}

export function durableObjectQuery(namespaces: readonly string[], startMs: number): BoundQuery {
  if (namespaces.length === 0 || namespaces.length > MAX_NAMESPACES_PER_PROJECT) {
    throw new RangeError(`namespace list must hold 1 to ${MAX_NAMESPACES_PER_PROJECT} ids`);
  }
  const params: Record<string, string> = {};
  const placeholders = namespaces.map((id, index) => {
    if (!NAMESPACE_ID_PATTERN.test(id)) {
      throw new RangeError("namespace id is not a valid Durable Object namespace id");
    }
    params[`namespace${index}`] = id;
    return `$namespace${index}`;
  });
  return {
    query: [
      "SELECT toStartOfFiveMinutes(timestamp) AS bucket, status,",
      "SUM(sampleInterval) AS invocations,",
      "SUM(cpuTimeUs * sampleInterval) AS cpu_us,",
      "SUM(wallTimeUs * sampleInterval) AS wall_us,",
      "APPROX_MAX(cpuTimeUs) AS cpu_max_us",
      "FROM events.durableObjectsInvocations",
      `WHERE namespaceId IN (${placeholders.join(", ")}) AND timestamp >= $start`,
      "GROUP BY toStartOfFiveMinutes(timestamp), status",
      `LIMIT ${ROW_LIMIT}`,
    ].join(" "),
    params: { ...params, start: isoStart(startMs) },
  };
}

export function r2OperationsQuery(buckets: readonly string[], startMs: number): BoundQuery {
  const names = bucketParams(buckets);
  return {
    query: [
      "SELECT bucketName, toStartOfFiveMinutes(timestamp) AS bucket, actionStatus,",
      "SUM(sampleInterval) AS operations",
      "FROM events.r2CombinedOperations",
      `WHERE bucketName IN (${names.placeholders}) AND timestamp >= $start`,
      "GROUP BY bucketName, toStartOfFiveMinutes(timestamp), actionStatus",
      `LIMIT ${ROW_LIMIT}`,
    ].join(" "),
    params: { ...names.params, start: isoStart(startMs) },
  };
}

export function r2StorageQuery(buckets: readonly string[], startMs: number): BoundQuery {
  const names = bucketParams(buckets);
  return {
    query: [
      "SELECT bucketName, toStartOfTenMinutes(usageReportTimestamp) AS bucket,",
      "MAX(payloadSizeBytes) AS storage_bytes, MAX(objectCount) AS objects",
      "FROM states.r2CombinedStorage",
      `WHERE bucketName IN (${names.placeholders}) AND usageReportTimestamp >= $start`,
      "GROUP BY bucketName, toStartOfTenMinutes(usageReportTimestamp)",
      `LIMIT ${ROW_LIMIT}`,
    ].join(" "),
    params: { ...names.params, start: isoStart(startMs) },
  };
}

export function d1Query(databases: readonly string[], startMs: number): BoundQuery {
  const ids = d1Params(databases);
  return {
    query: [
      "SELECT toStartOfFiveMinutes(timestamp) AS bucket,",
      "SUM(sampleInterval) AS queries,",
      "SUM(rowsRead * sampleInterval) AS rows_read,",
      "SUM(rowsWritten * sampleInterval) AS rows_written",
      "FROM events.d1Queries",
      `WHERE databaseId IN (${ids.placeholders}) AND timestamp >= $start`,
      "GROUP BY toStartOfFiveMinutes(timestamp)",
      `LIMIT ${ROW_LIMIT}`,
    ].join(" "),
    params: { ...ids.params, start: isoStart(startMs) },
  };
}

export function d1StatementQuery(databases: readonly string[], startMs: number): BoundQuery {
  const ids = d1Params(databases);
  return {
    query: [
      `SELECT toStartOfFiveMinutes(timestamp) AS bucket, substring(query, 1, ${D1_STATEMENT_PREFIX_LENGTH}) AS statement,`,
      "SUM(sampleInterval) AS queries,",
      "SUM(rowsRead * sampleInterval) AS rows_read,",
      "SUM(rowsWritten * sampleInterval) AS rows_written",
      "FROM events.d1Queries",
      `WHERE databaseId IN (${ids.placeholders}) AND timestamp >= $start`,
      `GROUP BY toStartOfFiveMinutes(timestamp), substring(query, 1, ${D1_STATEMENT_PREFIX_LENGTH})`,
      `ORDER BY rows_written DESC LIMIT ${ROW_LIMIT}`,
    ].join(" "),
    params: { ...ids.params, start: isoStart(startMs) },
  };
}

function d1Params(databases: readonly string[]): { placeholders: string; params: Record<string, string> } {
  if (databases.length === 0 || databases.length > MAX_D1_DATABASES_PER_PROJECT) {
    throw new RangeError(`database list must hold 1 to ${MAX_D1_DATABASES_PER_PROJECT} ids`);
  }
  const params: Record<string, string> = {};
  const placeholders = databases.map((id, index) => {
    if (!D1_DATABASE_ID_PATTERN.test(id)) {
      throw new RangeError("database id is not a valid D1 database id");
    }
    params[`database${index}`] = id;
    return `$database${index}`;
  });
  return { placeholders: placeholders.join(", "), params };
}

function bucketParams(buckets: readonly string[]): {
  placeholders: string;
  params: Record<string, string>;
} {
  if (buckets.length === 0 || buckets.length > MAX_BUCKETS_PER_PROJECT) {
    throw new RangeError(`bucket list must hold 1 to ${MAX_BUCKETS_PER_PROJECT} names`);
  }
  const params: Record<string, string> = {};
  const placeholders = buckets.map((name, index) => {
    if (!BUCKET_NAME_PATTERN.test(name)) {
      throw new RangeError("bucket name is not a valid R2 bucket name");
    }
    params[`bucket${index}`] = name;
    return `$bucket${index}`;
  });
  return { placeholders: placeholders.join(", "), params };
}

function isoStart(startMs: number): string {
  if (!Number.isSafeInteger(startMs) || startMs < 0) {
    throw new RangeError("start must be a non-negative integer of epoch milliseconds");
  }
  return new Date(startMs).toISOString();
}
