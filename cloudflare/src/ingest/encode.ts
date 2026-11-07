import { FS_TYPES, MEMORY_PRESSURE_LEVELS } from "../protocol.ts";

export interface SourceBatch {
  readonly hostId: string;
  readonly bootId: string;
  readonly system?: Readonly<Record<string, unknown>>;
  readonly samples: readonly Readonly<Record<string, unknown>>[];
}

type Json = Readonly<Record<string, unknown>>;

const GROUPS = ["cpu", "load", "mem", "uptimeMs", "cpuCount", "disks", "nets", "psi", "filesystems", "block", "gpu", "power", "services"] as const;
const UNAVAILABLE = { cpu: 0, load: 1, mem: 2, uptime: 3, disks: 5, nets: 6, psi: 7, filesystems: 8, gpu: 10, power: 11, services: 12 } as const;
const text = new TextEncoder();

function object(value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
  return value as Json;
}

function list(value: unknown): readonly Json[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value.map(object);
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

function ordinal(names: readonly string[], name: string): number {
  const index = names.indexOf(name);
  if (index < 0) throw new Error(`unknown name ${name}`);
  return index;
}

function u64(value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 out of range: ${value}`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`expected a non-negative safe integer, got ${value}`);
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`expected a decimal string, got ${String(value)}`);
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 out of range: ${value}`);
  return parsed;
}

function scaled(value: unknown, digits: number): bigint {
  if (typeof value !== "string") throw new Error("expected a fixed-point string");
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length !== digits) throw new Error(`expected ${digits} decimals in ${value}`);
  return BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction);
}

class Writer {
  readonly bytes: number[] = [];

  byte(value: number): void {
    this.bytes.push(value);
  }

  varint(value: bigint | number): void {
    let rest = BigInt(value);
    while (rest >= 0x80n) {
      this.bytes.push(Number(rest & 0x7fn) | 0x80);
      rest >>= 7n;
    }
    this.bytes.push(Number(rest));
  }

  text(value: string): void {
    const encoded = text.encode(value);
    this.varint(encoded.length);
    this.bytes.push(...encoded);
  }

  hex(value: string): void {
    for (let index = 0; index < value.length; index += 2) this.bytes.push(Number.parseInt(value.slice(index, index + 2), 16));
  }
}

function counterRecord(out: Writer, head: number, deltaBit: number, values: readonly bigint[], previous: readonly bigint[] | undefined, delta: boolean): void {
  const base = delta && previous !== undefined && previous.length === values.length && values.every((value, index) => value >= previous[index]!) ? previous : undefined;
  out.byte(head | (base === undefined ? 0 : deltaBit));
  values.forEach((value, index) => out.varint(base === undefined ? value : value - base[index]!));
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function cpuShape(cpu: Json): [number, bigint[]] {
  const shape = (cpu.iowait === undefined ? 0 : 1) | (cpu.steal === undefined ? 0 : 2);
  return [shape, [cpu.user, cpu.system, cpu.idle, cpu.iowait, cpu.steal, cpu.total].filter(present).map(u64)];
}

function diskShape(disk: Json): [number, bigint[]] {
  const shape = (disk.ioMs === undefined ? 0 : 1) | (disk.readMs === undefined ? 0 : 4) | (disk.writeMs === undefined ? 0 : 8) | (disk.weightedIoMs === undefined ? 0 : 16);
  return [shape, [disk.reads, disk.readSectors, disk.writes, disk.writeSectors, disk.ioMs, disk.readMs, disk.writeMs, disk.weightedIoMs].filter(present).map(u64)];
}

function netShape(net: Json): [number, bigint[]] {
  return [net.txDrops === undefined ? 0 : 1, [net.rxBytes, net.rxPackets, net.rxDrops, net.rxErrors, net.txBytes, net.txPackets, net.txErrors, net.txDrops].filter(present).map(u64)];
}

function powerShape(power: Json): [number, bigint[]] {
  const shape = (power.gpuNj === undefined ? 0 : 1) | (power.systemMwSum === undefined ? 0 : 2);
  return [shape, [power.gpuNj, power.systemMwSum, power.systemReadings].filter(present).map(u64)];
}

function sameShape(current: [number, bigint[]], previous: [number, bigint[]] | undefined): bigint[] | undefined {
  return previous !== undefined && previous[0] === current[0] ? previous[1] : undefined;
}

interface Dictionaries { disks: string[]; nets: string[]; filesystems: string[]; services: string[] }

const SERVICE_IO_FIELDS = ["ioReadBytes", "ioWriteBytes", "ioReads", "ioWrites"] as const;

function serviceShape(service: Json): [number, bigint[]] {
  const io = service.ioReadBytes !== undefined;
  return [io ? 1 : 0, [service.cpuUsec, ...(io ? SERVICE_IO_FIELDS.map(field => service[field]) : [])].map(u64)];
}

function writeService(out: Writer, service: Json, previous: Json | undefined, delta: boolean): void {
  if (service.unavailable === true) {
    out.byte(1 << 4);
    return;
  }
  const [shape, values] = serviceShape(service);
  const prior = previous === undefined || previous.unavailable === true ? undefined : serviceShape(previous);
  const before = prior !== undefined && prior[0] === shape ? prior[1] : undefined;
  const base = delta && before !== undefined && values.every((value, index) => value >= before[index]!) ? before : undefined;
  const memory = service.memoryCurrent !== undefined;
  out.byte((memory ? 1 : 0) | (service.memoryPeak === undefined ? 0 : 2) | (shape === 1 ? 4 : 0) | (base === undefined ? 0 : 8));
  const counter = (index: number) => out.varint(base === undefined ? values[index]! : values[index]! - base[index]!);
  counter(0);
  if (memory) out.varint(u64(service.memoryCurrent));
  if (service.memoryPeak !== undefined) out.varint(u64(service.memoryPeak));
  if (shape === 1) for (let index = 1; index < 5; index += 1) counter(index);
}

function reference(out: Writer, entries: string[], key: string): boolean {
  const index = entries.indexOf(key);
  if (index >= 0) {
    out.varint(index + 1);
    return false;
  }
  out.varint(0);
  entries.push(key);
  return true;
}

function writeSample(out: Writer, sample: Json, previous: Json | undefined, dictionaries: Dictionaries, delta: boolean): void {
  let mask = 0;
  GROUPS.forEach((group, bit) => { if (sample[group] !== undefined) mask |= 1 << bit; });
  let unavailable = 0;
  for (const group of (sample.unavailable ?? []) as (keyof typeof UNAVAILABLE)[]) unavailable |= 1 << UNAVAILABLE[group];
  out.varint(u64(sample.seq));
  out.varint(u64(sample.atMs));
  out.varint(u64(sample.monoMs));
  out.varint(mask);
  out.varint(unavailable);
  if (sample.cpu !== undefined) {
    const current = cpuShape(object(sample.cpu));
    counterRecord(out, current[0], 4, current[1], sameShape(current, previous?.cpu === undefined ? undefined : cpuShape(object(previous.cpu))), delta);
  }
  if (sample.load !== undefined) {
    const load = object(sample.load);
    for (const key of ["one", "five", "fifteen"]) out.varint(scaled(load[key], 3));
  }
  if (sample.mem !== undefined) {
    const mem = object(sample.mem);
    const before = previous?.mem === undefined ? undefined : object(previous.mem);
    const swap = mem.swapIn === undefined ? undefined : [u64(mem.swapIn), u64(mem.swapOut)];
    const prior = before?.swapIn === undefined ? undefined : [u64(before.swapIn), u64(before.swapOut)];
    const base = delta && swap !== undefined && prior !== undefined && swap.every((value, index) => value >= prior[index]!) ? prior : undefined;
    out.byte((swap === undefined ? 0 : 1) | (mem.pressure === undefined ? 0 : 2) | (base === undefined ? 0 : 4));
    for (const key of ["total", "available", "swapTotal", "swapFree"]) out.varint(u64(mem[key]));
    swap?.forEach((value, index) => out.varint(base === undefined ? value : value - base[index]!));
    if (mem.pressure !== undefined) out.byte(ordinal(MEMORY_PRESSURE_LEVELS, str(mem.pressure)));
  }
  if (sample.uptimeMs !== undefined) counterRecord(out, 0, 1, [u64(sample.uptimeMs)], previous?.uptimeMs === undefined ? undefined : [u64(previous.uptimeMs)], delta);
  if (sample.cpuCount !== undefined) out.varint(u64(sample.cpuCount));
  if (sample.disks !== undefined) {
    const disks = list(sample.disks);
    out.varint(disks.length);
    for (const disk of disks) {
      if (reference(out, dictionaries.disks, `${str(disk.id)}\u0000${str(disk.name)}`)) {
        const [major = "", minor = ""] = str(disk.id).split(":");
        out.varint(BigInt(major));
        out.varint(BigInt(minor));
        out.text(str(disk.name));
      }
      const predecessor = previous?.disks === undefined ? undefined : list(previous.disks).find(other => other.id === disk.id);
      const current = diskShape(disk);
      counterRecord(out, current[0] | (disk.inFlight === undefined ? 0 : 32), 2, current[1], sameShape(current, predecessor === undefined ? undefined : diskShape(predecessor)), delta);
      if (disk.inFlight !== undefined) out.varint(u64(disk.inFlight));
    }
  }
  if (sample.nets !== undefined) {
    const nets = list(sample.nets);
    out.varint(nets.length);
    for (const net of nets) {
      if (reference(out, dictionaries.nets, str(net.id))) out.text(str(net.id));
      const predecessor = previous?.nets === undefined ? undefined : list(previous.nets).find(other => other.id === net.id);
      const current = netShape(net);
      counterRecord(out, current[0], 2, current[1], sameShape(current, predecessor === undefined ? undefined : netShape(predecessor)), delta);
    }
  }
  if (sample.psi !== undefined) {
    const psi = object(sample.psi);
    const before = previous?.psi === undefined ? undefined : object(previous.psi);
    const resources = ["cpu", "memory", "io"];
    out.byte(resources.reduce((bits, resource, index) => bits | (psi[resource] === undefined ? 0 : 1 << index), 0));
    for (const resource of resources) {
      if (psi[resource] === undefined) continue;
      const group = object(psi[resource]);
      const full = group.fullTotal !== undefined;
      const totals = [u64(group.total), ...(full ? [u64(group.fullTotal)] : [])];
      const prior = before?.[resource] === undefined ? undefined : object(before[resource]);
      const priorTotals = prior === undefined || (prior.fullTotal !== undefined) !== full ? undefined : [u64(prior.total), ...(full ? [u64(prior.fullTotal)] : [])];
      const base = delta && priorTotals !== undefined && totals.every((value, index) => value >= priorTotals[index]!) ? priorTotals : undefined;
      out.byte((full ? 1 : 0) | (base === undefined ? 0 : 2));
      for (const key of ["some10", "some60", "some300"]) out.varint(scaled(group[key], 2));
      out.varint(base === undefined ? totals[0]! : totals[0]! - base[0]!);
      if (full) {
        for (const key of ["full10", "full60", "full300"]) out.varint(scaled(group[key], 2));
        out.varint(base === undefined ? totals[1]! : totals[1]! - base[1]!);
      }
    }
  }
  if (sample.filesystems !== undefined) {
    const filesystems = list(sample.filesystems);
    out.varint(filesystems.length);
    for (const filesystem of filesystems) {
      if (reference(out, dictionaries.filesystems, `${str(filesystem.id)}\u0000${str(filesystem.type)}`)) {
        out.text(str(filesystem.id));
        out.byte(ordinal(FS_TYPES, str(filesystem.type)));
      }
      out.varint(u64(filesystem.total));
      out.varint(u64(filesystem.available));
    }
  }
  if (sample.block !== undefined) {
    const block = object(sample.block);
    for (const bucket of block.buckets as unknown[]) out.varint(u64(bucket));
    for (const key of ["count", "totalUs", "minUs", "maxUs"]) out.varint(u64(block[key]));
  }
  if (sample.gpu !== undefined) {
    const gpu = object(sample.gpu);
    const before = previous?.gpu === undefined ? undefined : object(previous.gpu);
    counterRecord(out, 0, 1, [u64(gpu.active), u64(gpu.total)], before === undefined ? undefined : [u64(before.active), u64(before.total)], delta);
  }
  if (sample.power !== undefined) {
    const current = powerShape(object(sample.power));
    counterRecord(out, current[0], 4, current[1], sameShape(current, previous?.power === undefined ? undefined : powerShape(object(previous.power))), delta);
  }
  if (sample.services !== undefined) {
    const services = list(sample.services);
    out.varint(services.length);
    for (const service of services) {
      if (reference(out, dictionaries.services, str(service.name))) out.text(str(service.name));
      writeService(out, service, previous?.services === undefined ? undefined : list(previous.services).find(other => other.name === service.name), delta);
    }
  }
}

function writeSystem(out: Writer, system: Json): void {
  const cpu = object(system.cpu);
  out.byte((system.os === undefined ? 0 : 1) | (cpu.model === undefined ? 0 : 2) | (cpu.cores === undefined ? 0 : 4) | (cpu.sockets === undefined ? 0 : 8) | (cpu.maxMhz === undefined ? 0 : 16));
  out.text(str(system.agent));
  out.text(str(system.hostname));
  if (system.os !== undefined) out.text(str(system.os));
  out.text(str(system.kernel));
  out.text(str(system.arch));
  out.varint(u64(cpu.threads));
  if (cpu.model !== undefined) out.text(str(cpu.model));
  for (const key of ["cores", "sockets", "maxMhz"]) if (cpu[key] !== undefined) out.varint(u64(cpu[key]));
}

export function encodeFrame(batch: SourceBatch, options: { readonly delta?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const out = new Writer();
  out.hex("5354423202");
  out.byte(batch.system === undefined ? 0 : 1);
  out.hex(batch.hostId.slice(2));
  out.hex(batch.bootId.replaceAll("-", ""));
  out.byte(batch.samples.length);
  if (batch.system !== undefined) writeSystem(out, batch.system);
  const dictionaries: Dictionaries = { disks: [], nets: [], filesystems: [], services: [] };
  batch.samples.forEach((sample, index) => writeSample(out, sample, batch.samples[index - 1], dictionaries, options.delta ?? true));
  return new Uint8Array(out.bytes);
}
