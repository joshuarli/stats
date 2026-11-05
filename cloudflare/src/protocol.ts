export const MAX_SAMPLES = 16;
export const MAX_DEVICES = 16;
export const MAX_SAFE_INTEGER = 9_007_199_254_740_991n;

export interface Cpu {
  readonly user: string;
  readonly system: string;
  readonly idle: string;
  readonly iowait?: string;
  readonly steal?: string;
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
  readonly swapIn?: string;
  readonly swapOut?: string;
  readonly pressure?: MemoryPressure;
}

export const MEMORY_PRESSURE_LEVELS = ["normal", "warn", "critical"] as const;
export type MemoryPressure = (typeof MEMORY_PRESSURE_LEVELS)[number];

export interface Disk {
  readonly id: string;
  readonly name: string;
  readonly reads: string;
  readonly readSectors: string;
  readonly writes: string;
  readonly writeSectors: string;
  readonly ioMs?: string;
}

export interface Net {
  readonly id: string;
  readonly rxBytes: string;
  readonly rxPackets: string;
  readonly rxDrops: string;
  readonly rxErrors: string;
  readonly txBytes: string;
  readonly txPackets: string;
  readonly txDrops?: string;
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
  readonly type: (typeof FS_TYPES)[number];
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

export interface Gpu {
  readonly active: string;
  readonly total: string;
}

export interface Power {
  readonly gpuNj?: string;
  readonly systemMwSum?: string;
  readonly systemReadings?: string;
}

export interface MeasuredService {
  readonly name: string;
  readonly cpuUsec: string;
  readonly memoryCurrent?: string;
  readonly memoryPeak?: string;
  readonly ioReadBytes?: string;
  readonly ioWriteBytes?: string;
  readonly ioReads?: string;
  readonly ioWrites?: string;
}

export interface UnavailableService {
  readonly name: string;
  readonly unavailable: true;
}

export type Service = MeasuredService | UnavailableService;

export type UnavailableGroup = (typeof UNAVAILABLE_GROUPS)[number];

export interface Sample {
  readonly seq: string;
  readonly atMs: string;
  readonly monoMs: string;
  readonly unavailable?: readonly UnavailableGroup[];
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
  readonly gpu?: Gpu;
  readonly power?: Power;
  readonly services?: readonly Service[];
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

export const UNAVAILABLE_GROUPS = ["cpu", "load", "mem", "uptime", "disks", "nets", "psi", "filesystems", "gpu", "power", "services"] as const;
export const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
export const FS_TYPES = ["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "vfat", "exfat", "ntfs3", "zfs", "tmpfs", "overlay", "apfs"] as const;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
