import { FS_TYPES, MAX_DEVICES, MAX_SAMPLES, MEMORY_PRESSURE_LEVELS, SERVICE_NAME, type MemoryPressure } from "../protocol.ts";
import { BLOCK_BUCKETS } from "../limits.ts";

export type FrameRejectCode = "invalid_frame" | "unknown_version" | "invalid_batch";

export interface WireCpu { readonly user: bigint; readonly system: bigint; readonly idle: bigint; readonly iowait?: bigint; readonly steal?: bigint; readonly total: bigint }
export interface WireLoad { readonly one: bigint; readonly five: bigint; readonly fifteen: bigint }
export interface WireSwap { readonly swapIn: bigint; readonly swapOut: bigint }
export interface WireMem { readonly total: bigint; readonly available: bigint; readonly swapTotal: bigint; readonly swapFree: bigint; readonly swap?: WireSwap; readonly pressure?: MemoryPressure }
export interface DiskEntry { readonly major: number; readonly minor: number; readonly name: string }
export interface WireDisk { readonly entry: DiskEntry; readonly reads: bigint; readonly readSectors: bigint; readonly writes: bigint; readonly writeSectors: bigint; readonly ioMs?: bigint; readonly readMs?: bigint; readonly writeMs?: bigint; readonly weightedIoMs?: bigint; readonly inFlight?: bigint }
export interface WireNet { readonly name: string; readonly rxBytes: bigint; readonly rxPackets: bigint; readonly rxDrops: bigint; readonly rxErrors: bigint; readonly txBytes: bigint; readonly txPackets: bigint; readonly txErrors: bigint; readonly txDrops?: bigint }
export interface WirePsiFull { readonly avg10: bigint; readonly avg60: bigint; readonly avg300: bigint; readonly total: bigint }
export interface WirePsiGroup { readonly some10: bigint; readonly some60: bigint; readonly some300: bigint; readonly total: bigint; readonly full?: WirePsiFull }
export interface WirePsi { readonly cpu?: WirePsiGroup; readonly memory?: WirePsiGroup; readonly io?: WirePsiGroup }
export interface FileSystemEntry { readonly path: string; readonly type: (typeof FS_TYPES)[number] }
export interface WireFileSystem { readonly entry: FileSystemEntry; readonly total: bigint; readonly available: bigint }
export interface WireBlock { readonly buckets: readonly bigint[]; readonly count: bigint; readonly totalUs: bigint; readonly minUs: bigint; readonly maxUs: bigint }
export interface WireGpu { readonly active: bigint; readonly total: bigint }
export interface WireSystemPower { readonly milliwattSum: bigint; readonly readings: bigint }
export interface WirePower { readonly gpuNj?: bigint; readonly system?: WireSystemPower }
export interface WireServiceMemory { readonly current: bigint; readonly peak?: bigint }
export interface WireServiceIo { readonly readBytes: bigint; readonly writeBytes: bigint; readonly reads: bigint; readonly writes: bigint }
export interface WireServiceUsage { readonly cpuUsec: bigint; readonly memory?: WireServiceMemory; readonly io?: WireServiceIo }
export interface WireService { readonly name: string; readonly usage?: WireServiceUsage }

export interface WireSample {
  readonly seq: bigint;
  readonly atMs: bigint;
  readonly monoMs: bigint;
  readonly unavailable: number;
  readonly cpu?: WireCpu;
  readonly load?: WireLoad;
  readonly mem?: WireMem;
  readonly uptimeMs?: bigint;
  readonly cpuCount?: bigint;
  readonly disks?: readonly WireDisk[];
  readonly nets?: readonly WireNet[];
  readonly psi?: WirePsi;
  readonly filesystems?: readonly WireFileSystem[];
  readonly block?: WireBlock;
  readonly gpu?: WireGpu;
  readonly power?: WirePower;
  readonly services?: readonly WireService[];
}

export interface WireSystem {
  readonly agent: string;
  readonly hostname: string;
  readonly os?: string;
  readonly kernel: string;
  readonly arch: string;
  readonly threads: number;
  readonly model?: string;
  readonly cores?: number;
  readonly sockets?: number;
  readonly maxMhz?: number;
}

export interface WireBatch { readonly hostId: string; readonly bootId: string; readonly system?: WireSystem; readonly samples: readonly WireSample[] }

export type FrameResult =
  | { readonly ok: true; readonly batch: WireBatch }
  | { readonly ok: false; readonly code: FrameRejectCode; readonly message: string };

export const GROUP = {
  cpu: 1 << 0,
  load: 1 << 1,
  mem: 1 << 2,
  uptime: 1 << 3,
  cpuCount: 1 << 4,
  disks: 1 << 5,
  nets: 1 << 6,
  psi: 1 << 7,
  filesystems: 1 << 8,
  block: 1 << 9,
  gpu: 1 << 10,
  power: 1 << 11,
  services: 1 << 12
} as const;

const SERVICE_HEAD = { memory: 1 << 0, peak: 1 << 1, io: 1 << 2, delta: 1 << 3, unavailable: 1 << 4 } as const;
const PRESENT_MASK = (1 << 13) - 1;
const UNAVAILABLE_MASK = PRESENT_MASK & ~GROUP.cpuCount & ~GROUP.block;
const HEADER_BYTES = 39;
const U64_MAX = (1n << 64n) - 1n;
const DISK_MAJOR_MAX = 4_095;
const DISK_MINOR_MAX = 1_048_575;
const DISK_NAME = /^[A-Za-z0-9._-]{1,32}$/u;
const IFNAME = /^[A-Za-z0-9_.:@-]{1,15}$/u;
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Rejection extends Error {
  readonly code: FrameRejectCode;

  constructor(code: FrameRejectCode, message: string) {
    super(message);
    this.code = code;
  }
}

function structural(message: string): never {
  throw new Rejection("invalid_frame", message);
}

function semantic(message: string): never {
  throw new Rejection("invalid_batch", message);
}

class Reader {
  readonly bytes: Uint8Array;
  offset: number;

  constructor(bytes: Uint8Array, offset: number) {
    this.bytes = bytes;
    this.offset = offset;
  }

  u8(field: string): number {
    if (this.offset >= this.bytes.length) structural(`${field} is truncated`);
    return this.bytes[this.offset++]!;
  }

  mask(field: string, allowed: number): number {
    const value = this.u8(field);
    if ((value & ~allowed) !== 0) structural(`${field} sets a reserved bit`);
    return value;
  }

  varint(field: string): bigint {
    let low = 0;
    let shift = 0;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.u8(field);
      if (index === 9 && byte > 1) structural(`${field} exceeds u64`);
      if (index === 7) return this.wideVarint(field, BigInt(low), byte);
      low += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) {
        if (byte === 0 && index > 0) structural(`${field} is not a canonical varint`);
        return BigInt(low);
      }
    }
    return structural(`${field} is an overlong varint`);
  }

  private wideVarint(field: string, low: bigint, first: number): bigint {
    let value = low;
    let byte = first;
    for (let index = 7; ; index += 1) {
      if (index === 9 && byte > 1) structural(`${field} exceeds u64`);
      value |= BigInt(byte & 0x7f) << BigInt(7 * index);
      if ((byte & 0x80) === 0) {
        if (byte === 0) structural(`${field} is not a canonical varint`);
        return value;
      }
      if (index === 9) return structural(`${field} is an overlong varint`);
      byte = this.u8(field);
    }
  }

  small(field: string, max: number): number {
    const value = this.varint(field);
    if (value > BigInt(max)) structural(`${field} exceeds ${max}`);
    return Number(value);
  }

  text(field: string, maxBytes: number): string {
    const length = this.small(`${field} length`, maxBytes);
    if (length === 0) structural(`${field} is empty`);
    if (this.offset + length > this.bytes.length) structural(`${field} is truncated`);
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    try {
      return utf8.decode(slice);
    } catch {
      return structural(`${field} is not valid UTF-8`);
    }
  }
}

function hex(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let index = start; index < end; index += 1) text += HEX[bytes[index]!];
  return text;
}

function bootText(bytes: Uint8Array): string {
  const digits = hex(bytes, 22, 38);
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`;
}

function plain(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

function characters(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += value.codePointAt(index)! > 0xffff ? 2 : 1) count += 1;
  return count;
}

function systemText(reader: Reader, field: string, limit: number): string {
  const value = reader.text(field, limit * 4);
  if (characters(value) > limit || !plain(value)) semantic(`system ${field} is outside its bounds`);
  return value;
}

function bounded(reader: Reader, field: string, max: number): number {
  const value = reader.varint(field);
  if (value < 1n || value > BigInt(max)) semantic(`system ${field} is outside 1-${max}`);
  return Number(value);
}

function readSystem(reader: Reader): WireSystem {
  const mask = reader.mask("system mask", 0b1_1111);
  const agent = systemText(reader, "agent", 32);
  const hostname = systemText(reader, "hostname", 64);
  const os = (mask & 1) !== 0 ? systemText(reader, "os", 128) : undefined;
  const kernel = systemText(reader, "kernel", 64);
  const arch = systemText(reader, "arch", 16);
  const threads = bounded(reader, "threads", 4096);
  const model = (mask & 2) !== 0 ? systemText(reader, "model", 128) : undefined;
  const cores = (mask & 4) !== 0 ? bounded(reader, "cores", 4096) : undefined;
  const sockets = (mask & 8) !== 0 ? bounded(reader, "sockets", 256) : undefined;
  const maxMhz = (mask & 16) !== 0 ? bounded(reader, "maxMhz", 100_000) : undefined;
  return {
    agent, hostname, kernel, arch, threads,
    ...(os === undefined ? {} : { os }),
    ...(model === undefined ? {} : { model }),
    ...(cores === undefined ? {} : { cores }),
    ...(sockets === undefined ? {} : { sockets }),
    ...(maxMhz === undefined ? {} : { maxMhz })
  };
}

function counters(reader: Reader, field: string, count: number, base: readonly bigint[] | undefined): bigint[] {
  const values: bigint[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = reader.varint(field);
    if (base === undefined) {
      values.push(value);
      continue;
    }
    const sum = base[index]! + value;
    if (sum > U64_MAX) structural(`${field} delta overflows u64`);
    values.push(sum);
  }
  return values;
}

function base(field: string, delta: boolean, previous: readonly bigint[] | undefined): readonly bigint[] | undefined {
  if (!delta) return undefined;
  if (previous === undefined) structural(`${field} is a delta without a predecessor of the same shape`);
  return previous;
}

function optional(values: readonly (bigint | undefined)[]): bigint[] {
  return values.filter((value): value is bigint => value !== undefined);
}

function cpuValues(cpu: WireCpu): bigint[] {
  return optional([cpu.user, cpu.system, cpu.idle, cpu.iowait, cpu.steal, cpu.total]);
}

function cpuShape(cpu: WireCpu): number {
  return (cpu.iowait === undefined ? 0 : 1) | (cpu.steal === undefined ? 0 : 2);
}

function readCpu(reader: Reader, previous: WireCpu | undefined): WireCpu {
  const head = reader.mask("cpu head", 0b111);
  const shape = head & 0b11;
  const count = 4 + (shape & 1) + ((shape >> 1) & 1);
  const values = counters(reader, "cpu", count, base("cpu", (head & 4) !== 0, previous !== undefined && cpuShape(previous) === shape ? cpuValues(previous) : undefined));
  let index = 3;
  const iowait = (shape & 1) !== 0 ? values[index++] : undefined;
  const steal = (shape & 2) !== 0 ? values[index++] : undefined;
  return { user: values[0]!, system: values[1]!, idle: values[2]!, ...(iowait === undefined ? {} : { iowait }), ...(steal === undefined ? {} : { steal }), total: values[index]! };
}

function readMem(reader: Reader, previous: WireMem | undefined): WireMem {
  const head = reader.mask("mem head", 0b111);
  if ((head & 4) !== 0 && (head & 1) === 0) structural("mem swap delta without swap activity");
  const total = reader.varint("mem total");
  const available = reader.varint("mem available");
  const swapTotal = reader.varint("mem swapTotal");
  const swapFree = reader.varint("mem swapFree");
  let swap: WireSwap | undefined;
  if ((head & 1) !== 0) {
    const before = previous?.swap === undefined ? undefined : [previous.swap.swapIn, previous.swap.swapOut];
    const [swapIn, swapOut] = counters(reader, "mem swap", 2, base("mem swap", (head & 4) !== 0, before));
    swap = { swapIn: swapIn!, swapOut: swapOut! };
  }
  let pressure: MemoryPressure | undefined;
  if ((head & 2) !== 0) {
    const level = reader.u8("mem pressure");
    pressure = MEMORY_PRESSURE_LEVELS[level];
    if (pressure === undefined) structural("mem pressure is not a known level");
  }
  return { total, available, swapTotal, swapFree, ...(swap === undefined ? {} : { swap }), ...(pressure === undefined ? {} : { pressure }) };
}

function count(reader: Reader, field: string): number {
  return reader.small(`${field} count`, MAX_DEVICES);
}

function reference<T>(reader: Reader, field: string, entries: T[], define: () => T, same: (left: T, right: T) => boolean): T {
  const ref = reader.small(`${field} reference`, entries.length);
  if (ref > 0) return entries[ref - 1]!;
  const entry = define();
  if (entries.some(known => same(known, entry))) structural(`${field} dictionary entry is defined twice`);
  entries.push(entry);
  return entry;
}

const DISK_OPTIONAL_COUNTERS = [
  { bit: 1, field: "ioMs" }, { bit: 4, field: "readMs" }, { bit: 8, field: "writeMs" }, { bit: 16, field: "weightedIoMs" }
] as const;
const DISK_IN_FLIGHT_BIT = 32;

function diskValues(disk: WireDisk): bigint[] {
  return optional([disk.reads, disk.readSectors, disk.writes, disk.writeSectors, disk.ioMs, disk.readMs, disk.writeMs, disk.weightedIoMs]);
}

function readDisks(reader: Reader, entries: DiskEntry[], previous: readonly WireDisk[] | undefined): WireDisk[] {
  const disks: WireDisk[] = [];
  const total = count(reader, "disks");
  for (let index = 0; index < total; index += 1) {
    const entry = reference(reader, "disk", entries, () => {
      const major = reader.varint("disk major");
      const minor = reader.varint("disk minor");
      const name = reader.text("disk name", 32);
      if (major > BigInt(DISK_MAJOR_MAX) || minor > BigInt(DISK_MINOR_MAX) || !DISK_NAME.test(name)) semantic("disk identity is outside its bounds");
      return { major: Number(major), minor: Number(minor), name };
    }, (left, right) => left.major === right.major && left.minor === right.minor && left.name === right.name);
    if (disks.some(disk => disk.entry.major === entry.major && disk.entry.minor === entry.minor)) structural("a disk appears twice in one sample");
    const head = reader.mask("disk head", 0b11_1111);
    const predecessor = previous?.find(disk => disk.entry.major === entry.major && disk.entry.minor === entry.minor);
    const optionalCounters = DISK_OPTIONAL_COUNTERS.filter(({ bit }) => (head & bit) !== 0);
    const sameShape = predecessor !== undefined && DISK_OPTIONAL_COUNTERS.every(({ bit, field }) => (predecessor[field] !== undefined) === ((head & bit) !== 0));
    const values = counters(reader, "disk", 4 + optionalCounters.length, base("disk", (head & 2) !== 0, sameShape ? diskValues(predecessor) : undefined));
    const inFlight = (head & DISK_IN_FLIGHT_BIT) === 0 ? undefined : reader.varint("disk inFlight");
    disks.push({
      entry, reads: values[0]!, readSectors: values[1]!, writes: values[2]!, writeSectors: values[3]!,
      ...Object.fromEntries(optionalCounters.map(({ field }, index) => [field, values[4 + index]!])),
      ...(inFlight === undefined ? {} : { inFlight })
    });
  }
  return disks;
}

function netValues(net: WireNet): bigint[] {
  return optional([net.rxBytes, net.rxPackets, net.rxDrops, net.rxErrors, net.txBytes, net.txPackets, net.txErrors, net.txDrops]);
}

function readNets(reader: Reader, entries: string[], previous: readonly WireNet[] | undefined): WireNet[] {
  const nets: WireNet[] = [];
  const total = count(reader, "nets");
  for (let index = 0; index < total; index += 1) {
    const name = reference(reader, "interface", entries, () => {
      const value = reader.text("interface name", 15);
      if (!IFNAME.test(value)) semantic("interface name is outside its bounds");
      return value;
    }, (left, right) => left === right);
    if (nets.some(net => net.name === name)) structural("an interface appears twice in one sample");
    const head = reader.mask("interface head", 0b11);
    const predecessor = previous?.find(net => net.name === name);
    const sameShape = predecessor !== undefined && (predecessor.txDrops !== undefined) === ((head & 1) !== 0);
    const values = counters(reader, "interface", 7 + (head & 1), base("interface", (head & 2) !== 0, sameShape ? netValues(predecessor) : undefined));
    nets.push({ name, rxBytes: values[0]!, rxPackets: values[1]!, rxDrops: values[2]!, rxErrors: values[3]!, txBytes: values[4]!, txPackets: values[5]!, txErrors: values[6]!, ...(values[7] === undefined ? {} : { txDrops: values[7] }) });
  }
  return nets;
}

const PSI_RESOURCES = ["cpu", "memory", "io"] as const;

function readPsiGroup(reader: Reader, previous: WirePsiGroup | undefined): WirePsiGroup {
  const head = reader.mask("psi head", 0b11);
  const full = (head & 1) !== 0;
  const before = previous !== undefined && (previous.full !== undefined) === full ? optional([previous.total, previous.full?.total]) : undefined;
  const totals = base("psi", (head & 2) !== 0, before);
  const some10 = reader.varint("psi some10");
  const some60 = reader.varint("psi some60");
  const some300 = reader.varint("psi some300");
  const [total] = counters(reader, "psi total", 1, totals === undefined ? undefined : [totals[0]!]);
  if (!full) return { some10, some60, some300, total: total! };
  const avg10 = reader.varint("psi full10");
  const avg60 = reader.varint("psi full60");
  const avg300 = reader.varint("psi full300");
  const [fullTotal] = counters(reader, "psi fullTotal", 1, totals === undefined ? undefined : [totals[1]!]);
  return { some10, some60, some300, total: total!, full: { avg10, avg60, avg300, total: fullTotal! } };
}

function readPsi(reader: Reader, previous: WirePsi | undefined): WirePsi {
  const mask = reader.mask("psi mask", 0b111);
  if (mask === 0) structural("psi has no resource");
  const psi: { -readonly [K in keyof WirePsi]: WirePsiGroup } = {};
  for (const [index, resource] of PSI_RESOURCES.entries()) {
    if ((mask & (1 << index)) !== 0) psi[resource] = readPsiGroup(reader, previous?.[resource]);
  }
  return psi;
}

function readFilesystems(reader: Reader, entries: FileSystemEntry[]): WireFileSystem[] {
  const filesystems: WireFileSystem[] = [];
  const total = count(reader, "filesystems");
  for (let index = 0; index < total; index += 1) {
    const entry = reference(reader, "filesystem", entries, () => {
      const path = reader.text("filesystem path", 255);
      const type = FS_TYPES[reader.u8("filesystem type")];
      if (type === undefined) structural("filesystem type is not a known type");
      if (!path.startsWith("/") || path.includes("\0")) semantic("filesystem path is outside its bounds");
      return { path, type };
    }, (left, right) => left.path === right.path && left.type === right.type);
    if (filesystems.some(filesystem => filesystem.entry.path === entry.path)) structural("a filesystem appears twice in one sample");
    filesystems.push({ entry, total: reader.varint("filesystem total"), available: reader.varint("filesystem available") });
  }
  return filesystems;
}

function readBlock(reader: Reader): WireBlock {
  const buckets: bigint[] = [];
  for (let index = 0; index < BLOCK_BUCKETS; index += 1) buckets.push(reader.varint("block bucket"));
  return { buckets, count: reader.varint("block count"), totalUs: reader.varint("block totalUs"), minUs: reader.varint("block minUs"), maxUs: reader.varint("block maxUs") };
}

function readGpu(reader: Reader, previous: WireGpu | undefined): WireGpu {
  const head = reader.mask("gpu head", 0b1);
  const [active, total] = counters(reader, "gpu", 2, base("gpu", head !== 0, previous === undefined ? undefined : [previous.active, previous.total]));
  return { active: active!, total: total! };
}

function powerShape(power: WirePower): number {
  return (power.gpuNj === undefined ? 0 : 1) | (power.system === undefined ? 0 : 2);
}

function readPower(reader: Reader, previous: WirePower | undefined): WirePower {
  const head = reader.mask("power head", 0b111);
  const shape = head & 0b11;
  if (shape === 0) structural("power has no reading");
  const before = previous !== undefined && powerShape(previous) === shape ? optional([previous.gpuNj, previous.system?.milliwattSum, previous.system?.readings]) : undefined;
  const values = counters(reader, "power", (shape & 1) + (shape & 2), base("power", (head & 4) !== 0, before));
  const gpuNj = (shape & 1) !== 0 ? values[0] : undefined;
  const offset = shape & 1;
  return { ...(gpuNj === undefined ? {} : { gpuNj }), ...((shape & 2) === 0 ? {} : { system: { milliwattSum: values[offset]!, readings: values[offset + 1]! } }) };
}

function serviceValues(usage: WireServiceUsage): bigint[] {
  return usage.io === undefined ? [usage.cpuUsec] : [usage.cpuUsec, usage.io.readBytes, usage.io.writeBytes, usage.io.reads, usage.io.writes];
}

function readServiceUsage(reader: Reader, head: number, previous: WireServiceUsage | undefined): WireServiceUsage {
  if ((head & SERVICE_HEAD.peak) !== 0 && (head & SERVICE_HEAD.memory) === 0) structural("service peak memory without current memory");
  const io = (head & SERVICE_HEAD.io) !== 0;
  const before = previous !== undefined && (previous.io !== undefined) === io ? serviceValues(previous) : undefined;
  const counted = base("service", (head & SERVICE_HEAD.delta) !== 0, before);
  const [cpuUsec] = counters(reader, "service cpuUsec", 1, counted?.slice(0, 1));
  const memory = (head & SERVICE_HEAD.memory) === 0 ? undefined : {
    current: reader.varint("service memoryCurrent"),
    ...((head & SERVICE_HEAD.peak) === 0 ? {} : { peak: reader.varint("service memoryPeak") })
  };
  const values = io ? counters(reader, "service io", 4, counted?.slice(1)) : undefined;
  return {
    cpuUsec: cpuUsec!,
    ...(memory === undefined ? {} : { memory }),
    ...(values === undefined ? {} : { io: { readBytes: values[0]!, writeBytes: values[1]!, reads: values[2]!, writes: values[3]! } })
  };
}

function readServices(reader: Reader, entries: string[], previous: readonly WireService[] | undefined): WireService[] {
  const services: WireService[] = [];
  const total = count(reader, "services");
  for (let index = 0; index < total; index += 1) {
    const name = reference(reader, "service", entries, () => {
      const value = reader.text("service name", 32);
      if (!SERVICE_NAME.test(value)) semantic("service name is outside its bounds");
      return value;
    }, (left, right) => left === right);
    if (services.some(service => service.name === name)) structural("a service appears twice in one sample");
    const head = reader.mask("service head", 0b1_1111);
    if ((head & SERVICE_HEAD.unavailable) !== 0) {
      if (head !== SERVICE_HEAD.unavailable) structural("an unavailable service carries readings");
      services.push({ name });
      continue;
    }
    services.push({ name, usage: readServiceUsage(reader, head, previous?.find(service => service.name === name)?.usage) });
  }
  return services;
}

interface Dictionaries { readonly disks: DiskEntry[]; readonly nets: string[]; readonly filesystems: FileSystemEntry[]; readonly services: string[] }

function readSample(reader: Reader, previous: WireSample | undefined, dictionaries: Dictionaries): WireSample {
  const seq = reader.varint("seq");
  const atMs = reader.varint("atMs");
  const monoMs = reader.varint("monoMs");
  const present = reader.varint("present mask");
  const unavailableMask = reader.varint("unavailable mask");
  if ((present & ~BigInt(PRESENT_MASK)) !== 0n) structural("present mask sets a reserved bit");
  if ((unavailableMask & ~BigInt(UNAVAILABLE_MASK)) !== 0n) structural("unavailable mask sets a reserved bit");
  const has = Number(present);
  const unavailable = Number(unavailableMask);
  if ((has & unavailable) !== 0) structural("a group is both present and unavailable");
  const on = (bit: number) => (has & bit) !== 0;
  const cpu = on(GROUP.cpu) ? readCpu(reader, previous?.cpu) : undefined;
  const load = on(GROUP.load) ? { one: reader.varint("load one"), five: reader.varint("load five"), fifteen: reader.varint("load fifteen") } : undefined;
  const mem = on(GROUP.mem) ? readMem(reader, previous?.mem) : undefined;
  let uptimeMs: bigint | undefined;
  if (on(GROUP.uptime)) {
    const head = reader.mask("uptime head", 0b1);
    uptimeMs = counters(reader, "uptimeMs", 1, base("uptimeMs", head !== 0, previous?.uptimeMs === undefined ? undefined : [previous.uptimeMs]))[0];
  }
  const cpuCount = on(GROUP.cpuCount) ? reader.varint("cpuCount") : undefined;
  const disks = on(GROUP.disks) ? readDisks(reader, dictionaries.disks, previous?.disks) : undefined;
  const nets = on(GROUP.nets) ? readNets(reader, dictionaries.nets, previous?.nets) : undefined;
  const psi = on(GROUP.psi) ? readPsi(reader, previous?.psi) : undefined;
  const filesystems = on(GROUP.filesystems) ? readFilesystems(reader, dictionaries.filesystems) : undefined;
  const block = on(GROUP.block) ? readBlock(reader) : undefined;
  const gpu = on(GROUP.gpu) ? readGpu(reader, previous?.gpu) : undefined;
  const power = on(GROUP.power) ? readPower(reader, previous?.power) : undefined;
  const services = on(GROUP.services) ? readServices(reader, dictionaries.services, previous?.services) : undefined;
  return {
    seq, atMs, monoMs, unavailable,
    ...(cpu === undefined ? {} : { cpu }),
    ...(load === undefined ? {} : { load }),
    ...(mem === undefined ? {} : { mem }),
    ...(uptimeMs === undefined ? {} : { uptimeMs }),
    ...(cpuCount === undefined ? {} : { cpuCount }),
    ...(disks === undefined ? {} : { disks }),
    ...(nets === undefined ? {} : { nets }),
    ...(psi === undefined ? {} : { psi }),
    ...(filesystems === undefined ? {} : { filesystems }),
    ...(block === undefined ? {} : { block }),
    ...(gpu === undefined ? {} : { gpu }),
    ...(power === undefined ? {} : { power }),
    ...(services === undefined ? {} : { services })
  };
}

export function decodeFrame(bytes: Uint8Array): FrameResult {
  try {
    if (bytes.length < 5 || bytes[0] !== 0x53 || bytes[1] !== 0x54 || bytes[2] !== 0x42 || bytes[3] !== 0x32) structural("magic is not STB2");
    if (bytes[4] !== 2) throw new Rejection("unknown_version", "unsupported ingest frame version");
    if (bytes.length < HEADER_BYTES) structural("header is truncated");
    const flags = bytes[5]!;
    if ((flags & ~1) !== 0) structural("flags set a reserved bit");
    const total = bytes[38]!;
    if (total < 1 || total > MAX_SAMPLES) semantic("sample count is outside 1-16");
    const reader = new Reader(bytes, HEADER_BYTES);
    const system = (flags & 1) !== 0 ? readSystem(reader) : undefined;
    const dictionaries: Dictionaries = { disks: [], nets: [], filesystems: [], services: [] };
    const samples: WireSample[] = [];
    for (let index = 0; index < total; index += 1) samples.push(readSample(reader, samples[index - 1], dictionaries));
    if (reader.offset !== bytes.length) structural("bytes follow the last sample");
    return { ok: true, batch: { hostId: `h_${hex(bytes, 6, 22)}`, bootId: bootText(bytes), ...(system === undefined ? {} : { system }), samples } };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
