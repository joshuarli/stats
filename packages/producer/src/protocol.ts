export const SCHEMA_VERSION = 1;
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_EVENTS = 128;
export const MAX_WORK_MEASUREMENTS = 16;
export const MAX_DURATION_MS = 86_400_000;
export const MAX_WORK_VALUE = 1_000_000_000_000;

export const SERVICE = /^[a-z][a-z0-9-]{0,31}$/u;
export const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
export const OPERATION = /^[a-z][A-Za-z0-9_.-]{0,63}$/u;
export const OUTCOME = /^[a-z][a-z0-9_-]{0,31}$/u;
export const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/u;
export const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const WORK_KEY = /^[a-z][a-z0-9_]{0,31}$/u;
export const TRACE_ID = /^(?!0{32})[0-9a-f]{32}$/u;
export const SPAN_ID = /^(?!0{16})[0-9a-f]{16}$/u;
export const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/u;
export const SUCCESS_OUTCOME = "ok";

export interface Trace {
  readonly traceId: string;
  readonly spanId: string;
}

export interface EventError {
  readonly code: string;
}

export interface ProducerDelivery {
  readonly id: string;
  readonly sequence: number;
  readonly accepted: number;
  readonly dropped: number;
  readonly queued: number;
  readonly startedAtMs: number;
  readonly atMs: number;
}

export interface OperationEvent {
  readonly delivery?: ProducerDelivery;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly eventId: string;
  readonly atMs: number;
  readonly operation: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly work: Readonly<Record<string, number>>;
  readonly release: string;
  readonly service: string;
  readonly instance?: string;
  readonly host?: string;
  readonly trace?: Trace;
  readonly error?: EventError;
}

export function workOf(value: Readonly<Record<string, number>>): Readonly<Record<string, number>> | null {
  const keys = Object.keys(value);
  if (keys.length > MAX_WORK_MEASUREMENTS) return null;
  const work: Record<string, number> = {};
  for (const key of keys) {
    const count = value[key];
    if (!WORK_KEY.test(key) || count === undefined || !Number.isSafeInteger(count) || count < 0 || count > MAX_WORK_VALUE) return null;
    work[key] = count;
  }
  return Object.fromEntries(Object.keys(work).sort().map(key => [key, work[key]!]));
}

function plainEvent(event: OperationEvent): Record<string, unknown> {
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

export function encodeEvent(event: OperationEvent): string {
  return JSON.stringify(plainEvent(event));
}

export function encodeBatch(events: readonly OperationEvent[]): string {
  return JSON.stringify({ events: events.map(plainEvent) });
}
