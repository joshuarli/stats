/** Experimental, dependency-free numeric frames. Not imported by production routes. */
export type NumericType = "f64" | "u64" | "u8";
export type Cells = ArrayLike<number | bigint | null>;
export interface ColumnInput { readonly name: string; readonly type: NumericType; readonly values: Cells }
export interface TableInput { readonly name: string; readonly rows: number; readonly columns: readonly ColumnInput[] }
export interface FrameInput { readonly metadata: unknown; readonly tables: readonly TableInput[] }
export interface ColumnView {
  readonly name: string;
  readonly type: NumericType;
  readonly values: Float64Array | BigUint64Array | Uint8Array;
  /** null means every cell is present. Otherwise a set bit means present. */
  readonly validity: Uint8Array | null;
}
export interface TableView { readonly name: string; readonly rows: number; readonly columns: readonly ColumnView[] }
export interface FrameView {
  readonly metadata: unknown;
  readonly tables: readonly TableView[];
  /** False only when alignment or native endianness required copying values. */
  readonly zeroCopy: boolean;
}

const HEADER = 16;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_METADATA = 1024 * 1024;
const MAX_TABLES = 4096;
const MAX_COLUMNS = 32768;
const MAX_ROWS = 16384;
const MAX_U64 = (1n << 64n) - 1n;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
interface Descriptor { name: string; type: NumericType; nullable?: boolean; ref?: number }
interface TableDescriptor { name: string; rows: number; columns: Descriptor[] }
interface Block { column: ColumnInput; rows: number; nullable: boolean }

function fail(message: string): never { throw new Error(`stats columns: ${message}`); }
function align(value: number): number { return Math.ceil(value / 8) * 8; }
function width(type: NumericType): number { return type === "u8" ? 1 : 8; }
function integer(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function name(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function numericType(value: unknown): value is NumericType { return value === "f64" || value === "u64" || value === "u8"; }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid descriptor");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("unknown descriptor field");
}
function checkedCell(type: NumericType, value: number | bigint | null | undefined): void {
  if (value === null) return;
  if (type === "u64") {
    if (typeof value !== "bigint" || value < 0n || value > MAX_U64) fail("u64 requires an exact unsigned bigint");
  } else if (typeof value !== "number" || !Number.isFinite(value) || (type === "u8" && !integer(value, 255))) {
    fail(`invalid ${type} cell`);
  }
}

/** Shared values objects are encoded once; history uses this to intern identical time axes. */
export function encodeColumns(input: FrameInput): Uint8Array {
  if (input.tables.length > MAX_TABLES) fail("too many tables");
  const seen = new Map<Cells, { index: number; type: NumericType; rows: number }>();
  const tableNames = new Set<string>();
  const tables: TableDescriptor[] = [];
  const blocks: Block[] = [];
  let count = 0;
  let dataBytes = 0;
  for (const table of input.tables) {
    if (!name(table.name) || tableNames.has(table.name) || !integer(table.rows, MAX_ROWS)) fail("invalid table");
    tableNames.add(table.name);
    const columns: Descriptor[] = [];
    const columnNames = new Set<string>();
    for (const column of table.columns) {
      if (++count > MAX_COLUMNS) fail("too many columns");
      if (!name(column.name) || columnNames.has(column.name) || !numericType(column.type) || column.values.length !== table.rows) fail("invalid column");
      columnNames.add(column.name);
      const previous = seen.get(column.values);
      if (previous !== undefined && previous.type === column.type && previous.rows === table.rows) {
        columns.push({ name: column.name, type: column.type, ref: previous.index });
        continue;
      }
      let nullable = false;
      for (let row = 0; row < table.rows; row += 1) {
        const value = column.values[row];
        checkedCell(column.type, value);
        if (value === null) nullable = true;
      }
      seen.set(column.values, { index: count - 1, type: column.type, rows: table.rows });
      columns.push({ name: column.name, type: column.type, nullable });
      blocks.push({ column, rows: table.rows, nullable });
      dataBytes += (nullable ? align(Math.ceil(table.rows / 8)) : 0) + align(table.rows * width(column.type));
      if (dataBytes > MAX_BYTES) fail("frame too large");
    }
    tables.push({ name: table.name, rows: table.rows, columns });
  }
  const text = JSON.stringify({ metadata: input.metadata, tables });
  if (text.length > MAX_METADATA) fail("metadata too large");
  const metadata = encoder.encode(text);
  if (metadata.length > MAX_METADATA) fail("metadata too large");
  const start = align(HEADER + metadata.length);
  const length = start + dataBytes;
  if (length > MAX_BYTES) fail("frame too large");
  const bytes = new Uint8Array(length);
  bytes.set([83, 84, 67, 49]); // STC1
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint32(8, metadata.length, true);
  view.setUint32(12, length, true);
  bytes.set(metadata, HEADER);
  let offset = start;
  for (const { column, rows, nullable } of blocks) {
    const mask = offset;
    if (nullable) offset += align(Math.ceil(rows / 8));
    const size = width(column.type);
    for (let row = 0; row < rows; row += 1) {
      const value = column.values[row];
      if (value === null) continue;
      if (nullable) bytes[mask + (row >>> 3)]! |= 1 << (row & 7);
      if (column.type === "u64") view.setBigUint64(offset + row * size, value as bigint, true);
      else if (column.type === "f64") view.setFloat64(offset + row * size, value as number, true);
      else view.setUint8(offset + row, value as number);
    }
    offset += align(rows * size);
  }
  return bytes;
}

/** Validates the whole frame before exposing views. Caller must not mutate its backing buffer. */
export function decodeColumns(input: ArrayBuffer | Uint8Array): FrameView {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!(bytes.buffer instanceof ArrayBuffer)) fail("shared buffers are not supported");
  if (bytes.length < HEADER || bytes.length > MAX_BYTES) fail("invalid frame length");
  let zeroCopy = LITTLE_ENDIAN;
  if (bytes.byteOffset % 8 !== 0) { bytes = bytes.slice(); zeroCopy = false; }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x53544331 || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) fail("unknown format or flags");
  const length = view.getUint32(8, true);
  if (length > MAX_METADATA || HEADER + length > bytes.length || view.getUint32(12, true) !== bytes.length) fail("invalid frame length");
  const root = record(JSON.parse(decoder.decode(bytes.subarray(HEADER, HEADER + length))) as unknown);
  keys(root, ["metadata", "tables"]);
  if (!Object.hasOwn(root, "metadata") || !Array.isArray(root.tables) || root.tables.length > MAX_TABLES) fail("invalid tables");
  let offset = align(HEADER + length);
  function zeroes(start: number, end: number): void {
    if (end > bytes.length) fail("truncated frame");
    for (let index = start; index < end; index += 1) if (bytes[index] !== 0) fail("nonzero padding");
  }
  zeroes(HEADER + length, offset);
  const all: ColumnView[] = [];
  const tables: TableView[] = [];
  const tableNames = new Set<string>();
  for (const item of root.tables) {
    const table = record(item);
    keys(table, ["name", "rows", "columns"]);
    if (!name(table.name) || tableNames.has(table.name) || !integer(table.rows, MAX_ROWS) || !Array.isArray(table.columns)) fail("invalid table");
    tableNames.add(table.name);
    const rows = table.rows;
    const columns: ColumnView[] = [];
    const columnNames = new Set<string>();
    for (const itemColumn of table.columns) {
      if (all.length >= MAX_COLUMNS) fail("too many columns");
      const column = record(itemColumn);
      keys(column, ["name", "type", "nullable", "ref"]);
      if (!name(column.name) || columnNames.has(column.name) || !numericType(column.type)) fail("invalid column");
      columnNames.add(column.name);
      let found: ColumnView;
      if (column.ref !== undefined) {
        if (!integer(column.ref, all.length - 1) || column.nullable !== undefined) fail("invalid column reference");
        const prior = all[column.ref]!;
        if (prior.type !== column.type || prior.values.length !== rows) fail("incompatible column reference");
        found = { ...prior, name: column.name };
      } else {
        if (typeof column.nullable !== "boolean") fail("invalid nullability");
        let validity: Uint8Array | null = null;
        if (column.nullable) {
          const maskBytes = Math.ceil(rows / 8);
          zeroes(offset + maskBytes, offset + align(maskBytes));
          validity = bytes.subarray(offset, offset + maskBytes);
          if (rows % 8 !== 0 && (validity[maskBytes - 1]! >>> (rows % 8)) !== 0) fail("invalid bitmap padding");
          offset += align(maskBytes);
        }
        const size = width(column.type);
        const end = offset + rows * size;
        zeroes(end, align(end));
        if (end > bytes.length) fail("truncated values");
        let values: ColumnView["values"];
        const at = bytes.byteOffset + offset;
        if (column.type === "u8") values = bytes.subarray(offset, end);
        else if (LITTLE_ENDIAN) values = column.type === "f64" ? new Float64Array(bytes.buffer, at, rows) : new BigUint64Array(bytes.buffer, at, rows);
        else if (column.type === "f64") values = Float64Array.from({ length: rows }, (_, index) => view.getFloat64(offset + index * 8, true));
        else values = BigUint64Array.from({ length: rows }, (_, index) => view.getBigUint64(offset + index * 8, true));
        for (let row = 0; row < rows; row += 1) {
          if (column.type === "f64" && !Number.isFinite(values[row] as number)) fail("non-finite value");
          if (validity !== null && (validity[row >>> 3]! & (1 << (row & 7))) === 0) zeroes(offset + row * size, offset + (row + 1) * size);
        }
        found = { name: column.name, type: column.type, values, validity };
        offset = align(end);
      }
      all.push(found);
      columns.push(found);
    }
    tables.push({ name: table.name, rows, columns });
  }
  if (offset !== bytes.length) fail("trailing bytes");
  return { metadata: root.metadata, tables, zeroCopy };
}

export function cell(column: ColumnView, row: number): number | bigint | null {
  if (!integer(row, column.values.length - 1)) fail("row out of bounds");
  return column.validity !== null && (column.validity[row >>> 3]! & (1 << (row & 7))) === 0 ? null : column.values[row]!;
}
