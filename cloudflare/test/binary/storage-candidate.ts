/** Lossless storage candidate, not a migration. Decode cost must beat JSON before adoption. */
export type StoredKind = "sample" | "delta" | "rollup";
const KINDS: readonly StoredKind[] = ["sample", "delta", "rollup"];
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_STRING = 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_KEYS = 8192;
const MAX_DEPTH = 32;
const MAX_U64 = (1n << 64n) - 1n;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function fail(message: string): never { throw new Error(`stats storage: ${message}`); }

class Writer {
  bytes = new Uint8Array(256);
  offset = 16;
  reserve(count: number): void {
    const needed = this.offset + count;
    if (needed > MAX_BYTES) fail("record too large");
    if (needed > this.bytes.length) {
      const next = new Uint8Array(Math.min(MAX_BYTES, Math.max(needed, this.bytes.length * 2)));
      next.set(this.bytes);
      this.bytes = next;
    }
  }
  byte(value: number): void { this.reserve(1); this.bytes[this.offset++] = value; }
  uint(value: number): void {
    do { const low = value % 128; value = Math.floor(value / 128); this.byte(low | (value === 0 ? 0 : 128)); } while (value > 0);
  }
  string(value: string): void {
    // UTF-8 cannot represent lone UTF-16 surrogates. Preserve them, never replace them silently.
    if (value.length > MAX_STRING) fail("string too large");
    let bytes = encoder.encode(value);
    const escaped = decoder.decode(bytes) !== value;
    if (escaped) bytes = encoder.encode(JSON.stringify(value));
    if (bytes.length > MAX_STRING) fail("string too large");
    this.byte(escaped ? 1 : 0);
    this.uint(bytes.length);
    this.reserve(bytes.length);
    this.bytes.set(bytes, this.offset);
    this.offset += bytes.length;
  }
  scalar(value: number | bigint): void {
    this.reserve(8);
    const view = new DataView(this.bytes.buffer);
    if (typeof value === "bigint") view.setBigUint64(this.offset, value, true);
    else view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }
}

class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset = 16;
  constructor(bytes: Uint8Array) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length); }
  need(count: number): void { if (this.offset + count > this.bytes.length) fail("truncated record"); }
  byte(): number { this.need(1); return this.bytes[this.offset++]!; }
  uint(max: number): number {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** (index * 7);
      if (value > max) fail("length limit exceeded");
      if (byte < 128) { if (index > 0 && byte === 0) fail("noncanonical length"); return value; }
    }
    return fail("invalid length");
  }
  string(): string {
    const escaped = this.byte();
    if (escaped > 1) fail("invalid string encoding");
    const length = this.uint(MAX_STRING);
    this.need(length);
    const text = decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    if (escaped === 0) return text;
    const value: unknown = JSON.parse(text);
    if (typeof value !== "string") fail("invalid escaped string");
    return value;
  }
  scalar(integer: boolean): number | string {
    this.need(8);
    const value = integer ? this.view.getBigUint64(this.offset, true).toString() : this.view.getFloat64(this.offset, true);
    this.offset += 8;
    if (typeof value === "number" && !Number.isFinite(value)) fail("non-finite number");
    return value;
  }
}

export function encodeStored(kind: StoredKind, value: unknown): Uint8Array {
  const kindIndex = KINDS.indexOf(kind);
  if (kindIndex < 0) fail("unknown record kind");
  const names = new Set<string>();
  let nodes = 0;
  function scan(value: unknown, depth: number): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail("record complexity limit");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") { if (!Number.isFinite(value)) fail("non-finite number"); return; }
    if (Array.isArray(value)) { for (const item of value) scan(item, depth + 1); return; }
    if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail("expected JSON-compatible value");
    for (const [key, item] of Object.entries(value)) {
      names.add(key);
      if (names.size > MAX_KEYS) fail("too many keys");
      scan(item, depth + 1);
    }
  }
  scan(value, 0);
  const dictionary = [...names].sort();
  const indexes = new Map(dictionary.map((key, index) => [key, index]));
  const writer = new Writer();
  for (const key of dictionary) writer.string(key);
  function write(value: unknown): void {
    if (value === null) { writer.byte(0); return; }
    if (value === false) { writer.byte(1); return; }
    if (value === true) { writer.byte(2); return; }
    if (typeof value === "number") { writer.byte(3); writer.scalar(value); return; }
    if (typeof value === "string") {
      if (/^(0|[1-9][0-9]{0,19})$/u.test(value)) {
        const integer = BigInt(value);
        if (integer <= MAX_U64) { writer.byte(5); writer.scalar(integer); return; }
      }
      writer.byte(4); writer.string(value); return;
    }
    if (Array.isArray(value)) { writer.byte(6); writer.uint(value.length); for (const item of value) write(item); return; }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => indexes.get(left)! - indexes.get(right)!);
    writer.byte(7); writer.uint(entries.length);
    for (const [key, item] of entries) { writer.uint(indexes.get(key)!); write(item); }
  }
  write(value);
  const bytes = writer.bytes.slice(0, writer.offset);
  bytes.set([83, 84, 82, 49, kindIndex, 1]); // STR1, kind, version; reserved bytes 6..7 remain zero.
  const header = new DataView(bytes.buffer);
  header.setUint32(8, bytes.length, true);
  header.setUint32(12, dictionary.length, true);
  return bytes;
}

/** Legacy TEXT and versioned BLOBs can coexist. Malformed binary never falls back to JSON. */
export function decodeStored(kind: StoredKind, stored: string | ArrayBuffer | Uint8Array): unknown {
  const kindIndex = KINDS.indexOf(kind);
  if (kindIndex < 0) fail("unknown record kind");
  if (typeof stored === "string") {
    if (stored.length > MAX_BYTES || encoder.encode(stored).length > MAX_BYTES) fail("record too large");
    return JSON.parse(stored) as unknown;
  }
  const bytes = stored instanceof Uint8Array ? stored : new Uint8Array(stored);
  if (!(bytes.buffer instanceof ArrayBuffer) || bytes.length < 16 || bytes.length > MAX_BYTES) fail("invalid record length");
  const reader = new Reader(bytes);
  const header = reader.view;
  if (header.getUint32(0, false) !== 0x53545231 || bytes[4] !== kindIndex || bytes[5] !== 1 || header.getUint16(6, true) !== 0) fail("unknown format or record kind");
  if (header.getUint32(8, true) !== bytes.length) fail("invalid record length");
  const keyCount = header.getUint32(12, true);
  if (keyCount > MAX_KEYS) fail("too many keys");
  const dictionary: string[] = [];
  for (let index = 0; index < keyCount; index += 1) {
    const key = reader.string();
    if (index > 0 && dictionary[index - 1]! >= key) fail("invalid dictionary order");
    dictionary.push(key);
  }
  let nodes = 0;
  function read(depth: number): unknown {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail("record complexity limit");
    switch (reader.byte()) {
      case 0: return null;
      case 1: return false;
      case 2: return true;
      case 3: return reader.scalar(false);
      case 4: return reader.string();
      case 5: return reader.scalar(true);
      case 6: {
        const length = reader.uint(MAX_NODES - nodes);
        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) result.push(read(depth + 1));
        return result;
      }
      case 7: {
        const length = reader.uint(Math.min(keyCount, MAX_NODES - nodes));
        const result: Record<string, unknown> = {};
        let previous = -1;
        for (let index = 0; index < length; index += 1) {
          const key = reader.uint(keyCount - 1);
          if (key <= previous) fail("duplicate or unordered key");
          previous = key;
          Object.defineProperty(result, dictionary[key]!, { value: read(depth + 1), enumerable: true, writable: true, configurable: true });
        }
        return result;
      }
      default: return fail("unknown value tag");
    }
  }
  const value = read(0);
  if (reader.offset !== bytes.length) fail("trailing bytes");
  return value;
}
