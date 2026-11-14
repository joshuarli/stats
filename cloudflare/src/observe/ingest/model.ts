export const INGEST_SCHEMA_VERSION = 1;
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_EVENTS = 128;
export const MAX_WORK_MEASUREMENTS = 16;
export const MAX_BATCHES_PER_WINDOW = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_DURATION_MS = 86_400_000;
export const MAX_WORK_VALUE = 1_000_000_000_000;
export const PROVENANCE = "application";

export const SERVICE_SLUG = /^[a-z][a-z0-9-]{0,31}$/u;
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

export interface ExternalTrace {
  readonly traceId: string;
  readonly spanId: string;
}

export interface ExternalError {
  readonly code: string;
}

export interface ExternalDiagnostics {
  readonly version: 1;
  readonly name: string;
  readonly message: string;
  readonly frames: readonly string[];
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

export interface ExternalEvent {
  readonly delivery?: ProducerDelivery;
  readonly schemaVersion: typeof INGEST_SCHEMA_VERSION;
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
  readonly trace?: ExternalTrace;
  readonly error?: ExternalError;
  readonly diagnostics?: ExternalDiagnostics;
}

export interface ApplicationFailure {
  readonly fingerprint: string;
  readonly invocationKey: string;
  readonly code: string;
  readonly prepared?: import("../core/model.ts").PreparedError;
}

export interface ReceivedEvent {
  readonly event: ExternalEvent;
  readonly failure: ApplicationFailure | null;
}

export interface ExternalBatch {
  readonly events: readonly ExternalEvent[];
}

export interface ExternalEventRecord {
  readonly eventId: string;
  readonly service: string;
  readonly receivedAtMs: number;
  readonly provenance: typeof PROVENANCE;
  readonly event: ExternalEvent;
}

export interface ExternalFilter {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly limit?: number;
}

export type ExternalDecodeCode =
  | "invalid_json"
  | "invalid_batch"
  | "too_many_events"
  | "invalid_event"
  | "invalid_schema_version"
  | "invalid_event_id"
  | "duplicate_event_id"
  | "invalid_time"
  | "expired_event"
  | "future_event"
  | "invalid_operation"
  | "invalid_outcome"
  | "invalid_duration"
  | "invalid_work"
  | "invalid_release"
  | "invalid_service"
  | "invalid_instance"
  | "invalid_host"
  | "invalid_trace"
  | "invalid_error";

export type ExternalDecode =
  | { readonly ok: true; readonly batch: ExternalBatch }
  | { readonly ok: false; readonly code: ExternalDecodeCode; readonly message: string };

export type ExternalIngest =
  | { readonly ok: true; readonly accepted: number; readonly duplicate: number }
  | { readonly ok: false; readonly code: "rate_limited" | "event_conflict" };
