import { MAX_SAFE_INTEGER, UNAVAILABLE_GROUPS, type Block, type Cpu, type Disk, type FileSystem, type Mem, type Net, type Power, type Psi, type PsiGroup, type Sample, type Service, type SystemInfo } from "../protocol.ts";
import { GROUP, type WireBlock, type WirePsiGroup, type WireSample, type WireService, type WireSystem } from "./frame.ts";

export type SampleResult =
  | { readonly ok: true; readonly sample: Sample; readonly atMs: number; readonly monoMs: number }
  | { readonly ok: false; readonly seq: string; readonly message: string };

const LOAD_MAX = 999_999_999n;
const PSI_MAX = 99_999_999n;
const UNAVAILABLE_BITS = [GROUP.cpu, GROUP.load, GROUP.mem, GROUP.uptime, GROUP.disks, GROUP.nets, GROUP.psi, GROUP.filesystems, GROUP.gpu, GROUP.power, GROUP.services] as const;

function decimal(value: bigint): string {
  return value.toString();
}

function fixed(value: bigint, scale: bigint, digits: number): string {
  return `${value / scale}.${(value % scale).toString().padStart(digits, "0")}`;
}

function psiGroup(group: WirePsiGroup): PsiGroup {
  const some = { some10: fixed(group.some10, 100n, 2), some60: fixed(group.some60, 100n, 2), some300: fixed(group.some300, 100n, 2), total: decimal(group.total) };
  if (group.full === undefined) return some;
  return { ...some, full10: fixed(group.full.avg10, 100n, 2), full60: fixed(group.full.avg60, 100n, 2), full300: fixed(group.full.avg300, 100n, 2), fullTotal: decimal(group.full.total) };
}

function psiAverages(group: WirePsiGroup | undefined): readonly bigint[] {
  if (group === undefined) return [];
  return [group.some10, group.some60, group.some300, ...(group.full === undefined ? [] : [group.full.avg10, group.full.avg60, group.full.avg300])];
}

function service(entry: WireService): Service {
  const usage = entry.usage;
  if (usage === undefined) return { name: entry.name, unavailable: true };
  return {
    name: entry.name, cpuUsec: decimal(usage.cpuUsec),
    ...(usage.memory === undefined ? {} : { memoryCurrent: decimal(usage.memory.current) }),
    ...(usage.memory?.peak === undefined ? {} : { memoryPeak: decimal(usage.memory.peak) }),
    ...(usage.io === undefined ? {} : { ioReadBytes: decimal(usage.io.readBytes), ioWriteBytes: decimal(usage.io.writeBytes), ioReads: decimal(usage.io.reads), ioWrites: decimal(usage.io.writes) })
  };
}

function blockProblem(block: WireBlock): string | null {
  const sum = block.buckets.reduce((total, bucket) => total + bucket, 0n);
  if (sum !== block.count) return "block count is not the sum of its buckets";
  if (block.count === 0n) return block.totalUs === 0n && block.minUs === 0n && block.maxUs === 0n ? null : "an empty block histogram has non-zero totals";
  return block.minUs <= block.maxUs && block.maxUs <= block.totalUs ? null : "block minimum, maximum, and total are inconsistent";
}

function problem(sample: WireSample): string | null {
  if (sample.atMs > MAX_SAFE_INTEGER || sample.monoMs > MAX_SAFE_INTEGER || sample.seq > MAX_SAFE_INTEGER) return "seq, atMs, or monoMs exceeds 2^53-1";
  const metric = sample.cpu ?? sample.load ?? sample.mem ?? sample.uptimeMs ?? sample.disks ?? sample.nets ?? sample.psi ?? sample.filesystems ?? sample.block ?? sample.gpu ?? sample.power ?? sample.services;
  if (metric === undefined) return "sample has no metric group";
  if (sample.load !== undefined && [sample.load.one, sample.load.five, sample.load.fifteen].some(value => value > LOAD_MAX)) return "load exceeds 999999.999";
  if (sample.psi !== undefined && [sample.psi.cpu, sample.psi.memory, sample.psi.io].flatMap(psiAverages).some(value => value > PSI_MAX)) return "psi average exceeds 999999.99";
  if (sample.cpuCount !== undefined && (sample.cpuCount < 1n || sample.cpuCount > 4096n)) return "cpuCount is outside 1-4096";
  if (sample.block !== undefined) return blockProblem(sample.block);
  return null;
}

function normalize(sample: WireSample): Sample {
  const unavailable = UNAVAILABLE_GROUPS.filter((_, index) => (sample.unavailable & UNAVAILABLE_BITS[index]!) !== 0);
  const cpu: Cpu | undefined = sample.cpu === undefined ? undefined : {
    user: decimal(sample.cpu.user), system: decimal(sample.cpu.system), idle: decimal(sample.cpu.idle),
    ...(sample.cpu.iowait === undefined ? {} : { iowait: decimal(sample.cpu.iowait) }),
    ...(sample.cpu.steal === undefined ? {} : { steal: decimal(sample.cpu.steal) }),
    total: decimal(sample.cpu.total)
  };
  const mem: Mem | undefined = sample.mem === undefined ? undefined : {
    total: decimal(sample.mem.total), available: decimal(sample.mem.available), swapTotal: decimal(sample.mem.swapTotal), swapFree: decimal(sample.mem.swapFree),
    ...(sample.mem.swap === undefined ? {} : { swapIn: decimal(sample.mem.swap.swapIn), swapOut: decimal(sample.mem.swap.swapOut) }),
    ...(sample.mem.pressure === undefined ? {} : { pressure: sample.mem.pressure })
  };
  const disks: Disk[] | undefined = sample.disks?.map(disk => ({
    id: `${disk.entry.major}:${disk.entry.minor}`, name: disk.entry.name,
    reads: decimal(disk.reads), readSectors: decimal(disk.readSectors), writes: decimal(disk.writes), writeSectors: decimal(disk.writeSectors),
    ...(disk.ioMs === undefined ? {} : { ioMs: decimal(disk.ioMs) }),
    ...(disk.readMs === undefined ? {} : { readMs: decimal(disk.readMs) }),
    ...(disk.writeMs === undefined ? {} : { writeMs: decimal(disk.writeMs) }),
    ...(disk.weightedIoMs === undefined ? {} : { weightedIoMs: decimal(disk.weightedIoMs) }),
    ...(disk.inFlight === undefined ? {} : { inFlight: decimal(disk.inFlight) })
  }));
  const nets: Net[] | undefined = sample.nets?.map(net => ({
    id: net.name, rxBytes: decimal(net.rxBytes), rxPackets: decimal(net.rxPackets), rxDrops: decimal(net.rxDrops), rxErrors: decimal(net.rxErrors),
    txBytes: decimal(net.txBytes), txPackets: decimal(net.txPackets), txErrors: decimal(net.txErrors),
    ...(net.txDrops === undefined ? {} : { txDrops: decimal(net.txDrops) })
  }));
  const psi: Psi | undefined = sample.psi === undefined ? undefined : {
    ...(sample.psi.cpu === undefined ? {} : { cpu: psiGroup(sample.psi.cpu) }),
    ...(sample.psi.memory === undefined ? {} : { memory: psiGroup(sample.psi.memory) }),
    ...(sample.psi.io === undefined ? {} : { io: psiGroup(sample.psi.io) })
  };
  const filesystems: FileSystem[] | undefined = sample.filesystems?.map(filesystem => ({ id: filesystem.entry.path, type: filesystem.entry.type, total: decimal(filesystem.total), available: decimal(filesystem.available) }));
  const block: Block | undefined = sample.block === undefined ? undefined : { buckets: sample.block.buckets.map(decimal), count: decimal(sample.block.count), totalUs: decimal(sample.block.totalUs), minUs: decimal(sample.block.minUs), maxUs: decimal(sample.block.maxUs) };
  const power: Power | undefined = sample.power === undefined ? undefined : {
    ...(sample.power.gpuNj === undefined ? {} : { gpuNj: decimal(sample.power.gpuNj) }),
    ...(sample.power.system === undefined ? {} : { systemMwSum: decimal(sample.power.system.milliwattSum), systemReadings: decimal(sample.power.system.readings) })
  };
  return {
    seq: decimal(sample.seq), atMs: decimal(sample.atMs), monoMs: decimal(sample.monoMs),
    ...(unavailable.length === 0 ? {} : { unavailable }),
    ...(cpu === undefined ? {} : { cpu }),
    ...(sample.load === undefined ? {} : { load: { one: fixed(sample.load.one, 1000n, 3), five: fixed(sample.load.five, 1000n, 3), fifteen: fixed(sample.load.fifteen, 1000n, 3) } }),
    ...(mem === undefined ? {} : { mem }),
    ...(sample.uptimeMs === undefined ? {} : { uptimeMs: decimal(sample.uptimeMs) }),
    ...(sample.cpuCount === undefined ? {} : { cpuCount: Number(sample.cpuCount) }),
    ...(disks === undefined ? {} : { disks }),
    ...(nets === undefined ? {} : { nets }),
    ...(psi === undefined ? {} : { psi }),
    ...(filesystems === undefined ? {} : { filesystems }),
    ...(block === undefined ? {} : { block }),
    ...(sample.gpu === undefined ? {} : { gpu: { active: decimal(sample.gpu.active), total: decimal(sample.gpu.total) } }),
    ...(power === undefined ? {} : { power }),
    ...(sample.services === undefined ? {} : { services: sample.services.map(service) })
  };
}

export function validateSample(sample: WireSample): SampleResult {
  const message = problem(sample);
  if (message !== null) return { ok: false, seq: decimal(sample.seq), message };
  return { ok: true, sample: normalize(sample), atMs: Number(sample.atMs), monoMs: Number(sample.monoMs) };
}

export function normalizeSystem(system: WireSystem): SystemInfo {
  return {
    agent: system.agent, hostname: system.hostname, kernel: system.kernel, arch: system.arch,
    ...(system.os === undefined ? {} : { os: system.os }),
    cpu: {
      threads: system.threads,
      ...(system.model === undefined ? {} : { model: system.model }),
      ...(system.cores === undefined ? {} : { cores: system.cores }),
      ...(system.sockets === undefined ? {} : { sockets: system.sockets }),
      ...(system.maxMhz === undefined ? {} : { maxMhz: system.maxMhz })
    }
  };
}
