import { diagnosticsOf } from "../ingest/codec.ts";
import { ERROR_CODE } from "../ingest/model.ts";
import type { ErrorReport, OperationSummary } from "../producer/channel.ts";
import type { OperationSink } from "../../operations.ts";
import type { ExternalEvent } from "../ingest/model.ts";

export const APPLICATION_EVENTS_SERVICE = "stats";

export interface ApplicationEventSinkOptions {
  readonly post: (body: { readonly events: readonly ExternalEvent[] }) => Promise<boolean>;
  readonly now: () => number;
  readonly release: string;
  readonly service?: string;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase().replaceAll(".", "_");
}

function workFields(summary: OperationSummary): Record<string, number> {
  const work: Record<string, number> = {
    sql_rows_read: summary.rows.read,
    sql_rows_written: summary.rows.written,
    sql_statements: summary.rows.statements
  };
  const visit = (value: unknown, prefix: string): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (Object.keys(work).length >= 16) return;
      if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 && entry <= 1e12) work[snake(prefix === "" ? key : `${prefix}_${key}`)] = entry;
      else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) visit(entry, key);
    }
  };
  if ("work" in summary && summary.work !== undefined) visit(summary.work, "");
  return work;
}

export function toApplicationEvent(summary: OperationSummary, options: ApplicationEventSinkOptions): ExternalEvent {
  return {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    atMs: options.now(),
    operation: summary.operation,
    outcome: "ok",
    durationMs: summary.durationMs ?? 0,
    work: workFields(summary),
    release: options.release,
    service: options.service ?? APPLICATION_EVENTS_SERVICE
  };
}

export function postApplicationEvent(event: ExternalEvent, options: ApplicationEventSinkOptions): void {
  const promise = Promise.resolve().then(() => options.post({ events: [event] })).then(ok => {
    if (!ok) console.error(JSON.stringify({ event: "application_event_failed" }));
  }).catch(() => { console.error(JSON.stringify({ event: "application_event_failed" })); });
  if (options.waitUntil !== undefined) options.waitUntil(promise);
}

export function applicationEventErrorReporter(options: ApplicationEventSinkOptions): (message: unknown) => void {
  return message => {
    if (typeof message !== "object" || message === null || !("kind" in message) || message.kind !== "error") return;
    const report = message as ErrorReport<string>;
    if (typeof report.operation !== "string" || !ERROR_CODE.test(report.operation) || typeof report.name !== "string" || typeof report.message !== "string" || (report.stack !== null && typeof report.stack !== "string")) return;
    const diagnostics = diagnosticsOf({ version: 1, name: report.name, message: report.message, frames: report.stack?.split("\n") ?? [] });
    if (diagnostics === null) return;
    postApplicationEvent({ schemaVersion: 1, eventId: crypto.randomUUID(), atMs: options.now(), operation: report.operation, outcome: "error", durationMs: 0, work: {}, release: options.release, service: options.service ?? APPLICATION_EVENTS_SERVICE, error: { code: report.operation }, diagnostics }, options);
  };
}

export function applicationEventOperations(options: ApplicationEventSinkOptions): OperationSink {
  return {
    invocation: () => {},
    operation: summary => postApplicationEvent(toApplicationEvent(summary, options), options)
  };
}
