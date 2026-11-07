import type { Block, Cpu, Disk, FileSystem, Gpu, MemoryPressure, Net, Power, PsiGroup, Sample } from "./protocol.ts";
import type { Delta, SwapDelta } from "./delta.ts";
import { DISK_FIELDS, NET_FIELDS } from "./delta.ts";
import { BLOCK_BOUNDS_US, BLOCK_BUCKETS, HISTORY_KINDS, MAX_POINTS, RANGES, RANGE_MS, type HistoryKind, type RangeKey } from "./limits.ts";

export type HistoryQuery = { readonly range: RangeKey } | { readonly fromMs: number; readonly toMs: number };

export interface CpuPercent {
  readonly user: number;
  readonly system: number;
  readonly idle: number;
  readonly iowait?: number;
  readonly steal?: number;
}
export interface LoadValues {
  readonly one: number;
  readonly five: number;
  readonly fifteen: number;
}
export interface MemValues {
  readonly total: number;
  readonly available: number;
  readonly swapUsed: number;
  readonly swapInBytesPerSec?: number;
  readonly swapOutBytesPerSec?: number;
  readonly pressure?: MemoryPressureShare;
}
export interface MemoryPressureShare {
  readonly warnPct: number;
  readonly criticalPct: number;
}
export interface PsiGroupAverages {
  readonly some10: number;
  readonly some60: number;
  readonly some300: number;
  readonly full10?: number;
  readonly full60?: number;
  readonly full300?: number;
}
export interface PsiAverages {
  readonly cpu?: PsiGroupAverages;
  readonly memory?: PsiGroupAverages;
  readonly io?: PsiGroupAverages;
}
export interface GpuValues {
  readonly busyPct: number;
}
export interface PowerValues {
  readonly gpuWatts?: number;
  readonly systemWatts?: number;
}
export interface SummaryPoint {
  readonly atMs: number;
  readonly coverageMs: number;
  readonly partial: boolean;
  readonly cpu?: CpuPercent;
  readonly load?: LoadValues;
  readonly mem?: MemValues;
  readonly psi?: PsiAverages;
  readonly gpu?: GpuValues;
  readonly power?: PowerValues;
  readonly cpuCount?: number;
  readonly uptimeMs?: number;
}
export interface DiskPoint {
  readonly atMs: number;
  readonly readBytesPerSec: number;
  readonly writeBytesPerSec: number;
  readonly readsPerSec: number;
  readonly writesPerSec: number;
  readonly busyPct?: number;
  readonly readLatencyMs?: number;
  readonly writeLatencyMs?: number;
  readonly queueDepth?: number;
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
export interface BlockRollup {
  readonly buckets: readonly string[];
  readonly count: string;
  readonly totalUs: string;
  readonly minUs: string;
  readonly maxUs: string;
}
export interface Series<P> {
  readonly id: string;
  readonly name?: string;
  readonly points: P[];
}

interface Gauge {
  readonly sum: number;
  readonly count: number;
}
export interface SwapRollup extends SwapDelta {
  readonly coveredMs: number;
}
export interface PowerRollup extends Power {
  readonly gpuCoveredMs?: number;
}
interface FileSums {
  readonly total: Gauge;
  readonly available: Gauge;
}
export interface ServiceRollup {
  readonly cpu?: { readonly usec: string; readonly coveredMs: number };
  readonly io?: { readonly readBytes: string; readonly writeBytes: string; readonly coveredMs: number };
  readonly memoryCurrent?: Gauge;
}
export interface ServiceLevels {
  readonly cpuCores?: number;
  readonly memoryBytes?: number;
  readonly ioBytesPerSec?: number;
}
export interface RollupPayload {
  readonly v: 1;
  readonly bucketMs: number;
  readonly samples: number;
  readonly coverageMs: number;
  readonly partial: boolean;
  readonly cpu?: Cpu;
  readonly swap?: SwapRollup;
  readonly gpu?: Gpu;
  readonly power?: PowerRollup;
  readonly gauges: Readonly<Record<string, Gauge>>;
  readonly psi: Readonly<Record<string, Readonly<Record<string, Gauge>>>>;
  readonly disks: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly nets: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly filesystems: Readonly<Record<string, FileSums>>;
  readonly block?: BlockRollup;
  readonly services?: Readonly<Record<string, ServiceRollup>>;
}

export interface RawRow {
  readonly sample: Sample;
  readonly delta: Delta;
}

const DEVICE_COVERAGE = "coveredMs";
const READS_TIMED = "readsTimed";
const WRITES_TIMED = "writesTimed";
const WEIGHTED_COVERAGE = "weightedCoveredMs";

function meanLatencyMs(timeMs: string | undefined, operations: string | undefined): number | undefined {
  if (timeMs === undefined || operations === undefined) return undefined;
  const completed = Number(operations);
  return completed > 0 ? Number(timeMs) / completed : undefined;
}

function queueDepth(weightedMs: string | undefined, coverageMs: string | undefined): number | undefined {
  if (weightedMs === undefined || coverageMs === undefined) return undefined;
  const covered = Number(coverageMs);
  return covered > 0 ? Number(weightedMs) / covered : undefined;
}

function diskLatencyPoint(values: { readonly readLatencyMs: number | undefined; readonly writeLatencyMs: number | undefined; readonly queueDepth: number | undefined }): Pick<DiskPoint, "readLatencyMs" | "writeLatencyMs" | "queueDepth"> {
  return {
    ...(values.readLatencyMs === undefined ? {} : { readLatencyMs: values.readLatencyMs }),
    ...(values.writeLatencyMs === undefined ? {} : { writeLatencyMs: values.writeLatencyMs }),
    ...(values.queueDepth === undefined ? {} : { queueDepth: values.queueDepth })
  };
}
const PSI_FIELDS = ["some10", "some60", "some300", "full10", "full60", "full300"] as const;

export function rangeKey(value: string | null): RangeKey | null {
  return value !== null && (RANGES as readonly string[]).includes(value) ? value as RangeKey : null;
}

export function historyQuery(params: URLSearchParams): HistoryQuery | null {
  const range = params.get("range");
  const from = params.get("from");
  const to = params.get("to");
  if (from === null && to === null) {
    const key = range === null ? "1h" : rangeKey(range);
    return key === null ? null : { range: key };
  }
  if (range !== null || from === null || to === null || !/^[0-9]{1,15}$/u.test(from) || !/^[0-9]{1,15}$/u.test(to)) return null;
  const fromMs = Number(from);
  const toMs = Number(to);
  return fromMs < toMs && toMs - fromMs <= RANGE_MS["30d"] ? { fromMs, toMs } : null;
}

export function kindValue(value: string | null): HistoryKind | null {
  return value !== null && (HISTORY_KINDS as readonly string[]).includes(value) ? value as HistoryKind : null;
}

export function kindsValue(value: string): HistoryKind[] | null {
  const kinds: HistoryKind[] = [];
  for (const part of value.split(",")) {
    const kind = kindValue(part);
    if (kind === null) return null;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function gaugeAdd(gauges: Record<string, Gauge>, key: string, value: number): void {
  const current = gauges[key];
  gauges[key] = { sum: (current?.sum ?? 0) + value, count: (current?.count ?? 0) + 1 };
}

function gaugeAverage(gauges: Readonly<Record<string, Gauge>>, key: string): number | undefined {
  const value = gauges[key];
  return value === undefined || value.count === 0 ? undefined : value.sum / value.count;
}

function psiAverages(sample: Sample): PsiAverages | undefined {
  if (sample.psi === undefined) return undefined;
  const group = (value: PsiGroup): PsiGroupAverages => ({
    some10: Number(value.some10),
    some60: Number(value.some60),
    some300: Number(value.some300),
    ...(value.full10 === undefined || value.full60 === undefined || value.full300 === undefined ? {} : { full10: Number(value.full10), full60: Number(value.full60), full300: Number(value.full300) })
  });
  return {
    ...(sample.psi.cpu === undefined ? {} : { cpu: group(sample.psi.cpu) }),
    ...(sample.psi.memory === undefined ? {} : { memory: group(sample.psi.memory) }),
    ...(sample.psi.io === undefined ? {} : { io: group(sample.psi.io) })
  };
}

function cpuPercent(cpu: Cpu): CpuPercent | undefined {
  const total = Number(cpu.total);
  if (!Number.isFinite(total) || total <= 0) return undefined;
  const share = (value: string) => (Number(value) / total) * 100;
  return {
    user: share(cpu.user),
    system: share(cpu.system),
    idle: share(cpu.idle),
    ...(cpu.iowait === undefined ? {} : { iowait: share(cpu.iowait) }),
    ...(cpu.steal === undefined ? {} : { steal: share(cpu.steal) })
  };
}

function pressureShare(level: MemoryPressure | undefined): MemoryPressureShare | undefined {
  if (level === undefined) return undefined;
  return { warnPct: level === "normal" ? 0 : 100, criticalPct: level === "critical" ? 100 : 0 };
}

function sumCpu(cpu: Cpu, add: Cpu): Cpu {
  return {
    user: (BigInt(cpu.user) + BigInt(add.user)).toString(),
    system: (BigInt(cpu.system) + BigInt(add.system)).toString(),
    idle: (BigInt(cpu.idle) + BigInt(add.idle)).toString(),
    total: (BigInt(cpu.total) + BigInt(add.total)).toString(),
    ...(cpu.iowait === undefined || add.iowait === undefined ? {} : { iowait: (BigInt(cpu.iowait) + BigInt(add.iowait)).toString() }),
    ...(cpu.steal === undefined || add.steal === undefined ? {} : { steal: (BigInt(cpu.steal) + BigInt(add.steal)).toString() })
  };
}

function sumSwap(target: SwapRollup | undefined, add: SwapDelta, coveredMs: number): SwapRollup {
  return {
    swapIn: (BigInt(target?.swapIn ?? "0") + BigInt(add.swapIn)).toString(),
    swapOut: (BigInt(target?.swapOut ?? "0") + BigInt(add.swapOut)).toString(),
    coveredMs: (target?.coveredMs ?? 0) + coveredMs
  };
}

function swapRates(swap: SwapDelta | undefined, coveredMs: number): { swapInBytesPerSec?: number; swapOutBytesPerSec?: number } {
  if (swap === undefined || coveredMs <= 0) return {};
  return { swapInBytesPerSec: (Number(swap.swapIn) * 1000) / coveredMs, swapOutBytesPerSec: (Number(swap.swapOut) * 1000) / coveredMs };
}

function sumGpu(target: Gpu | undefined, add: Gpu): Gpu {
  return { active: (BigInt(target?.active ?? "0") + BigInt(add.active)).toString(), total: (BigInt(target?.total ?? "0") + BigInt(add.total)).toString() };
}

function sumPower(target: PowerRollup | undefined, add: Power, gpuCoveredMs: number): PowerRollup {
  const gpuNj = add.gpuNj === undefined ? target?.gpuNj : (BigInt(target?.gpuNj ?? "0") + BigInt(add.gpuNj)).toString();
  const system = add.systemMwSum !== undefined && add.systemReadings !== undefined;
  const systemMwSum = system ? (BigInt(target?.systemMwSum ?? "0") + BigInt(add.systemMwSum!)).toString() : target?.systemMwSum;
  const systemReadings = system ? (BigInt(target?.systemReadings ?? "0") + BigInt(add.systemReadings!)).toString() : target?.systemReadings;
  const covered = add.gpuNj === undefined ? target?.gpuCoveredMs : (target?.gpuCoveredMs ?? 0) + gpuCoveredMs;
  return {
    ...(gpuNj === undefined ? {} : { gpuNj }),
    ...(covered === undefined ? {} : { gpuCoveredMs: covered }),
    ...(systemMwSum === undefined || systemReadings === undefined ? {} : { systemMwSum, systemReadings })
  };
}

function gpuValues(gpu: Gpu | undefined): GpuValues | undefined {
  if (gpu === undefined) return undefined;
  const total = Number(gpu.total);
  return total > 0 ? { busyPct: (Number(gpu.active) / total) * 100 } : undefined;
}

function powerValues(power: PowerRollup | undefined, gpuCoveredMs: number): PowerValues | undefined {
  if (power === undefined) return undefined;
  const gpuWatts = power.gpuNj === undefined || gpuCoveredMs <= 0 ? undefined : Number(power.gpuNj) / gpuCoveredMs / 1e6;
  const readings = power.systemReadings === undefined ? 0 : Number(power.systemReadings);
  const systemWatts = power.systemMwSum === undefined || readings <= 0 ? undefined : Number(power.systemMwSum) / readings / 1000;
  if (gpuWatts === undefined && systemWatts === undefined) return undefined;
  return { ...(gpuWatts === undefined ? {} : { gpuWatts }), ...(systemWatts === undefined ? {} : { systemWatts }) };
}

function sumDevices(target: Record<string, Record<string, string>>, source: Record<string, Record<string, string>>): void {
  for (const [id, values] of Object.entries(source)) {
    const current = target[id] ?? {};
    const next: Record<string, string> = { ...current };
    for (const [key, value] of Object.entries(values)) next[key] = (BigInt(current[key] ?? "0") + BigInt(value)).toString();
    target[id] = next;
  }
}

function addBlock(target: BlockRollup | undefined, source: Block | BlockRollup): BlockRollup {
  const buckets = Array.from({ length: BLOCK_BUCKETS }, (_, index) => (BigInt(target?.buckets[index] ?? "0") + BigInt(source.buckets[index] ?? "0")).toString());
  const count = BigInt(target?.count ?? "0") + BigInt(source.count);
  const totalUs = BigInt(target?.totalUs ?? "0") + BigInt(source.totalUs);
  const minUs = target === undefined || BigInt(source.minUs) < BigInt(target.minUs) ? source.minUs : target.minUs;
  const maxUs = target === undefined || BigInt(source.maxUs) > BigInt(target.maxUs) ? source.maxUs : target.maxUs;
  return { buckets, count: count.toString(), totalUs: totalUs.toString(), minUs, maxUs };
}

function addService(target: ServiceRollup | undefined, add: ServiceRollup): ServiceRollup {
  const cpu = add.cpu === undefined ? target?.cpu : { usec: (BigInt(target?.cpu?.usec ?? "0") + BigInt(add.cpu.usec)).toString(), coveredMs: (target?.cpu?.coveredMs ?? 0) + add.cpu.coveredMs };
  const io = add.io === undefined ? target?.io : {
    readBytes: (BigInt(target?.io?.readBytes ?? "0") + BigInt(add.io.readBytes)).toString(),
    writeBytes: (BigInt(target?.io?.writeBytes ?? "0") + BigInt(add.io.writeBytes)).toString(),
    coveredMs: (target?.io?.coveredMs ?? 0) + add.io.coveredMs
  };
  const memoryCurrent = add.memoryCurrent === undefined ? target?.memoryCurrent : { sum: (target?.memoryCurrent?.sum ?? 0) + add.memoryCurrent.sum, count: (target?.memoryCurrent?.count ?? 0) + add.memoryCurrent.count };
  return { ...(cpu === undefined ? {} : { cpu }), ...(io === undefined ? {} : { io }), ...(memoryCurrent === undefined ? {} : { memoryCurrent }) };
}

function rawServices(row: RawRow): Record<string, ServiceRollup> {
  const services: Record<string, ServiceRollup> = {};
  for (const service of row.sample.services ?? []) {
    if ("unavailable" in service || service.memoryCurrent === undefined) continue;
    services[service.name] = { memoryCurrent: { sum: Number(service.memoryCurrent), count: 1 } };
  }
  for (const [name, delta] of Object.entries(row.delta.services ?? {})) {
    const io = delta.ioReadBytes === undefined || delta.ioWriteBytes === undefined ? undefined : { readBytes: delta.ioReadBytes, writeBytes: delta.ioWriteBytes, coveredMs: row.delta.intervalMs };
    services[name] = { ...services[name], cpu: { usec: delta.cpuUsec, coveredMs: row.delta.intervalMs }, ...(io === undefined ? {} : { io }) };
  }
  return services;
}

function mergeServices(target: Record<string, ServiceRollup>, source: Readonly<Record<string, ServiceRollup>>): void {
  for (const [name, value] of Object.entries(source)) target[name] = addService(target[name], value);
}

export function serviceLevels(payload: RollupPayload, name: string, minCoveredMs: number): ServiceLevels {
  const service = payload.services?.[name];
  if (service === undefined) return {};
  const covered = Math.max(1, minCoveredMs);
  const cpu = service.cpu === undefined || service.cpu.coveredMs < covered ? undefined : Number(service.cpu.usec) / (service.cpu.coveredMs * 1000);
  const memory = service.memoryCurrent === undefined || service.memoryCurrent.count === 0 ? undefined : service.memoryCurrent.sum / service.memoryCurrent.count;
  const io = service.io === undefined || service.io.coveredMs < covered ? undefined : (Number(service.io.readBytes) + Number(service.io.writeBytes)) * 1000 / service.io.coveredMs;
  return { ...(cpu === undefined ? {} : { cpuCores: cpu }), ...(memory === undefined ? {} : { memoryBytes: memory }), ...(io === undefined ? {} : { ioBytesPerSec: io }) };
}

function blockPercentile(buckets: readonly string[], count: bigint, maxUs: string, percent: bigint): number {
  const target = (count * percent + 99n) / 100n;
  let cumulative = 0n;
  for (let index = 0; index < BLOCK_BUCKETS; index += 1) {
    cumulative += BigInt(buckets[index] ?? "0");
    if (cumulative >= target) return index === 15 ? Number(maxUs) : Math.min(BLOCK_BOUNDS_US[index]!, Number(maxUs));
  }
  return Number(maxUs);
}

export function blockPoint(atMs: number, block: Block | BlockRollup): BlockPoint | null {
  const count = BigInt(block.count);
  if (count === 0n) return null;
  return {
    atMs,
    count: Number(count),
    totalUs: Number(block.totalUs),
    minUs: Number(block.minUs),
    maxUs: Number(block.maxUs),
    p50Us: blockPercentile(block.buckets, count, block.maxUs, 50n),
    p95Us: blockPercentile(block.buckets, count, block.maxUs, 95n),
    p99Us: blockPercentile(block.buckets, count, block.maxUs, 99n)
  };
}

export function rollupFromRaw(rows: readonly RawRow[], bucketMs: number, spanMs: number): RollupPayload | null {
  if (rows.length === 0) return null;
  const coverageMs = rows.reduce((total, row) => total + row.delta.intervalMs, 0);
  let cpu: Cpu | undefined;
  let swap: SwapRollup | undefined;
  let gpu: Gpu | undefined;
  let power: PowerRollup | undefined;
  const gauges: Record<string, Gauge> = {};
  const psi: Record<string, Record<string, Gauge>> = {};
  const disks: Record<string, Record<string, string>> = {};
  const nets: Record<string, Record<string, string>> = {};
  const filesystems: Record<string, { total: Gauge; available: Gauge }> = {};
  const services: Record<string, ServiceRollup> = {};
  let block: BlockRollup | undefined;
  for (const row of rows) {
    const { sample, delta } = row;
    mergeServices(services, rawServices(row));
    if (delta.cpu !== undefined) cpu = cpu === undefined ? { ...delta.cpu } : sumCpu(cpu, delta.cpu);
    if (delta.swap !== undefined) swap = sumSwap(swap, delta.swap, delta.intervalMs);
    if (delta.gpu !== undefined) gpu = sumGpu(gpu, delta.gpu);
    if (delta.power !== undefined) power = sumPower(power, delta.power, delta.intervalMs);
    if (sample.load !== undefined) {
      gaugeAdd(gauges, "load.one", Number(sample.load.one));
      gaugeAdd(gauges, "load.five", Number(sample.load.five));
      gaugeAdd(gauges, "load.fifteen", Number(sample.load.fifteen));
    }
    if (sample.mem !== undefined) {
      gaugeAdd(gauges, "mem.total", Number(sample.mem.total));
      gaugeAdd(gauges, "mem.available", Number(sample.mem.available));
      gaugeAdd(gauges, "mem.swapUsed", Number(sample.mem.swapTotal) - Number(sample.mem.swapFree));
      const pressure = pressureShare(sample.mem.pressure);
      if (pressure !== undefined) {
        gaugeAdd(gauges, "mem.pressureWarnPct", pressure.warnPct);
        gaugeAdd(gauges, "mem.pressureCriticalPct", pressure.criticalPct);
      }
    }
    if (sample.uptimeMs !== undefined) gaugeAdd(gauges, "uptimeMs", Number(sample.uptimeMs));
    if (sample.cpuCount !== undefined) gaugeAdd(gauges, "cpuCount", sample.cpuCount);
    if (sample.psi !== undefined) {
      for (const [name, group] of [["cpu", sample.psi.cpu], ["memory", sample.psi.memory], ["io", sample.psi.io]] as const) {
        if (group === undefined) continue;
        const target = psi[name] ?? {};
        for (const field of PSI_FIELDS) {
          const value = group[field];
          if (value !== undefined) gaugeAdd(target, field, Number(value));
        }
        psi[name] = target;
      }
    }
    for (const [id, disk] of Object.entries(delta.disks)) {
      const target = disks[id] ?? {};
      for (const field of DISK_FIELDS) {
        const value = disk[field];
        if (value !== undefined) target[field] = (BigInt(target[field] ?? "0") + BigInt(value)).toString();
      }
      const addTo = (key: string, amount: string | number) => { target[key] = (BigInt(target[key] ?? "0") + BigInt(amount)).toString(); };
      if (disk.readMs !== undefined) addTo(READS_TIMED, disk.reads);
      if (disk.writeMs !== undefined) addTo(WRITES_TIMED, disk.writes);
      if (disk.weightedIoMs !== undefined) addTo(WEIGHTED_COVERAGE, delta.intervalMs);
      target[DEVICE_COVERAGE] = (BigInt(target[DEVICE_COVERAGE] ?? "0") + BigInt(delta.intervalMs)).toString();
      disks[id] = target;
    }
    for (const [id, net] of Object.entries(delta.nets)) {
      const target = nets[id] ?? {};
      for (const field of NET_FIELDS) {
        const value = net[field];
        if (value !== undefined) target[field] = (BigInt(target[field] ?? "0") + BigInt(value)).toString();
      }
      target[DEVICE_COVERAGE] = (BigInt(target[DEVICE_COVERAGE] ?? "0") + BigInt(delta.intervalMs)).toString();
      nets[id] = target;
    }
    for (const filesystem of sample.filesystems ?? []) {
      const target = filesystems[filesystem.id] ?? { total: { sum: 0, count: 0 }, available: { sum: 0, count: 0 } };
      filesystems[filesystem.id] = {
        total: { sum: target.total.sum + Number(filesystem.total), count: target.total.count + 1 },
        available: { sum: target.available.sum + Number(filesystem.available), count: target.available.count + 1 }
      };
    }
    if (sample.block !== undefined && BigInt(sample.block.count) > 0n) block = addBlock(block, sample.block);
  }
  return {
    v: 1,
    bucketMs,
    samples: rows.length,
    coverageMs,
    partial: coverageMs < spanMs * 0.8,
    ...(cpu === undefined ? {} : { cpu }),
    ...(swap === undefined ? {} : { swap }),
    ...(gpu === undefined ? {} : { gpu }),
    ...(power === undefined ? {} : { power }),
    gauges,
    psi,
    disks,
    nets,
    filesystems,
    ...(block === undefined ? {} : { block }),
    ...(Object.keys(services).length === 0 ? {} : { services })
  };
}

export function combineRollups(payloads: readonly RollupPayload[], bucketMs: number, spanMs: number): RollupPayload | null {
  if (payloads.length === 0) return null;
  let cpu: Cpu | undefined;
  let swap: SwapRollup | undefined;
  let gpu: Gpu | undefined;
  let power: PowerRollup | undefined;
  const gauges: Record<string, Gauge> = {};
  const psi: Record<string, Record<string, Gauge>> = {};
  const disks: Record<string, Record<string, string>> = {};
  const nets: Record<string, Record<string, string>> = {};
  const filesystems: Record<string, { total: Gauge; available: Gauge }> = {};
  const services: Record<string, ServiceRollup> = {};
  let block: BlockRollup | undefined;
  let coverageMs = 0;
  let samples = 0;
  for (const payload of payloads) {
    coverageMs += payload.coverageMs;
    samples += payload.samples;
    if (payload.cpu !== undefined) cpu = cpu === undefined ? { ...payload.cpu } : sumCpu(cpu, payload.cpu);
    if (payload.swap !== undefined) swap = sumSwap(swap, payload.swap, payload.swap.coveredMs);
    if (payload.gpu !== undefined) gpu = sumGpu(gpu, payload.gpu);
    if (payload.power !== undefined) power = sumPower(power, payload.power, payload.power.gpuCoveredMs ?? 0);
    for (const [key, value] of Object.entries(payload.gauges)) {
      const target = gauges[key] ?? { sum: 0, count: 0 };
      gauges[key] = { sum: target.sum + value.sum, count: target.count + value.count };
    }
    for (const [name, group] of Object.entries(payload.psi)) {
      const target = psi[name] ?? {};
      for (const [field, value] of Object.entries(group)) {
        const current = target[field] ?? { sum: 0, count: 0 };
        target[field] = { sum: current.sum + value.sum, count: current.count + value.count };
      }
      psi[name] = target;
    }
    sumDevices(disks, payload.disks);
    sumDevices(nets, payload.nets);
    for (const [id, value] of Object.entries(payload.filesystems)) {
      const target = filesystems[id] ?? { total: { sum: 0, count: 0 }, available: { sum: 0, count: 0 } };
      filesystems[id] = {
        total: { sum: target.total.sum + value.total.sum, count: target.total.count + value.total.count },
        available: { sum: target.available.sum + value.available.sum, count: target.available.count + value.available.count }
      };
    }
    if (payload.block !== undefined) block = addBlock(block, payload.block);
    if (payload.services !== undefined) mergeServices(services, payload.services);
  }
  return {
    v: 1,
    bucketMs,
    samples,
    coverageMs,
    partial: coverageMs < spanMs * 0.8,
    ...(cpu === undefined ? {} : { cpu }),
    ...(swap === undefined ? {} : { swap }),
    ...(gpu === undefined ? {} : { gpu }),
    ...(power === undefined ? {} : { power }),
    gauges,
    psi,
    disks,
    nets,
    filesystems,
    ...(block === undefined ? {} : { block }),
    ...(Object.keys(services).length === 0 ? {} : { services })
  };
}

function summaryFromRollup(payload: RollupPayload): SummaryPoint {
  const cpu = payload.cpu === undefined ? undefined : cpuPercent(payload.cpu);
  const load = gaugeAverage(payload.gauges, "load.one") === undefined ? undefined : {
    one: gaugeAverage(payload.gauges, "load.one")!,
    five: gaugeAverage(payload.gauges, "load.five")!,
    fifteen: gaugeAverage(payload.gauges, "load.fifteen")!
  };
  const mem = gaugeAverage(payload.gauges, "mem.total") === undefined ? undefined : {
    total: gaugeAverage(payload.gauges, "mem.total")!,
    available: gaugeAverage(payload.gauges, "mem.available")!,
    swapUsed: gaugeAverage(payload.gauges, "mem.swapUsed")!,
    ...swapRates(payload.swap, payload.swap?.coveredMs ?? 0),
    ...(gaugeAverage(payload.gauges, "mem.pressureWarnPct") === undefined ? {} : { pressure: { warnPct: gaugeAverage(payload.gauges, "mem.pressureWarnPct")!, criticalPct: gaugeAverage(payload.gauges, "mem.pressureCriticalPct")! } })
  };
  const psi = Object.keys(payload.psi).length === 0 ? undefined : Object.fromEntries(Object.entries(payload.psi).map(([name, group]) => [name, {
    some10: gaugeAverage(group, "some10")!,
    some60: gaugeAverage(group, "some60")!,
    some300: gaugeAverage(group, "some300")!,
    ...(gaugeAverage(group, "full10") === undefined ? {} : { full10: gaugeAverage(group, "full10")!, full60: gaugeAverage(group, "full60")!, full300: gaugeAverage(group, "full300")! })
  }])) as PsiAverages;
  const gpu = gpuValues(payload.gpu);
  const power = powerValues(payload.power, payload.power?.gpuCoveredMs ?? 0);
  const cpuCount = gaugeAverage(payload.gauges, "cpuCount");
  const uptimeMs = gaugeAverage(payload.gauges, "uptimeMs");
  return { atMs: payload.bucketMs, coverageMs: payload.coverageMs, partial: payload.partial, ...(cpu === undefined ? {} : { cpu }), ...(load === undefined ? {} : { load }), ...(mem === undefined ? {} : { mem }), ...(psi === undefined ? {} : { psi }), ...(gpu === undefined ? {} : { gpu }), ...(power === undefined ? {} : { power }), ...(cpuCount === undefined ? {} : { cpuCount: Math.round(cpuCount) }), ...(uptimeMs === undefined ? {} : { uptimeMs }) };
}

function summaryFromRaw(row: RawRow): SummaryPoint {
  const atMs = Number(row.sample.atMs);
  const cpu = row.delta.cpu === undefined ? undefined : cpuPercent(row.delta.cpu);
  const load = row.sample.load === undefined ? undefined : { one: Number(row.sample.load.one), five: Number(row.sample.load.five), fifteen: Number(row.sample.load.fifteen) };
  const pressure = pressureShare(row.sample.mem?.pressure);
  const mem = row.sample.mem === undefined ? undefined : { total: Number(row.sample.mem.total), available: Number(row.sample.mem.available), swapUsed: Number(row.sample.mem.swapTotal) - Number(row.sample.mem.swapFree), ...swapRates(row.delta.swap, row.delta.intervalMs), ...(pressure === undefined ? {} : { pressure }) };
  const psi = psiAverages(row.sample);
  const gpu = gpuValues(row.delta.gpu);
  const power = powerValues(row.delta.power, row.delta.intervalMs);
  return { atMs, coverageMs: row.delta.intervalMs, partial: false, ...(cpu === undefined ? {} : { cpu }), ...(load === undefined ? {} : { load }), ...(mem === undefined ? {} : { mem }), ...(psi === undefined ? {} : { psi }), ...(gpu === undefined ? {} : { gpu }), ...(power === undefined ? {} : { power }), ...(row.sample.cpuCount === undefined ? {} : { cpuCount: row.sample.cpuCount }), ...(row.sample.uptimeMs === undefined ? {} : { uptimeMs: Number(row.sample.uptimeMs) }) };
}

function diskPoints(row: RawRow): Array<{ id: string; name: string; point: DiskPoint }> {
  if (row.delta.intervalMs <= 0) return [];
  const atMs = Number(row.sample.atMs);
  return Object.values(row.delta.disks).map((disk: Disk) => ({
    id: disk.id,
    name: disk.name,
    point: {
      atMs,
      readBytesPerSec: (Number(disk.readSectors) * 512 * 1000) / row.delta.intervalMs,
      writeBytesPerSec: (Number(disk.writeSectors) * 512 * 1000) / row.delta.intervalMs,
      readsPerSec: (Number(disk.reads) * 1000) / row.delta.intervalMs,
      writesPerSec: (Number(disk.writes) * 1000) / row.delta.intervalMs,
      ...(disk.ioMs === undefined ? {} : { busyPct: (Number(disk.ioMs) / row.delta.intervalMs) * 100 }),
      ...diskLatencyPoint({
        readLatencyMs: meanLatencyMs(disk.readMs, disk.reads),
        writeLatencyMs: meanLatencyMs(disk.writeMs, disk.writes),
        queueDepth: disk.weightedIoMs === undefined ? undefined : Number(disk.weightedIoMs) / row.delta.intervalMs
      })
    }
  }));
}

function netPoints(row: RawRow): Array<{ id: string; point: NetPoint }> {
  if (row.delta.intervalMs <= 0) return [];
  const atMs = Number(row.sample.atMs);
  return Object.values(row.delta.nets).map((net: Net) => ({
    id: net.id,
    point: {
      atMs,
      rxBytesPerSec: (Number(net.rxBytes) * 1000) / row.delta.intervalMs,
      txBytesPerSec: (Number(net.txBytes) * 1000) / row.delta.intervalMs,
      rxPacketsPerSec: (Number(net.rxPackets) * 1000) / row.delta.intervalMs,
      txPacketsPerSec: (Number(net.txPackets) * 1000) / row.delta.intervalMs,
      rxDropsPerSec: (Number(net.rxDrops) * 1000) / row.delta.intervalMs,
      ...(net.txDrops === undefined ? {} : { txDropsPerSec: (Number(net.txDrops) * 1000) / row.delta.intervalMs }),
      rxErrorsPerSec: (Number(net.rxErrors) * 1000) / row.delta.intervalMs,
      txErrorsPerSec: (Number(net.txErrors) * 1000) / row.delta.intervalMs
    }
  }));
}

function filesystemPoints(row: RawRow): Array<{ id: string; point: FilesystemPoint }> {
  const atMs = Number(row.sample.atMs);
  return (row.sample.filesystems ?? []).map((filesystem: FileSystem) => ({ id: filesystem.id, point: { atMs, total: Number(filesystem.total), available: Number(filesystem.available) } }));
}

export type HistoryPoints = SummaryPoint[] | Series<DiskPoint>[] | Series<NetPoint>[] | Series<FilesystemPoint>[] | Series<BlockPoint>[];

export interface RowPoints {
  readonly atMs: number;
  readonly summary: SummaryPoint;
  readonly disks: readonly { readonly id: string; readonly name: string; readonly point: DiskPoint }[];
  readonly nets: readonly { readonly id: string; readonly point: NetPoint }[];
  readonly filesystems: readonly { readonly id: string; readonly point: FilesystemPoint }[];
  readonly block?: BlockPoint;
}

export function rowPoints(row: RawRow): RowPoints {
  const atMs = Number(row.sample.atMs);
  const block = row.sample.block === undefined ? null : blockPoint(atMs, row.sample.block);
  return {
    atMs,
    summary: summaryFromRaw(row),
    disks: diskPoints(row),
    nets: netPoints(row),
    filesystems: filesystemPoints(row),
    ...(block === null ? {} : { block })
  };
}

export function pointsFromRows(rows: readonly RowPoints[], kind: HistoryKind): HistoryPoints {
  if (kind === "summary") return rows.map(row => row.summary);
  if (kind === "block") return [{ id: "block", points: rows.flatMap(row => row.block ?? []) }];
  const grouped = new Map<string, { name?: string; points: unknown[] }>();
  for (const row of rows) {
    for (const value of row[kind]) {
      const group = grouped.get(value.id) ?? { points: [] };
      if ("name" in value) group.name = value.name;
      group.points.push(value.point);
      grouped.set(value.id, group);
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, group]) => ({ id, ...(group.name === undefined ? {} : { name: group.name }), points: group.points })) as never;
}

function rate(value: string | undefined, coverage: number, multiplier = 1): number {
  return value === undefined || coverage <= 0 ? 0 : (Number(value) * multiplier * 1000) / coverage;
}

export function rollupPoints(payloads: readonly RollupPayload[], kind: HistoryKind): HistoryPoints {
  if (kind === "summary") return payloads.map(summaryFromRollup);
  if (kind === "block") {
    const points = payloads.flatMap(payload => payload.block === undefined ? [] : (blockPoint(payload.bucketMs, payload.block) ?? []));
    return [{ id: "block", points }];
  }
  if (kind === "filesystems") {
    const grouped = new Map<string, FilesystemPoint[]>();
    for (const payload of payloads) {
      for (const [id, value] of Object.entries(payload.filesystems)) {
        const points = grouped.get(id) ?? [];
        points.push({ atMs: payload.bucketMs, total: value.total.sum / Math.max(1, value.total.count), available: value.available.sum / Math.max(1, value.available.count) });
        grouped.set(id, points);
      }
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, points]) => ({ id, points }));
  }
  if (kind === "disks") {
    const grouped = new Map<string, DiskPoint[]>();
    for (const payload of payloads) {
      for (const [id, values] of Object.entries(payload.disks)) {
        const points = grouped.get(id) ?? [];
        const coverage = Number(values[DEVICE_COVERAGE] ?? payload.coverageMs);
        points.push({
          atMs: payload.bucketMs,
          readBytesPerSec: rate(values.readSectors, coverage, 512),
          writeBytesPerSec: rate(values.writeSectors, coverage, 512),
          readsPerSec: rate(values.reads, coverage),
          writesPerSec: rate(values.writes, coverage),
          ...(values.ioMs === undefined ? {} : { busyPct: rate(values.ioMs, coverage) / 1000 * 100 }),
          ...diskLatencyPoint({
            readLatencyMs: meanLatencyMs(values.readMs, values[READS_TIMED]),
            writeLatencyMs: meanLatencyMs(values.writeMs, values[WRITES_TIMED]),
            queueDepth: queueDepth(values.weightedIoMs, values[WEIGHTED_COVERAGE])
          })
        });
        grouped.set(id, points);
      }
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, points]) => ({ id, points }));
  }
  const grouped = new Map<string, NetPoint[]>();
  for (const payload of payloads) {
    for (const [id, values] of Object.entries(payload.nets)) {
      const points = grouped.get(id) ?? [];
      const coverage = Number(values[DEVICE_COVERAGE] ?? payload.coverageMs);
      points.push({
        atMs: payload.bucketMs,
        rxBytesPerSec: rate(values.rxBytes, coverage),
        txBytesPerSec: rate(values.txBytes, coverage),
        rxPacketsPerSec: rate(values.rxPackets, coverage),
        txPacketsPerSec: rate(values.txPackets, coverage),
        rxDropsPerSec: rate(values.rxDrops, coverage),
        ...(values.txDrops === undefined ? {} : { txDropsPerSec: rate(values.txDrops, coverage) }),
        rxErrorsPerSec: rate(values.rxErrors, coverage),
        txErrorsPerSec: rate(values.txErrors, coverage)
      });
      grouped.set(id, points);
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, points]) => ({ id, points }));
}

export function downsample<T>(items: readonly T[], max = MAX_POINTS): { items: T[]; stride: number } {
  if (items.length <= max) return { items: [...items], stride: 1 };
  const stride = Math.ceil(items.length / max);
  const sampled: T[] = [];
  for (let index = 0; index < items.length; index += stride) sampled.push(items[index]!);
  return { items: sampled, stride };
}
