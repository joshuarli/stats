#!/usr/bin/env node
/** Local CPU and size measurements, not a Cloudflare billing or production latency measurement. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cpus, platform, arch } from "node:os";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { openHistory } from "../src/binary/history.ts";
import { decodeFleetHistories, decodeHostHistories, decodeProjectHistories } from "../src/client/history.ts";
import { encodeHostBundle, encodeProjectBundle, encodeProjectHistory, hostHistoryColumns } from "../src/history-frame.ts";
import { compact, encodeHistory, readHistory } from "../test/support/history.ts";
import { encodeStored, decodeStored } from "../test/binary/storage-candidate.ts";
import { captures, root, syntheticCases } from "../test/binary/cases.ts";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--quick")) throw new Error("usage: node --experimental-strip-types cloudflare/scripts/bench-history.mjs [--quick]");
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
function bundles() {
  const found = new Map();
  for (const { name, value } of captures()) {
    const directory = name.slice(0, name.lastIndexOf("/"));
    const range = name.slice(name.lastIndexOf("-") + 1, -5);
    const key = `${directory}/${range}`;
    const entry = found.get(key) ?? { name: key, kind: "hostId" in value ? "host" : "project", histories: {} };
    entry.histories[value.kind] = value;
    found.set(key, entry);
  }
  const real = [...found.values()].filter(entry => Object.keys(entry.histories).length > 1).map(entry => {
    const first = Object.values(entry.histories)[0];
    return { name: entry.name, value: entry.kind === "host" ? { hostId: first.hostId, histories: entry.histories } : { projectId: first.projectId, histories: entry.histories } };
  });
  return [...real, ...syntheticCases().filter(({ name }) => name.includes("bundle") || name.includes("project"))];
}
function productionEncode(value) {
  if ("hostId" in value && "histories" in value) return () => encodeHostBundle(value.hostId, Object.values(value.histories).map(history => hostHistoryColumns(history)));
  if ("projectId" in value && "histories" in value) return () => encodeProjectBundle(value.projectId, Object.values(value.histories));
  return () => encodeProjectHistory(value);
}
const results = [];
for (const { name, value } of bundles()) {
  const json = JSON.stringify(value);
  const encode = productionEncode(value);
  const encoded = encode();
  const expected = readHistory(encodeHistory(value));
  assert.deepEqual(readHistory(encoded), "hostId" in value ? compact(expected) : expected);
  const columns = "hostId" in value && "histories" in value ? Object.values(value.histories).map(history => hostHistoryColumns(history)) : null;
  const isHostBundle = "hostId" in value && "histories" in value && "block" in value.histories;
  const isProjectBundle = "projectId" in value && "histories" in value && "worker" in value.histories;
  const openedRoot = openHistory(encoded).root;
  results.push({ name, format: "history", json: compressed(Buffer.from(json)), binary: compressed(encoded),
    jsonEncode: measure(() => JSON.stringify(value)),
    binaryExtractAndEncode: measure(encode),
    binaryEncodeCachedColumns: columns === null ? null : measure(() => encodeHostBundle(value.hostId, columns)),
    jsonParse: measure(() => JSON.parse(json)),
    binaryOpenValidated: measure(() => openHistory(encoded)),
    clientDecodeFleet: isHostBundle ? measure(() => decodeFleetHistories(openedRoot)) : null,
    clientDecodeHost: isHostBundle ? measure(() => decodeHostHistories(openedRoot)) : null,
    clientDecodeProject: isProjectBundle ? measure(() => decodeProjectHistories(openedRoot)) : null });
}
for (const filename of readdirSync(join(root, "fixtures/v2/sources")).filter(name => /^(linux|macos)-normal\.json$|^minimal\.json$|^system\.json$|^u64-boundaries\.json$/u.test(name))) {
  const batch = JSON.parse(readFileSync(join(root, "fixtures/v2/sources", filename), "utf8"));
  for (const [index, value] of batch.samples.entries()) {
    const json = JSON.stringify(value);
    const encoded = encodeStored("sample", value);
    assert.deepEqual(decodeStored("sample", encoded), value);
    results.push({ name: `fixtures/v2/sources/${filename}#sample-${index}`, format: "storage", json: compressed(Buffer.from(json)), binary: compressed(encoded),
      jsonEncode: measure(() => JSON.stringify(value)), binaryEncode: measure(() => encodeStored("sample", value)),
      jsonDecode: measure(() => JSON.parse(json)), binaryDecodeToObjects: measure(() => decodeStored("sample", encoded)) });
  }
}
if (sink === undefined) throw new Error("no benchmark work");
console.log(JSON.stringify({ environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", iterations, rounds, forcedGc: global.gc !== undefined },
  notes: ["Minified JSON is what the API returned before the frame replaced it; byte counts include the frame header and descriptor.", "Gzip level 6 and Brotli quality 5; transfer sizes are local compression results, not observed network traffic.", "binaryExtractAndEncode builds typed columns from point objects and serializes them; binaryEncodeCachedColumns serializes columns the Durable Object already holds for the window.", "JSON.parse is native parsing only; it does not run the old API's schema decoders. binaryOpenValidated is the whole client-side parse and validation of a frame.", "Synthetic cases are labelled separately from repository captures. Browser and workerd timings differ."], results }, null, 2));
