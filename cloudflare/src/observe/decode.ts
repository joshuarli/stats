import type { Health, InvocationSummary, IssueState, IssueSummary, Occurrence, Page, TraceDetail, TraceSummary } from "./core/store.ts";
import type { StackFrame } from "./core/stack.ts";
import type { ErrorSource, InvocationKind, Stage } from "./core/model.ts";

export interface ObserveHealth extends Health {
  readonly databaseBytes: number;
}

type Fields = Record<string, unknown>;

function fail(what: string): never {
  throw new Error(`invalid observability response: ${what}`);
}

function record(value: unknown, what: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(what);
  return value as Fields;
}

function text(value: unknown, what: string, limit = 4096): string {
  if (typeof value !== "string" || value.length > limit) fail(what);
  return value;
}

function nullableText(value: unknown, what: string, limit = 4096): string | null {
  return value === null ? null : text(value, what, limit);
}

function integer(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(what);
  return value;
}

function nullableInteger(value: unknown, what: string): number | null {
  return value === null ? null : integer(value, what);
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") fail(what);
  return value;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], what: string): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) fail(what);
  return value as T;
}

function list<T>(value: unknown, limit: number, decode: (item: unknown) => T, what: string): T[] {
  if (!Array.isArray(value) || value.length > limit) fail(what);
  return value.map(decode);
}

function page<T>(value: unknown, decode: (item: unknown) => T, what: string): Page<T> {
  const fields = record(value, what);
  return { items: list(fields["items"], 100, decode, `${what} items`), next: nullableText(fields["next"], `${what} cursor`, 128) };
}

const STAGES: readonly Stage[] = ["worker", "object"];
const KINDS: readonly InvocationKind[] = ["fetch", "rpc", "alarm", "scheduled"];
const SOURCES: readonly ErrorSource[] = ["uncaught", "caught"];
const STATES: readonly IssueState[] = ["open", "resolved"];

function frame(value: unknown): StackFrame {
  const fields = record(value, "frame");
  return { fn: nullableText(fields["fn"], "frame function", 512), file: text(fields["file"], "frame file", 512), line: integer(fields["line"], "frame line"), column: integer(fields["column"], "frame column") };
}

function invocation(value: unknown): InvocationSummary {
  const fields = record(value, "invocation");
  return {
    key: text(fields["key"], "invocation key", 64),
    traceId: nullableText(fields["traceId"], "trace id", 32),
    stage: oneOf(fields["stage"], STAGES, "stage"),
    kind: oneOf(fields["kind"], KINDS, "kind"),
    label: text(fields["label"], "label", 128),
    objectId: nullableText(fields["objectId"], "object id", 64),
    status: nullableInteger(fields["status"], "status"),
    outcome: text(fields["outcome"], "outcome", 32),
    failed: bool(fields["failed"], "failed"),
    cpuMs: integer(fields["cpuMs"], "cpu"),
    wallMs: integer(fields["wallMs"], "wall"),
    atMs: integer(fields["atMs"], "time"),
    version: nullableText(fields["version"], "version", 36),
    errorCount: integer(fields["errorCount"], "error count")
  };
}

function occurrence(value: unknown): Occurrence {
  const fields = record(value, "occurrence");
  return {
    id: integer(fields["id"], "occurrence id"),
    invocationKey: text(fields["invocationKey"], "occurrence invocation", 64),
    traceId: nullableText(fields["traceId"], "occurrence trace", 32),
    atMs: integer(fields["atMs"], "occurrence time"),
    version: nullableText(fields["version"], "occurrence version", 36),
    source: oneOf(fields["source"], SOURCES, "occurrence source"),
    operation: nullableText(fields["operation"], "occurrence operation", 64),
    name: text(fields["name"], "occurrence name", 128),
    message: nullableText(fields["message"], "occurrence message", 512),
    frames: list(fields["frames"], 32, frame, "frames")
  };
}

export function decodeTraces(value: unknown): Page<TraceSummary> {
  return page(value, item => {
    const fields = record(item, "trace");
    return { ...invocation(item), objectInvocations: integer(fields["objectInvocations"], "object invocations"), objectCpuMs: integer(fields["objectCpuMs"], "object cpu") };
  }, "traces");
}

export function decodeTrace(value: unknown, traceId: string): TraceDetail {
  const fields = record(value, "trace detail");
  if (fields["traceId"] !== traceId) fail("trace id mismatch");
  return {
    traceId,
    rootPresent: bool(fields["rootPresent"], "root present"),
    truncated: bool(fields["truncated"], "truncated"),
    invocations: list(fields["invocations"], 16, invocation, "invocations"),
    occurrences: list(fields["occurrences"], 64, occurrence, "occurrences")
  };
}

export function decodeIssues(value: unknown): Page<IssueSummary> {
  return page(value, item => {
    const fields = record(item, "issue");
    return {
      fingerprint: text(fields["fingerprint"], "fingerprint", 64),
      name: text(fields["name"], "issue name", 128),
      operation: nullableText(fields["operation"], "issue operation", 64),
      frame: nullableText(fields["frame"], "issue frame", 1024),
      state: oneOf(fields["state"], STATES, "issue state"),
      occurrences: integer(fields["occurrences"], "occurrences"),
      firstAtMs: integer(fields["firstAtMs"], "first seen"),
      lastAtMs: integer(fields["lastAtMs"], "last seen"),
      lastVersion: nullableText(fields["lastVersion"], "last version", 36),
      versions: integer(fields["versions"], "versions")
    };
  }, "issues");
}

export function decodeOccurrences(value: unknown): Page<Occurrence> {
  return page(value, occurrence, "occurrences");
}

export function decodeHealth(value: unknown): ObserveHealth {
  const fields = record(value, "health");
  const counter = (key: string) => integer(fields[key], key);
  return {
    newestAtMs: nullableInteger(fields["newestAtMs"], "newest"),
    oldestAtMs: nullableInteger(fields["oldestAtMs"], "oldest"),
    liveInvocations: counter("liveInvocations"),
    cleanupBacklog: counter("cleanupBacklog"),
    cleanupLagMs: counter("cleanupLagMs"),
    openIssues: counter("openIssues"),
    duplicate: counter("duplicate"),
    conflict: counter("conflict"),
    expired: counter("expired"),
    future: counter("future"),
    rejected: counter("rejected"),
    issueCapacity: counter("issueCapacity"),
    evicted: counter("evicted"),
    databaseBytes: counter("databaseBytes")
  };
}
