export const MAX_BODY_BYTES = 65_536;
export const MAX_SAMPLES = 16;
export const MAX_DEVICES = 16;
export const MAX_SAFE_INTEGER = 9_007_199_254_740_991n;
export const U64_MAX = 18_446_744_073_709_551_615n;

export type RejectCode = "too_large" | "invalid_json" | "unknown_version" | "invalid_batch" | "invalid_sample";

export interface Cpu {
  readonly user: string;
  readonly system: string;
  readonly idle: string;
  readonly iowait: string;
  readonly steal: string;
  readonly total: string;
}

export interface Load {
  readonly one: string;
  readonly five: string;
  readonly fifteen: string;
}

export interface Mem {
  readonly total: string;
  readonly available: string;
  readonly swapTotal: string;
  readonly swapFree: string;
}

export interface Disk {
  readonly id: string;
  readonly name: string;
  readonly reads: string;
  readonly readSectors: string;
  readonly writes: string;
  readonly writeSectors: string;
  readonly ioMs: string;
}

export interface Net {
  readonly id: string;
  readonly rxBytes: string;
  readonly rxPackets: string;
  readonly rxDrops: string;
  readonly rxErrors: string;
  readonly txBytes: string;
  readonly txPackets: string;
  readonly txDrops: string;
  readonly txErrors: string;
}

export interface PsiGroup {
  readonly some10: string;
  readonly some60: string;
  readonly some300: string;
  readonly total: string;
  readonly full10?: string;
  readonly full60?: string;
  readonly full300?: string;
  readonly fullTotal?: string;
}

export interface Psi {
  readonly cpu?: PsiGroup;
  readonly memory?: PsiGroup;
  readonly io?: PsiGroup;
}

export interface FileSystem {
  readonly id: string;
  readonly type: string;
  readonly total: string;
  readonly available: string;
}

export interface Block {
  readonly buckets: readonly string[];
  readonly count: string;
  readonly totalUs: string;
  readonly minUs: string;
  readonly maxUs: string;
}

export interface Sample {
  readonly seq: string;
  readonly atMs: string;
  readonly monoMs: string;
  readonly unavailable?: readonly string[];
  readonly cpu?: Cpu;
  readonly load?: Load;
  readonly mem?: Mem;
  readonly uptimeMs?: string;
  readonly cpuCount?: number;
  readonly disks?: readonly Disk[];
  readonly nets?: readonly Net[];
  readonly psi?: Psi;
  readonly filesystems?: readonly FileSystem[];
  readonly block?: Block;
}

export type SampleResult =
  | { readonly ok: true; readonly sample: Sample }
  | { readonly ok: false; readonly code: "invalid_sample"; readonly message: string; readonly seq?: string };

export type BatchResult =
  | { readonly ok: true; readonly hostId: string; readonly bootId: string; readonly samples: readonly SampleResult[] }
  | { readonly ok: false; readonly code: RejectCode; readonly message: string };

const SAMPLE_KEYS = ["seq", "atMs", "monoMs", "unavailable", "cpu", "load", "mem", "uptimeMs", "cpuCount", "disks", "nets", "psi", "filesystems", "block"] as const;
const UNAVAILABLE_GROUPS = ["cpu", "load", "mem", "uptime", "disks", "nets", "psi", "filesystems"] as const;
const BLOCK_BUCKETS = 16;
const FS_TYPES = ["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "vfat", "exfat", "ntfs3", "zfs", "tmpfs", "overlay"] as const;
const HOST = /^h_[0-9a-f]{32}$/u;
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/u;
const FIXED = /^(0|[1-9][0-9]{0,5})\.[0-9]+$/u;
const DISK_ID = /^[0-9]{1,6}:[0-9]{1,6}$/u;
const DISK_NAME = /^[A-Za-z0-9._-]{1,32}$/u;
const IFNAME = /^[A-Za-z0-9_.:@-]{1,15}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function subset(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every(key => keys.includes(key));
}

function decimal(value: unknown, max: bigint = U64_MAX): value is string {
  if (typeof value !== "string" || !DECIMAL.test(value)) return false;
  return BigInt(value) <= max;
}

function safeDecimal(value: unknown): value is string {
  return decimal(value, MAX_SAFE_INTEGER);
}

function fixed(value: unknown, digits: number): value is string {
  return typeof value === "string" && FIXED.test(value) && (value.split(".")[1]?.length ?? 0) === digits;
}

function u64Fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return exact(value, keys) && keys.every(key => decimal(value[key]));
}

function arrayUnique(value: unknown, key: string, limit: number): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!record(entry) || typeof entry[key] !== "string" || ids.has(entry[key])) return null;
    ids.add(entry[key]);
  }
  return value as Record<string, unknown>[];
}

function parseBlock(value: unknown): Block | null {
  if (!exact(value, ["buckets", "count", "totalUs", "minUs", "maxUs"])) return null;
  const buckets = value.buckets;
  if (!Array.isArray(buckets) || buckets.length !== BLOCK_BUCKETS || !buckets.every(bucket => decimal(bucket))) return null;
  if (!decimal(value.count) || !decimal(value.totalUs) || !decimal(value.minUs) || !decimal(value.maxUs)) return null;
  const count = BigInt(value.count);
  const total = BigInt(value.totalUs);
  const min = BigInt(value.minUs);
  const max = BigInt(value.maxUs);
  if (buckets.reduce((sum, bucket) => sum + BigInt(bucket as string), 0n) !== count) return null;
  if (count === 0n) {
    if (total !== 0n || min !== 0n || max !== 0n) return null;
  } else if (min > max || max > total) {
    return null;
  }
  return value as unknown as Block;
}

function parsePsiGroup(value: unknown): PsiGroup | null {
  if (!subset(value, ["some10", "some60", "some300", "total", "full10", "full60", "full300", "fullTotal"])) return null;
  if (!["some10", "some60", "some300", "total"].every(key => key in value)) return null;
  if (!["some10", "some60", "some300"].every(key => fixed(value[key], 2)) || !decimal(value.total)) return null;
  const full = ["full10", "full60", "full300", "fullTotal"].filter(key => key in value);
  if (full.length !== 0 && full.length !== 4) return null;
  if (full.length === 4 && (!["full10", "full60", "full300"].every(key => fixed(value[key], 2)) || !decimal(value.fullTotal))) return null;
  return value as unknown as PsiGroup;
}

export function parseSample(value: unknown): SampleResult {
  if (!subset(value, SAMPLE_KEYS)) return { ok: false, code: "invalid_sample", message: "unknown sample field" };
  const seq = value.seq;
  if (!safeDecimal(seq)) return { ok: false, code: "invalid_sample", message: "seq is not a bounded decimal string" };
  const fail = (message: string): SampleResult => ({ ok: false, code: "invalid_sample", message, seq });
  if (!safeDecimal(value.atMs) || !safeDecimal(value.monoMs)) return fail("timestamp or monotonic clock is not bounded");
  const unavailable = value.unavailable;
  if (unavailable !== undefined) {
    if (!Array.isArray(unavailable) || unavailable.length > 8) return fail("unavailable must be a bounded array");
    const seen = new Set<string>();
    for (const group of unavailable) {
      if (typeof group !== "string" || !(UNAVAILABLE_GROUPS as readonly string[]).includes(group) || seen.has(group)) return fail("unavailable contains an unknown or repeated group");
      seen.add(group);
    }
  }
  const metrics = ["cpu", "load", "mem", "uptimeMs", "disks", "nets", "psi", "filesystems", "block"].filter(key => value[key] !== undefined);
  if (metrics.length === 0) return fail("sample has no metric group");
  if (value.unavailable !== undefined) {
    for (const group of value.unavailable as string[]) {
      const present = group === "uptime" ? "uptimeMs" : group;
      if (value[present] !== undefined) return fail(`${group} is both present and unavailable`);
    }
  }
  if (value.cpu !== undefined && !u64Fields(value.cpu, ["user", "system", "idle", "iowait", "steal", "total"])) return fail("cpu counters");
  const load = value.load;
  if (load !== undefined && (!exact(load, ["one", "five", "fifteen"]) || !["one", "five", "fifteen"].every(key => fixed(load[key], 3)))) return fail("load");
  if (value.mem !== undefined && !u64Fields(value.mem, ["total", "available", "swapTotal", "swapFree"])) return fail("mem");
  if (value.uptimeMs !== undefined && !decimal(value.uptimeMs)) return fail("uptimeMs");
  const cpuCount = value.cpuCount;
  if (cpuCount !== undefined && (typeof cpuCount !== "number" || !Number.isInteger(cpuCount) || cpuCount < 1 || cpuCount > 4096)) return fail("cpuCount");
  if (value.disks !== undefined) {
    const disks = arrayUnique(value.disks, "id", MAX_DEVICES);
    if (disks === null || !disks.every(disk => exact(disk, ["id", "name", "reads", "readSectors", "writes", "writeSectors", "ioMs"]) && typeof disk.id === "string" && DISK_ID.test(disk.id) && typeof disk.name === "string" && DISK_NAME.test(disk.name) && ["reads", "readSectors", "writes", "writeSectors", "ioMs"].every(key => decimal(disk[key])))) return fail("disks");
  }
  if (value.nets !== undefined) {
    const nets = arrayUnique(value.nets, "id", MAX_DEVICES);
    if (nets === null || !nets.every(net => exact(net, ["id", "rxBytes", "rxPackets", "rxDrops", "rxErrors", "txBytes", "txPackets", "txDrops", "txErrors"]) && typeof net.id === "string" && IFNAME.test(net.id) && ["rxBytes", "rxPackets", "rxDrops", "rxErrors", "txBytes", "txPackets", "txDrops", "txErrors"].every(key => decimal(net[key])))) return fail("nets");
  }
  if (value.psi !== undefined) {
    if (!subset(value.psi, ["cpu", "memory", "io"]) || Object.keys(value.psi).length === 0) return fail("psi");
    for (const group of Object.values(value.psi)) if (parsePsiGroup(group) === null) return fail("psi group");
  }
  if (value.filesystems !== undefined) {
    const filesystems = arrayUnique(value.filesystems, "id", MAX_DEVICES);
    if (filesystems === null || !filesystems.every(filesystem => exact(filesystem, ["id", "type", "total", "available"]) && typeof filesystem.id === "string" && filesystem.id.startsWith("/") && filesystem.id.length <= 255 && !filesystem.id.includes("\0") && typeof filesystem.type === "string" && (FS_TYPES as readonly string[]).includes(filesystem.type) && decimal(filesystem.total) && decimal(filesystem.available))) return fail("filesystems");
  }
  if (value.block !== undefined && parseBlock(value.block) === null) return fail("block");
  return { ok: true, sample: value as unknown as Sample };
}

export function parseBatch(text: string): BatchResult {
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, code: "too_large", message: "batch exceeds the body cap" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_json", message: "body is not valid JSON" };
  }
  if (!exact(value, ["v", "hostId", "bootId", "samples"])) return { ok: false, code: "invalid_batch", message: "batch shape" };
  if (value.v !== 1) return { ok: false, code: "unknown_version", message: "unknown protocol version" };
  if (typeof value.hostId !== "string" || !HOST.test(value.hostId) || typeof value.bootId !== "string" || !BOOT.test(value.bootId)) return { ok: false, code: "invalid_batch", message: "host or boot identity" };
  if (!Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > MAX_SAMPLES) return { ok: false, code: "invalid_batch", message: "sample count" };
  return { ok: true, hostId: value.hostId, bootId: value.bootId, samples: value.samples.map(parseSample) };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sampleBytes(sample: Sample): number {
  return new TextEncoder().encode(canonicalJson(sample)).length;
}
