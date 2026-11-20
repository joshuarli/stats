import { DURATION_BOUNDS_US, PLATFORM_OPERATIONS, type PlatformTelemetry } from "../../../packages/platform-bridge/src/contract.ts";
import { UI_JOURNEY_HEADER } from "../observe/application/journey.ts";
import { decodeCapabilities } from "../core/capabilities.ts";
import { decodeLatestProjectDeployment } from "../deployments/decode.ts";
import type { LatestDeployment } from "../deployments/model.ts";
import { HISTORY_CONTENT_TYPE, openHistory, type HistoryView } from "../binary/history.ts";
import { decodeProject, type ProjectSummary } from "./project-model.ts";
import { decodeServices } from "../deployments/service-decode.ts";
import type { Service } from "../core/installation/services.ts";
import { decodeHostServiceResources, type HostServiceResources } from "../core/installation/service-resources-model.ts";
import { decodeServiceHealthHistory, type ServiceHealthHistory } from "../core/installation/service-health-model.ts";
import { decodeIssues } from "../observe/client/decode.ts";
import type { IssueSummary, Page } from "../observe/core/store.ts";
import type { ApplicationSummary, ApplicationTelemetry } from "../observe/application/telemetry.ts";
import { projectHistoryPath, windowParams, type HistoryQuery } from "./history-path.ts";
import { decodeFleetHistories, decodeHostHistories, decodeProjectHistories, decodeSummary, type FleetHistories, type HostHistories, type ProjectHistories, type SummaryHistory } from "./history.ts";

export interface Host {
  readonly hostId: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly revoked: boolean;
  readonly lastReceivedAtMs: number | null;
  readonly online: boolean;
}

export interface CpuInfo {
  readonly model?: string;
  readonly threads: number;
  readonly cores?: number;
  readonly sockets?: number;
  readonly maxMhz?: number;
}

export interface SystemInfo {
  readonly agent: string;
  readonly hostname: string;
  readonly os?: string;
  readonly kernel: string;
  readonly arch: string;
  readonly cpu: CpuInfo;
}

export interface HostSystem {
  readonly reportedAtMs: number;
  readonly system: SystemInfo;
}

export type { HistoryQuery };

export type { CollectorState } from "./project-model.ts";
export type Project = ProjectSummary & { readonly latestDeployment?: LatestDeployment };

type JsonObject = { readonly [key: string]: unknown };

export class ApiFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ApiFailure";
    this.status = status;
  }
}

export async function failureForResponse(response: Response, message: string, status = response.status): Promise<ApiFailure> {
  try { await response.body?.cancel(); } catch (cause) { return new ApiFailure(status, message, cause); }
  return new ApiFailure(status, message);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonObject {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("expected a finite number");
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("expected a boolean");
  return value;
}

function array<T>(value: unknown, decode: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value.map(decode);
}

function decodeHost(value: unknown): Host {
  const entry = record(value);
  return {
    hostId: string(entry.hostId),
    name: string(entry.name),
    createdAtMs: number(entry.createdAtMs),
    revoked: boolean(entry.revoked),
    lastReceivedAtMs: entry.lastReceivedAtMs === null ? null : number(entry.lastReceivedAtMs),
    online: boolean(entry.online)
  };
}

function decodeSystem(value: unknown): HostSystem {
  const entry = record(value);
  const system = record(entry.system);
  const cpu = record(system.cpu);
  return {
    reportedAtMs: number(entry.reportedAtMs),
    system: {
      agent: string(system.agent),
      hostname: string(system.hostname),
      ...(system.os === undefined ? {} : { os: string(system.os) }),
      kernel: string(system.kernel),
      arch: string(system.arch),
      cpu: {
        threads: number(cpu.threads),
        ...(cpu.model === undefined ? {} : { model: string(cpu.model) }),
        ...(cpu.cores === undefined ? {} : { cores: number(cpu.cores) }),
        ...(cpu.sockets === undefined ? {} : { sockets: number(cpu.sockets) }),
        ...(cpu.maxMhz === undefined ? {} : { maxMhz: number(cpu.maxMhz) })
      }
    }
  };
}

function failureMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "The request was cancelled.";
  return error instanceof Error ? error.message : "The request could not be sent.";
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return "Open Stats from a device on the tailnet.";
  if (status === 404) return "No telemetry is stored for this target.";
  if (status === 503) return "The telemetry service is not configured correctly.";
  if (status === 429) return "Telemetry is rate limited. Try again shortly.";
  return `The telemetry service returned ${status}.`;
}

interface ConditionalEntry<T> {
  readonly etag: string;
  readonly value: T;
  readonly bytes: number;
}

export const CONDITIONAL_CACHE_LIMIT = 32;
export const CONDITIONAL_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export class ConditionalCache<T> {
  private readonly entries = new Map<string, ConditionalEntry<T>>();
  private readonly sequences = new Map<string, number>();
  private nextSequence = 0;
  private retainedBytes = 0;
  readonly maxEntries: number;
  readonly maxBytes: number;

  constructor(maxEntries = CONDITIONAL_CACHE_LIMIT, maxBytes = CONDITIONAL_CACHE_MAX_BYTES) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.retainedBytes;
  }

  get pending(): number {
    return this.sequences.size;
  }

  begin(path: string): number {
    const seq = ++this.nextSequence;
    this.sequences.set(path, seq);
    return seq;
  }

  finish(path: string, seq: number): void {
    if (this.sequences.get(path) === seq) this.sequences.delete(path);
  }

  peek(path: string): ConditionalEntry<T> | undefined {
    return this.entries.get(path);
  }

  touch(path: string, expectedEtag?: string): T | undefined {
    const existing = this.entries.get(path);
    if (existing === undefined) return undefined;
    if (expectedEtag !== undefined && existing.etag !== expectedEtag) return existing.value;
    this.entries.delete(path);
    this.entries.set(path, existing);
    return existing.value;
  }

  remember(path: string, seq: number, etag: string, value: T, bytes: number): boolean {
    if (this.sequences.get(path) !== seq) return false;
    const previous = this.entries.get(path);
    if (previous !== undefined) {
      this.entries.delete(path);
      this.retainedBytes -= previous.bytes;
    }
    if (bytes > this.maxBytes || this.maxEntries <= 0) return false;
    this.entries.set(path, { etag, value, bytes });
    this.retainedBytes += bytes;
    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const oldest = this.entries.entries().next();
      if (oldest.done) break;
      const [oldestKey, oldestEntry] = oldest.value;
      this.entries.delete(oldestKey);
      this.retainedBytes -= oldestEntry.bytes;
    }
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.sequences.clear();
    this.nextSequence = 0;
    this.retainedBytes = 0;
  }
}

const summaryCache = new ConditionalCache<SummaryHistory>();
const hostCache = new ConditionalCache<HostHistories>();
const fleetCache = new ConditionalCache<FleetHistories>();
const projectCache = new ConditionalCache<ProjectHistories>();

export function resetHistoryCaches(): void {
  summaryCache.clear();
  hostCache.clear();
  fleetCache.clear();
  projectCache.clear();
}

async function send(path: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(path, { headers, cache: "no-store", signal });
  } catch (error) {
    throw new ApiFailure(0, failureMessage(error));
  }
}

function contract<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    console.error("telemetry response decode failed", error);
    throw new ApiFailure(0, "The response did not match the telemetry contract.", error);
  }
}

export function openHistoryFrame<T>(
  input: ArrayBuffer | Uint8Array,
  decode: (root: HistoryView) => T
): { readonly value: T; readonly retainedBytes: number } {
  const opened = openHistory(input);
  return {
    value: decode(opened.root),
    retainedBytes: input.byteLength * (opened.zeroCopy ? 1 : 2)
  };
}

export interface JsonReadMeasurement {
  readonly startedMs: number;
  readonly fetchMs: number;
  readonly bodyMs?: number;
  readonly decodeMs?: number;
  readonly serverTiming: string | null;
  readonly journeyDelivery: boolean | undefined;
}

export interface JsonReadObservation {
  readonly trace: { readonly traceId: string; readonly spanId: string };
  readonly measured: (measurement: JsonReadMeasurement) => void;
}

async function getJson<T>(path: string, decode: (value: unknown) => T, signal: AbortSignal, observation?: JsonReadObservation): Promise<T> {
  const started = observation === undefined ? 0 : performance.now();
  let response: Response | undefined, headersAt: number | undefined, bodyAt: number | undefined;
  try {
    response = await send(path, { Accept: "application/json", ...(observation === undefined ? {} : { traceparent: `00-${observation.trace.traceId}-${observation.trace.spanId}-00` }) }, signal);
    if (observation !== undefined) headersAt = performance.now();
    if (!response.ok) throw await failureForResponse(response, statusMessage(response.status));
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw await failureForResponse(response, "The response was not telemetry JSON. Open Stats from a device on the tailnet.", 0);
    }
    let body: unknown;
    try {
      if (observation === undefined) body = await response.json();
      else {
        const text = await response.text();
        bodyAt = performance.now();
        body = JSON.parse(text) as unknown;
      }
    } catch (error) { throw new ApiFailure(0, "The response was not valid JSON.", error); }
    return contract(() => decode(body));
  } finally {
    if (observation !== undefined) {
      const ended = performance.now();
      try {
        observation.measured({ startedMs: started, fetchMs: (headersAt ?? ended) - started,
          ...(headersAt === undefined ? {} : { bodyMs: (bodyAt ?? ended) - headersAt }),
          ...(bodyAt === undefined ? {} : { decodeMs: ended - bodyAt }),
          serverTiming: response?.headers.get("Server-Timing") ?? null, journeyDelivery: response === undefined ? undefined : response.headers.get(UI_JOURNEY_HEADER) === "1" });
      } catch { console.error("ui_read_measurement_failed"); }
    }
  }
}

export async function getHistory<T>(
  path: string,
  decode: (root: HistoryView) => T,
  cache: ConditionalCache<T>,
  signal: AbortSignal
): Promise<T> {
  const seq = cache.begin(path);
  try {
    return await fetchHistory(path, decode, cache, seq, signal);
  } finally {
    cache.finish(path, seq);
  }
}

async function fetchHistory<T>(
  path: string,
  decode: (root: HistoryView) => T,
  cache: ConditionalCache<T>,
  seq: number,
  signal: AbortSignal
): Promise<T> {
  const cached = cache.peek(path);
  let response = await send(path, cached === undefined ? {} : { "If-None-Match": cached.etag }, signal);
  if (response.status === 304) {
    if (cached === undefined) throw new ApiFailure(0, "The response was not modified but no cached copy exists.");
    const responseEtag = response.headers.get("etag");
    if (responseEtag === null || responseEtag === cached.etag) {
      cache.touch(path, cached.etag);
      return cached.value;
    }
    response = await send(path, {}, signal);
    if (response.status === 304) {
      throw new ApiFailure(0, "The response was not modified but no cached copy exists.");
    }
  }
  if (!response.ok) throw await failureForResponse(response, statusMessage(response.status));
  if ((response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== HISTORY_CONTENT_TYPE) {
    throw await failureForResponse(response, "The response was not telemetry history. Open Stats from a device on the tailnet.", 0);
  }
  let bytes: ArrayBuffer | Uint8Array;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    throw new ApiFailure(0, "The response could not be read.", error);
  }
  if (signal.aborted) {
    throw new ApiFailure(0, "The request was cancelled.");
  }
  const { value, retainedBytes } = contract(() => openHistoryFrame(bytes, decode));
  const etag = response.headers.get("etag");
  if (etag !== null) cache.remember(path, seq, etag, value, retainedBytes);
  return value;
}

const hostPath = (hostId: string, suffix = "") => `/api/v1/hosts/${encodeURIComponent(hostId)}${suffix}`;

export async function getHosts(signal: AbortSignal): Promise<readonly Host[]> {
  return getJson("/api/v1/hosts", value => array(record(value).hosts, decodeHost), signal);
}

export type { Service };

export function getServices(signal: AbortSignal): Promise<readonly Service[]> {
  return getJson("/api/v1/services", decodeServices, signal);
}

export function getServiceIssues(service: string, signal: AbortSignal): Promise<Page<IssueSummary>> {
  return getJson(`/api/observe/${encodeURIComponent(service)}/issues?state=open&limit=50`, decodeIssues, signal);
}

export function getProjects(signal: AbortSignal): Promise<readonly Project[]> {
  return getJson("/api/v1/projects", value => array(value, entry => {
    const project = decodeProject(entry);
    const latestDeployment = decodeLatestProjectDeployment(record(entry)["latestDeployment"], project.id);
    return latestDeployment === undefined ? project : { ...project, latestDeployment };
  }), signal);
}

export function getProjectHistories(
  projectId: string,
  query: HistoryQuery,
  options: { readonly durableObjects: boolean; readonly d1: boolean; readonly probes: boolean },
  signal: AbortSignal
): Promise<ProjectHistories> {
  return getHistory(projectHistoryPath(projectId, query, options), decodeProjectHistories, projectCache, signal);
}

export async function getSystem(hostId: string, signal: AbortSignal): Promise<HostSystem | null> {
  try {
    return await getJson(hostPath(hostId, "/system"), decodeSystem, signal);
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 404) return null;
    throw error;
  }
}

function historyUrl(hostId: string, query: HistoryQuery): string {
  return `${hostPath(hostId, "/history")}?${windowParams(query)}`;
}

export function getSummary(hostId: string, query: HistoryQuery, signal: AbortSignal): Promise<SummaryHistory> {
  return getHistory(`${historyUrl(hostId, query)}&kind=summary`, decodeSummary, summaryCache, signal);
}

export function getHostHistories(hostId: string, query: HistoryQuery, signal: AbortSignal): Promise<HostHistories> {
  return getHistory(`${historyUrl(hostId, query)}&kinds=summary,disks,nets,filesystems,block`, decodeHostHistories, hostCache, signal);
}

export function getFleetHistories(hostId: string, query: HistoryQuery, signal: AbortSignal): Promise<FleetHistories> {
  return getHistory(`${historyUrl(hostId, query)}&kinds=summary,disks,nets,filesystems`, decodeFleetHistories, fleetCache, signal);
}

export function getServiceHealth(service: string, fromMs: number, toMs: number, signal: AbortSignal): Promise<ServiceHealthHistory> {
  return getJson(`/api/v1/services/${encodeURIComponent(service)}/health?fromMs=${Math.floor(fromMs)}&toMs=${Math.ceil(toMs)}`, value => decodeServiceHealthHistory(value, service), signal);
}

export function getHostServiceResources(hostId: string, fromMs: number, toMs: number, signal: AbortSignal): Promise<HostServiceResources> {
  return getJson(hostPath(hostId, `/services?fromMs=${Math.floor(fromMs)}&toMs=${Math.ceil(toMs)}`), decodeHostServiceResources, signal);
}

export function getCapabilities(signal: AbortSignal) {
  return getJson("/api/v1/capabilities", decodeCapabilities, signal);
}

function applicationInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("expected a nonnegative safe integer");
  return value;
}

export function decodeApplicationSummary(value: unknown): ApplicationSummary {
  const root = record(value);
  const integer = applicationInteger;
  const totals = (v: unknown) => {
    const x = record(v);
    return { events: integer(x.events), failed: integer(x.failed), cancelled: integer(x.cancelled), requests: integer(x.requests), requestDurationMsSum: integer(x.requestDurationMsSum), requestDurationMsMax: integer(x.requestDurationMsMax), status2xx: integer(x.status2xx), status3xx: integer(x.status3xx), status4xx: integer(x.status4xx), status5xx: integer(x.status5xx), durationMsSum: integer(x.durationMsSum), durationMsMax: integer(x.durationMsMax), firstAtMs: integer(x.firstAtMs), lastAtMs: integer(x.lastAtMs) };
  };
  if (root.provenance !== "application") throw new Error("invalid application provenance");
  const buckets = array(root.buckets, v => ({ ...totals(v), atMs: integer(record(v).atMs) }));
  const operations = array(root.operations, v => ({ ...totals(v), operation: string(record(v).operation) }));
  if (buckets.length > 120 || operations.length > 20) throw new Error("application telemetry exceeds response limits");
  const fromMs = integer(root.fromMs), toMs = integer(root.toMs), stepMs = integer(root.stepMs);
  if (fromMs >= toMs || stepMs === 0 || buckets.some(bucket => bucket.atMs < fromMs || bucket.atMs >= toMs || bucket.events === 0)) throw new Error("invalid application telemetry window");
  return { provenance: "application", fromMs, toMs, stepMs, totals: root.totals === null ? null : totals(root.totals), openIssues: integer(root.openIssues), buckets, operations, moreOperations: boolean(root.moreOperations) };
}

export function decodeApplicationTelemetry(value: unknown): ApplicationTelemetry {
  const summary = decodeApplicationSummary(value);
  const root = record(value);
  const integer = applicationInteger;
  const recent = array(root.recent, v => {
    const row = record(v), e = record(row.event), work = record(e.work);
    if (row.provenance !== "application" || e.schemaVersion !== 1) throw new Error("invalid application event");
    const decodedWork: Record<string, number> = {};
    for (const [key, item] of Object.entries(work)) decodedWork[key] = integer(item);
    const diagnostics = e.diagnostics === undefined ? undefined : record(e.diagnostics);
    if (diagnostics !== undefined && diagnostics.version !== 1) throw new Error("invalid diagnostics");
    return { eventId: string(row.eventId), service: string(row.service), receivedAtMs: integer(row.receivedAtMs), provenance: "application" as const, event: {
      schemaVersion: 1 as const, eventId: string(e.eventId), atMs: integer(e.atMs), operation: string(e.operation), outcome: string(e.outcome), durationMs: integer(e.durationMs), work: decodedWork, release: string(e.release), service: string(e.service),
      ...(e.error === undefined ? {} : { error: { code: string(record(e.error).code) } }),
      ...(diagnostics === undefined ? {} : { diagnostics: { version: 1 as const, name: string(diagnostics.name), message: string(diagnostics.message), frames: array(diagnostics.frames, string) } })
    } };
  });
  if (recent.length > 50) throw new Error("application telemetry exceeds response limits");
  return { ...summary, recent, moreRecent: boolean(root.moreRecent) };
}

export function getApplicationTelemetry(service: string, fromMs: number, toMs: number, signal: AbortSignal): Promise<import("../observe/application/telemetry.ts").ApplicationTelemetry> {
  return getJson(`/api/observe/${encodeURIComponent(service)}/external/telemetry?from=${Math.round(fromMs)}&to=${Math.round(toMs)}`, decodeApplicationTelemetry, signal);
}

export function getApplicationSummary(service: string, fromMs: number, toMs: number, signal: AbortSignal, observation?: JsonReadObservation): Promise<ApplicationSummary> {
  return getJson(`/api/observe/${encodeURIComponent(service)}/external/telemetry/summary?from=${Math.round(fromMs)}&to=${Math.round(toMs)}`, decodeApplicationSummary, signal, observation);
}

export function decodePlatformTelemetry(value: unknown): PlatformTelemetry {
  const root = record(value), caps = record(root.capabilities);
  const integer = applicationInteger;
  const fromMs = integer(root.fromMs), toMs = integer(root.toMs);
  if (fromMs >= toMs || caps.actorRequests !== true || caps.sqlite !== true || caps.outboundRpc !== false || caps.runtimeMetrics !== false) throw new Error("invalid platform window or capabilities");
  const operations = array(root.operations, value => {
    const row = record(value), operation = string(row.operation), release = string(row.release);
    const count = integer(row.count), failed = integer(row.failed), meanUs = number(row.meanUs), maxUs = integer(row.maxUs), p50UpperUs = integer(row.p50UpperUs), p95UpperUs = integer(row.p95UpperUs);
    const histogram = array(row.histogram, item => { const bin = record(item); return { upperUs: integer(bin.upperUs), count: integer(bin.count) }; });
    if (!PLATFORM_OPERATIONS.includes(operation) || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/u.test(release) || count === 0 || failed > count || meanUs < 0 || meanUs > maxUs || histogram.length === 0 || histogram.some((bin, i) => !DURATION_BOUNDS_US.some(bound => bound === bin.upperUs) || bin.count === 0 || (i > 0 && bin.upperUs <= histogram[i - 1]!.upperUs)) || histogram.reduce((sum, bin) => sum + bin.count, 0) !== count) throw new Error("invalid platform operation");
    const percentile = (fraction: number) => { let n = 0; return histogram.find(bin => (n += bin.count) >= Math.ceil(count * fraction))!.upperUs; };
    if (p50UpperUs !== percentile(0.5) || p95UpperUs !== percentile(0.95) || maxUs > histogram[histogram.length - 1]!.upperUs) throw new Error("invalid platform histogram");
    return { operation, release, count, failed, meanUs, maxUs, p50UpperUs, p95UpperUs, histogram };
  });
  if (operations.length > 80 || new Set(operations.map(row => `${row.operation}\n${row.release}`)).size !== operations.length) throw new Error("invalid platform groups");
  const delivery = root.delivery === null ? null : (() => { const d = record(root.delivery); const result = { atMs: integer(d.atMs), release: string(d.release), samplePpm: integer(d.samplePpm), received: integer(d.received), admitted: integer(d.admitted), filtered: integer(d.filtered), invalid: integer(d.invalid), dropped: integer(d.dropped), queued: integer(d.queued), sent: integer(d.sent), exporterLoss: "unknown" as const }; if (d.exporterLoss !== "unknown" || result.samplePpm > 1_000_000 || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/u.test(result.release)) throw new Error("invalid platform delivery"); return result; })();
  return { fromMs, toMs, operations, delivery, truncated: boolean(root.truncated), capabilities: { actorRequests: true, sqlite: true, outboundRpc: false, runtimeMetrics: false } };
}

export async function getPlatformTelemetry(fromMs: number, toMs: number, signal: AbortSignal): Promise<PlatformTelemetry | null> {
  try { return await getJson(`/api/observe/stats-platform/platform?from=${Math.round(fromMs)}&to=${Math.round(toMs)}`, decodePlatformTelemetry, signal); }
  catch (error) { if (error instanceof ApiFailure && error.status === 404) return null; throw error; }
}
