import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { encodeAck } from "../cloudflare/src/ingest/ack.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v2");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const size = relative => statSync(join(root, relative)).size;

console.log("Request bodies in bytes. v1 JSON is the minified v1 batch for the same samples; gzip is an offline comparison only (the protocol has no request compression).");
console.log("workload | label | samples | v1 JSON | JSON gzip -6 | JSON gzip -9 | STB2 absolute | STB2 | STB2 vs JSON | STB2 vs gzip -9 | bytes/sample | delta saving");
for (const entry of manifest.batches.filter(item => item.workload !== undefined)) {
  const source = JSON.parse(readFileSync(join(root, entry.source), "utf8"));
  const json = Buffer.from(JSON.stringify({ v: 1, ...source }));
  const gzip6 = gzipSync(json, { level: 6 }).length;
  const gzip9 = gzipSync(json, { level: 9 }).length;
  const frame = size(entry.frame);
  const absolute = size(entry.frame.replace(/\.stb2$/u, ".absolute.stb2"));
  const percent = (value, base) => `${(100 * (value / base - 1)).toFixed(1)}%`;
  console.log(`${entry.workload} | ${entry.label} | ${source.samples.length} | ${json.length} | ${gzip6} | ${gzip9} | ${absolute} | ${frame} | ${percent(frame, json.length)} | ${percent(frame, gzip9)} | ${(frame / source.samples.length).toFixed(0)} | ${percent(frame, absolute)}`);
}
console.log("");
console.log("Success acknowledgments in bytes (body only):");
for (const [label, ack, legacy] of [
  ["2 accepted", { accepted: 2, duplicates: 0, rejected: [] }, { v: 1, accepted: 2, duplicates: 0, rejected: [] }],
  ["16 accepted", { accepted: 16, duplicates: 0, rejected: [] }, { v: 1, accepted: 16, duplicates: 0, rejected: [] }],
  ["1 accepted, 1 rejected", { accepted: 1, duplicates: 0, rejected: [{ seq: 900015n, code: "invalid_sample" }] }, { v: 1, accepted: 1, duplicates: 0, rejected: [{ seq: "900015", code: "invalid_sample" }] }]
]) console.log(`${label}: v1 JSON ${Buffer.byteLength(JSON.stringify(legacy))}, STA2 ${encodeAck(ack).length}`);
