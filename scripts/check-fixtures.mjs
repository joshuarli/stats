import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../cloudflare/src/protocol.ts";
import { computeDelta } from "../cloudflare/src/delta.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = join(root, "fixtures", "v2");
const failures = [];
const fail = message => failures.push(message);

function source(relative) {
  return readFileSync(join(root, relative), "utf8");
}

function quotedList(text, pattern, label) {
  const match = pattern.exec(text);
  if (match === null) throw new Error(`${label}: declaration not found`);
  return [...match[1].matchAll(/"([^"]+)"/gu)].map(entry => entry[1]);
}

function numberList(text, pattern, label) {
  const match = pattern.exec(text);
  if (match === null) throw new Error(`${label}: declaration not found`);
  return match[1].split(",").map(value => Number(value.trim().replaceAll("_", "")));
}

function json(relative) {
  return JSON.parse(readFileSync(join(fixtureDir, relative), "utf8"));
}

function size(relative) {
  return statSync(join(fixtureDir, relative)).size;
}

execFileSync(process.execPath, [join(root, "scripts", "fixture-sources.mjs"), "--check"], { stdio: "inherit" });

const errorCodes = new Set(quotedList(source("cloudflare/src/codes.ts"), /export const ERROR_CODES = \[([\s\S]*?)\] as const;/u, "ERROR_CODES"));
const serverFilesystems = quotedList(source("cloudflare/src/protocol.ts"), /export const FS_TYPES = \[([^\]]+)\] as const;/u, "protocol FS_TYPES");
const agentFilesystems = quotedList(source("agent/src/model.rs"), /pub const FILESYSTEM_TYPES: \[&str; [0-9]+\] = \[([^\]]+)\];/u, "agent FILESYSTEM_TYPES");
const serverBounds = numberList(source("cloudflare/src/limits.ts"), /export const BLOCK_BOUNDS_US = \[([^\]]+)\] as const;/u, "BLOCK_BOUNDS_US");
const collectorBounds = [...source("bpf/biolatency-collector.bt").matchAll(/\$latency_us <= ([0-9_]+)/gu)].map(entry => Number(entry[1].replaceAll("_", "")));
const blockBuckets = Number(/export const BLOCK_BUCKETS = ([0-9]+);/u.exec(source("cloudflare/src/limits.ts"))?.[1]);
const agentBuckets = Number(/pub const BLOCK_BUCKETS: usize = ([0-9]+);/u.exec(source("agent/src/model.rs"))?.[1]);
const serverCap = Number(/export const MAX_BODY_BYTES = ([0-9_]+);/u.exec(source("cloudflare/src/limits.ts"))?.[1].replaceAll("_", ""));
const agentCap = Number(/pub const MAX_BODY: usize = ([0-9_]+);/u.exec(source("agent/src/wire.rs"))?.[1].replaceAll("_", ""));
for (const [label, server, agent] of [["request media type", /INGEST_MEDIA_TYPE = "([^"]+)"/u.exec(source("cloudflare/src/ingest/http.ts"))?.[1], /REQUEST_MEDIA_TYPE: &str = "([^"]+)"/u.exec(source("agent/src/wire.rs"))?.[1]], ["ack media type", /ACK_MEDIA_TYPE = "([^"]+)"/u.exec(source("cloudflare/src/ingest/ack.ts"))?.[1], /ACK_MEDIA_TYPE: &str = "([^"]+)"/u.exec(source("agent/src/wire.rs"))?.[1]], ["ingest path", /INGEST_PATH = "([^"]+)"/u.exec(source("cloudflare/src/ingest/http.ts"))?.[1], /INGEST_PATH: &str = "([^"]+)"/u.exec(source("agent/src/transport.rs"))?.[1]]]) {
  if (server === undefined || server !== agent) fail(`${label} differs: server ${server}; agent ${agent}`);
}

if (JSON.stringify(serverFilesystems) !== JSON.stringify(agentFilesystems)) fail(`filesystem type list differs: server ${serverFilesystems.join(",")}; agent ${agentFilesystems.join(",")}`);
if (JSON.stringify(serverBounds) !== JSON.stringify(collectorBounds)) fail(`block bucket bounds differ: server ${serverBounds.join(",")}; collector ${collectorBounds.join(",")}`);
if (blockBuckets !== serverBounds.length + 1 || blockBuckets !== agentBuckets) fail(`block bucket count differs: limits ${blockBuckets}; bounds ${serverBounds.length + 1}; agent ${agentBuckets}`);
if (serverCap !== agentCap) fail(`body cap differs: server ${serverCap}; agent ${agentCap}`);

const manifest = json("manifest.json");
const expectedFrames = new Set();
for (const entry of manifest.batches) {
  const batch = json(entry.source);
  if (!Array.isArray(batch.samples) || batch.samples.length < 1 || batch.samples.length > 16) fail(`${entry.name}: sample count`);
  if (entry.samples.length !== batch.samples.length || !entry.samples.every(outcome => outcome === "accept" || outcome === "invalid_sample")) fail(`${entry.name}: per-sample outcomes`);
  for (const frame of [entry.frame, entry.frame.replace(/\.stb2$/u, ".absolute.stb2")]) {
    expectedFrames.add(frame.slice("frames/".length));
    try { if (size(frame) > serverCap) fail(`${frame}: exceeds the body cap`); } catch { fail(`${frame}: missing; run make fixtures-write`); }
  }
  if (entry.budget !== undefined && size(entry.frame) > entry.budget) fail(`${entry.name}: ${size(entry.frame)} bytes exceeds its ${entry.budget} byte budget`);
}
for (const name of readdirSync(join(fixtureDir, "frames"))) {
  if (name.endsWith(".stb2") && !expectedFrames.has(name)) fail(`frames/${name}: not listed in the manifest`);
}
const acks = json("acks.json").cases;
const ackFrames = new Set(acks.filter(entry => entry.frame !== undefined).map(entry => entry.frame.slice("frames/acks/".length)));
for (const name of readdirSync(join(fixtureDir, "frames", "acks"))) if (!ackFrames.has(name)) fail(`frames/acks/${name}: not listed in acks.json`);
for (const entry of json("malformed.json").cases) {
  if (!errorCodes.has(entry.code)) fail(`${entry.name}: unknown expected code ${entry.code}`);
  if (entry.hex.length / 2 > serverCap) fail(`${entry.name}: larger than the body cap`);
}
for (const vector of json("annotated.json").vectors) if (!manifest.batches.some(entry => entry.name === vector.batch)) fail(`${vector.name}: unknown batch ${vector.batch}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

const workload = name => manifest.batches.find(entry => entry.workload === name);
const legacyBytes = batch => Buffer.byteLength(JSON.stringify({ v: 1, ...batch }));
const storedBytes = batch => batch.samples.reduce((total, sample, index) => {
  const previous = batch.samples[index - 1];
  const elapsed = previous === undefined ? 0 : Number(sample.monoMs) - Number(previous.monoMs);
  return total + Buffer.byteLength(canonicalJson(sample)) + Buffer.byteLength(JSON.stringify(computeDelta(previous, sample, elapsed)));
}, 0);

console.log(`fixtures: ${manifest.batches.length} batches, ${json("malformed.json").cases.length} malformed frames, ${acks.length} acknowledgments, ${json("annotated.json").vectors.length} annotated vectors checked`);
console.log("");
console.log("request bodies (golden frames; HTTP headers excluded):");
console.log("workload             | samples | v1 JSON | STB2 absolute | STB2 | vs JSON | budget");
for (const name of ["linux-normal", "macos-normal", "linux-single", "macos-single", "system", "linux-normal-system", "linux-backlog-16", "macos-backlog-16", "high-cardinality-16", "device-union", "missing-groups", "counter-reset", "large-counters"]) {
  const entry = workload(name);
  if (entry === undefined) continue;
  const batch = json(entry.source);
  const legacy = legacyBytes(batch);
  const frame = size(entry.frame);
  const absolute = size(entry.frame.replace(/\.stb2$/u, ".absolute.stb2"));
  console.log(`${name.padEnd(20)} | ${String(batch.samples.length).padStart(7)} | ${String(legacy).padStart(7)} | ${String(absolute).padStart(13)} | ${String(frame).padStart(4)} | ${`${(100 * (frame / legacy - 1)).toFixed(1)}%`.padStart(7)} | ${entry.budget ?? "-"}`);
}

const normal = json(workload("linux-normal").source);
const frameBytes = size(workload("linux-normal").frame);
const sampleIntervalSeconds = 15;
const samplesPerRequest = normal.samples.length;
const samplesPerDay = 86_400 / sampleIntervalSeconds;
const requestsPerDay = samplesPerDay / samplesPerRequest;
const rawRows = samplesPerDay * 2;
const minuteRows = (86_400 / 60) * 7;
const hourRows = 24 * 30;
const storedPerSample = storedBytes(normal) / samplesPerRequest;
const rollupFactor = 0.5;
console.log("");
console.log(`cadence: one sample every ${sampleIntervalSeconds} s, ${samplesPerRequest} per upload, so ${samplesPerDay} samples and ${requestsPerDay} ingest requests per host per day (unchanged by the wire format)`);
console.log(`rows per host (from retention): ${rawRows} raw (48 h), ${minuteRows} one-minute (7 d), ${hourRows} hourly (30 d); rows written per day: ${samplesPerDay} raw inserts plus rollup upserts`);
console.log(`measured stored raw row payload: ${storedPerSample.toFixed(0)} bytes per sample (canonical JSON payload + delta JSON, linux-normal; unchanged by this protocol)`);
console.log("");
console.log("hosts | ingress/day (STB2 bodies) | ingress/day (v1 JSON, for comparison) | requests/day | raw stored GB (48 h, measured row JSON) | rollup GB (estimate: 0.5 x row JSON) | rows");
for (const hosts of [1, 10, 100]) {
  const ingress = (requestsPerDay * frameBytes * hosts) / 1_000_000;
  const legacyIngress = (requestsPerDay * legacyBytes(normal) * hosts) / 1_000_000;
  const raw = (rawRows * storedPerSample * hosts) / 1_000_000_000;
  const rollups = ((minuteRows + hourRows) * storedPerSample * rollupFactor * hosts) / 1_000_000_000;
  console.log(`${String(hosts).padStart(5)} | ${`${ingress.toFixed(2)} MB`.padStart(25)} | ${`${legacyIngress.toFixed(2)} MB`.padStart(38)} | ${String(requestsPerDay * hosts).padStart(12)} | ${raw.toFixed(3).padStart(39)} | ${rollups.toFixed(3).padStart(36)} | ${(rawRows + minuteRows + hourRows) * hosts}`);
}
console.log("");
console.log("Ingress counts request bodies only. Storage, rows, and request counts do not depend on the wire format. Account limits, Access, billing, and the Durable Object ceiling are verified only in a real deployment.");
