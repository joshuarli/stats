import { RANGES, type RangeKey } from "../limits";

export interface Host {
  readonly hostId: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly revoked: boolean;
  readonly lastReceivedAtMs: number | null;
  readonly online: boolean;
}

export interface Cpu {
  readonly user: number;
  readonly system: number;
  readonly idle: number;
  readonly iowait?: number;
  readonly steal?: number;
}

export interface Load {
  readonly one: number;
  readonly five: number;
  readonly fifteen: number;
}

export interface Mem {
  readonly total: number;
  readonly available: number;
  readonly swapUsed: number;
  readonly swapInBytesPerSec?: number;
  readonly swapOutBytesPerSec?: number;
}

export interface PsiGroup {
  readonly some10: number;
  readonly some60: number;
  readonly some300: number;
  readonly full10?: number;
  readonly full60?: number;
  readonly full300?: number;
}

export interface Psi {
  readonly cpu?: PsiGroup;
  readonly memory?: PsiGroup;
  readonly io?: PsiGroup;
}

export interface SummaryPoint {
  readonly atMs: number;
  readonly coverageMs: number;
  readonly partial: boolean;
  readonly cpu?: Cpu;
  readonly load?: Load;
  readonly mem?: Mem;
  readonly psi?: Psi;
  readonly cpuCount?: number;
  readonly uptimeMs?: number;
}

export interface DiskPoint {
  readonly atMs: number;
  readonly readBytesPerSec: number;
  readonly writeBytesPerSec: number;
  readonly readsPerSec: number;
  readonly writesPerSec: number;
  readonly busyPct: number;
}

export interface NetPoint {
  readonly atMs: number;
  readonly rxBytesPerSec: number;
  readonly txBytesPerSec: number;
  readonly rxPacketsPerSec: number;
  readonly txPacketsPerSec: number;
  readonly rxDropsPerSec: number;
  readonly txDropsPerSec?: number;
  readonly rxErrorsPerSec: number;
  readonly txErrorsPerSec: number;
}

export interface FilesystemPoint {
  readonly atMs: number;
  readonly total: number;
  readonly available: number;
}

export interface BlockPoint {
  readonly atMs: number;
  readonly count: number;
  readonly totalUs: number;
  readonly minUs: number;
  readonly maxUs: number;
  readonly p50Us: number;
  readonly p95Us: number;
  readonly p99Us: number;
}

export interface Series<P> {
  readonly id: string;
  readonly name?: string;
  readonly points: readonly P[];
}

export type DiskSeries = Series<DiskPoint>;
export type NetSeries = Series<NetPoint>;
export type FilesystemSeries = Series<FilesystemPoint>;
export type BlockSeries = Series<BlockPoint>;

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

interface HistoryBase {
  readonly hostId: string;
  readonly range?: RangeKey;
  readonly fromMs: number;
  readonly toMs: number;
  readonly resolution: "raw" | "1m" | "1h";
  readonly stepMs: number;
}

export interface SummaryHistory extends HistoryBase {
  readonly kind: "summary";
  readonly points?: readonly SummaryPoint[];
}

export interface DiskHistory extends HistoryBase {
  readonly kind: "disks";
  readonly series?: readonly Series<DiskPoint>[];
}

export interface NetHistory extends HistoryBase {
  readonly kind: "nets";
  readonly series?: readonly Series<NetPoint>[];
}

export interface FilesystemHistory extends HistoryBase {
  readonly kind: "filesystems";
  readonly series?: readonly Series<FilesystemPoint>[];
}

export interface BlockHistory extends HistoryBase {
  readonly kind: "block";
  readonly series?: readonly Series<BlockPoint>[];
}

export interface HostHistories {
  readonly summary: SummaryHistory;
  readonly disks: DiskHistory;
  readonly nets: NetHistory;
  readonly filesystems: FilesystemHistory;
  readonly block: BlockHistory;
}

export type FleetHistories = Pick<HostHistories, "summary" | "disks" | "nets">;

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

export type ProjectMetricKind = "worker" | "routes" | "durable-objects" | "r2" | "d1" | "d1-statements" | "probes";

export interface ProjectSeries {
  readonly metric: string;
  readonly values: readonly (number | null)[];
}

export interface ProjectMetricHistory {
  readonly projectId: string;
  readonly range: RangeKey;
  readonly kind: ProjectMetricKind;
  readonly fromMs: number;
  readonly toMs: number;
  readonly stepMs: number;
  readonly series: readonly ProjectSeries[];
}

export interface CollectorRun {
  readonly atMs: number;
  readonly ok: boolean;
  readonly detail: string;
  readonly rowsRead: number;
  readonly durationMs: number;
}

export interface ProjectCollectorHistory {
  readonly projectId: string;
  readonly range: RangeKey;
  readonly fromMs: number;
  readonly toMs: number;
  readonly runs: readonly CollectorRun[];
}

export interface ProjectHistories {
  readonly worker: ProjectMetricHistory;
  readonly routes: ProjectMetricHistory;
  readonly r2: ProjectMetricHistory;
  readonly collector: ProjectCollectorHistory;
  readonly "durable-objects"?: ProjectMetricHistory;
  readonly d1?: ProjectMetricHistory;
  readonly "d1-statements"?: ProjectMetricHistory;
  readonly probes?: ProjectMetricHistory;
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

function decodeCpu(value: unknown): Cpu {
  const entry = record(value);
  return {
    user: number(entry.user),
    system: number(entry.system),
    idle: number(entry.idle),
    ...(entry.iowait === undefined ? {} : { iowait: number(entry.iowait) }),
    ...(entry.steal === undefined ? {} : { steal: number(entry.steal) })
  };
}

function decodeLoad(value: unknown): Load {
  const entry = record(value);
  return { one: number(entry.one), five: number(entry.five), fifteen: number(entry.fifteen) };
}

function decodeMem(value: unknown): Mem {
  const entry = record(value);
  return {
    total: number(entry.total),
    available: number(entry.available),
    swapUsed: number(entry.swapUsed),
    ...(entry.swapInBytesPerSec === undefined ? {} : { swapInBytesPerSec: number(entry.swapInBytesPerSec), swapOutBytesPerSec: number(entry.swapOutBytesPerSec) })
  };
}

function decodePsiGroup(value: unknown): PsiGroup {
  const entry = record(value);
  return {
    some10: number(entry.some10),
    some60: number(entry.some60),
    some300: number(entry.some300),
    ...(entry.full10 === undefined ? {} : { full10: number(entry.full10), full60: number(entry.full60), full300: number(entry.full300) })
  };
}

function decodePsi(value: unknown): Psi {
  const entry = record(value);
  return {
    ...(entry.cpu === undefined ? {} : { cpu: decodePsiGroup(entry.cpu) }),
    ...(entry.memory === undefined ? {} : { memory: decodePsiGroup(entry.memory) }),
    ...(entry.io === undefined ? {} : { io: decodePsiGroup(entry.io) })
  };
}

function decodeSummaryPoint(value: unknown): SummaryPoint {
  const entry = record(value);
  return {
    atMs: number(entry.atMs),
    coverageMs: number(entry.coverageMs),
    partial: boolean(entry.partial),
    ...(entry.cpu === undefined ? {} : { cpu: decodeCpu(entry.cpu) }),
    ...(entry.load === undefined ? {} : { load: decodeLoad(entry.load) }),
    ...(entry.mem === undefined ? {} : { mem: decodeMem(entry.mem) }),
    ...(entry.psi === undefined ? {} : { psi: decodePsi(entry.psi) }),
    ...(entry.cpuCount === undefined ? {} : { cpuCount: number(entry.cpuCount) }),
    ...(entry.uptimeMs === undefined ? {} : { uptimeMs: number(entry.uptimeMs) })
  };
}

function decodeDiskPoint(value: unknown): DiskPoint {
  const entry = record(value);
  return {
    atMs: number(entry.atMs),
    readBytesPerSec: number(entry.readBytesPerSec),
    writeBytesPerSec: number(entry.writeBytesPerSec),
    readsPerSec: number(entry.readsPerSec),
    writesPerSec: number(entry.writesPerSec),
    busyPct: number(entry.busyPct)
  };
}

function decodeNetPoint(value: unknown): NetPoint {
  const entry = record(value);
  return {
    atMs: number(entry.atMs),
    rxBytesPerSec: number(entry.rxBytesPerSec),
    txBytesPerSec: number(entry.txBytesPerSec),
    rxPacketsPerSec: number(entry.rxPacketsPerSec),
    txPacketsPerSec: number(entry.txPacketsPerSec),
    rxDropsPerSec: number(entry.rxDropsPerSec),
    ...(entry.txDropsPerSec === undefined ? {} : { txDropsPerSec: number(entry.txDropsPerSec) }),
    rxErrorsPerSec: number(entry.rxErrorsPerSec),
    txErrorsPerSec: number(entry.txErrorsPerSec)
  };
}

function decodeFilesystemPoint(value: unknown): FilesystemPoint {
  const entry = record(value);
  return { atMs: number(entry.atMs), total: number(entry.total), available: number(entry.available) };
}

function decodeBlockPoint(value: unknown): BlockPoint {
  const entry = record(value);
  return {
    atMs: number(entry.atMs),
    count: number(entry.count),
    totalUs: number(entry.totalUs),
    minUs: number(entry.minUs),
    maxUs: number(entry.maxUs),
    p50Us: number(entry.p50Us),
    p95Us: number(entry.p95Us),
    p99Us: number(entry.p99Us)
  };
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

function rangeValue(value: unknown): RangeKey {
  const text = string(value);
  const found = RANGES.find(range => range === text);
  if (found === undefined) throw new Error("expected a range");
  return found;
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

function decodeProjectMetricHistory(kind: ProjectMetricKind): (value: unknown) => ProjectMetricHistory {
  return value => {
    const entry = record(value);
    if (entry.kind !== kind) throw new Error(`expected ${kind} history`);
    const series = array(entry.series, item => {
      const found = record(item);
      return { metric: string(found.metric), values: array(found.values, cell => nullable(cell, number)) };
    });
    const stepMs = number(entry.stepMs);
    if (stepMs <= 0) throw new Error("expected a positive step");
    return { projectId: string(entry.projectId), range: rangeValue(entry.range), kind, fromMs: number(entry.fromMs), toMs: number(entry.toMs), stepMs, series };
  };
}

function decodeProjectCollectorHistory(value: unknown): ProjectCollectorHistory {
  const entry = record(value);
  if (entry.kind !== "collector") throw new Error("expected collector history");
  return {
    projectId: string(entry.projectId),
    range: rangeValue(entry.range),
    fromMs: number(entry.fromMs),
    toMs: number(entry.toMs),
    runs: array(entry.runs, item => {
      const run = record(item);
      return { atMs: number(run.atMs), ok: boolean(run.ok), detail: string(run.detail), rowsRead: number(run.rowsRead), durationMs: number(run.durationMs) };
    })
  };
}

function decodeProjectHistories(value: unknown): ProjectHistories {
  const histories = record(record(value).histories);
  return {
    worker: decodeProjectMetricHistory("worker")(histories.worker),
    routes: decodeProjectMetricHistory("routes")(histories.routes),
    r2: decodeProjectMetricHistory("r2")(histories.r2),
    collector: decodeProjectCollectorHistory(histories.collector),
    ...(histories["durable-objects"] === undefined ? {} : { "durable-objects": decodeProjectMetricHistory("durable-objects")(histories["durable-objects"]) }),
    ...(histories.d1 === undefined ? {} : { d1: decodeProjectMetricHistory("d1")(histories.d1) }),
    ...(histories["d1-statements"] === undefined ? {} : { "d1-statements": decodeProjectMetricHistory("d1-statements")(histories["d1-statements"]) }),
    ...(histories.probes === undefined ? {} : { probes: decodeProjectMetricHistory("probes")(histories.probes) })
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

function decodeSeries<T>(value: unknown, decodePoint: (point: unknown) => T): Series<T> {
  const entry = record(value);
  return {
    id: string(entry.id),
    ...(entry.name === undefined ? {} : { name: string(entry.name) }),
    points: array(entry.points, decodePoint)
  };
}

function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && (RANGES as readonly string[]).includes(value);
}

function decodeHistoryBase(entry: JsonObject): HistoryBase {
  const resolution = entry.resolution;
  if (resolution !== "raw" && resolution !== "1m" && resolution !== "1h") throw new Error("expected a history resolution");
  const range = entry.range;
  if (range !== undefined && !isRangeKey(range)) throw new Error("expected a history range");
  return {
    hostId: string(entry.hostId),
    ...(range === undefined ? {} : { range }),
    fromMs: number(entry.fromMs),
    toMs: number(entry.toMs),
    resolution,
    stepMs: number(entry.stepMs)
  };
}

function decodeSummaryHistory(value: unknown): SummaryHistory {
  const entry = record(value);
  if (entry.kind !== "summary") throw new Error("expected summary history");
  return {
    ...decodeHistoryBase(entry),
    kind: "summary",
    ...(entry.points === undefined ? {} : { points: array(entry.points, decodeSummaryPoint) })
  };
}

function decodeDiskHistory(value: unknown): DiskHistory {
  const entry = record(value);
  if (entry.kind !== "disks") throw new Error("expected disk history");
  return {
    ...decodeHistoryBase(entry),
    kind: "disks",
    ...(entry.series === undefined ? {} : { series: array(entry.series, series => decodeSeries(series, decodeDiskPoint)) })
  };
}

function decodeNetHistory(value: unknown): NetHistory {
  const entry = record(value);
  if (entry.kind !== "nets") throw new Error("expected network history");
  return {
    ...decodeHistoryBase(entry),
    kind: "nets",
    ...(entry.series === undefined ? {} : { series: array(entry.series, series => decodeSeries(series, decodeNetPoint)) })
  };
}

function decodeFilesystemHistory(value: unknown): FilesystemHistory {
  const entry = record(value);
  if (entry.kind !== "filesystems") throw new Error("expected filesystem history");
  return {
    ...decodeHistoryBase(entry),
    kind: "filesystems",
    ...(entry.series === undefined ? {} : { series: array(entry.series, series => decodeSeries(series, decodeFilesystemPoint)) })
  };
}

function decodeBlockHistory(value: unknown): BlockHistory {
  const entry = record(value);
  if (entry.kind !== "block") throw new Error("expected block history");
  return {
    ...decodeHistoryBase(entry),
    kind: "block",
    ...(entry.series === undefined ? {} : { series: array(entry.series, series => decodeSeries(series, decodeBlockPoint)) })
  };
}

function bundledHistories(value: unknown): JsonObject {
  return record(record(value).histories);
}

function decodeHostHistories(value: unknown): HostHistories {
  const histories = bundledHistories(value);
  return {
    summary: decodeSummaryHistory(histories.summary),
    disks: decodeDiskHistory(histories.disks),
    nets: decodeNetHistory(histories.nets),
    filesystems: decodeFilesystemHistory(histories.filesystems),
    block: decodeBlockHistory(histories.block)
  };
}

function decodeFleetHistories(value: unknown): FleetHistories {
  const histories = bundledHistories(value);
  return {
    summary: decodeSummaryHistory(histories.summary),
    disks: decodeDiskHistory(histories.disks),
    nets: decodeNetHistory(histories.nets)
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

interface ConditionalEntry {
  readonly etag: string;
  readonly body: unknown;
}

const CONDITIONAL_CACHE_LIMIT = 32;
const conditionalCache = new Map<string, ConditionalEntry>();

function rememberConditional(path: string, etag: string, body: unknown): void {
  conditionalCache.delete(path);
  conditionalCache.set(path, { etag, body });
  while (conditionalCache.size > CONDITIONAL_CACHE_LIMIT) {
    const oldest = conditionalCache.keys().next().value;
    if (oldest === undefined) break;
    conditionalCache.delete(oldest);
  }
}

async function getJson<T>(path: string, decode: (value: unknown) => T, signal: AbortSignal, conditional = false): Promise<T> {
  const cached = conditional ? conditionalCache.get(path) : undefined;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cached !== undefined) headers["If-None-Match"] = cached.etag;
  let response: Response;
  try {
    response = await fetch(path, { headers, cache: "no-store", signal });
  } catch (error) {
    throw new ApiFailure(0, failureMessage(error));
  }
  if (response.status === 304) {
    if (cached === undefined) throw new ApiFailure(0, "The response was not modified but no cached copy exists.");
    try {
      return decode(cached.body);
    } catch (error) {
      console.error("telemetry response decode failed", error);
      throw new ApiFailure(0, "The response did not match the telemetry contract.", error);
    }
  }
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
  let value: T;
  try {
    value = decode(body);
  } catch (error) {
    console.error("telemetry response decode failed", error);
    throw new ApiFailure(0, "The response did not match the telemetry contract.", error);
  }
  if (conditional) {
    const etag = response.headers.get("etag");
    if (etag !== null) rememberConditional(path, etag, body);
  }
  return value;
}

const hostPath = (hostId: string, suffix = "") => `/api/v1/hosts/${encodeURIComponent(hostId)}${suffix}`;

export async function getHosts(signal: AbortSignal): Promise<readonly Host[]> {
  const body = await getJson("/api/v1/hosts", value => array(record(value).hosts, decodeHost), signal);
  return body;
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
  return getJson(`/api/v1/projects/${encodeURIComponent(projectId)}/history?range=${range}&kinds=${kinds.join(",")}`, decodeProjectHistories, signal, true);
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
  return getJson(`${historyUrl(hostId, query)}&kind=summary`, decodeSummaryHistory, signal, true);
}

export function getHostHistories(hostId: string, query: HistoryQuery, signal: AbortSignal): Promise<HostHistories> {
  return getJson(`${historyUrl(hostId, query)}&kinds=summary,disks,nets,filesystems,block`, decodeHostHistories, signal, true);
}

export function getFleetHistories(hostId: string, query: HistoryQuery, signal: AbortSignal): Promise<FleetHistories> {
  return getJson(`${historyUrl(hostId, query)}&kinds=summary,disks,nets`, decodeFleetHistories, signal, true);
}
