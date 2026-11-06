import { OBSERVE_CHANNEL, OPERATION_IDS, SAMPLE_REJECTIONS, WORKLOAD_CLASS, type OperationId, type OperationSummary, type RowAccount } from "../producer/channel.ts";
import type { ServicePolicy } from "../core/policies.ts";
import { isFailedInvocation, NO_SUMMARY_TOTALS, OTHER_ROUTE, prepareInvocation, rejection, summaryTotals, VERSION, type CountDelta, type ServiceOperationReading, type ExcludedOutcome, type InvocationKind, type MessagePolicy, type OutcomeClass, type OutcomeEvent, type Preparation, type ObservedError, type ObservedInvocation, type Stage, type TraceContext } from "../core/model.ts";
import { MAX_LABEL_BYTES } from "../core/limits.ts";
import { addCount, countBucket } from "../core/counts.ts";
import { keepReason } from "../core/sampling.ts";
import type { AlwaysKeptCap } from "../core/always-kept-cap.ts";

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
  const eventAtMs = item.eventTimestamp;
  if (stage === null || eventAtMs === null) return REJECTED;
  const entry = describeEvent(item.event, stage, item.entrypoint ?? "Object", policy);
  if (entry === null) return REJECTED;
  if (!("excluded" in entry)) return observe(item, stage, entry, eventAtMs, policy);
  if (entry.unmatched === null || !carriesFailure(item, entry.unmatched.status)) return { kind: "excluded", outcome: entry.excluded, stage, route: entry.route };
  return observe(item, stage, entry.unmatched, eventAtMs, policy);
}

function carriesFailure(item: TailItem, status: number | null): boolean {
  if (item.exceptions.length > 0 || (status !== null && status >= 500)) return true;
  return item.diagnosticsChannelEvents.some(event => event.channel === OBSERVE_CHANNEL && field(event.message, "kind") === "error");
}

function observe(item: TailItem, stage: Stage, entry: Entry, eventAtMs: number, policy: ServicePolicy): Reduction {
  const channel = readChannel(item.diagnosticsChannelEvents, policy);
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
      eventAtMs,
      trace: channel.trace,
      ...(channel.operation === null ? {} : { operation: channel.operation }),
      ...(policy.sampling.kind === "sampled" && channel.serviceOperation !== null ? { serviceOperation: channel.serviceOperation } : {}),
      errors: [...uncaught, ...channel.errors]
    }
  };
}

function versionOf(item: TailItem): string {
  const version = item.scriptVersion?.id;
  return version !== undefined && VERSION.test(version) ? version : "";
}

export function outcomeOf(item: TailItem, outcome: OutcomeClass, route: string, stage = stageOf(item)): OutcomeEvent {
  return { version: versionOf(item), stage: stage ?? "unknown", outcome, route, eventAtMs: item.eventTimestamp };
}

export interface TailBatch {
  readonly preparations: Preparation[];
  readonly outcomes: OutcomeEvent[];
  readonly counts: CountDelta[];
}

function excludedCount(item: TailItem, reduction: Extract<Reduction, { kind: "excluded" }>, nowMs: number): CountDelta {
  return {
    bucketAt: countBucket(item.eventTimestamp ?? nowMs, nowMs), version: versionOf(item), stage: reduction.stage, route: reduction.route, operation: "", outcome: reduction.outcome,
    kept: 0, sampledOut: 1, capped: 0, cpuMsSum: Math.round(item.cpuTime), wallMsSum: Math.round(item.wallTime), ...NO_SUMMARY_TOTALS
  };
}

function rejectedCount(item: TailItem, stage: Stage, nowMs: number): CountDelta {
  return {
    bucketAt: countBucket(item.eventTimestamp ?? nowMs, nowMs), version: versionOf(item), stage, route: OTHER_ROUTE, operation: "", outcome: "rejected-invalid",
    kept: 0, sampledOut: 1, capped: 0, cpuMsSum: 0, wallMsSum: 0, ...NO_SUMMARY_TOTALS
  };
}

function sampledOutCount(invocation: ObservedInvocation, nowMs: number, capped: 0 | 1): CountDelta {
  return {
    bucketAt: countBucket(invocation.eventAtMs, nowMs), version: invocation.version ?? "", stage: invocation.stage, route: invocation.label, operation: invocation.serviceOperation?.name ?? "",
    outcome: isFailedInvocation({ errorCount: invocation.errors.length, status: invocation.status, outcome: invocation.outcome }) ? "failed" : "ok",
    kept: 0, sampledOut: 1, capped, cpuMsSum: invocation.cpuMs, wallMsSum: invocation.wallMs, ...summaryTotals(invocation.serviceOperation)
  };
}

export async function prepareTailItems(items: readonly TailItem[], policy: ServicePolicy, nowMs: number, cap: AlwaysKeptCap): Promise<TailBatch> {
  const preparations: Preparation[] = [];
  const outcomes: OutcomeEvent[] = [];
  const counted = new Map<string, CountDelta>();
  for (const item of items) {
    const reduction = reduceTailItem(item, policy);
    if (reduction.kind === "excluded") {
      if (policy.sampling.kind === "sampled") addCount(counted, excludedCount(item, reduction, nowMs));
      else outcomes.push(outcomeOf(item, reduction.outcome, reduction.route, reduction.stage));
      continue;
    }
    if (reduction.kind === "rejected") {
      const stage = stageOf(item);
      if (policy.sampling.kind === "sampled" && stage !== null && !cap.admit(countBucket(item.eventTimestamp ?? nowMs, nowMs))) {
        addCount(counted, rejectedCount(item, stage, nowMs));
        continue;
      }
      preparations.push({ ok: false, reason: "invalid_event" });
      outcomes.push(outcomeOf(item, "rejected-invalid", OTHER_ROUTE));
      continue;
    }
    const reason = keepReason(reduction.invocation, policy.sampling);
    if (rejection(reduction.invocation) === null) {
      if (reason === null) {
        addCount(counted, sampledOutCount(reduction.invocation, nowMs, 0));
        continue;
      }
      if (policy.sampling.kind === "sampled" && reason !== "trace-hash" && !cap.admit(countBucket(reduction.invocation.eventAtMs, nowMs))) {
        addCount(counted, sampledOutCount(reduction.invocation, nowMs, 1));
        continue;
      }
    } else if (policy.sampling.kind === "sampled" && !cap.admit(countBucket(reduction.invocation.eventAtMs, nowMs))) {
      addCount(counted, rejectedCount(item, reduction.invocation.stage, nowMs));
      continue;
    }
    const preparation = await prepareInvocation(reduction.invocation, POLICY);
    preparations.push(preparation);
    if (!preparation.ok) outcomes.push(outcomeOf(item, "rejected-invalid", routeLabel(reduction.invocation.label)));
  }
  return { preparations, outcomes, counts: [...counted.values()] };
}

interface Entry {
  readonly kind: InvocationKind;
  readonly label: string;
  readonly status: number | null;
}

interface Excluded {
  readonly excluded: ExcludedOutcome;
  readonly route: string;
  readonly unmatched: Entry | null;
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
    if (status !== null && EXCLUDED_STATUSES.has(status)) return { excluded: `excluded-status:${status}` as ExcludedOutcome, route: routeLabel(label), unmatched: null };
    if (path === null) return null;
    if (label !== null) return { kind: "fetch", label, status };
    return { excluded: "excluded-route", route: OTHER_ROUTE, unmatched: stage === "worker" ? { kind: "fetch", label: `${method} unmatched`, status } : null };
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

function readChannel(events: TailItem["diagnosticsChannelEvents"], policy: ServicePolicy): { trace: TraceContext | null; operation: OperationSummary | null; serviceOperation: ServiceOperationReading | null; errors: ObservedError[] } | null {
  let trace: TraceContext | null = null;
  let summary: OperationSummary | null = null;
  let serviceOperation: ServiceOperationReading | null = null;
  let operationSeen = false;
  const errors: ObservedError[] = [];
  const ownSpan = markedSpan(events);
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
      if (traceId === null || spanId === null) return null;
      if (ownSpan !== null && spanId !== ownSpan) continue;
      if (operationSeen) return null;
      if (policy.operationMessages === "stats") {
        summary = readOperation(message);
        if (summary === null) return null;
      } else {
        serviceOperation = readServiceOperation(message, policy.operations);
        if (serviceOperation === null) return null;
      }
      trace ??= { traceId, spanId };
      operationSeen = true;
    } else if (kind === "error") {
      const operation = field(message, "operation");
      const name = text(field(message, "name"));
      const errorMessage = text(field(message, "message"));
      const stack = field(message, "stack");
      if (typeof operation !== "string" || !policy.operations.has(operation) || name === null || errorMessage === null || (stack !== null && typeof stack !== "string")) return null;
      errors.push({ source: "caught", operation, name, message: errorMessage, stack });
    } else {
      return null;
    }
  }
  return { trace, operation: summary, serviceOperation, errors };
}

function markedSpan(events: TailItem["diagnosticsChannelEvents"]): string | null {
  for (const event of events) {
    if (event.channel === OBSERVE_CHANNEL && field(event.message, "kind") === "invocation") return text(field(event.message, "spanId"));
  }
  return null;
}

function readServiceOperation(message: unknown, operations: ReadonlySet<string>): ServiceOperationReading | null {
  const operation = field(message, "operation");
  const rowsField = field(message, "rows");
  const lagField = field(message, "workLagMs");
  if (typeof operation !== "string" || !operations.has(operation) || typeof field(message, "synthetic") !== "boolean") return null;
  const rows = rowsField === null ? null : readRows(rowsField);
  if (rowsField !== null && rows === null) return null;
  const [workLagMs] = counts(message, ["workLagMs"]);
  if (lagField !== undefined && workLagMs === undefined) return null;
  return { name: operation, rows, workLagMs: workLagMs ?? null };
}

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
      const codes = counts(rejected, SAMPLE_REJECTIONS);
      if (received === undefined || persisted === undefined || duplicate === undefined || inputBytes === undefined || codes.includes(undefined) || hasExtra(rejected, SAMPLE_REJECTIONS)) return null;
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
