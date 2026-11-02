#!/usr/bin/env node
/** Local CPU/size experiment, not a Cloudflare billing or production latency measurement. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cpus, platform, arch } from "node:os";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { cell, decodeColumns, encodeColumns } from "../src/binary/columns.ts";
import { encodeHistory, openHistory, materializeHistory } from "../src/binary/history.ts";
import { encodeStored, decodeStored } from "../test/binary/storage-candidate.ts";
import { captures, root, syntheticCases } from "../test/binary/cases.mjs";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--quick")) throw new Error("usage: node --experimental-strip-types cloudflare/scripts/bench-binary.mjs [--quick]");
const iterations = args.includes("--quick") ? 20 : 100;
const rounds = 5;
let sink;
function measure(fn) {
  for (let index = 0; index < 10; index += 1) sink = fn();
  const times = [];
  for (let round = 0; round < rounds; round += 1) {
    const start = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) sink = fn();
    times.push(Number(process.hrtime.bigint() - start) / iterations / 1000);
  }
  times.sort((a, b) => a - b);
  return { medianUs: +times[Math.floor(times.length / 2)].toFixed(3), minUs: +times[0].toFixed(3), maxUs: +times.at(-1).toFixed(3) };
}
function compressed(bytes) {
  return {
    bytes: bytes.byteLength,
    gzip6: gzipSync(bytes, { level: 6 }).byteLength,
    brotli5: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).byteLength
  };
}
function retained(fn) {
  if (global.gc === undefined) return null;
  // Retained output size, NOT total allocation traffic. The input buffer/string is shared.
  const holder = [];
  global.gc(); const before = process.memoryUsage();
  for (let index = 0; index < 32; index += 1) holder.push(fn());
  global.gc(); const after = process.memoryUsage();
  sink = holder;
  return { heapBytesPerResult: Math.round((after.heapUsed - before.heapUsed) / holder.length), arrayBufferBytesPerResult: Math.round((after.arrayBuffers - before.arrayBuffers) / holder.length) };
}
function columnarJson(bytes) {
  const frame = decodeColumns(bytes);
  const prior = new Map();
  let count = 0;
  const tables = frame.tables.map(table => ({ name: table.name, rows: table.rows, columns: table.columns.map(column => {
    const index = count++;
    const reference = prior.get(column.values);
    if (reference !== undefined) return { name: column.name, type: column.type, ref: reference };
    prior.set(column.values, index);
    return { name: column.name, type: column.type, values: Array.from({ length: table.rows }, (_, row) => cell(column, row)) };
  }) }));
  return { metadata: frame.metadata, tables };
}
function restoreColumnar(value) {
  const prior = [];
  return { metadata: value.metadata, tables: value.tables.map(table => ({ ...table, columns: table.columns.map(column => {
    const values = column.ref === undefined ? column.values : prior[column.ref];
    prior.push(values);
    return { name: column.name, type: column.type, values };
  }) })) };
}
const results = [];
for (const { name, value } of [...captures(), ...syntheticCases()]) {
  const json = JSON.stringify(value);
  const encoded = encodeHistory(value);
  assert.deepEqual(materializeHistory(openHistory(encoded).root), value);
  const columnar = columnarJson(encoded);
  const columnarText = JSON.stringify(columnar);
  assert.deepEqual(materializeHistory(openHistory(encodeColumns(restoreColumnar(JSON.parse(columnarText)))).root), value);
  results.push({ name, format: "history", json: compressed(Buffer.from(json)), binary: compressed(encoded), columnarJson: compressed(Buffer.from(columnarText)),
    columnarJsonParseOnly: measure(() => JSON.parse(columnarText)),
    columnarJsonRetained: retained(() => JSON.parse(columnarText)),
    jsonEncode: measure(() => JSON.stringify(value)), binaryEncode: measure(() => encodeHistory(value)),
    jsonDecode: measure(() => JSON.parse(json)), binaryOpenValidatedViews: measure(() => openHistory(encoded)),
    binaryDecodeToObjects: measure(() => materializeHistory(openHistory(encoded).root)),
    jsonRetained: retained(() => JSON.parse(json)), binaryRetained: retained(() => openHistory(encoded)) });
}
for (const filename of readdirSync(join(root, "fixtures/v1")).filter(name => /^batch-(full|minimal|macos|system)\.json$/u.test(name))) {
  const batch = JSON.parse(readFileSync(join(root, "fixtures/v1", filename), "utf8"));
  for (const [index, value] of batch.samples.entries()) {
    const json = JSON.stringify(value);
    const encoded = encodeStored("sample", value);
    assert.deepEqual(decodeStored("sample", encoded), value);
    results.push({ name: `fixtures/v1/${filename}#sample-${index}`, format: "storage", json: compressed(Buffer.from(json)), binary: compressed(encoded),
      jsonEncode: measure(() => JSON.stringify(value)), binaryEncode: measure(() => encodeStored("sample", value)),
      jsonDecode: measure(() => JSON.parse(json)), binaryDecodeToObjects: measure(() => decodeStored("sample", encoded)) });
  }
}
if (sink === undefined) throw new Error("no benchmark work");
console.log(JSON.stringify({ environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", iterations, rounds, forcedGc: global.gc !== undefined },
  notes: ["Minified JSON baseline; byte counts include binary headers and dictionaries.", "Gzip level 6 and Brotli quality 5; transfer sizes are local compression results, not observed network traffic.", "Validated typed views and reconstruction into objects are separate measurements.", "JSON.parse is native parsing only; it does not run the existing API's schema decoders.", "Columnar JSON is a layout-only control, with shared-axis references preserved; parse timing excludes schema validation.", "Retained heap is noisy, excludes shared input and is not an allocation-per-operation measurement.", "Synthetic cases are labelled separately from repository captures. Run in workerd and a browser before cutover."], results }, null, 2));
