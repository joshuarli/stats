import { HISTORY_CONTENT_TYPE, openHistory, type HistoryView } from "../binary/history.ts";
import { decodeProject, type ProjectSummary } from "./project-model.ts";
import { decodeServices } from "../deployments/service-decode.ts";
import type { Service } from "../core/installation/services.ts";
import { decodeIssues } from "../observe/client/decode.ts";
import type { IssueSummary, Page } from "../observe/core/store.ts";
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

export type { CollectorState, ProbeTarget } from "./project-model.ts";
export type Project = ProjectSummary;

type JsonObject = { readonly [key: string]: unknown };

export class ApiFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ApiFailure";
    this.status = status;
  }
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
  if (status === 401 || status === 403) return "Sign in through Cloudflare Access.";
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

async function getJson<T>(path: string, decode: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  const response = await send(path, { Accept: "application/json" }, signal);
  if (!response.ok) throw new ApiFailure(response.status, statusMessage(response.status));
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiFailure(0, "The response was not telemetry JSON. Sign in through Cloudflare Access.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ApiFailure(0, "The response was not valid JSON.", error);
  }
  return contract(() => decode(body));
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
  if (!response.ok) throw new ApiFailure(response.status, statusMessage(response.status));
  if ((response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== HISTORY_CONTENT_TYPE) {
    throw new ApiFailure(0, "The response was not telemetry history. Sign in through Cloudflare Access.");
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
  return getJson("/api/v1/projects", value => array(value, decodeProject), signal);
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
