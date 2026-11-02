import { cell, decodeColumns, encodeColumns, type ColumnInput, type FrameView, type TableInput, type TableView, type ColumnView } from "./columns.ts";

/** Binary is an opt-in integration candidate. JSON remains the production API. */
export const HISTORY_CONTENT_TYPE = "application/vnd.stats.history.v1";
type Field = "number" | "boolean" | "object";
type Schema = Readonly<Record<string, Field>>;
const psiGroup = { some10: "number", some60: "number", some300: "number", full10: "number", full60: "number", full300: "number" } as const;
function group(prefix: string, fields: Schema): Record<string, Field> {
  return Object.fromEntries([[prefix, "object"], ...Object.entries(fields).map(([key, value]) => [`${prefix}.${key}`, value])]) as Record<string, Field>;
}
const SCHEMAS: Readonly<Record<string, Schema>> = {
  summary: {
    atMs: "number", coverageMs: "number", partial: "boolean", cpuCount: "number", uptimeMs: "number",
    ...group("cpu", { user: "number", system: "number", idle: "number", iowait: "number", steal: "number" }),
    ...group("load", { one: "number", five: "number", fifteen: "number" }),
    ...group("mem", { total: "number", available: "number", swapUsed: "number", swapInBytesPerSec: "number", swapOutBytesPerSec: "number", ...group("pressure", { warnPct: "number", criticalPct: "number" }) }),
    ...group("psi", { ...group("cpu", psiGroup), ...group("memory", psiGroup), ...group("io", psiGroup) }),
    ...group("gpu", { busyPct: "number" }),
    ...group("power", { gpuWatts: "number", systemWatts: "number" })
  },
  disks: { atMs: "number", readBytesPerSec: "number", writeBytesPerSec: "number", readsPerSec: "number", writesPerSec: "number", busyPct: "number" },
  nets: { atMs: "number", rxBytesPerSec: "number", txBytesPerSec: "number", rxPacketsPerSec: "number", txPacketsPerSec: "number", rxDropsPerSec: "number", txDropsPerSec: "number", rxErrorsPerSec: "number", txErrorsPerSec: "number" },
  filesystems: { atMs: "number", total: "number", available: "number" },
  block: { atMs: "number", count: "number", totalUs: "number", minUs: "number", maxUs: "number", p50Us: "number", p95Us: "number", p99Us: "number" }
};
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  summary: ["atMs", "coverageMs", "partial"],
  disks: ["atMs", "readBytesPerSec", "writeBytesPerSec", "readsPerSec", "writesPerSec"],
  nets: ["atMs", "rxBytesPerSec", "txBytesPerSec", "rxPacketsPerSec", "txPacketsPerSec", "rxDropsPerSec", "rxErrorsPerSec", "txErrorsPerSec"],
  filesystems: ["atMs", "total", "available"],
  block: ["atMs", "count", "totalUs", "minUs", "maxUs", "p50Us", "p95Us", "p99Us"]
};
const PROJECT_KINDS = ["worker", "routes", "durable-objects", "r2", "d1", "d1-statements", "probes"];
type ObjectValue = Record<string, unknown>;
interface SeriesNode { metadata: ObjectValue; table: string }
interface DataNode { form: "points" | "series" | "metrics"; metadata: ObjectValue; series: SeriesNode[] }
interface CollectorNode { form: "collector"; value: ObjectValue }
interface BundleNode { form: "bundle"; metadata: ObjectValue; entries: { name: string; node: DataNode | CollectorNode }[] }
type Node = DataNode | CollectorNode | BundleNode;
export type HistoryView =
  | { readonly form: "bundle"; readonly metadata: ObjectValue; readonly entries: readonly { readonly name: string; readonly history: HistoryView }[] }
  | { readonly form: "collector"; readonly value: ObjectValue }
  | { readonly form: "points" | "series" | "metrics"; readonly metadata: ObjectValue; readonly series: readonly { readonly metadata: ObjectValue; readonly table: TableView }[] };

function fail(message: string): never { throw new Error(`stats history: ${message}`); }
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("expected object");
  return value as ObjectValue;
}
function list(value: unknown): unknown[] { if (!Array.isArray(value)) fail("expected array"); return value; }
function text(value: unknown): string { if (typeof value !== "string" || value.length === 0) fail("expected name"); return value; }
function schemaFor(kind: unknown): Schema {
  if (typeof kind !== "string" || !Object.hasOwn(SCHEMAS, kind)) fail("unknown host history kind");
  return SCHEMAS[kind]!;
}
function omit(value: ObjectValue, key: string): ObjectValue { return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)); }
function exact(value: ObjectValue, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("unknown metadata field");
}
function bundleIdentity(value: ObjectValue): { readonly key: "hostId" | "projectId"; readonly id: string } {
  const host = Object.hasOwn(value, "hostId");
  const project = Object.hasOwn(value, "projectId");
  if (host === project) fail("bundle must have exactly one identity");
  const key = host ? "hostId" : "projectId";
  exact(value, [key]);
  return { key, id: text(value[key]) };
}
function bundleEntry(identity: { readonly key: "hostId" | "projectId"; readonly id: string }, name: string, value: ObjectValue): void {
  if (identity.key === "hostId" ? !Object.hasOwn(SCHEMAS, name) : name !== "collector" && !PROJECT_KINDS.includes(name)) fail("invalid bundled history kind");
  if (value.kind !== name || value[identity.key] !== identity.id) fail("history bundle identity or kind mismatch");
}
function windowMetadata(value: ObjectValue): void {
  for (const key of ["fromMs", "toMs", "stepMs"]) if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0) fail("invalid time window");
  if ((value.stepMs as number) <= 0 || (value.fromMs as number) > (value.toMs as number)) fail("invalid time window");
}
function flatten(value: ObjectValue, schema: Schema, output: Map<string, (number | null)[]>, row: number, count: number, prefix = ""): void {
  for (const [key, entry] of Object.entries(value)) {
    if (key.includes(".")) fail("literal dotted point key");
    const path = prefix + key;
    if (!Object.hasOwn(schema, path)) fail(`unknown point field ${path}`);
    const type = schema[path];
    let column = output.get(path);
    if (column === undefined) { column = Array.from({ length: count }, () => null); output.set(path, column); }
    if (type === "object") { column[row] = 1; flatten(object(entry), schema, output, row, count, `${path}.`); }
    else if (type === "boolean") { if (typeof entry !== "boolean") fail("invalid boolean"); column[row] = entry ? 1 : 0; }
    else { if (typeof entry !== "number" || !Number.isFinite(entry)) fail("invalid number"); column[row] = entry; }
  }
}

export function encodeHistory(history: unknown): Uint8Array {
  const tables: TableInput[] = [];
  const axes = new Map<string, readonly number[]>();
  function addPoints(value: unknown, kind: string): string {
    const points = list(value);
    if (points.length > 16384) fail("too many points");
    const schema = schemaFor(kind);
    const fields = new Map<string, (number | null)[]>();
    for (let row = 0; row < points.length; row += 1) flatten(object(points[row]), schema, fields, row, points.length);
    if (points.length > 0) {
      for (const key of REQUIRED[kind]!) {
        const column = fields.get(key);
        if (column === undefined || column.some(value => value === null)) fail("incomplete point");
      }
      for (const timestamp of fields.get("atMs")!) if (!Number.isSafeInteger(timestamp) || timestamp! < 0) fail("invalid timestamp");
    }
    function presentTogether(left: readonly (number | null)[], right: readonly (number | null)[] | undefined): void {
      if (right === undefined || left.some((value, row) => value !== null && right[row] === null)) fail("missing dependent point field");
    }
    for (const [name, required] of Object.entries(REQUIRED_GROUPS)) {
      const column = fields.get(name);
      if (column !== undefined) for (const field of required) presentTogether(column, fields.get(`${name}.${field}`));
    }
    for (const pair of PAIRED_FIELDS) for (const field of pair) {
      const column = fields.get(field);
      if (column !== undefined) for (const other of pair) presentTogether(column, fields.get(other));
    }
    const columns: ColumnInput[] = [];
    for (const [name, type] of Object.entries(schema)) {
      const column = fields.get(name);
      if (column === undefined) continue;
      let values: ArrayLike<number | null> = column;
      if (name === "atMs") {
        const timestamps = values as readonly number[];
        const key = timestamps.join(",");
        const old = axes.get(key);
        if (old !== undefined && old.every((value, index) => Object.is(value, timestamps[index]))) values = old;
        else axes.set(key, timestamps);
      }
      columns.push({ name, type: type === "number" ? "f64" : "u8", values });
    }
    const name = String(tables.length);
    tables.push({ name, rows: points.length, columns });
    return name;
  }
  function single(value: unknown): DataNode | CollectorNode {
    const entry = object(value);
    const kind = text(entry.kind);
    if (kind === "collector") { list(entry.runs); return { form: "collector", value: entry }; }
    windowMetadata(entry);
    if (Object.hasOwn(entry, "hostId")) {
      schemaFor(kind);
      if (kind === "summary") return { form: "points", metadata: omit(entry, "points"), series: [{ metadata: {}, table: addPoints(entry.points, kind) }] };
      return { form: "series", metadata: omit(entry, "series"), series: list(entry.series).map(item => {
        const series = object(item);
        text(series.id);
        return { metadata: omit(series, "points"), table: addPoints(series.points, kind) };
      }) };
    }
    if (!Object.hasOwn(entry, "projectId") || !PROJECT_KINDS.includes(kind)) fail("unknown project history kind");
    return { form: "metrics", metadata: omit(entry, "series"), series: list(entry.series).map(item => {
      const series = object(item);
      text(series.metric);
      const values = list(series.values);
      const name = String(tables.length);
      tables.push({ name, rows: values.length, columns: [{ name: "value", type: "f64", values: values as (number | null)[] }] });
      return { metadata: omit(series, "values"), table: name };
    }) };
  }
  const root = object(history);
  let node: Node;
  if (Object.hasOwn(root, "histories")) {
    const metadata = omit(root, "histories");
    const identity = bundleIdentity(metadata);
    const entries = Object.entries(object(root.histories)).map(([name, entry]) => {
      bundleEntry(identity, name, object(entry));
      return { name, node: single(entry) };
    });
    node = { form: "bundle", metadata, entries };
  } else node = single(root);
  return encodeColumns({ metadata: { format: "stats-history", node }, tables });
}

const REQUIRED_GROUPS: Readonly<Record<string, readonly string[]>> = {
  cpu: ["user", "system", "idle"], load: ["one", "five", "fifteen"],
  mem: ["total", "available", "swapUsed"], "mem.pressure": ["warnPct", "criticalPct"],
  "psi.cpu": ["some10", "some60", "some300"], "psi.memory": ["some10", "some60", "some300"],
  "psi.io": ["some10", "some60", "some300"], gpu: ["busyPct"]
};

const PAIRED_FIELDS = [["mem.swapInBytesPerSec", "mem.swapOutBytesPerSec"], ...["cpu", "memory", "io"].map(name => ["10", "60", "300"].map(period => `psi.${name}.full${period}`))];

function checkPoints(table: TableView, kind: string): void {
  const schema = schemaFor(kind);
  const columns = new Map(table.columns.map(column => [column.name, column]));
  // Presence checks work on bitmaps, not materialized cells. Every bit set in left
  // must also be set in right. Mask the unused bits in the final byte.
  function subset(left: ColumnView, right: ColumnView | undefined): void {
    if (right === undefined) fail("missing dependent point field");
    if (right.validity === null) return;
    for (let index = 0; index < right.validity.length; index += 1) {
      const mask = index === right.validity.length - 1 && table.rows % 8 !== 0 ? (1 << (table.rows % 8)) - 1 : 255;
      if (((left.validity?.[index] ?? 255) & ~right.validity[index]! & mask) !== 0) fail("inconsistent point presence");
    }
  }
  for (const column of table.columns) {
    const type = schema[column.name];
    if (!Object.hasOwn(schema, column.name) || column.type !== (type === "number" ? "f64" : "u8")) fail("invalid point column");
    const separator = column.name.lastIndexOf(".");
    if (separator !== -1) subset(column, columns.get(column.name.slice(0, separator)));
    if (type !== "number" || column.name === "atMs") {
      for (let row = 0; row < table.rows; row += 1) {
        if (column.validity !== null && (column.validity[row >>> 3]! & (1 << (row & 7))) === 0) continue;
        const value = column.values[row] as number;
        if ((type === "object" && value !== 1) || (type === "boolean" && value !== 0 && value !== 1)) fail("invalid presence or boolean");
        if (column.name === "atMs" && (!Number.isSafeInteger(value) || value < 0)) fail("invalid timestamp");
      }
    }
    if (type === "object") for (const field of REQUIRED_GROUPS[column.name] ?? []) subset(column, columns.get(`${column.name}.${field}`));
  }
  for (const required of REQUIRED[kind]!) {
    const column = columns.get(required);
    if (table.rows > 0 && (column === undefined || column.validity !== null)) fail("missing required point field");
  }
  for (const pair of PAIRED_FIELDS) for (const field of pair) {
    const column = columns.get(field);
    if (column !== undefined) for (const other of pair) subset(column, columns.get(other));
  }
}

/** The fast read path: bounded metadata objects plus typed numeric views, not point objects. */
export function openHistory(input: ArrayBuffer | Uint8Array): { readonly root: HistoryView; readonly zeroCopy: boolean } {
  const frame: FrameView = decodeColumns(input);
  const metadata = object(frame.metadata);
  exact(metadata, ["format", "node"]);
  if (metadata.format !== "stats-history") fail("unknown history format");
  const tables = new Map(frame.tables.map(table => [table.name, table]));
  const used = new Set<string>();
  function visit(value: unknown, allowBundle: boolean): HistoryView {
    const node = object(value);
    if (node.form === "bundle" && allowBundle) {
      exact(node, ["form", "metadata", "entries"]);
      const metadata = object(node.metadata);
      const identity = bundleIdentity(metadata);
      const names = new Set<string>();
      return { form: "bundle", metadata, entries: list(node.entries).map(value => {
        const entry = object(value);
        exact(entry, ["name", "node"]);
        const name = text(entry.name);
        if (names.has(name)) fail("duplicate history kind");
        names.add(name);
        const history = visit(entry.node, false);
        if (history.form === "bundle") fail("nested bundle");
        bundleEntry(identity, name, history.form === "collector" ? history.value : history.metadata);
        return { name, history };
      }) };
    }
    if (node.form === "collector") {
      exact(node, ["form", "value"]);
      const value = object(node.value);
      if (value.kind !== "collector") fail("invalid collector");
      list(value.runs);
      return { form: "collector", value };
    }
    if (node.form !== "points" && node.form !== "series" && node.form !== "metrics") fail("invalid history layout");
    exact(node, ["form", "metadata", "series"]);
    const data = object(node.metadata);
    windowMetadata(data);
    const kind = text(data.kind);
    if (node.form === "metrics") {
      text(data.projectId);
      if (!PROJECT_KINDS.includes(kind)) fail("unknown project kind");
    } else { text(data.hostId); schemaFor(kind); if ((node.form === "points") !== (kind === "summary")) fail("incorrect point layout"); }
    const series = list(node.series).map(item => {
      const entry = object(item);
      exact(entry, ["metadata", "table"]);
      const name = text(entry.table);
      const table = tables.get(name);
      if (table === undefined || used.has(name)) fail("invalid table reference");
      used.add(name);
      const meta = object(entry.metadata);
      if (node.form === "metrics") {
        text(meta.metric);
        if (table.columns.length !== 1 || table.columns[0]!.name !== "value" || table.columns[0]!.type !== "f64") fail("invalid metric column");
      } else { if (node.form === "series") text(meta.id); checkPoints(table, kind); }
      return { metadata: meta, table };
    });
    if (node.form === "points" && series.length !== 1) fail("invalid summary tables");
    return { form: node.form, metadata: data, series };
  }
  const root = visit(metadata.node, true);
  if (used.size !== tables.size) fail("unreferenced table");
  return { root, zeroCopy: frame.zeroCopy };
}

/** Compatibility/testing only: reconstructing JSON-shaped points intentionally allocates. */
export function materializeHistory(history: HistoryView): ObjectValue {
  if (history.form === "collector") return history.value;
  if (history.form === "bundle") return { ...history.metadata, histories: Object.fromEntries(history.entries.map(entry => [entry.name, materializeHistory(entry.history)])) };
  const kind = history.metadata.kind;
  function points(table: TableView): ObjectValue[] {
    const schema = schemaFor(kind);
    const columns = new Map(table.columns.map(column => [column.name, column]));
    return Array.from({ length: table.rows }, (_, row) => {
      const point: ObjectValue = {};
      for (const [path, type] of Object.entries(schema)) {
        const column = columns.get(path);
        if (column === undefined) continue;
        const value = cell(column, row);
        if (value === null) continue;
        const parts = path.split(".");
        let target = point;
        for (const key of parts.slice(0, -1)) target = object(target[key]);
        target[parts.at(-1)!] = type === "object" ? {} : type === "boolean" ? value === 1 : value;
      }
      return point;
    });
  }
  if (history.form === "points") return { ...history.metadata, points: points(history.series[0]!.table) };
  return { ...history.metadata, series: history.series.map(series => history.form === "metrics"
    ? { ...series.metadata, values: Array.from({ length: series.table.rows }, (_, row) => cell(series.table.columns[0]!, row)) }
    : { ...series.metadata, points: points(series.table) }) };
}
