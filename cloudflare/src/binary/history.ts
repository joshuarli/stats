import type { HistoryKind } from "../limits";
import { decodeColumns, isPresent, type ColumnView, type FrameView, type TableView } from "./columns.ts";

export const HISTORY_CONTENT_TYPE = "application/vnd.stats.history.v1";
export type FieldKind = "number" | "boolean" | "object";

const SUMMARY = {
  atMs: "number", coverageMs: "number", partial: "boolean", cpuCount: "number", uptimeMs: "number",
  cpu: "object", "cpu.user": "number", "cpu.system": "number", "cpu.idle": "number", "cpu.iowait": "number", "cpu.steal": "number",
  load: "object", "load.one": "number", "load.five": "number", "load.fifteen": "number",
  mem: "object", "mem.total": "number", "mem.available": "number", "mem.swapUsed": "number", "mem.swapInBytesPerSec": "number", "mem.swapOutBytesPerSec": "number",
  "mem.pressure": "object", "mem.pressure.warnPct": "number", "mem.pressure.criticalPct": "number",
  psi: "object",
  "psi.cpu": "object", "psi.cpu.some10": "number", "psi.cpu.some60": "number", "psi.cpu.some300": "number", "psi.cpu.full10": "number", "psi.cpu.full60": "number", "psi.cpu.full300": "number",
  "psi.memory": "object", "psi.memory.some10": "number", "psi.memory.some60": "number", "psi.memory.some300": "number", "psi.memory.full10": "number", "psi.memory.full60": "number", "psi.memory.full300": "number",
  "psi.io": "object", "psi.io.some10": "number", "psi.io.some60": "number", "psi.io.some300": "number", "psi.io.full10": "number", "psi.io.full60": "number", "psi.io.full300": "number",
  gpu: "object", "gpu.busyPct": "number",
  power: "object", "power.gpuWatts": "number", "power.systemWatts": "number"
} as const;
const DISKS = { atMs: "number", readBytesPerSec: "number", writeBytesPerSec: "number", readsPerSec: "number", writesPerSec: "number", busyPct: "number" } as const;
const NETS = {
  atMs: "number", rxBytesPerSec: "number", txBytesPerSec: "number", rxPacketsPerSec: "number", txPacketsPerSec: "number",
  rxDropsPerSec: "number", txDropsPerSec: "number", rxErrorsPerSec: "number", txErrorsPerSec: "number"
} as const;
const FILESYSTEMS = { atMs: "number", total: "number", available: "number" } as const;
const BLOCK = { atMs: "number", count: "number", totalUs: "number", minUs: "number", maxUs: "number", p50Us: "number", p95Us: "number", p99Us: "number" } as const;

export const SCHEMAS = { summary: SUMMARY, disks: DISKS, nets: NETS, filesystems: FILESYSTEMS, block: BLOCK } as const satisfies Readonly<Record<HistoryKind, Readonly<Record<string, FieldKind>>>>;
export type HostKind = HistoryKind;
export type HostField<K extends HostKind> = keyof (typeof SCHEMAS)[K] & string;
export type SummaryField = HostField<"summary">;
export const PROJECT_METRIC_KINDS = ["worker", "routes", "durable-objects", "r2", "d1", "d1-statements", "probes"] as const;
export type ProjectMetricKind = (typeof PROJECT_METRIC_KINDS)[number];

const REQUIRED: Readonly<Record<HostKind, readonly string[]>> = {
  summary: ["atMs", "coverageMs", "partial"],
  disks: ["atMs", "readBytesPerSec", "writeBytesPerSec", "readsPerSec", "writesPerSec"],
  nets: ["atMs", "rxBytesPerSec", "txBytesPerSec", "rxPacketsPerSec", "txPacketsPerSec", "rxDropsPerSec", "rxErrorsPerSec", "txErrorsPerSec"],
  filesystems: ["atMs", "total", "available"],
  block: ["atMs", "count", "totalUs", "minUs", "maxUs", "p50Us", "p95Us", "p99Us"]
};
const REQUIRED_GROUPS: Readonly<Record<string, readonly string[]>> = {
  cpu: ["user", "system", "idle"], load: ["one", "five", "fifteen"],
  mem: ["total", "available", "swapUsed"], "mem.pressure": ["warnPct", "criticalPct"],
  "psi.cpu": ["some10", "some60", "some300"], "psi.memory": ["some10", "some60", "some300"],
  "psi.io": ["some10", "some60", "some300"], gpu: ["busyPct"]
};
const PAIRED_FIELDS = [["mem.swapInBytesPerSec", "mem.swapOutBytesPerSec"], ...["cpu", "memory", "io"].map(group => ["10", "60", "300"].map(period => `psi.${group}.full${period}`))];

export type ObjectValue = Readonly<Record<string, unknown>>;
export interface PointsView { readonly form: "points"; readonly metadata: ObjectValue; readonly series: readonly { readonly metadata: ObjectValue; readonly table: TableView }[] }
export interface SeriesView { readonly form: "series"; readonly metadata: ObjectValue; readonly series: readonly { readonly metadata: ObjectValue; readonly table: TableView }[] }
export interface MetricsView { readonly form: "metrics"; readonly metadata: ObjectValue; readonly table: TableView }
export interface CollectorView { readonly form: "collector"; readonly value: ObjectValue }
export type SingleView = PointsView | SeriesView | MetricsView | CollectorView;
export interface BundleView { readonly form: "bundle"; readonly metadata: ObjectValue; readonly entries: readonly { readonly name: string; readonly history: SingleView }[] }
export type HistoryView = SingleView | BundleView;

function fail(message: string): never { throw new Error(`stats history: ${message}`); }
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("expected object");
  return value as ObjectValue;
}
function list(value: unknown): unknown[] { if (!Array.isArray(value)) fail("expected array"); return value; }
function text(value: unknown): string { if (typeof value !== "string" || value.length === 0) fail("expected name"); return value; }
export function hostKind(kind: unknown): HostKind {
  if (typeof kind !== "string" || !Object.hasOwn(SCHEMAS, kind)) fail("unknown host history kind");
  return kind as HostKind;
}
function fieldKind(kind: HostKind, field: string): FieldKind | undefined {
  const schema: Readonly<Record<string, FieldKind>> = SCHEMAS[kind];
  return Object.hasOwn(schema, field) ? schema[field] : undefined;
}
function exact(value: ObjectValue, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("unknown metadata field");
}
export function bundleIdentity(value: ObjectValue): { readonly key: "hostId" | "projectId"; readonly id: string } {
  const host = Object.hasOwn(value, "hostId");
  const project = Object.hasOwn(value, "projectId");
  if (host === project) fail("bundle must have exactly one identity");
  const key = host ? "hostId" : "projectId";
  exact(value, [key]);
  return { key, id: text(value[key]) };
}
export function bundleEntry(identity: { readonly key: "hostId" | "projectId"; readonly id: string }, name: string, value: ObjectValue): void {
  if (identity.key === "hostId" ? !Object.hasOwn(SCHEMAS, name) : name !== "collector" && !(PROJECT_METRIC_KINDS as readonly string[]).includes(name)) fail("invalid bundled history kind");
  if (value.kind !== name || value[identity.key] !== identity.id) fail("history bundle identity or kind mismatch");
}
export function windowMetadata(value: ObjectValue): void {
  for (const key of ["fromMs", "toMs", "stepMs"]) if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0) fail("invalid time window");
  if ((value.stepMs as number) <= 0 || (value.fromMs as number) > (value.toMs as number)) fail("invalid time window");
}

function checkPoints(table: TableView, kind: HostKind): void {
  const columns = new Map(table.columns.map(column => [column.name, column]));
  function subset(left: ColumnView, right: ColumnView | undefined): void {
    if (right === undefined) fail("missing dependent point field");
    if (right.validity === null) return;
    for (let index = 0; index < right.validity.length; index += 1) {
      const mask = index === right.validity.length - 1 && table.rows % 8 !== 0 ? (1 << (table.rows % 8)) - 1 : 255;
      if (((left.validity?.[index] ?? 255) & ~right.validity[index]! & mask) !== 0) fail("inconsistent point presence");
    }
  }
  for (const column of table.columns) {
    const type = fieldKind(kind, column.name);
    if (type === undefined || column.type !== (type === "number" ? "f64" : "u8")) fail("invalid point column");
    const separator = column.name.lastIndexOf(".");
    if (separator !== -1) subset(column, columns.get(column.name.slice(0, separator)));
    if (type !== "number" || column.name === "atMs") {
      for (let row = 0; row < table.rows; row += 1) {
        if (!isPresent(column, row)) continue;
        const value = column.values[row] as number;
        if ((type === "object" && value !== 1) || (type === "boolean" && value !== 0 && value !== 1)) fail("invalid presence or boolean");
        if (column.name === "atMs" && (!Number.isSafeInteger(value) || value < 0)) fail("invalid timestamp");
      }
    }
    if (type === "object") for (const field of REQUIRED_GROUPS[column.name] ?? []) subset(column, columns.get(`${column.name}.${field}`));
  }
  for (const required of REQUIRED[kind]) {
    const column = columns.get(required);
    if (table.rows > 0 && (column === undefined || column.validity !== null)) fail("missing required point field");
  }
  for (const pair of PAIRED_FIELDS) for (const field of pair) {
    const column = columns.get(field);
    if (column !== undefined) for (const other of pair) subset(column, columns.get(other));
  }
}

/** Validates a frame and returns bounded metadata plus typed column views. Points are never materialized as objects. */
export function openHistory(input: ArrayBuffer | Uint8Array): { readonly root: HistoryView; readonly zeroCopy: boolean } {
  const frame: FrameView = decodeColumns(input);
  const metadata = object(frame.metadata);
  exact(metadata, ["format", "node"]);
  if (metadata.format !== "stats-history") fail("unknown history format");
  const tables = new Map(frame.tables.map(table => [table.name, table]));
  const used = new Set<string>();
  function claim(value: unknown): TableView {
    const name = text(value);
    const table = tables.get(name);
    if (table === undefined || used.has(name)) fail("invalid table reference");
    used.add(name);
    return table;
  }
  function single(value: unknown): SingleView {
    const node = object(value);
    if (node.form === "collector") {
      exact(node, ["form", "value"]);
      const found = object(node.value);
      if (found.kind !== "collector") fail("invalid collector");
      list(found.runs);
      return { form: "collector", value: found };
    }
    if (node.form === "metrics") {
      exact(node, ["form", "metadata", "table"]);
      const data = object(node.metadata);
      windowMetadata(data);
      text(data.projectId);
      if (!(PROJECT_METRIC_KINDS as readonly string[]).includes(text(data.kind))) fail("unknown project kind");
      const table = claim(node.table);
      if (table.columns.some(column => column.type !== "f64")) fail("invalid metric column");
      return { form: "metrics", metadata: data, table };
    }
    if (node.form !== "points" && node.form !== "series") fail("invalid history layout");
    exact(node, ["form", "metadata", "series"]);
    const data = object(node.metadata);
    windowMetadata(data);
    text(data.hostId);
    const kind = hostKind(data.kind);
    if ((node.form === "points") !== (kind === "summary")) fail("incorrect point layout");
    const series = list(node.series).map(item => {
      const entry = object(item);
      exact(entry, ["metadata", "table"]);
      const table = claim(entry.table);
      const meta = object(entry.metadata);
      if (node.form === "series") text(meta.id);
      checkPoints(table, kind);
      return { metadata: meta, table };
    });
    if (node.form === "points") {
      if (series.length !== 1) fail("invalid summary tables");
      return { form: "points", metadata: data, series };
    }
    return { form: "series", metadata: data, series };
  }
  const top = object(metadata.node);
  let root: HistoryView;
  if (top.form === "bundle") {
    exact(top, ["form", "metadata", "entries"]);
    const bundle = object(top.metadata);
    const identity = bundleIdentity(bundle);
    const names = new Set<string>();
    root = { form: "bundle", metadata: bundle, entries: list(top.entries).map(value => {
      const entry = object(value);
      exact(entry, ["name", "node"]);
      const name = text(entry.name);
      if (names.has(name)) fail("duplicate history kind");
      names.add(name);
      const history = single(entry.node);
      bundleEntry(identity, name, history.form === "collector" ? history.value : history.metadata);
      return { name, history };
    }) };
  } else root = single(top);
  if (used.size !== tables.size) fail("unreferenced table");
  return { root, zeroCopy: frame.zeroCopy };
}
