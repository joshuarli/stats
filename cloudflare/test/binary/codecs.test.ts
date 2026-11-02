import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeColumns, encodeColumns, type NumericType } from "../../src/binary/columns.ts";
import { openHistory } from "../../src/binary/history.ts";
import { cell, encodeCells, encodeHistory, materializeHistory, type Cell, type CellFrame as TestFrame } from "../support/history.ts";
import { encodeStored, decodeStored } from "./storage-candidate.ts";
import { captures, histories, root, syntheticCases } from "./cases.ts";

interface Metadata { surprise?: boolean; tables: { rows: number; columns: { nullable?: boolean; ref?: number }[] }[] }
interface HistoryMetadata { format: string; node: { entries: { name: string }[]; metadata: { hostId: string } } }
const frame = (values: readonly unknown[], type: NumericType = "f64"): TestFrame => ({ metadata: { test: true }, tables: [{ name: "t", rows: values.length, columns: [{ name: "v", type, values: values as Cell[] }] }] });
const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
function values(bytes: Uint8Array): Cell[] { const column = decodeColumns(bytes).tables[0]!.columns[0]!; return Array.from({ length: column.values.length }, (_, index) => cell(column, index)); }
function mutate(bytes: Uint8Array, callback: (copy: Uint8Array, view: DataView) => void): Uint8Array { const copy = bytes.slice(); callback(copy, new DataView(copy.buffer)); return copy; }
function rebuild(bytes: Uint8Array, change: (data: TestFrame) => void): Uint8Array {
  const source = decodeColumns(bytes);
  const data: TestFrame = { metadata: source.metadata, tables: source.tables.map(table => ({ name: table.name, rows: table.rows, columns: table.columns.map(column => ({ name: column.name, type: column.type, values: Array.from({ length: table.rows }, (_, index) => cell(column, index)) })) })) };
  change(data);
  return encodeCells(data);
}

await test("numeric columns retain zero, missing, negative zero, f64 and u64 boundaries", () => {
  const numericCases: [NumericType, Cell[]][] = [["f64", [null, 0, -0, Number.MAX_SAFE_INTEGER, -1.125, Number.MIN_VALUE]], ["u64", [null, 0n, 9007199254740993n, 18446744073709551615n]], ["u8", [null, 0, 1, 255]]];
  for (const [type, input] of numericCases) assert.deepEqual(values(encodeCells(frame(input, type))), input);
});
await test("aligned numeric and bitmap views share the input buffer; unaligned input copies explicitly", () => {
  const encoded = encodeCells(frame([0, null, 3.125]));
  const opened = decodeColumns(encoded);
  assert.equal(opened.zeroCopy, true);
  assert.equal(opened.tables[0]!.columns[0]!.values.buffer, encoded.buffer);
  assert.equal(opened.tables[0]!.columns[0]!.validity!.buffer, encoded.buffer);
  const unaligned = new Uint8Array(encoded.length + 1); unaligned.set(encoded, 1);
  const result = decodeColumns(unaligned.subarray(1));
  assert.equal(result.zeroCopy, false);
  assert.notEqual(result.tables[0]!.columns[0]!.values.buffer, unaligned.buffer);
  assert.deepEqual(values(unaligned.subarray(1)), [0, null, 3.125]);
});
await test("reused axes are shared, including reference indexes following other references", () => {
  const axis = [1, 2, 3], other = [4, 5, 6];
  const data = frame(axis);
  data.tables[0]!.columns.push({ name: "again", type: "f64", values: axis }, { name: "other", type: "f64", values: other }, { name: "otherAgain", type: "f64", values: other });
  const columns = decodeColumns(encodeCells(data)).tables[0]!.columns;
  assert.equal(columns[0]!.values, columns[1]!.values);
  assert.equal(columns[2]!.values, columns[3]!.values);
});
await test("column encoder rejects type confusion, overflow, holes and invalid descriptors", () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, 1n]) assert.throws(() => encodeCells(frame([value])));
  for (const value of [-1n, 1n << 64n, 1]) assert.throws(() => encodeCells(frame([value], "u64")));
  for (const value of [-1, 256, 1.5]) assert.throws(() => encodeCells(frame([value], "u8")));
  const holey: unknown[] = []; holey.length = 1;
  assert.throws(() => encodeCells(frame(holey)));
  assert.throws(() => encodeColumns({ metadata: {}, tables: [{ name: "x", rows: 16385, columns: [] }] }));
  const duplicate = frame([1]); duplicate.tables[0]!.columns.push(duplicate.tables[0]!.columns[0]!);
  assert.throws(() => encodeCells(duplicate));
  assert.throws(() => encodeColumns({ metadata: {}, tables: [{ name: "x", rows: 2, columns: [{ name: "v", type: "f64", values: new Float64Array(3), validity: null }] }] }));
  assert.throws(() => encodeColumns({ metadata: {}, tables: [{ name: "x", rows: 2, columns: [{ name: "v", type: "f64", values: new Float64Array(2), validity: new Uint8Array(2) }] }] }));
});
await test("column parser rejects every truncation, extra bytes, version, flags and oversized length", () => {
  const encoded = encodeCells(frame([null, 0, 1.25]));
  for (let length = 0; length < encoded.length; length += 1) assert.throws(() => decodeColumns(encoded.subarray(0, length)));
  assert.throws(() => decodeColumns(new Uint8Array([...encoded, 0])));
  for (const offset of [0, 4, 6]) assert.throws(() => decodeColumns(mutate(encoded, bytes => { bytes[offset] = bytes[offset]! ^ 255; })));
  assert.throws(() => decodeColumns(mutate(encoded, (_, view) => view.setUint32(8, 0xffffffff, true))));
  assert.throws(() => decodeColumns(new Uint8Array(new SharedArrayBuffer(32))));
});
await test("column parser rejects non-finite numbers, null-slot data and padding", () => {
  const encoded = encodeCells(frame([null, 0, 1.25]));
  const column = decodeColumns(encoded).tables[0]!.columns[0]!;
  const at = column.values.byteOffset;
  assert.throws(() => decodeColumns(mutate(encoded, (_, view) => view.setFloat64(at + 8, Infinity, true))));
  assert.throws(() => decodeColumns(mutate(encoded, bytes => { bytes[at] = 1; })));
  assert.throws(() => decodeColumns(mutate(encoded, bytes => { bytes[column.validity!.byteOffset] = bytes[column.validity!.byteOffset]! | 128; })));
  assert.throws(() => decodeColumns(mutate(encoded, bytes => { bytes[column.validity!.byteOffset + 1] = 1; })));
});
await test("column parser rejects unknown metadata fields and forward/cyclic references", () => {
  const encoded = encodeCells(frame([1]));
  function rewrite(callback: (metadata: Metadata) => void): Uint8Array {
    const view = new DataView(encoded.buffer);
    const oldLength = view.getUint32(8, true);
    const metadata: Metadata = JSON.parse(new TextDecoder().decode(encoded.subarray(16, 16 + oldLength)));
    callback(metadata);
    const text = new TextEncoder().encode(JSON.stringify(metadata));
    const oldStart = Math.ceil((16 + oldLength) / 8) * 8;
    const start = Math.ceil((16 + text.length) / 8) * 8;
    const copy = new Uint8Array(start + encoded.length - oldStart);
    copy.set(encoded.subarray(0, 16)); copy.set(text, 16); copy.set(encoded.subarray(oldStart), start);
    const header = new DataView(copy.buffer); header.setUint32(8, text.length, true); header.setUint32(12, copy.length, true);
    return copy;
  }
  assert.throws(() => decodeColumns(rewrite(data => { data.surprise = true; })));
  assert.throws(() => decodeColumns(rewrite(data => { const c = data.tables[0]!.columns[0]!; delete c.nullable; c.ref = 0; })));
  assert.throws(() => decodeColumns(rewrite(data => { data.tables[0]!.rows = 0xffffffff; })));
});

for (const { name, value } of [...captures(), ...syntheticCases()]) await test(`history round trip: ${name}`, () => {
  const encoded = encodeHistory(value);
  const view = openHistory(encoded);
  assert.equal(view.zeroCopy, true);
  assert.deepEqual(materializeHistory(view.root), value);
  assert.deepEqual(encodeHistory(materializeHistory(view.root)), encoded);
});
for (const [kind, value] of Object.entries(histories(0))) await test(`empty history: ${kind}`, () => assert.deepEqual(materializeHistory(openHistory(encodeHistory(value)).root), value));
await test("all project kinds, collector text, and bundles survive", () => {
  const fixture = histories(13).project;
  const historiesByKind: Record<string, unknown> = Object.fromEntries(["worker", "routes", "durable-objects", "r2", "d1", "d1-statements", "probes"].map(kind => [kind, { ...fixture, kind }]));
  historiesByKind.collector = { projectId: "stuff", kind: "collector", fromMs: 1, toMs: 2, range: "1h", runs: [{ atMs: 1, ok: false, detail: "unavailable, not zero", rowsRead: 0, durationMs: 1.25 }] };
  const value = { projectId: "stuff", histories: historiesByKind };
  assert.deepEqual(materializeHistory(openHistory(encodeHistory(value)).root), value);
});
await test("bundles reject cross-host data, mislabeled kinds, and malformed root identities", () => {
  const data = histories(2);
  const hostId = data.summary.hostId;
  const valid = { hostId, histories: { summary: data.summary } };
  assert.deepEqual(materializeHistory(openHistory(encodeHistory(valid)).root), valid);
  assert.throws(() => encodeHistory({ hostId, histories: { summary: { ...data.summary, hostId: "h_other" } } }));
  assert.throws(() => encodeHistory({ hostId, histories: { disks: data.summary } }));
  assert.throws(() => encodeHistory({ ...valid, unknown: true }));
  assert.throws(() => encodeHistory({ projectId: "stuff", histories: { worker: { ...data.project, kind: "r2" } } }));
  assert.throws(() => openHistory(rebuild(encodeHistory(valid), frame => { (frame.metadata as HistoryMetadata).node.entries[0]!.name = "nets"; })));
  assert.throws(() => openHistory(rebuild(encodeHistory(valid), frame => { (frame.metadata as HistoryMetadata).node.metadata.hostId = "h_other"; })));
});

await test("history shares identical axes without inventing data for sparse devices", () => {
  const data = histories(20);
  const encoded = encodeHistory({ hostId: data.summary.hostId, histories: { summary: data.summary, filesystems: data.filesystems, nets: data.nets } });
  const frame = decodeColumns(encoded);
  const axes = frame.tables.map(table => table.columns.find(column => column.name === "atMs"));
  assert.equal(axes[0]!.values, axes[1]!.values);
  assert.equal(axes[0]!.values, axes[2]!.values);
  assert.notEqual(axes[0]!.values, axes.at(-1)!.values);
});
await test("a host with thousands of short-lived devices still fits one frame", () => {
  const nets = histories(3).nets;
  const point = nets.series[0]!.points[0]!;
  const value = { ...nets, series: Array.from({ length: 3000 }, (_, index) => ({ id: `veth${index.toString(16).padStart(8, "0")}`, points: [{ ...point, atMs: point.atMs + index }, { ...point, atMs: point.atMs + index + 15000 }] })) };
  const encoded = encodeHistory(value);
  assert.ok(encoded.length > 1024 * 1024);
  assert.deepEqual(materializeHistory(openHistory(encoded).root), value);
});
await test("history rejects unknown fields, invalid timestamps and new kinds instead of dropping them", () => {
  const value = histories(1).summary;
  for (const patch of [{ surprise: 1 }, { atMs: 1.5 }, { partial: 0 }, { cpu: null }, { mem: { total: Infinity } }]) assert.throws(() => encodeHistory({ ...value, points: [{ ...value.points[0], ...patch }] }));
  assert.throws(() => encodeHistory({ ...value, kind: "future-kind" }));
});
await test("history rejects incompatible metadata, missing parents, invalid booleans and unused tables", () => {
  const encoded = encodeHistory(histories(2).summary);
  assert.throws(() => openHistory(rebuild(encoded, data => { (data.metadata as HistoryMetadata).format = "unknown"; })));
  assert.throws(() => openHistory(rebuild(encoded, data => { data.tables[0]!.columns = data.tables[0]!.columns.filter(c => c.name !== "mem"); })));
  assert.throws(() => openHistory(rebuild(encoded, data => { data.tables[0]!.columns.find(c => c.name === "partial")!.values[0] = 2; })));
  assert.throws(() => openHistory(rebuild(encoded, data => { data.tables[0]!.columns.find(c => c.name === "atMs")!.values[0] = null; })));
  assert.throws(() => openHistory(rebuild(encoded, data => { data.tables.push({ name: "unused", rows: 0, columns: [] }); })));
});
await test("wall-clock regression, reboot uptime and optional Mac fields retain their exact shape", () => {
  const value = histories(3).summary;
  value.points[2]!.atMs = value.points[0]!.atMs - 3000;
  value.points[2]!.uptimeMs = 1;
  delete value.points[1]!.cpu!.iowait; delete value.points[1]!.cpu!.steal;
  assert.deepEqual(materializeHistory(openHistory(encodeHistory(value)).root), value);
});

const special = JSON.parse('{"__proto__":{"polluted":true},"constructor":"safe","v":1}');
const storageValues = [null, true, false, 0, -0, 1.125, "", "0", "000", "0.000", "9007199254740993", "18446744073709551615", "18446744073709551616", "123456789012345678901234567890", "🌱", "\ud800", "\udc00", [null, true, "0", 0], special, { "\ud800": "\udc00" }, {}];
for (const kind of ["sample", "delta", "rollup"] as const) await test(`storage exactness and legacy TEXT: ${kind}`, () => {
  for (const value of storageValues) {
    assert.deepEqual(decodeStored(kind, encodeStored(kind, value)), value);
    assert.deepEqual(decodeStored(kind, JSON.stringify(value)), JSON.parse(JSON.stringify(value)));
  }
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});
const fixtureFiles = readdirSync(join(root, "fixtures/v1")).filter(name => /^batch-.*\.json$/u.test(name) || name === "u64-boundaries.json");
for (const filename of fixtureFiles) await test(`raw sample fixture: ${filename}`, () => {
  const batch = JSON.parse(readFileSync(join(root, "fixtures/v1", filename), "utf8")) as { samples: unknown[] };
  for (const sample of batch.samples) assert.deepEqual(decodeStored("sample", encodeStored("sample", sample)), sample);
});
await test("storage encoding is deterministic regardless of object key insertion order", () => {
  assert.deepEqual(encodeStored("delta", { b: { z: "10", a: "0" }, a: 1 }), encodeStored("delta", { a: 1, b: { a: "0", z: "10" } }));
});
await test("storage rejects truncation, unknown versions/tags, wrong kind and trailing bytes", () => {
  const encoded = encodeStored("rollup", { counter: "18446744073709551615", values: [null, true, 3.125] });
  for (let length = 0; length < encoded.length; length += 1) assert.throws(() => decodeStored("rollup", encoded.subarray(0, length)));
  assert.throws(() => decodeStored("sample", encoded));
  assert.throws(() => decodeStored("rollup", new Uint8Array([...encoded, 0])));
  for (const offset of [0, 5, 6, 15]) assert.throws(() => decodeStored("rollup", mutate(encoded, bytes => { bytes[offset] = bytes[offset]! ^ 255; })));
  const scalar = encodeStored("sample", 1);
  assert.throws(() => decodeStored("sample", mutate(scalar, bytes => { bytes[16] = 255; })));
  assert.throws(() => decodeStored("sample", mutate(scalar, (_, view) => view.setFloat64(17, Infinity, true))));
});
await test("storage enforces complexity limits and rejects unsupported JSON values", () => {
  for (const value of [undefined, 1n, NaN, Infinity, new Date(), new Uint8Array([1])]) assert.throws(() => encodeStored("sample", value));
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic; assert.throws(() => encodeStored("sample", cyclic));
  let nested = {}; for (let index = 0; index < 40; index += 1) nested = { nested }; assert.throws(() => encodeStored("sample", nested));
  assert.throws(() => encodeStored("sample", Array.from({ length: 100001 }, () => null)));
});
await test("deterministic randomized mutation smoke checks both bounded parsers", () => {
  let seed = 0x12345678;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const columns = encodeCells(frame([null, 0, 1.25]));
  const stored = encodeStored("sample", { value: "18446744073709551615", flag: false });
  const decoders: [Uint8Array, (bytes: Uint8Array) => unknown][] = [[columns, decodeColumns], [stored, bytes => decodeStored("sample", bytes)]];
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    for (const [input, decode] of decoders) {
      const changed = input.slice(); const position = random() % changed.length; changed[position] = changed[position]! ^ (1 << (random() % 8));
      try { decode(changed); } catch (error) { assert.ok(error instanceof Error); }
    }
  }
});
await test("v1 golden byte vectors pin endianness, tags, framing and dictionary order", () => {
  const columns = encodeCells({ metadata: {}, tables: [{ name: "t", rows: 2, columns: [{ name: "v", type: "u64", values: [0n, 18446744073709551615n] }] }] });
  assert.equal(hex(columns), "535443310100000067000000880000007b226d65746164617461223a7b7d2c227461626c6573223a5b7b226e616d65223a2274222c22726f7773223a322c22636f6c756d6e73223a5b7b226e616d65223a2276222c2274797065223a22753634222c226e756c6c61626c65223a66616c73657d5d7d5d7d000000000000000000ffffffffffffffff");
  assert.equal(hex(encodeStored("sample", { a: "18446744073709551615", b: 0 })), "53545231000100002c0000000200000000016100016207020005ffffffffffffffff01030000000000000000");
});
await test("required nested fields, optional pairs and literal dotted keys fail closed", () => {
  const data = histories(1).summary;
  for (const change of [{ mem: {} }, { "mem.total": 1 }, { mem: { total: 1, available: 0, swapUsed: 0, swapInBytesPerSec: 1 } }, { psi: { cpu: { some10: 0, some60: 0, some300: 0, full10: 1 } } }]) assert.throws(() => encodeHistory({ ...data, points: [{ ...data.points[0], ...change }] }));
  const valid = encodeHistory(histories(2).summary);
  assert.throws(() => openHistory(rebuild(valid, frame => { frame.tables[0]!.columns = frame.tables[0]!.columns.filter(column => column.name !== "mem.total"); })));
});
await test("axis interning never conflates positive and negative zero", () => {
  const { summary, filesystems } = histories(1);
  summary.points[0]!.atMs = 0; filesystems.series[0]!.points[0]!.atMs = -0;
  const value = { hostId: summary.hostId, histories: { summary, filesystems } };
  assert.deepEqual(materializeHistory(openHistory(encodeHistory(value)).root), value);
});
