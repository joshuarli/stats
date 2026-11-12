import { MAX_FUTURE_SKEW_MS, RETENTION_MS } from "../core/limits.ts";
import {
  ERROR_CODE, EVENT_ID, HOST, INGEST_SCHEMA_VERSION, INSTANCE, MAX_DURATION_MS, MAX_EVENTS, MAX_WORK_MEASUREMENTS, MAX_WORK_VALUE,
  OPERATION, OUTCOME, RELEASE, SERVICE_SLUG, SPAN_ID, SUCCESS_OUTCOME, TRACE_ID, WORK_KEY,
  type ProducerDelivery, type ExternalBatch, type ExternalDecode, type ExternalDecodeCode, type ExternalError, type ExternalEvent, type ExternalTrace
} from "./model.ts";

const EVENT_KEYS = ["delivery", "schemaVersion", "eventId", "atMs", "operation", "outcome", "durationMs", "work", "release", "service", "instance", "host", "trace", "error"] as const;
const REQUIRED_KEYS = ["schemaVersion", "eventId", "atMs", "operation", "outcome", "durationMs", "work", "release", "service"] as const;
const TRACE_KEYS = ["traceId", "spanId"] as const;
const ERROR_KEYS = ["code"] as const;

export interface DecodeOptions {
  readonly service: string;
  readonly nowMs: number;
}

function fail(code: ExternalDecodeCode, message: string): ExternalDecode {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workOf(value: unknown): Readonly<Record<string, number>> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_WORK_MEASUREMENTS) return null;
  const work: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!WORK_KEY.test(key) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > MAX_WORK_VALUE) return null;
    work[key] = count;
  }
  return Object.fromEntries(Object.keys(work).sort().map(key => [key, work[key]!]));
}

function traceOf(value: unknown): ExternalTrace | null {
  if (!isRecord(value) || Object.keys(value).length !== TRACE_KEYS.length || !TRACE_KEYS.every(key => key in value)) return null;
  const { traceId, spanId } = value;
  return typeof traceId === "string" && TRACE_ID.test(traceId) && typeof spanId === "string" && SPAN_ID.test(spanId) ? { traceId, spanId } : null;
}

function errorOf(value: unknown): ExternalError | null {
  if (!isRecord(value) || Object.keys(value).length !== ERROR_KEYS.length || !ERROR_KEYS.every(key => key in value)) return null;
  const { code } = value;
  return typeof code === "string" && ERROR_CODE.test(code) ? { code } : null;
}

function deliveryOf(value: unknown): ProducerDelivery | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "accepted,atMs,dropped,id,queued,sequence,startedAtMs") return null;
  if (typeof value["id"] !== "string" || !EVENT_ID.test(value["id"])) return null;
  for (const key of ["sequence", "accepted", "dropped", "queued", "startedAtMs", "atMs"]) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  }
  const delivery = value as unknown as ProducerDelivery;
  return delivery.sequence > 0 && delivery.sequence <= delivery.accepted && delivery.queued <= delivery.accepted && delivery.startedAtMs > 0 && delivery.atMs >= delivery.startedAtMs ? delivery : null;
}

function eventOf(value: unknown, options: DecodeOptions, seen: Set<string>): ExternalDecode | ExternalEvent {
  if (!isRecord(value)) return fail("invalid_event", "each event must be an object");
  const unknown = Object.keys(value).find(key => !(EVENT_KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) return fail("invalid_event", `event has an unexpected field ${unknown}`);
  const missing = REQUIRED_KEYS.find(key => !(key in value));
  if (missing !== undefined) return fail("invalid_event", `event is missing ${missing}`);
  if (value["schemaVersion"] !== INGEST_SCHEMA_VERSION) return fail("invalid_schema_version", `schemaVersion must be ${INGEST_SCHEMA_VERSION}`);
  const eventId = value["eventId"];
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) return fail("invalid_event_id", "eventId must be 1-64 letters, digits, or ._:- starting with a letter or digit");
  if (seen.has(eventId)) return fail("duplicate_event_id", `eventId ${eventId} appears more than once`);
  const service = value["service"];
  if (typeof service !== "string" || !SERVICE_SLUG.test(service) || service !== options.service) return fail("invalid_service", `service must be ${options.service}`);
  const atMs = value["atMs"];
  if (typeof atMs !== "number" || !Number.isSafeInteger(atMs) || atMs <= 0) return fail("invalid_time", "atMs must be a positive integer");
  if (atMs <= options.nowMs - RETENTION_MS) return fail("expired_event", `atMs is older than the ${RETENTION_MS} ms retention`);
  if (atMs > options.nowMs + MAX_FUTURE_SKEW_MS) return fail("future_event", `atMs is more than ${MAX_FUTURE_SKEW_MS} ms in the future`);
  const operation = value["operation"];
  if (typeof operation !== "string" || !OPERATION.test(operation)) return fail("invalid_operation", "operation must be 1-64 letters, digits, or ._- starting with a lowercase letter");
  const outcome = value["outcome"];
  if (typeof outcome !== "string" || !OUTCOME.test(outcome)) return fail("invalid_outcome", "outcome must be 1-32 lowercase letters, digits, or _- starting with a letter");
  const durationMs = value["durationMs"];
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS) return fail("invalid_duration", `durationMs must be an integer from 0 to ${MAX_DURATION_MS}`);
  const work = workOf(value["work"]);
  if (work === null) return fail("invalid_work", `work must be at most ${MAX_WORK_MEASUREMENTS} lowercase keys with non-negative integer counts`);
  const release = value["release"];
  if (typeof release !== "string" || !RELEASE.test(release)) return fail("invalid_release", "release must be 1-64 letters, digits, or ._:+- starting with a letter or digit");
  const instance = value["instance"];
  if (instance !== undefined && (typeof instance !== "string" || !INSTANCE.test(instance))) return fail("invalid_instance", "instance must be 1-128 letters, digits, or ._:- starting with a letter or digit");
  const host = value["host"];
  if (host !== undefined && (typeof host !== "string" || !HOST.test(host))) return fail("invalid_host", "host must be 1-128 letters, digits, or ._:- starting with a letter or digit");
  const trace = value["trace"];
  if (trace !== undefined && traceOf(trace) === null) return fail("invalid_trace", "trace must hold a nonzero 32-hex traceId and 16-hex spanId");
  const raised = value["error"];
  const error = raised === undefined ? undefined : errorOf(raised);
  if (error === null) return fail("invalid_error", "error must be exactly { code } with 1-64 lowercase letters, digits, or _.- starting with a letter");
  if (error !== undefined && outcome === SUCCESS_OUTCOME) return fail("invalid_error", `error is allowed only when outcome is not ${SUCCESS_OUTCOME}`);
  const delivery = value["delivery"] === undefined ? undefined : deliveryOf(value["delivery"]);
  if (delivery === null || (delivery !== undefined && delivery.atMs > options.nowMs + MAX_FUTURE_SKEW_MS)) return fail("invalid_event", "invalid producer delivery evidence");
  seen.add(eventId);
  return {
    ...(delivery === undefined ? {} : { delivery }),
    schemaVersion: INGEST_SCHEMA_VERSION,
    eventId,
    atMs,
    operation,
    outcome,
    durationMs,
    work,
    release,
    service,
    ...(instance === undefined ? {} : { instance: instance as string }),
    ...(host === undefined ? {} : { host: host as string }),
    ...(trace === undefined ? {} : { trace: trace as ExternalTrace }),
    ...(error === undefined ? {} : { error })
  };
}

export function decodeBatchValue(value: unknown, options: DecodeOptions): ExternalDecode {
  if (!isRecord(value)) return fail("invalid_batch", "body must be an object with events");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "events") return fail("invalid_batch", "body must be an object with only events");
  const raw = value["events"];
  if (!Array.isArray(raw) || raw.length === 0) return fail("invalid_batch", "events must be a non-empty array");
  if (raw.length > MAX_EVENTS) return fail("too_many_events", `events must hold at most ${MAX_EVENTS} entries`);
  const seen = new Set<string>();
  const events: ExternalEvent[] = [];
  for (const item of raw) {
    const event = eventOf(item, options, seen);
    if (!("schemaVersion" in event)) return event;
    events.push(event);
  }
  return { ok: true, batch: { events } };
}

export function decodeBatch(text: string, options: DecodeOptions): ExternalDecode {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("invalid_json", "body is not valid JSON");
  }
  return decodeBatchValue(value, options);
}

function plainEvent(event: ExternalEvent): Record<string, unknown> {
  return {
    ...(event.delivery === undefined ? {} : { delivery: { id: event.delivery.id, sequence: event.delivery.sequence, accepted: event.delivery.accepted, dropped: event.delivery.dropped, queued: event.delivery.queued, startedAtMs: event.delivery.startedAtMs, atMs: event.delivery.atMs } }),
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    atMs: event.atMs,
    operation: event.operation,
    outcome: event.outcome,
    durationMs: event.durationMs,
    work: Object.fromEntries(Object.keys(event.work).sort().map(key => [key, event.work[key]!])),
    release: event.release,
    service: event.service,
    ...(event.instance === undefined ? {} : { instance: event.instance }),
    ...(event.host === undefined ? {} : { host: event.host }),
    ...(event.trace === undefined ? {} : { trace: { traceId: event.trace.traceId, spanId: event.trace.spanId } }),
    ...(event.error === undefined ? {} : { error: { code: event.error.code } })
  };
}

export function encodeEvent(event: ExternalEvent): string {
  return JSON.stringify(plainEvent(event));
}

export function encodeBatch(batch: ExternalBatch): string {
  return JSON.stringify({ events: batch.events.map(plainEvent) });
}
