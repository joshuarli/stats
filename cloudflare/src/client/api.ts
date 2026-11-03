import { HISTORY_CONTENT_TYPE, openHistory, type HistoryView } from "../binary/history";
import type { RangeKey } from "../limits";
import { decodeFleetHistories, decodeHostHistories, decodeProjectHistories, decodeSummary, type FleetHistories, type HostHistories, type ProjectHistories, type SummaryHistory } from "./history";

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

export type HistoryQuery = { readonly range: RangeKey } | { readonly fromMs: number; readonly toMs: number };

export interface ProbeTarget {
  readonly name: string;
  readonly url: string;
}

export interface CollectorState {
  readonly lastRunAtMs: number | null;
  readonly lastSuccessAtMs: number | null;
  readonly lastError: string | null;
  readonly stale: boolean;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly worker: string;
  readonly buckets: readonly string[];
  readonly durableObjectNamespaces: readonly string[];
  readonly d1Databases: readonly string[];
  readonly probes: readonly ProbeTarget[];
  readonly collector: CollectorState;
}

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

function nullable<T>(value: unknown, decode: (entry: unknown) => T): T | null {
  return value === null ? null : decode(value);
}

function decodeProject(value: unknown): Project {
  const entry = record(value);
  const collector = record(entry.collector);
  return {
    id: string(entry.id),
    name: string(entry.name),
    worker: string(entry.worker),
    buckets: array(entry.buckets, string),
    durableObjectNamespaces: array(entry.durableObjectNamespaces, string),
    d1Databases: array(entry.d1Databases, string),
    probes: array(entry.probes, probe => {
      const target = record(probe);
      return { name: string(target.name), url: string(target.url) };
    }),
    collector: {
      lastRunAtMs: nullable(collector.lastRunAtMs, number),
      lastSuccessAtMs: nullable(collector.lastSuccessAtMs, number),
      lastError: nullable(collector.lastError, string),
      stale: boolean(collector.stale)
    }
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
}

type ConditionalCache<T> = Map<string, ConditionalEntry<T>>;

const CONDITIONAL_CACHE_LIMIT = 32;
const summaryCache: ConditionalCache<SummaryHistory> = new Map();
const hostCache: ConditionalCache<HostHistories> = new Map();
const fleetCache: ConditionalCache<FleetHistories> = new Map();
const projectCache: ConditionalCache<ProjectHistories> = new Map();

function rememberConditional<T>(cache: ConditionalCache<T>, path: string, etag: string, value: T): void {
  cache.delete(path);
  cache.set(path, { etag, value });
  while (cache.size > CONDITIONAL_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
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

async function getHistory<T>(path: string, decode: (root: HistoryView) => T, cache: ConditionalCache<T>, signal: AbortSignal): Promise<T> {
  const cached = cache.get(path);
  const response = await send(path, cached === undefined ? {} : { "If-None-Match": cached.etag }, signal);
  if (response.status === 304) {
    if (cached === undefined) throw new ApiFailure(0, "The response was not modified but no cached copy exists.");
    return cached.value;
  }
  if (!response.ok) throw new ApiFailure(response.status, statusMessage(response.status));
  if ((response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== HISTORY_CONTENT_TYPE) {
    throw new ApiFailure(0, "The response was not telemetry history. Sign in through Cloudflare Access.");
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    throw new ApiFailure(0, "The response could not be read.", error);
  }
  const value = contract(() => decode(openHistory(bytes).root));
  const etag = response.headers.get("etag");
  if (etag !== null) rememberConditional(cache, path, etag, value);
  return value;
}

const hostPath = (hostId: string, suffix = "") => `/api/v1/hosts/${encodeURIComponent(hostId)}${suffix}`;

export async function getHosts(signal: AbortSignal): Promise<readonly Host[]> {
  return getJson("/api/v1/hosts", value => array(record(value).hosts, decodeHost), signal);
}

export function getProjects(signal: AbortSignal): Promise<readonly Project[]> {
  return getJson("/api/v1/projects", value => array(value, decodeProject), signal);
}

export function getProjectHistories(
  projectId: string,
  range: RangeKey,
  options: { readonly durableObjects: boolean; readonly d1: boolean; readonly probes: boolean },
  signal: AbortSignal
): Promise<ProjectHistories> {
  const kinds = ["worker", "routes", "r2", "collector"];
  if (options.durableObjects) kinds.push("durable-objects");
  if (options.d1) kinds.push("d1", "d1-statements");
  if (options.probes) kinds.push("probes");
  return getHistory(`/api/v1/projects/${encodeURIComponent(projectId)}/history?range=${range}&kinds=${kinds.join(",")}`, decodeProjectHistories, projectCache, signal);
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
  const window = "range" in query ? `range=${encodeURIComponent(query.range)}` : `from=${Math.round(query.fromMs)}&to=${Math.round(query.toMs)}`;
  return `${hostPath(hostId, "/history")}?${window}`;
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
