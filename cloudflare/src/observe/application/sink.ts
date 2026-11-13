import type { OperationSummary } from "../producer/channel.ts";
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
  for (const [key, value] of Object.entries(summary)) {
    if (key === "rows" || key === "operation" || key === "synthetic" || key === "durationMs" || key === "workloadClass" || key === "work") continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) visit(value, "");
  }
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

export function applicationEventOperations(options: ApplicationEventSinkOptions): OperationSink {
  return {
    invocation: () => {},
    operation: summary => {
      const event = toApplicationEvent(summary, options);
      const promise = options.post({ events: [event] }).then(ok => { if (!ok) console.error(JSON.stringify({ event: "application_event_failed", message: "ingest did not accept the event" })); return ok; });
      if (options.waitUntil !== undefined) options.waitUntil(promise);
      void promise.catch((error: unknown) => console.error(JSON.stringify({ event: "application_event_failed", message: error instanceof Error ? error.message : String(error) })));
    }
  };
}
