import { HEALTH_COUNTERS, type HealthReason } from "../core/store.ts";
import type { Exploration, Health, Heatmap, ImpactState, RouteStats, InvocationSummary, IssueRef, IssueState, IssueSummary, Occurrence, Page, RolloutImpact, TraceDetail, TraceSummary, VersionStats } from "../core/store.ts";
import type { OriginalPosition, SymbolicatedFrame } from "../core/stack.ts";
import type { ErrorSource, InvocationKind, Stage } from "../core/model.ts";

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

function original(value: unknown): OriginalPosition | null {
  if (value === null) return null;
  const fields = record(value, "original position");
  return { fn: nullableText(fields["fn"], "original function", 512), file: text(fields["file"], "original file", 512), line: integer(fields["line"], "original line"), column: integer(fields["column"], "original column") };
}

function frame(value: unknown): SymbolicatedFrame {
  const fields = record(value, "frame");
  return {
    fn: nullableText(fields["fn"], "frame function", 512), file: text(fields["file"], "frame file", 512), line: integer(fields["line"], "frame line"), column: integer(fields["column"], "frame column"),
    original: original(fields["original"] ?? null)
  };
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
    version: nullableText(fields["version"], "version", 64),
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
    version: nullableText(fields["version"], "occurrence version", 64),
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

export function decodeIssue(value: unknown): IssueSummary {
  return issueSummary(value);
}

export function decodeIssues(value: unknown): Page<IssueSummary> {
  return page(value, issueSummary, "issues");
}

function issueSummary(item: unknown): IssueSummary {
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
    lastVersion: nullableText(fields["lastVersion"], "last version", 64),
    versions: integer(fields["versions"], "versions"),
    firstVersion: nullableText(fields["firstVersion"], "first version", 64),
    firstVersionLabel: nullableText(fields["firstVersionLabel"], "first version label", 128)
  };
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
    reasons: list(fields["reasons"], 20, healthReason, "health reasons"),
    writes: writeCost(fields["writes"]),
    databaseBytes: counter("databaseBytes")
  };
}

function healthReason(value: unknown): HealthReason {
  const fields = record(value, "health reason");
  return {
    counter: oneOf(fields["counter"], HEALTH_COUNTERS, "health counter"),
    reason: text(fields["reason"], "health reason", 64),
    count: integer(fields["count"], "health reason count"),
    example: nullableText(fields["example"], "health example", 512)
  };
}

function writeCost(value: unknown): Health["writes"] {
  const fields = record(value, "write cost");
  return {
    ingestBatches: integer(fields["ingestBatches"], "ingest batches"),
    accepted: integer(fields["accepted"], "accepted invocations"),
    ingestRows: integer(fields["ingestRows"], "ingest rows written"),
    cleanupRows: integer(fields["cleanupRows"], "cleanup rows written")
  };
}

const IMPACT_STATES: readonly ImpactState[] = ["measured", "expired"];

function issueRef(value: unknown): IssueRef {
  const fields = record(value, "issue reference");
  return {
    fingerprint: text(fields["fingerprint"], "fingerprint", 64),
    name: text(fields["name"], "issue name", 128),
    operation: nullableText(fields["operation"], "issue operation", 64),
    frame: nullableText(fields["frame"], "issue frame", 1024),
    occurrences: integer(fields["occurrences"], "occurrences"),
    firstAtMs: integer(fields["firstAtMs"], "first seen")
  };
}

function versionStats(value: unknown): VersionStats {
  const fields = record(value, "version stats");
  return {
    version: text(fields["version"], "version", 64),
    label: nullableText(fields["label"], "version label", 128),
    introduced: bool(fields["introduced"], "introduced"),
    requests: integer(fields["requests"], "requests"),
    failed: integer(fields["failed"], "failed")
  };
}

export function decodeImpact(value: unknown, rolloutId: string): RolloutImpact {
  const fields = record(value, "rollout impact");
  if (fields["rolloutId"] !== rolloutId) fail("rollout id mismatch");
  return {
    rolloutId,
    atMs: integer(fields["atMs"], "rollout time"),
    previousRolloutId: nullableText(fields["previousRolloutId"], "previous rollout", 64),
    introduced: list(fields["introduced"], 4, item => text(item, "introduced version", 64), "introduced"),
    state: oneOf(fields["state"], IMPACT_STATES, "impact state"),
    baselineMs: integer(fields["baselineMs"], "baseline"),
    newIssues: list(fields["newIssues"], 50, issueRef, "new issues"),
    regressions: list(fields["regressions"], 50, issueRef, "regressions"),
    versions: list(fields["versions"], 8, versionStats, "versions")
  };
}

function routeStats(value: unknown): RouteStats {
  const fields = record(value, "route stats");
  const ms = (key: string) => integer(fields[key], key);
  return {
    label: text(fields["label"], "route label", 128),
    requests: ms("requests"), failed: ms("failed"), cpuMs: ms("cpuMs"),
    p50WallMs: ms("p50WallMs"), p95WallMs: ms("p95WallMs"), p99WallMs: ms("p99WallMs"), p50CpuMs: ms("p50CpuMs"), p95CpuMs: ms("p95CpuMs")
  };
}

function heatmap(value: unknown): Heatmap {
  const fields = record(value, "heatmap");
  const edges = list(fields["edges"], 16, item => integer(item, "edge"), "edges");
  return {
    fromMs: integer(fields["fromMs"], "heatmap start"),
    bucketMs: integer(fields["bucketMs"], "bucket"),
    edges,
    cells: list(fields["cells"], 120, row => list(row, edges.length + 1, item => integer(item, "cell"), "cell row"), "cells"),
    failed: list(fields["failed"], 120, item => integer(item, "failed"), "failed"),
    p95WallMs: list(fields["p95WallMs"], 120, item => nullableInteger(item, "p95"), "p95")
  };
}

export function decodeExploration(value: unknown): Exploration {
  const fields = record(value, "exploration");
  return {
    fromMs: integer(fields["fromMs"], "from"),
    toMs: integer(fields["toMs"], "to"),
    route: nullableText(fields["route"], "route", 128),
    routes: list(fields["routes"], 64, routeStats, "routes"),
    heatmap: heatmap(fields["heatmap"])
  };
}
