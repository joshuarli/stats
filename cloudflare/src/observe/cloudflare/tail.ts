import { OBSERVE_CHANNEL, OPERATIONS, type Operation } from "../producer/channel.ts";
import type { InvocationKind, ObservedError, ObservedInvocation, Stage, TraceContext } from "../core/model.ts";

export interface TailItem {
  readonly event: unknown;
  readonly eventTimestamp: number | null;
  readonly exceptions: readonly { readonly name: string; readonly message: string; readonly stack?: string }[];
  readonly diagnosticsChannelEvents: readonly { readonly channel: string; readonly message: unknown }[];
  readonly scriptVersion?: { readonly id?: string };
  readonly durableObjectId?: string;
  readonly entrypoint?: string;
  readonly executionModel: string;
  readonly outcome: string;
  readonly cpuTime: number;
  readonly wallTime: number;
}

export type Reduction =
  | { readonly kind: "observed"; readonly invocation: ObservedInvocation }
  | { readonly kind: "excluded" }
  | { readonly kind: "rejected" };

const EXCLUDED_STATUSES = new Set([401, 403, 404]);
const HOST_ID = /^h_[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const METHOD = /^[A-Z]{3,7}$/u;
const RPC_METHOD = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const CRON = /^[0-9*/,\- ]{1,64}$/u;
const OPERATION_SET: ReadonlySet<string> = new Set(OPERATIONS);
const EXCLUDED: Reduction = { kind: "excluded" };
const REJECTED: Reduction = { kind: "rejected" };

export function reduceTailItem(item: TailItem): Reduction {
  const stage: Stage | null = item.executionModel === "stateless" ? "worker" : item.executionModel === "durableObject" ? "object" : null;
  if (stage === null || item.eventTimestamp === null) return REJECTED;
  const entry = describeEvent(item.event, stage, item.entrypoint ?? "Object");
  if (entry === null) return REJECTED;
  if (entry === "excluded") return EXCLUDED;
  const channel = readChannel(item.diagnosticsChannelEvents);
  if (channel === null) return REJECTED;
  const uncaught: ObservedError[] = item.exceptions.map(exception => ({ source: "uncaught", operation: null, name: exception.name, message: exception.message, stack: exception.stack ?? null }));
  return {
    kind: "observed",
    invocation: {
      version: item.scriptVersion?.id ?? null,
      stage,
      objectId: stage === "object" ? item.durableObjectId ?? null : null,
      kind: entry.kind,
      label: entry.label,
      status: entry.status,
      outcome: item.outcome,
      cpuMs: Math.round(item.cpuTime),
      wallMs: Math.round(item.wallTime),
      eventAtMs: item.eventTimestamp,
      trace: channel.trace,
      errors: [...uncaught, ...channel.errors]
    }
  };
}

interface Entry {
  readonly kind: InvocationKind;
  readonly label: string;
  readonly status: number | null;
}

function describeEvent(event: unknown, stage: Stage, entrypoint: string): Entry | "excluded" | null {
  const request = field(event, "request");
  if (request !== undefined) {
    const url = text(field(request, "url"));
    const method = text(field(request, "method"));
    if (url === null || method === null || !METHOD.test(method)) return null;
    const statusValue = field(field(event, "response"), "status");
    const status = typeof statusValue === "number" ? statusValue : null;
    if (status !== null && EXCLUDED_STATUSES.has(status)) return "excluded";
    const path = pathOf(url);
    if (path === null) return null;
    const route = stage === "worker" ? workerRoute(path) : objectRoute(path);
    return route === null ? "excluded" : { kind: "fetch", label: stage === "worker" ? `${method} ${route}` : `${entrypoint} ${method} ${route}`, status };
  }
  const rpcMethod = text(field(event, "rpcMethod"));
  if (rpcMethod !== null) return RPC_METHOD.test(rpcMethod) ? { kind: "rpc", label: `${entrypoint}.${rpcMethod}`, status: null } : null;
  if (field(event, "scheduledTime") === undefined) return null;
  const cron = text(field(event, "cron"));
  if (cron !== null) return CRON.test(cron) ? { kind: "scheduled", label: `scheduled ${cron}`, status: null } : null;
  return { kind: "alarm", label: `${entrypoint}.alarm`, status: null };
}

export function workerRoute(path: string): string | null {
  if (path === "/ingest/v1/batches") return path;
  if (path.startsWith("/api/v1/")) return `/api/v1${template(path.slice("/api/v1".length))}`;
  return null;
}

function objectRoute(path: string): string | null {
  return path === "/" ? null : template(path);
}

function template(path: string): string {
  const segments = path.split("/");
  return segments.map((segment, index) => {
    if (HOST_ID.test(segment)) return ":host";
    if (UUID.test(segment)) return ":id";
    if (index > 0 && segments[index - 1] === "projects") return ":project";
    return segment;
  }).join("/");
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function readChannel(events: TailItem["diagnosticsChannelEvents"]): { trace: TraceContext | null; errors: ObservedError[] } | null {
  let trace: TraceContext | null = null;
  const errors: ObservedError[] = [];
  for (const event of events) {
    if (event.channel !== OBSERVE_CHANNEL) continue;
    const message = event.message;
    const kind = field(message, "kind");
    if (kind === "invocation") {
      const traceId = text(field(message, "traceId"));
      const spanId = text(field(message, "spanId"));
      if (traceId === null || spanId === null) return null;
      trace ??= { traceId, spanId };
    } else if (kind === "error") {
      const operation = field(message, "operation");
      const name = text(field(message, "name"));
      const errorMessage = text(field(message, "message"));
      const stack = field(message, "stack");
      if (!isOperation(operation) || name === null || errorMessage === null || (stack !== null && typeof stack !== "string")) return null;
      errors.push({ source: "caught", operation, name, message: errorMessage, stack });
    } else {
      return null;
    }
  }
  return { trace, errors };
}

function isOperation(value: unknown): value is Operation {
  return typeof value === "string" && OPERATION_SET.has(value);
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
