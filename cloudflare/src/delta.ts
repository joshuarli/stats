import type { Cpu, Disk, Net, Sample } from "./protocol";

export interface SwapDelta {
  readonly swapIn: string;
  readonly swapOut: string;
}

export interface Delta {
  readonly intervalMs: number;
  readonly cpu?: Cpu;
  readonly swap?: SwapDelta;
  readonly disks: Record<string, Disk>;
  readonly nets: Record<string, Net>;
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
  const iowait = difference(current.iowait, previous.iowait);
  const steal = difference(current.steal, previous.steal);
  const total = difference(current.total, previous.total);
  if ([user, system, idle, iowait, steal, total].some(value => value === null)) return null;
  return { user: user!, system: system!, idle: idle!, iowait: iowait!, steal: steal!, total: total! };
}

function swapDelta(previous: Sample, current: Sample): SwapDelta | null {
  const before = previous.mem;
  const after = current.mem;
  if (before?.swapIn === undefined || before.swapOut === undefined || after?.swapIn === undefined || after.swapOut === undefined) return null;
  const swapIn = difference(after.swapIn, before.swapIn);
  const swapOut = difference(after.swapOut, before.swapOut);
  return swapIn === null || swapOut === null ? null : { swapIn, swapOut };
}

export const DISK_FIELDS = ["reads", "readSectors", "writes", "writeSectors", "ioMs"] as const;
export const NET_FIELDS = ["rxBytes", "rxPackets", "rxDrops", "rxErrors", "txBytes", "txPackets", "txDrops", "txErrors"] as const;

function counterDelta(previous: object, current: object, fields: readonly string[]): Record<string, string> | null {
  const delta: Record<string, string> = {};
  const before = previous as Record<string, string>;
  const after = current as Record<string, string>;
  for (const field of fields) {
    const value = difference(after[field]!, before[field]!);
    if (value === null) return null;
    delta[field] = value;
  }
  return delta;
}

export function computeDelta(previous: Sample | undefined, current: Sample, elapsedMs: number): Delta {
  if (previous === undefined || elapsedMs <= 0) return EMPTY;
  const cpu = previous.cpu !== undefined && current.cpu !== undefined ? cpuDelta(previous.cpu, current.cpu) : null;
  const swap = swapDelta(previous, current);
  const disks: Record<string, Disk> = {};
  if (previous.disks !== undefined && current.disks !== undefined) {
    const before = new Map(previous.disks.map(disk => [disk.id, disk]));
    for (const disk of current.disks) {
      const prior = before.get(disk.id);
      if (prior === undefined) continue;
      const values = counterDelta(prior, disk, DISK_FIELDS);
      if (values === null) continue;
      disks[disk.id] = { id: disk.id, name: disk.name, reads: values.reads!, readSectors: values.readSectors!, writes: values.writes!, writeSectors: values.writeSectors!, ioMs: values.ioMs! };
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
      nets[net.id] = { id: net.id, rxBytes: values.rxBytes!, rxPackets: values.rxPackets!, rxDrops: values.rxDrops!, rxErrors: values.rxErrors!, txBytes: values.txBytes!, txPackets: values.txPackets!, txDrops: values.txDrops!, txErrors: values.txErrors! };
    }
  }
  return { intervalMs: elapsedMs, ...(cpu === null ? {} : { cpu }), ...(swap === null ? {} : { swap }), disks, nets };
}

export function parseDelta(text: string): Delta {
  try {
    const value = JSON.parse(text) as Partial<Delta>;
    return {
      intervalMs: typeof value.intervalMs === "number" && Number.isFinite(value.intervalMs) && value.intervalMs > 0 ? value.intervalMs : 0,
      ...(value.cpu === undefined ? {} : { cpu: value.cpu }),
      ...(value.swap === undefined ? {} : { swap: value.swap }),
      disks: value.disks ?? {},
      nets: value.nets ?? {}
    };
  } catch {
    return EMPTY;
  }
}
