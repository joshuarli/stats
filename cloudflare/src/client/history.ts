import type { BundleView, HistoryView, HostField, HostKind, ObjectValue, ProjectMetricKind, SingleView, SummaryField } from "../binary/history";
import { RANGES, type RangeKey } from "../limits";
import { gridAxis, hostAxis, Table, type Track } from "./columns";

export interface HostMeta {
  readonly hostId: string;
  readonly range?: RangeKey;
  readonly fromMs: number;
  readonly toMs: number;
  readonly resolution: "raw" | "1m" | "1h";
  readonly stepMs: number;
}

export type SummaryTable = Table<SummaryField>;

export interface SummaryHistory extends HostMeta {
  readonly table: SummaryTable;
}

type DeviceKind = Exclude<HostKind, "summary">;

export interface DeviceSeries<K extends DeviceKind> {
  readonly id: string;
  readonly name?: string;
  readonly table: Table<HostField<K>>;
}

export interface DeviceHistory<K extends DeviceKind> extends HostMeta {
  readonly series: readonly DeviceSeries<K>[];
}

export type DiskSeries = DeviceSeries<"disks">;
export type NetSeries = DeviceSeries<"nets">;
export type FilesystemSeries = DeviceSeries<"filesystems">;
export type BlockSeries = DeviceSeries<"block">;

export interface HostHistories {
  readonly summary: SummaryHistory;
  readonly disks: DeviceHistory<"disks">;
  readonly nets: DeviceHistory<"nets">;
  readonly filesystems: DeviceHistory<"filesystems">;
  readonly block: DeviceHistory<"block">;
}

export type FleetHistories = Pick<HostHistories, "summary" | "disks" | "nets" | "filesystems">;

export interface MetricHistory {
  readonly projectId: string;
  readonly range: RangeKey;
  readonly kind: ProjectMetricKind;
  readonly fromMs: number;
  readonly toMs: number;
  readonly stepMs: number;
  readonly table: Table<string>;
}

export interface CollectorRun {
  readonly atMs: number;
  readonly ok: boolean;
  readonly detail: string;
  readonly rowsRead: number;
  readonly durationMs: number;
}

export interface CollectorHistory {
  readonly projectId: string;
  readonly range: RangeKey;
  readonly fromMs: number;
  readonly toMs: number;
  readonly runs: readonly CollectorRun[];
}

export interface ProjectHistories {
  readonly worker: MetricHistory;
  readonly routes: MetricHistory;
  readonly r2: MetricHistory;
  readonly collector: CollectorHistory;
  readonly "durable-objects"?: MetricHistory;
  readonly d1?: MetricHistory;
  readonly "d1-statements"?: MetricHistory;
  readonly probes?: MetricHistory;
}

function isRecord(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("expected a finite number");
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("expected a boolean");
  return value;
}

function rangeOf(value: unknown): RangeKey {
  const found = RANGES.find(range => range === value);
  if (found === undefined) throw new Error("expected a range");
  return found;
}

function hostMeta(metadata: ObjectValue): HostMeta {
  const resolution = metadata.resolution;
  if (resolution !== "raw" && resolution !== "1m" && resolution !== "1h") throw new Error("expected a history resolution");
  return {
    hostId: text(metadata.hostId),
    ...(metadata.range === undefined ? {} : { range: rangeOf(metadata.range) }),
    fromMs: finite(metadata.fromMs),
    toMs: finite(metadata.toMs),
    resolution,
    stepMs: finite(metadata.stepMs)
  };
}

function summaryFrom(history: SingleView): SummaryHistory {
  if (history.form !== "points" || history.metadata.kind !== "summary") throw new Error("expected summary history");
  const view = history.series[0]!.table;
  return { ...hostMeta(history.metadata), table: Table.from<SummaryField>(view, hostAxis(view)) };
}

function devicesFrom<K extends DeviceKind>(history: SingleView, kind: K): DeviceHistory<K> {
  if (history.form !== "series" || history.metadata.kind !== kind) throw new Error(`expected ${kind} history`);
  return {
    ...hostMeta(history.metadata),
    series: history.series.map(entry => ({
      id: text(entry.metadata.id),
      ...(entry.metadata.name === undefined ? {} : { name: text(entry.metadata.name) }),
      table: Table.from<HostField<K>>(entry.table, hostAxis(entry.table))
    }))
  };
}

function bundled(root: HistoryView): BundleView {
  if (root.form !== "bundle") throw new Error("expected a history bundle");
  return root;
}

function entry(bundle: BundleView, name: string): SingleView {
  const found = bundle.entries.find(candidate => candidate.name === name);
  if (found === undefined) throw new Error(`expected ${name} history`);
  return found.history;
}

export function decodeSummary(root: HistoryView): SummaryHistory {
  if (root.form === "bundle") throw new Error("expected a single history");
  return summaryFrom(root);
}

export function decodeFleetHistories(root: HistoryView): FleetHistories {
  const bundle = bundled(root);
  return {
    summary: summaryFrom(entry(bundle, "summary")),
    disks: devicesFrom(entry(bundle, "disks"), "disks"),
    nets: devicesFrom(entry(bundle, "nets"), "nets"),
    filesystems: devicesFrom(entry(bundle, "filesystems"), "filesystems")
  };
}

export function decodeHostHistories(root: HistoryView): HostHistories {
  const bundle = bundled(root);
  return {
    ...decodeFleetHistories(root),
    filesystems: devicesFrom(entry(bundle, "filesystems"), "filesystems"),
    block: devicesFrom(entry(bundle, "block"), "block")
  };
}

function metricsFrom(history: SingleView, kind: ProjectMetricKind): MetricHistory {
  if (history.form !== "metrics" || history.metadata.kind !== kind) throw new Error(`expected ${kind} history`);
  const { metadata, table } = history;
  const fromMs = finite(metadata.fromMs);
  const stepMs = finite(metadata.stepMs);
  return {
    projectId: text(metadata.projectId),
    range: rangeOf(metadata.range),
    kind,
    fromMs,
    toMs: finite(metadata.toMs),
    stepMs,
    table: Table.from<string>(table, gridAxis(table.rows, fromMs, stepMs))
  };
}

function collectorFrom(history: SingleView): CollectorHistory {
  if (history.form !== "collector") throw new Error("expected collector history");
  const value = history.value;
  if (!Array.isArray(value.runs)) throw new Error("expected collector runs");
  return {
    projectId: text(value.projectId),
    range: rangeOf(value.range),
    fromMs: finite(value.fromMs),
    toMs: finite(value.toMs),
    runs: value.runs.map((item: unknown) => {
      if (!isRecord(item)) throw new Error("expected a collector run");
      return { atMs: finite(item.atMs), ok: flag(item.ok), detail: text(item.detail), rowsRead: finite(item.rowsRead), durationMs: finite(item.durationMs) };
    })
  };
}

export function decodeProjectHistories(root: HistoryView): ProjectHistories {
  const bundle = bundled(root);
  const optional = (kind: ProjectMetricKind): { readonly [name in ProjectMetricKind]?: MetricHistory } => {
    const found = bundle.entries.find(candidate => candidate.name === kind);
    return found === undefined ? {} : { [kind]: metricsFrom(found.history, kind) };
  };
  return {
    worker: metricsFrom(entry(bundle, "worker"), "worker"),
    routes: metricsFrom(entry(bundle, "routes"), "routes"),
    r2: metricsFrom(entry(bundle, "r2"), "r2"),
    collector: collectorFrom(entry(bundle, "collector")),
    ...optional("durable-objects"),
    ...optional("d1"),
    ...optional("d1-statements"),
    ...optional("probes")
  };
}

export function metricTrack(history: MetricHistory, metric: string): Track {
  return history.table.has(metric) ? history.table.track(metric) : { times: [], values: [] };
}
