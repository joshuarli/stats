import type { BlockPoint, DiskPoint, FilesystemPoint, NetPoint, Series, SummaryPoint } from "./aggregate";
import { encodeColumns, type ColumnView, type TableView } from "./binary/columns.ts";
import { SCHEMAS, type HostField, type HostKind, type ObjectValue } from "./binary/history.ts";
import type { RangeKey } from "./limits";
import type { ProjectHistory } from "./projects/history";

interface HostHistoryBase {
  readonly hostId: string;
  readonly range?: RangeKey;
  readonly fromMs: number;
  readonly toMs: number;
  readonly resolution: "raw" | "1m" | "1h";
  readonly stepMs: number;
}
export type HostHistory =
  | (HostHistoryBase & { readonly kind: "summary"; readonly points: readonly SummaryPoint[] })
  | (HostHistoryBase & { readonly kind: "disks"; readonly series: readonly Series<DiskPoint>[] })
  | (HostHistoryBase & { readonly kind: "nets"; readonly series: readonly Series<NetPoint>[] })
  | (HostHistoryBase & { readonly kind: "filesystems"; readonly series: readonly Series<FilesystemPoint>[] })
  | (HostHistoryBase & { readonly kind: "block"; readonly series: readonly Series<BlockPoint>[] });

interface Rows { readonly rows: number; readonly columns: readonly ColumnView[] }
export interface HostHistoryColumns {
  readonly kind: HostKind;
  readonly metadata: ObjectValue;
  readonly series: readonly { readonly metadata: ObjectValue; readonly rows: Rows }[];
}

type Reader<P> = (point: P) => number | undefined;
type Readers<K extends HostKind, P> = { readonly [F in HostField<K>]: Reader<P> };
const present = (): 1 => 1;

const summaryReaders: Readers<"summary", SummaryPoint> = {
  atMs: p => p.atMs, coverageMs: p => p.coverageMs, partial: p => (p.partial ? 1 : 0), cpuCount: p => p.cpuCount, uptimeMs: p => p.uptimeMs,
  cpu: p => (p.cpu === undefined ? undefined : present()), "cpu.user": p => p.cpu?.user, "cpu.system": p => p.cpu?.system, "cpu.idle": p => p.cpu?.idle, "cpu.iowait": p => p.cpu?.iowait, "cpu.steal": p => p.cpu?.steal,
  load: p => (p.load === undefined ? undefined : present()), "load.one": p => p.load?.one, "load.five": p => p.load?.five, "load.fifteen": p => p.load?.fifteen,
  mem: p => (p.mem === undefined ? undefined : present()), "mem.total": p => p.mem?.total, "mem.available": p => p.mem?.available, "mem.swapUsed": p => p.mem?.swapUsed,
  "mem.swapInBytesPerSec": p => p.mem?.swapInBytesPerSec, "mem.swapOutBytesPerSec": p => p.mem?.swapOutBytesPerSec,
  "mem.pressure": p => (p.mem?.pressure === undefined ? undefined : present()), "mem.pressure.warnPct": p => p.mem?.pressure?.warnPct, "mem.pressure.criticalPct": p => p.mem?.pressure?.criticalPct,
  psi: p => (p.psi === undefined ? undefined : present()),
  "psi.cpu": p => (p.psi?.cpu === undefined ? undefined : present()), "psi.cpu.some10": p => p.psi?.cpu?.some10, "psi.cpu.some60": p => p.psi?.cpu?.some60, "psi.cpu.some300": p => p.psi?.cpu?.some300,
  "psi.cpu.full10": p => p.psi?.cpu?.full10, "psi.cpu.full60": p => p.psi?.cpu?.full60, "psi.cpu.full300": p => p.psi?.cpu?.full300,
  "psi.memory": p => (p.psi?.memory === undefined ? undefined : present()), "psi.memory.some10": p => p.psi?.memory?.some10, "psi.memory.some60": p => p.psi?.memory?.some60, "psi.memory.some300": p => p.psi?.memory?.some300,
  "psi.memory.full10": p => p.psi?.memory?.full10, "psi.memory.full60": p => p.psi?.memory?.full60, "psi.memory.full300": p => p.psi?.memory?.full300,
  "psi.io": p => (p.psi?.io === undefined ? undefined : present()), "psi.io.some10": p => p.psi?.io?.some10, "psi.io.some60": p => p.psi?.io?.some60, "psi.io.some300": p => p.psi?.io?.some300,
  "psi.io.full10": p => p.psi?.io?.full10, "psi.io.full60": p => p.psi?.io?.full60, "psi.io.full300": p => p.psi?.io?.full300,
  gpu: p => (p.gpu === undefined ? undefined : present()), "gpu.busyPct": p => p.gpu?.busyPct,
  power: p => (p.power === undefined ? undefined : present()), "power.gpuWatts": p => p.power?.gpuWatts, "power.systemWatts": p => p.power?.systemWatts
};
const diskReaders: Readers<"disks", DiskPoint> = {
  atMs: p => p.atMs, readBytesPerSec: p => p.readBytesPerSec, writeBytesPerSec: p => p.writeBytesPerSec, readsPerSec: p => p.readsPerSec, writesPerSec: p => p.writesPerSec, busyPct: p => p.busyPct
};
const netReaders: Readers<"nets", NetPoint> = {
  atMs: p => p.atMs, rxBytesPerSec: p => p.rxBytesPerSec, txBytesPerSec: p => p.txBytesPerSec, rxPacketsPerSec: p => p.rxPacketsPerSec, txPacketsPerSec: p => p.txPacketsPerSec,
  rxDropsPerSec: p => p.rxDropsPerSec, txDropsPerSec: p => p.txDropsPerSec, rxErrorsPerSec: p => p.rxErrorsPerSec, txErrorsPerSec: p => p.txErrorsPerSec
};
const filesystemReaders: Readers<"filesystems", FilesystemPoint> = { atMs: p => p.atMs, total: p => p.total, available: p => p.available };
const blockReaders: Readers<"block", BlockPoint> = {
  atMs: p => p.atMs, count: p => p.count, totalUs: p => p.totalUs, minUs: p => p.minUs, maxUs: p => p.maxUs, p50Us: p => p.p50Us, p95Us: p => p.p95Us, p99Us: p => p.p99Us
};

export function roundValue(value: number): number {
  return Number.isInteger(value) || !Number.isFinite(value) ? value : Math.round(value * 1000) / 1000;
}

function column<T>(name: string, type: "f64" | "u8", items: readonly T[], read: Reader<T>): ColumnView | null {
  const rows = items.length;
  const values = type === "f64" ? new Float64Array(rows) : new Uint8Array(rows);
  let validity: Uint8Array | null = null;
  let found = 0;
  for (let row = 0; row < rows; row += 1) {
    const value = read(items[row]!);
    if (value === undefined || !Number.isFinite(value)) {
      if (validity === null) {
        validity = new Uint8Array((rows + 7) >> 3);
        for (let earlier = 0; earlier < row; earlier += 1) validity[earlier >> 3]! |= 1 << (earlier & 7);
      }
      continue;
    }
    values[row] = roundValue(value);
    if (validity !== null) validity[row >> 3]! |= 1 << (row & 7);
    found += 1;
  }
  if (found === 0) return null;
  return type === "f64" ? { name, type, values: values as Float64Array, validity } : { name, type, values: values as Uint8Array, validity };
}

function rowsOf<K extends HostKind, P>(kind: K, points: readonly P[], readers: Readers<K, P>): Rows {
  const schema = SCHEMAS[kind] as Readonly<Record<HostField<K>, "number" | "boolean" | "object">>;
  const columns: ColumnView[] = [];
  if (points.length > 0) {
    for (const field of Object.keys(schema) as HostField<K>[]) {
      const built = column(field, schema[field] === "number" ? "f64" : "u8", points, readers[field]);
      if (built !== null) columns.push(built);
    }
  }
  return { rows: points.length, columns };
}

function describe(history: HostHistory): ObjectValue {
  const { hostId, range, kind, fromMs, toMs, resolution, stepMs } = history;
  return { hostId, ...(range === undefined ? {} : { range }), kind, fromMs, toMs, resolution, stepMs };
}

function seriesOf<P>(kind: Exclude<HostKind, "summary">, series: readonly Series<P>[], readers: Readers<typeof kind, P>) {
  return series.map(entry => ({ metadata: { id: entry.id, ...(entry.name === undefined ? {} : { name: entry.name }) }, rows: rowsOf(kind, entry.points, readers) }));
}

/** Every number is rounded to three decimals, as the JSON representation did. */
export function hostHistoryColumns(history: HostHistory): HostHistoryColumns {
  const metadata = describe(history);
  switch (history.kind) {
    case "summary":
      return { kind: "summary", metadata, series: [{ metadata: {}, rows: rowsOf("summary", history.points, summaryReaders) }] };
    case "disks":
      return { kind: "disks", metadata, series: seriesOf("disks", history.series, diskReaders) };
    case "nets":
      return { kind: "nets", metadata, series: seriesOf("nets", history.series, netReaders) };
    case "filesystems":
      return { kind: "filesystems", metadata, series: seriesOf("filesystems", history.series, filesystemReaders) };
    case "block":
      return { kind: "block", metadata, series: seriesOf("block", history.series, blockReaders) };
  }
}

function sameAxis(left: Float64Array, right: Float64Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (!Object.is(left[index], right[index])) return false;
  return true;
}

class Tables {
  readonly tables: TableView[] = [];
  private readonly axes: Float64Array[] = [];

  add(rows: Rows): string {
    const name = String(this.tables.length);
    const columns = rows.columns.map(entry => {
      if (entry.name !== "atMs" || entry.type !== "f64") return entry;
      const shared = this.axes.find(axis => sameAxis(axis, entry.values));
      if (shared === undefined) {
        this.axes.push(entry.values);
        return entry;
      }
      return { ...entry, values: shared };
    });
    this.tables.push({ name, rows: rows.rows, columns });
    return name;
  }
}

function hostNode(tables: Tables, columns: HostHistoryColumns) {
  const series = columns.series.map(entry => ({ metadata: entry.metadata, table: tables.add(entry.rows) }));
  return { form: columns.kind === "summary" ? "points" : "series", metadata: columns.metadata, series };
}

function frame(node: unknown, tables: Tables): Uint8Array<ArrayBuffer> {
  return encodeColumns({ metadata: { format: "stats-history", node }, tables: tables.tables });
}

export function encodeHostHistory(columns: HostHistoryColumns): Uint8Array<ArrayBuffer> {
  const tables = new Tables();
  return frame(hostNode(tables, columns), tables);
}

export function encodeHostBundle(hostId: string, columns: readonly HostHistoryColumns[]): Uint8Array<ArrayBuffer> {
  const tables = new Tables();
  const entries = columns.map(entry => ({ name: entry.kind, node: hostNode(tables, entry) }));
  return frame({ form: "bundle", metadata: { hostId }, entries }, tables);
}

function projectNode(tables: Tables, history: ProjectHistory) {
  if (history.kind === "collector") return { form: "collector", value: history };
  const { projectId, range, kind, fromMs, toMs, stepMs } = history;
  const rows = history.series[0]?.values.length ?? 0;
  const columns = history.series.map((entry): ColumnView => {
    if (entry.values.length !== rows) throw new Error("project history series does not cover its window");
    const values = new Float64Array(rows);
    const validity = new Uint8Array((rows + 7) >> 3);
    let found = 0;
    for (let row = 0; row < rows; row += 1) {
      const value = entry.values[row];
      if (value === null || value === undefined) continue;
      values[row] = value;
      validity[row >> 3]! |= 1 << (row & 7);
      found += 1;
    }
    return { name: entry.metric, type: "f64", values, validity: found === rows ? null : validity };
  });
  return { form: "metrics", metadata: { projectId, range, kind, fromMs, toMs, stepMs }, table: tables.add({ rows, columns }) };
}

export function encodeProjectHistory(history: ProjectHistory): Uint8Array<ArrayBuffer> {
  const tables = new Tables();
  return frame(projectNode(tables, history), tables);
}

export function encodeProjectBundle(projectId: string, histories: readonly ProjectHistory[]): Uint8Array<ArrayBuffer> {
  const tables = new Tables();
  const entries = histories.map(history => ({ name: history.kind, node: projectNode(tables, history) }));
  return frame({ form: "bundle", metadata: { projectId }, entries }, tables);
}
