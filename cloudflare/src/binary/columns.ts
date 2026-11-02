export type NumericType = "f64" | "u64" | "u8";
interface ColumnBase { readonly name: string; readonly validity: Uint8Array | null }
export interface F64Column extends ColumnBase { readonly type: "f64"; readonly values: Float64Array }
export interface U64Column extends ColumnBase { readonly type: "u64"; readonly values: BigUint64Array }
export interface U8Column extends ColumnBase { readonly type: "u8"; readonly values: Uint8Array }
/** A null validity means every cell is present. Otherwise a set bit means present and absent slots hold zero bytes. */
export type ColumnView = F64Column | U64Column | U8Column;
export interface TableView { readonly name: string; readonly rows: number; readonly columns: readonly ColumnView[] }
export interface FrameInput { readonly metadata: unknown; readonly tables: readonly TableView[] }
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
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
interface Descriptor { name: string; type: NumericType; nullable?: boolean; ref?: number }
interface TableDescriptor { name: string; rows: number; columns: Descriptor[] }

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

/**
 * Serializes typed columns. Columns that share one values array within a frame are written once and referenced.
 * The caller guarantees finite values, zero bytes in absent slots and a zero-padded bitmap; decodeColumns rejects violations.
 */
export function encodeColumns(input: FrameInput): Uint8Array<ArrayBuffer> {
  if (!LITTLE_ENDIAN) fail("encoding requires a little-endian host");
  if (input.tables.length > MAX_TABLES) fail("too many tables");
  const seen = new Map<ColumnView["values"], number>();
  const tableNames = new Set<string>();
  const tables: TableDescriptor[] = [];
  const owned: ColumnView[] = [];
  let count = 0;
  let dataBytes = 0;
  for (const table of input.tables) {
    if (!name(table.name) || tableNames.has(table.name) || !integer(table.rows, MAX_ROWS)) fail("invalid table");
    tableNames.add(table.name);
    const columns: Descriptor[] = [];
    const columnNames = new Set<string>();
    for (const column of table.columns) {
      if (++count > MAX_COLUMNS) fail("too many columns");
      const maskBytes = Math.ceil(table.rows / 8);
      if (!name(column.name) || columnNames.has(column.name) || !numericType(column.type) || column.values.length !== table.rows || (column.validity !== null && column.validity.length !== maskBytes)) fail("invalid column");
      columnNames.add(column.name);
      const previous = seen.get(column.values);
      if (previous !== undefined) {
        columns.push({ name: column.name, type: column.type, ref: previous });
        continue;
      }
      seen.set(column.values, count - 1);
      columns.push({ name: column.name, type: column.type, nullable: column.validity !== null });
      owned.push(column);
      dataBytes += (column.validity === null ? 0 : align(maskBytes)) + align(table.rows * width(column.type));
      if (dataBytes > MAX_BYTES) fail("frame too large");
    }
    tables.push({ name: table.name, rows: table.rows, columns });
  }
  const metadata = encoder.encode(JSON.stringify({ metadata: input.metadata, tables }));
  if (metadata.length > MAX_METADATA) fail("metadata too large");
  const start = align(HEADER + metadata.length);
  const length = start + dataBytes;
  if (length > MAX_BYTES) fail("frame too large");
  const bytes = new Uint8Array(length);
  bytes.set([83, 84, 67, 49]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint32(8, metadata.length, true);
  view.setUint32(12, length, true);
  bytes.set(metadata, HEADER);
  let offset = start;
  for (const column of owned) {
    if (column.validity !== null) {
      bytes.set(column.validity, offset);
      offset += align(column.validity.length);
    }
    bytes.set(new Uint8Array(column.values.buffer, column.values.byteOffset, column.values.byteLength), offset);
    offset += align(column.values.byteLength);
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
      const type = column.type;
      let found: ColumnView;
      if (column.ref !== undefined) {
        if (!integer(column.ref, all.length - 1) || column.nullable !== undefined) fail("invalid column reference");
        const prior = all[column.ref]!;
        if (prior.type !== type || prior.values.length !== rows) fail("incompatible column reference");
        found = { ...prior, name: column.name } as ColumnView;
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
        const size = width(type);
        const end = offset + rows * size;
        zeroes(end, align(end));
        if (end > bytes.length) fail("truncated values");
        const at = bytes.byteOffset + offset;
        if (type === "u8") found = { name: column.name, type, values: bytes.subarray(offset, end), validity };
        else if (type === "f64") found = { name: column.name, type, values: LITTLE_ENDIAN ? new Float64Array(bytes.buffer, at, rows) : Float64Array.from({ length: rows }, (_, index) => view.getFloat64(offset + index * 8, true)), validity };
        else found = { name: column.name, type, values: LITTLE_ENDIAN ? new BigUint64Array(bytes.buffer, at, rows) : BigUint64Array.from({ length: rows }, (_, index) => view.getBigUint64(offset + index * 8, true)), validity };
        for (let row = 0; row < rows; row += 1) {
          if (found.type === "f64" && !Number.isFinite(found.values[row])) fail("non-finite value");
          if (validity !== null && (validity[row >>> 3]! & (1 << (row & 7))) === 0) zeroes(offset + row * size, offset + (row + 1) * size);
        }
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

export function isPresent(column: ColumnView, row: number): boolean {
  return column.validity === null || (column.validity[row >>> 3]! & (1 << (row & 7))) !== 0;
}
