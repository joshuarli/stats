import { encodeColumns, isPresent, type ColumnView, type NumericType, type TableView } from "../../src/binary/columns.ts";
import { bundleEntry, bundleIdentity, HISTORY_CONTENT_TYPE, hostKind, openHistory, PROJECT_METRIC_KINDS, SCHEMAS, windowMetadata, type HistoryView, type ObjectValue } from "../../src/binary/history.ts";

export type Cell = number | bigint | null;
export interface CellColumn { name: string; type: NumericType; values: Cell[] }
export interface CellTable { name: string; rows: number; columns: CellColumn[] }
export interface CellFrame { metadata: unknown; tables: CellTable[] }
type Json = Record<string, unknown>;

const MAX_U64 = (1n << 64n) - 1n;
function fail(message: string): never { throw new Error(`test history: ${message}`); }

function checkedCell(type: NumericType, value: Cell | undefined): void {
  if (value === null) return;
  if (type === "u64") {
    if (typeof value !== "bigint" || value < 0n || value > MAX_U64) fail("u64 requires an exact unsigned bigint");
  } else if (typeof value !== "number" || !Number.isFinite(value) || (type === "u8" && !(Number.isInteger(value) && value >= 0 && value <= 255))) {
    fail(`invalid ${type} cell`);
  }
}

function toColumn(column: CellColumn, rows: number): ColumnView {
  const validity = new Uint8Array(Math.ceil(rows / 8));
  let missing = false;
  const values = column.type === "f64" ? new Float64Array(rows) : column.type === "u64" ? new BigUint64Array(rows) : new Uint8Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const value = column.values[row];
    checkedCell(column.type, value);
    if (value === null) { missing = true; continue; }
    validity[row >> 3]! |= 1 << (row & 7);
    (values as unknown as Record<number, Cell>)[row] = value!;
  }
  return { name: column.name, type: column.type, values, validity: missing ? validity : null } as ColumnView;
}

export function tableView(rows: number, columns: Readonly<Record<string, Cell[]>>, type: NumericType = "f64"): TableView {
  return { name: "t", rows, columns: Object.entries(columns).map(([name, values]) => toColumn({ name, type, values }, rows)) };
}

export function encodeCells(frame: CellFrame): Uint8Array<ArrayBuffer> {
  const converted = new Map<Cell[], ColumnView>();
  const tables: TableView[] = frame.tables.map(table => ({
    name: table.name,
    rows: table.rows,
    columns: table.columns.map(column => {
      if (column.values.length !== table.rows) fail("column length differs from its table");
      const known = converted.get(column.values);
      if (known !== undefined && known.type === column.type) return { ...known, name: column.name } as ColumnView;
      const made = toColumn(column, table.rows);
      converted.set(column.values, made);
      return made;
    })
  }));
  return encodeColumns({ metadata: frame.metadata, tables });
}

export function cell(column: ColumnView, row: number): Cell {
  if (!Number.isInteger(row) || row < 0 || row >= column.values.length) fail("row out of bounds");
  return isPresent(column, row) ? column.values[row]! : null;
}

function object(value: unknown): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("expected object");
  return value as Json;
}
function list(value: unknown): unknown[] { if (!Array.isArray(value)) fail("expected array"); return value; }
function text(value: unknown): string { if (typeof value !== "string" || value.length === 0) fail("expected name"); return value; }
function omit(value: Json, key: string): Json { return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)); }

const REQUIRED_POINT: Readonly<Record<string, readonly string[]>> = {
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

function flatten(value: Json, schema: Readonly<Record<string, string>>, output: Map<string, (number | null)[]>, row: number, count: number, prefix = ""): void {
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

/** Independent oracle: encodes JSON-shaped history objects generically, field by field, with full validation. */
export function encodeHistory(history: unknown): Uint8Array<ArrayBuffer> {
  const tables: CellTable[] = [];
  const axes = new Map<string, (number | null)[]>();
  function addPoints(value: unknown, kind: string): string {
    const points = list(value);
    if (points.length > 16384) fail("too many points");
    const schema: Readonly<Record<string, string>> = SCHEMAS[hostKind(kind)];
    const fields = new Map<string, (number | null)[]>();
    for (let row = 0; row < points.length; row += 1) flatten(object(points[row]), schema, fields, row, points.length);
    if (points.length > 0) {
      for (const key of REQUIRED_POINT[kind]!) {
        const column = fields.get(key);
        if (column === undefined || column.some(entry => entry === null)) fail("incomplete point");
      }
      for (const timestamp of fields.get("atMs")!) if (!Number.isSafeInteger(timestamp) || timestamp! < 0) fail("invalid timestamp");
    }
    function presentTogether(left: readonly (number | null)[], right: readonly (number | null)[] | undefined): void {
      if (right === undefined || left.some((entry, row) => entry !== null && right[row] === null)) fail("missing dependent point field");
    }
    for (const [name, required] of Object.entries(REQUIRED_GROUPS)) {
      const column = fields.get(name);
      if (column !== undefined) for (const field of required) presentTogether(column, fields.get(`${name}.${field}`));
    }
    for (const pair of PAIRED_FIELDS) for (const field of pair) {
      const column = fields.get(field);
      if (column !== undefined) for (const other of pair) presentTogether(column, fields.get(other));
    }
    const columns: CellColumn[] = [];
    for (const [name, type] of Object.entries(schema)) {
      const column = fields.get(name);
      if (column === undefined || points.length === 0) continue;
      let values: (number | null)[] = column;
      if (name === "atMs") {
        const key = column.join(",");
        const old = axes.get(key);
        if (old !== undefined && old.every((entry, index) => Object.is(entry, column[index]))) values = old;
        else axes.set(key, column);
      }
      columns.push({ name, type: type === "number" ? "f64" : "u8", values });
    }
    const name = String(tables.length);
    tables.push({ name, rows: points.length, columns });
    return name;
  }
  function single(value: unknown): Json {
    const entry = object(value);
    const kind = text(entry.kind);
    if (kind === "collector") { list(entry.runs); return { form: "collector", value: entry }; }
    windowMetadata(entry);
    if (Object.hasOwn(entry, "hostId")) {
      hostKind(kind);
      if (kind === "summary") return { form: "points", metadata: omit(entry, "points"), series: [{ metadata: {}, table: addPoints(entry.points, kind) }] };
      return { form: "series", metadata: omit(entry, "series"), series: list(entry.series).map(item => {
        const series = object(item);
        text(series.id);
        return { metadata: omit(series, "points"), table: addPoints(series.points, kind) };
      }) };
    }
    if (!Object.hasOwn(entry, "projectId") || !(PROJECT_METRIC_KINDS as readonly string[]).includes(kind)) fail("unknown project history kind");
    const series = list(entry.series).map(item => {
      const found = object(item);
      return { metric: text(found.metric), values: list(found.values) as (number | null)[] };
    });
    const rows = series[0]?.values.length ?? 0;
    const name = String(tables.length);
    tables.push({ name, rows, columns: series.map(found => ({ name: found.metric, type: "f64" as const, values: found.values })) });
    return { form: "metrics", metadata: omit(entry, "series"), table: name };
  }
  const root = object(history);
  let node: Json;
  if (Object.hasOwn(root, "histories")) {
    const metadata = omit(root, "histories");
    const identity = bundleIdentity(metadata);
    const entries = Object.entries(object(root.histories)).map(([name, entry]) => {
      bundleEntry(identity, name, object(entry));
      return { name, node: single(entry) };
    });
    node = { form: "bundle", metadata, entries };
  } else node = single(root);
  return encodeCells({ metadata: { format: "stats-history", node }, tables });
}

function points(table: TableView, kind: string): Json[] {
  const schema: Readonly<Record<string, string>> = SCHEMAS[hostKind(kind)];
  const columns = new Map(table.columns.map(column => [column.name, column]));
  return Array.from({ length: table.rows }, (_, row) => {
    const point: Json = {};
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

/** Reconstructs the JSON-shaped history the frame was built from. Allocates a point object per row. */
export function materializeHistory(history: HistoryView): ObjectValue {
  if (history.form === "collector") return history.value;
  if (history.form === "bundle") return { ...history.metadata, histories: Object.fromEntries(history.entries.map(entry => [entry.name, materializeHistory(entry.history)])) };
  if (history.form === "metrics") {
    return { ...history.metadata, series: history.table.columns.map(column => ({ metric: column.name, values: Array.from({ length: history.table.rows }, (_, row) => cell(column, row)) })) };
  }
  const kind = history.metadata.kind;
  if (history.form === "points") return { ...history.metadata, points: points(history.series[0]!.table, text(kind)) };
  return { ...history.metadata, series: history.series.map(series => ({ ...series.metadata, points: points(series.table, text(kind)) })) };
}

export function readHistory(bytes: ArrayBuffer | Uint8Array): ObjectValue {
  return materializeHistory(openHistory(bytes).root);
}

export async function readFrame(response: Response): Promise<unknown> {
  if (response.headers.get("content-type") !== HISTORY_CONTENT_TYPE) throw new Error(`not a history frame: ${response.status} ${response.headers.get("content-type")}`);
  return readHistory(await response.arrayBuffer());
}

export function compact<T>(value: T): T {
  return roundNumbers(value) as T;
}

function roundNumbers(value: unknown): unknown {
  if (typeof value === "number") return Number.isInteger(value) || !Number.isFinite(value) ? value : Math.round(value * 1000) / 1000;
  if (Array.isArray(value)) return (value as unknown[]).map(roundNumbers);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundNumbers(entry)]));
  return value;
}
