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
  readonly iowait: number;
  readonly steal: number;
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
}

export interface PsiGroup {
  readonly some10: number;
  readonly some60: number;
  readonly some300: number;
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
  readonly txDropsPerSec: number;
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

export interface Latest {
  readonly hostId: string;
  readonly receivedAtMs: number;
  readonly sample: {
    readonly seq: string;
    readonly atMs: string;
    readonly monoMs: string;
    readonly uptimeMs?: string;
    readonly cpuCount?: number;
  };
}

interface HistoryBase {
  readonly hostId: string;
  readonly range: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly resolution: "raw" | "1m";
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

type JsonObject = { readonly [key: string]: unknown };

export class ApiFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
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
    iowait: number(entry.iowait),
    steal: number(entry.steal)
  };
}

function decodeLoad(value: unknown): Load {
  const entry = record(value);
  return { one: number(entry.one), five: number(entry.five), fifteen: number(entry.fifteen) };
}

function decodeMem(value: unknown): Mem {
  const entry = record(value);
  return { total: number(entry.total), available: number(entry.available), swapUsed: number(entry.swapUsed) };
}

function decodePsiGroup(value: unknown): PsiGroup {
  const entry = record(value);
  return { some10: number(entry.some10), some60: number(entry.some60), some300: number(entry.some300) };
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
    ...(entry.psi === undefined ? {} : { psi: decodePsi(entry.psi) })
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
    txDropsPerSec: number(entry.txDropsPerSec),
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

function decodeLatest(value: unknown): Latest {
  const entry = record(value);
  const sample = record(entry.sample);
  return {
    hostId: string(entry.hostId),
    receivedAtMs: number(entry.receivedAtMs),
    sample: {
      seq: string(sample.seq),
      atMs: string(sample.atMs),
      monoMs: string(sample.monoMs),
      ...(sample.uptimeMs === undefined ? {} : { uptimeMs: string(sample.uptimeMs) }),
      ...(sample.cpuCount === undefined ? {} : { cpuCount: number(sample.cpuCount) })
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

function decodeHistoryBase(entry: JsonObject): HistoryBase {
  const resolution = entry.resolution;
  if (resolution !== "raw" && resolution !== "1m") throw new Error("expected a history resolution");
  return {
    hostId: string(entry.hostId),
    range: string(entry.range),
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

function failureMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "The request was cancelled.";
  return error instanceof Error ? error.message : "The request could not be sent.";
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return "Sign in through Cloudflare Access.";
  if (status === 404) return "No telemetry is stored for this host.";
  if (status === 429) return "Telemetry is rate limited. Try again shortly.";
  return `The telemetry service returned ${status}.`;
}

async function getJson<T>(path: string, decode: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store", signal });
  } catch (error) {
    throw new ApiFailure(0, failureMessage(error));
  }
  if (!response.ok) throw new ApiFailure(response.status, statusMessage(response.status));
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiFailure(0, "The response was not telemetry JSON. Sign in through Cloudflare Access.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiFailure(0, "The response was not valid JSON.");
  }
  try {
    return decode(body);
  } catch {
    throw new ApiFailure(0, "The response did not match the telemetry contract.");
  }
}

const hostPath = (hostId: string, suffix = "") => `/api/v1/hosts/${encodeURIComponent(hostId)}${suffix}`;

export async function getHosts(signal: AbortSignal): Promise<readonly Host[]> {
  const body = await getJson("/api/v1/hosts", value => array(record(value).hosts, decodeHost), signal);
  return body;
}

export async function getLatest(hostId: string, signal: AbortSignal): Promise<Latest | null> {
  try {
    return await getJson(hostPath(hostId, "/latest"), decodeLatest, signal);
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 404) return null;
    throw error;
  }
}

export function getSummary(hostId: string, range: string, signal: AbortSignal): Promise<SummaryHistory> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=summary`, decodeSummaryHistory, signal);
}

export function getDisks(hostId: string, range: string, signal: AbortSignal): Promise<DiskHistory> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=disks`, decodeDiskHistory, signal);
}

export function getNets(hostId: string, range: string, signal: AbortSignal): Promise<NetHistory> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=nets`, decodeNetHistory, signal);
}

export function getFilesystems(hostId: string, range: string, signal: AbortSignal): Promise<FilesystemHistory> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=filesystems`, decodeFilesystemHistory, signal);
}

export function getBlock(hostId: string, range: string, signal: AbortSignal): Promise<BlockHistory> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=block`, decodeBlockHistory, signal);
}
