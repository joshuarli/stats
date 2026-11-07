import type { Cpu, Disk, Gpu, Net, Power, Sample, Service } from "./protocol.ts";

export interface SwapDelta {
  readonly swapIn: string;
  readonly swapOut: string;
}

export interface ServiceDelta {
  readonly cpuUsec: string;
  readonly ioReadBytes?: string;
  readonly ioWriteBytes?: string;
}

export interface Delta {
  readonly intervalMs: number;
  readonly cpu?: Cpu;
  readonly swap?: SwapDelta;
  readonly gpu?: Gpu;
  readonly power?: Power;
  readonly disks: Record<string, Disk>;
  readonly nets: Record<string, Net>;
  readonly services?: Record<string, ServiceDelta>;
}

const EMPTY: Delta = { intervalMs: 0, disks: {}, nets: {} };

function difference(current: string, previous: string): string | null {
  const value = BigInt(current) - BigInt(previous);
  return value < 0n ? null : value.toString();
}

function cpuDelta(previous: Cpu, current: Cpu): Cpu | null {
  const user = difference(current.user, previous.user);
  const system = difference(current.system, previous.system);
  const idle = difference(current.idle, previous.idle);
  const total = difference(current.total, previous.total);
  if ([user, system, idle, total].some(value => value === null)) return null;
  const optional = counterDelta(previous, current, CPU_OPTIONAL_FIELDS);
  if (optional === null) return null;
  return { user: user!, system: system!, idle: idle!, total: total!, ...optional };
}

function swapDelta(previous: Sample, current: Sample): SwapDelta | null {
  const before = previous.mem;
  const after = current.mem;
  if (before?.swapIn === undefined || before.swapOut === undefined || after?.swapIn === undefined || after.swapOut === undefined) return null;
  const swapIn = difference(after.swapIn, before.swapIn);
  const swapOut = difference(after.swapOut, before.swapOut);
  return swapIn === null || swapOut === null ? null : { swapIn, swapOut };
}

function gpuDelta(previous: Gpu | undefined, current: Gpu | undefined): Gpu | null {
  if (previous === undefined || current === undefined) return null;
  const active = difference(current.active, previous.active);
  const total = difference(current.total, previous.total);
  return active === null || total === null ? null : { active, total };
}

function powerDelta(previous: Power | undefined, current: Power | undefined): Power | null {
  if (previous === undefined || current === undefined) return null;
  const gpuNj = previous.gpuNj === undefined || current.gpuNj === undefined ? null : difference(current.gpuNj, previous.gpuNj);
  const hasSystem = previous.systemMwSum !== undefined && previous.systemReadings !== undefined && current.systemMwSum !== undefined && current.systemReadings !== undefined;
  const systemMwSum = hasSystem ? difference(current.systemMwSum!, previous.systemMwSum!) : null;
  const systemReadings = hasSystem ? difference(current.systemReadings!, previous.systemReadings!) : null;
  const system = systemMwSum !== null && systemReadings !== null;
  if (gpuNj === null && !system) return null;
  return { ...(gpuNj === null ? {} : { gpuNj }), ...(system ? { systemMwSum, systemReadings } : {}) };
}

const SERVICE_IO_FIELDS = ["ioReadBytes", "ioWriteBytes"] as const;

function serviceDelta(previous: Service, current: Service): ServiceDelta | null {
  if ("unavailable" in previous || "unavailable" in current) return null;
  const cpuUsec = difference(current.cpuUsec, previous.cpuUsec);
  const io = counterDelta(previous, current, SERVICE_IO_FIELDS);
  return cpuUsec === null || io === null ? null : { cpuUsec, ...io };
}

function serviceDeltas(previous: readonly Service[] | undefined, current: readonly Service[] | undefined): Record<string, ServiceDelta> | null {
  if (previous === undefined || current === undefined) return null;
  const before = new Map(previous.map(service => [service.name, service]));
  const deltas: Record<string, ServiceDelta> = {};
  for (const service of current) {
    const prior = before.get(service.name);
    const delta = prior === undefined ? null : serviceDelta(prior, service);
    if (delta !== null) deltas[service.name] = delta;
  }
  return Object.keys(deltas).length === 0 ? null : deltas;
}

const CPU_OPTIONAL_FIELDS = ["iowait", "steal"] as const;
export const DISK_FIELDS = ["reads", "readSectors", "writes", "writeSectors", "ioMs", "readMs", "writeMs", "weightedIoMs"] as const;
export const NET_FIELDS = ["rxBytes", "rxPackets", "rxDrops", "rxErrors", "txBytes", "txPackets", "txDrops", "txErrors"] as const;

function counterDelta(previous: object, current: object, fields: readonly string[]): Record<string, string> | null {
  const delta: Record<string, string> = {};
  const before = previous as Record<string, string>;
  const after = current as Record<string, string>;
  for (const field of fields) {
    if (after[field] === undefined || before[field] === undefined) continue;
    const value = difference(after[field], before[field]);
    if (value === null) return null;
    delta[field] = value;
  }
  return delta;
}

export function computeDelta(previous: Sample | undefined, current: Sample, elapsedMs: number): Delta {
  if (previous === undefined || elapsedMs <= 0) return EMPTY;
  const cpu = previous.cpu !== undefined && current.cpu !== undefined ? cpuDelta(previous.cpu, current.cpu) : null;
  const swap = swapDelta(previous, current);
  const gpu = gpuDelta(previous.gpu, current.gpu);
  const power = powerDelta(previous.power, current.power);
  const disks: Record<string, Disk> = {};
  if (previous.disks !== undefined && current.disks !== undefined) {
    const before = new Map(previous.disks.map(disk => [disk.id, disk]));
    for (const disk of current.disks) {
      const prior = before.get(disk.id);
      if (prior === undefined) continue;
      const values = counterDelta(prior, disk, DISK_FIELDS);
      if (values === null) continue;
      disks[disk.id] = { id: disk.id, name: disk.name, ...values } as Disk;
    }
  }
  const nets: Record<string, Net> = {};
  if (previous.nets !== undefined && current.nets !== undefined) {
    const before = new Map(previous.nets.map(net => [net.id, net]));
    for (const net of current.nets) {
      const prior = before.get(net.id);
      if (prior === undefined) continue;
      const values = counterDelta(prior, net, NET_FIELDS);
      if (values === null) continue;
      nets[net.id] = { id: net.id, ...values } as Net;
    }
  }
  const services = serviceDeltas(previous.services, current.services);
  return { intervalMs: elapsedMs, ...(cpu === null ? {} : { cpu }), ...(swap === null ? {} : { swap }), ...(gpu === null ? {} : { gpu }), ...(power === null ? {} : { power }), disks, nets, ...(services === null ? {} : { services }) };
}

export function parseDelta(text: string): Delta {
  try {
    const value = JSON.parse(text) as Partial<Delta>;
    return {
      intervalMs: typeof value.intervalMs === "number" && Number.isFinite(value.intervalMs) && value.intervalMs > 0 ? value.intervalMs : 0,
      ...(value.cpu === undefined ? {} : { cpu: value.cpu }),
      ...(value.swap === undefined ? {} : { swap: value.swap }),
      ...(value.gpu === undefined ? {} : { gpu: value.gpu }),
      ...(value.power === undefined ? {} : { power: value.power }),
      disks: value.disks ?? {},
      nets: value.nets ?? {},
      ...(value.services === undefined ? {} : { services: value.services })
    };
  } catch {
    return EMPTY;
  }
}
