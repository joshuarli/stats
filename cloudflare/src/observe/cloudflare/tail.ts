import { OBSERVE_CHANNEL, OPERATION_IDS, WORKLOAD_CLASS, type OperationId, type OperationSummary, type RowAccount } from "../producer/channel.ts";
import type { ServicePolicy } from "./policies.ts";
import { OTHER_ROUTE, prepareInvocation, VERSION, type InvocationKind, type MessagePolicy, type OutcomeClass, type OutcomeEvent, type Preparation, type ObservedError, type ObservedInvocation, type Stage, type TraceContext } from "../core/model.ts";
import { MAX_LABEL_BYTES } from "../core/limits.ts";

export interface TailItem {
  readonly event: unknown;
  readonly eventTimestamp: number | null;
  readonly exceptions: readonly { readonly name: string; readonly message: string; readonly stack?: string }[];
  readonly diagnosticsChannelEvents: readonly { readonly channel: string; readonly message: unknown }[];
  readonly scriptName?: string | null;
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
  | { readonly kind: "excluded"; readonly outcome: ExcludedOutcome; readonly stage: Stage; readonly route: string }
  | { readonly kind: "rejected" };

export type ExcludedOutcome = "excluded-status:401" | "excluded-status:403" | "excluded-status:404" | "excluded-route";

const POLICY: MessagePolicy = { safeNames: new Set() };
const EXCLUDED_STATUSES = new Set([401, 403, 404]);
const METHOD = /^[A-Z]{3,7}$/u;
const RPC_METHOD = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const CRON = /^[0-9*/,\- ]{1,64}$/u;
const REJECTED: Reduction = { kind: "rejected" };

export function stageOf(item: Pick<TailItem, "executionModel">): Stage | null {
  return item.executionModel === "stateless" ? "worker" : item.executionModel === "durableObject" ? "object" : null;
}

export function reduceTailItem(item: TailItem, policy: ServicePolicy): Reduction {
  const stage = stageOf(item);
  if (stage === null || item.eventTimestamp === null) return REJECTED;
  const entry = describeEvent(item.event, stage, item.entrypoint ?? "Object", policy);
  if (entry === null) return REJECTED;
  if ("excluded" in entry) return { kind: "excluded", outcome: entry.excluded, stage, route: entry.route };
  const channel = readChannel(item.diagnosticsChannelEvents, policy.operations);
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
      ...(channel.operation === null ? {} : { operation: channel.operation }),
      errors: [...uncaught, ...channel.errors]
    }
  };
}

export function outcomeOf(item: TailItem, outcome: OutcomeClass, route: string, stage = stageOf(item)): OutcomeEvent {
  const version = item.scriptVersion?.id;
  return { version: version !== undefined && VERSION.test(version) ? version : "", stage: stage ?? "unknown", outcome, route, eventAtMs: item.eventTimestamp };
}

export async function prepareTailItems(items: readonly TailItem[], policy: ServicePolicy): Promise<{ preparations: Preparation[]; outcomes: OutcomeEvent[] }> {
  const preparations: Preparation[] = [];
  const outcomes: OutcomeEvent[] = [];
  for (const item of items) {
    const reduction = reduceTailItem(item, policy);
    if (reduction.kind === "excluded") {
      outcomes.push(outcomeOf(item, reduction.outcome, reduction.route, reduction.stage));
      continue;
    }
    if (reduction.kind === "rejected") {
      preparations.push({ ok: false, reason: "invalid_event" });
      outcomes.push(outcomeOf(item, "rejected-invalid", OTHER_ROUTE));
      continue;
    }
    const preparation = await prepareInvocation(reduction.invocation, POLICY);
    preparations.push(preparation);
    if (!preparation.ok) outcomes.push(outcomeOf(item, "rejected-invalid", routeLabel(reduction.invocation.label)));
  }
  return { preparations, outcomes };
}

interface Entry {
  readonly kind: InvocationKind;
  readonly label: string;
  readonly status: number | null;
}

interface Excluded {
  readonly excluded: ExcludedOutcome;
  readonly route: string;
}

function describeEvent(event: unknown, stage: Stage, entrypoint: string, policy: ServicePolicy): Entry | Excluded | null {
  const request = field(event, "request");
  if (request !== undefined) {
    const url = text(field(request, "url"));
    const method = text(field(request, "method"));
    if (url === null || method === null || !METHOD.test(method)) return null;
    const statusValue = field(field(event, "response"), "status");
    const status = typeof statusValue === "number" ? statusValue : null;
    const path = pathOf(url);
    const route = path === null ? null : stage === "worker" ? policy.workerRoute(path) : policy.objectRoute(path);
    const label = route === null ? null : stage === "worker" ? `${method} ${route}` : `${entrypoint} ${method} ${route}`;
    if (status !== null && EXCLUDED_STATUSES.has(status)) return { excluded: `excluded-status:${status}` as ExcludedOutcome, route: routeLabel(label) };
    if (path === null) return null;
    return label === null ? { excluded: "excluded-route", route: OTHER_ROUTE } : { kind: "fetch", label, status };
  }
  const rpcMethod = text(field(event, "rpcMethod"));
  if (rpcMethod !== null) return RPC_METHOD.test(rpcMethod) ? { kind: "rpc", label: `${entrypoint}.${rpcMethod}`, status: null } : null;
  if (field(event, "scheduledTime") === undefined) return null;
  const cron = text(field(event, "cron"));
  if (cron !== null) return CRON.test(cron) ? { kind: "scheduled", label: `scheduled ${cron}`, status: null } : null;
  return { kind: "alarm", label: `${entrypoint}.alarm`, status: null };
}

export function routeLabel(label: string | null): string {
  return label === null || label.length > MAX_LABEL_BYTES ? OTHER_ROUTE : label;
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function readChannel(events: TailItem["diagnosticsChannelEvents"], operations: ReadonlySet<string>): { trace: TraceContext | null; operation: OperationSummary | null; errors: ObservedError[] } | null {
  let trace: TraceContext | null = null;
  let summary: OperationSummary | null = null;
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
    } else if (kind === "operation") {
      const traceId = text(field(message, "traceId"));
      const spanId = text(field(message, "spanId"));
      const parsed = readOperation(message);
      if (traceId === null || spanId === null || parsed === null || summary !== null) return null;
      trace ??= { traceId, spanId };
      summary = parsed;
    } else if (kind === "error") {
      const operation = field(message, "operation");
      const name = text(field(message, "name"));
      const errorMessage = text(field(message, "message"));
      const stack = field(message, "stack");
      if (typeof operation !== "string" || !operations.has(operation) || name === null || errorMessage === null || (stack !== null && typeof stack !== "string")) return null;
      errors.push({ source: "caught", operation, name, message: errorMessage, stack });
    } else {
      return null;
    }
  }
  return { trace, operation: summary, errors };
}

const REJECTION_CODES = ["invalid_sample", "too_old", "conflict"] as const;

function readOperation(message: unknown): OperationSummary | null {
  const id = field(message, "operation");
  const synthetic = field(message, "synthetic");
  const rows = readRows(field(message, "rows"));
  const work = field(message, "work");
  if (typeof id !== "string" || !(OPERATION_IDS as readonly string[]).includes(id) || typeof synthetic !== "boolean" || rows === null) return null;
  const common = { synthetic, rows };
  switch (id as OperationId) {
    case "host.ingest": {
      const rejected = field(work, "rejected");
      const [received, persisted, duplicate, inputBytes] = counts(work, ["received", "persisted", "duplicate", "inputBytes"]);
      const codes = counts(rejected, REJECTION_CODES);
      if (received === undefined || persisted === undefined || duplicate === undefined || inputBytes === undefined || codes.includes(undefined) || hasExtra(rejected, REJECTION_CODES)) return null;
      const [invalidSample, tooOld, conflict] = codes as [number, number, number];
      return { ...common, operation: "host.ingest", work: { received, persisted, duplicate, rejected: { invalid_sample: invalidSample, too_old: tooOld, conflict }, inputBytes } };
    }
    case "host.history":
    case "project.history": {
      const workloadClass = field(message, "workloadClass");
      const cache = field(work, "cache");
      const [points, cells, outputBytes] = counts(work, ["points", "cells", "outputBytes"]);
      if (typeof workloadClass !== "string" || !WORKLOAD_CLASS.test(workloadClass) || (cache !== "hit-304" && cache !== "rebuilt") || points === undefined || cells === undefined || outputBytes === undefined) return null;
      return { ...common, operation: id as "host.history" | "project.history", workloadClass, work: { points, cells, outputBytes, cache } };
    }
    case "collector.record": {
      const [runs, metricRows, hourRollups, upstreamQueries] = counts(work, ["runs", "metricRows", "hourRollups", "upstreamQueries"]);
      if (runs === undefined || metricRows === undefined || hourRollups === undefined || upstreamQueries === undefined) return null;
      return { ...common, operation: "collector.record", work: { runs, metricRows, hourRollups, upstreamQueries } };
    }
    case "cleanup.retention": {
      const [expired, backlog] = counts(work, ["expired", "backlog"]);
      if (expired === undefined || backlog === undefined) return null;
      return { ...common, operation: "cleanup.retention", work: { expired, backlog } };
    }
    case "deployments.poll":
      return work === undefined ? { ...common, operation: "deployments.poll" } : null;
  }
}

function readRows(value: unknown): RowAccount | null {
  const [read, written, statements] = counts(value, ["read", "written", "statements"]);
  return read === undefined || written === undefined || statements === undefined ? null : { read, written, statements };
}

function counts(value: unknown, keys: readonly string[]): (number | undefined)[] {
  return keys.map(key => {
    const count = field(value, key);
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  });
}

function hasExtra(value: unknown, keys: readonly string[]): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).some(key => !keys.includes(key));
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
