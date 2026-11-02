import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = join(root, "fixtures", "v1");
const hostPattern = /^h_[0-9a-f]{32}$/u;
const bootPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const decimal = /^(0|[1-9][0-9]{0,19})$/u;
const metricGroups = ["cpu", "load", "mem", "uptimeMs", "cpuCount", "disks", "nets", "psi", "filesystems", "block", "gpu", "power"];
const unavailableGroups = ["cpu", "load", "mem", "uptime", "disks", "nets", "psi", "filesystems", "gpu", "power"];

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

const errorCodes = new Set(quotedList(source("cloudflare/src/codes.ts"), /export const ERROR_CODES = \[([\s\S]*?)\] as const;/u, "ERROR_CODES"));
const serverFilesystems = quotedList(source("cloudflare/src/protocol.ts"), /const FS_TYPES = \[([^\]]+)\] as const;/u, "protocol FS_TYPES");
const agentFilesystems = quotedList(source("agent/src/parse.rs"), /pub const FILESYSTEM_TYPES: \[&str; [0-9]+\] = \[([^\]]+)\];/u, "agent FILESYSTEM_TYPES");
const serverBounds = numberList(source("cloudflare/src/limits.ts"), /export const BLOCK_BOUNDS_US = \[([^\]]+)\] as const;/u, "BLOCK_BOUNDS_US");
const collectorBounds = [...source("bpf/biolatency-collector.bt").matchAll(/\$latency_us <= ([0-9_]+)/gu)].map(entry => Number(entry[1].replaceAll("_", "")));
const blockBuckets = Number(/export const BLOCK_BUCKETS = ([0-9]+);/u.exec(source("cloudflare/src/limits.ts"))?.[1]);
const agentBuckets = Number(/pub const BUCKETS: usize = ([0-9]+);/u.exec(source("agent/src/block.rs"))?.[1]);
const manifest = JSON.parse(readFileSync(join(fixtureDir, "manifest.json"), "utf8"));
const failures = [];
const fail = message => failures.push(message);
const listed = new Set(manifest.fixtures.map(entry => entry.file));

if (JSON.stringify(serverFilesystems) !== JSON.stringify(agentFilesystems)) {
  fail(`filesystem allow-list differs: server ${serverFilesystems.join(",")}; agent ${agentFilesystems.join(",")}`);
}
if (JSON.stringify(serverBounds) !== JSON.stringify(collectorBounds)) {
  fail(`block bucket bounds differ: server ${serverBounds.join(",")}; collector ${collectorBounds.join(",")}`);
}
if (blockBuckets !== serverBounds.length + 1 || blockBuckets !== agentBuckets) {
  fail(`block bucket count differs: limits ${blockBuckets}; bounds ${serverBounds.length + 1}; agent ${agentBuckets}`);
}

for (const name of readdirSync(fixtureDir)) {
  if (name !== "manifest.json" && !listed.has(name)) fail(`${name}: not listed in manifest`);
}
for (const entry of manifest.fixtures) {
  const path = join(fixtureDir, entry.file);
  let text;
  try { text = readFileSync(path, "utf8"); } catch { fail(`${entry.file}: missing`); continue; }
  const bytes = Buffer.byteLength(text);
  if (entry.expect === "reject" && entry.code === "too_large") {
    if (bytes <= 65_536) fail(`${entry.file}: expected oversized body, got ${bytes}`);
  } else if (bytes > 65_536) fail(`${entry.file}: ${bytes} bytes exceeds the batch cap`);
  let value;
  try { value = JSON.parse(text); } catch (cause) { fail(`${entry.file}: invalid JSON: ${cause.message}`); continue; }
  if (entry.expect === "reject" && !errorCodes.has(entry.code ?? "")) fail(`${entry.file}: unknown expected code ${entry.code}`);
  if (entry.expect === "accept") {
    if (value.v !== 1) fail(`${entry.file}: v must be 1`);
    if (!hostPattern.test(value.hostId ?? "")) fail(`${entry.file}: hostId`);
    if (!bootPattern.test(value.bootId ?? "")) fail(`${entry.file}: bootId`);
    if (!Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 16) fail(`${entry.file}: samples count`);
    for (const [index, sample] of (value.samples ?? []).entries()) {
      for (const key of ["seq", "atMs", "monoMs"]) if (!decimal.test(sample[key] ?? "")) fail(`${entry.file}[${index}]: ${key}`);
      const groups = metricGroups.filter(key => sample[key] !== undefined);
      if (groups.length === 0) fail(`${entry.file}[${index}]: no metric group`);
      for (const key of sample.unavailable ?? []) {
        if (!unavailableGroups.includes(key)) fail(`${entry.file}[${index}]: unknown unavailable group ${key}`);
        if (groups.includes(key === "uptime" ? "uptimeMs" : key)) fail(`${entry.file}[${index}]: ${key} is both present and unavailable`);
      }
      if ((sample.unavailable ?? []).length > unavailableGroups.length) fail(`${entry.file}[${index}]: too many unavailable groups`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

const full = JSON.parse(readFileSync(join(fixtureDir, "batch-full.json"), "utf8"));
const wireBytes = Buffer.byteLength(JSON.stringify(full));
const samplesPerRequest = full.samples.length;
const sampleBytes = Math.ceil(wireBytes / samplesPerRequest);
const sampleIntervalSeconds = 15;
const samplesPerDay = 86_400 / sampleIntervalSeconds;
const requestsPerDay = samplesPerDay / samplesPerRequest;
const rawHours = 48;
const minuteDays = 7;
const hourDays = 90;
const rawRows = samplesPerDay * (rawHours / 24);
const minuteRows = (86_400 / 60) * minuteDays;
const hourRows = 24 * hourDays;
const rollupFactor = 0.5;
const rawBytes = rawRows * sampleBytes;
const rollupBytes = (minuteRows + hourRows) * sampleBytes * rollupFactor;

console.log(`fixtures: ${manifest.fixtures.length} checked`);
console.log(`wire sample: ${sampleBytes} bytes (batch-full is ${wireBytes} bytes for ${samplesPerRequest})`);
console.log("");
console.log("hosts | ingress/day | requests/day | raw GB (48h) | rollup GB (7d+90d) | rows");
for (const hosts of [1, 10, 100]) {
  const ingress = (samplesPerDay * sampleBytes * hosts) / 1_000_000;
  const requests = requestsPerDay * hosts;
  const raw = (rawBytes * hosts) / 1_000_000_000;
  const rollups = (rollupBytes * hosts) / 1_000_000_000;
  const rows = (rawRows + minuteRows + hourRows) * hosts;
  console.log(`${String(hosts).padStart(5)} | ${ingress.toFixed(1).padStart(11)} MB | ${String(requests).padStart(12)} | ${raw.toFixed(2).padStart(12)} | ${rollups.toFixed(2).padStart(18)} | ${rows}`);
}
console.log("");
console.log(`per host/day: ${samplesPerDay} samples, ${requestsPerDay} ingest requests, ${rawRows} raw rows, ${minuteRows} minute rows, ${hourRows} hourly rows`);
console.log(`storage assumption: ${rawHours}h raw, ${minuteDays}d one-minute, ${hourDays}d hourly; rollup payload = ${rollupFactor} × sample bytes`);
console.log("account limits, Access, billing, and Durable Object ceiling are verified only in a real deployment; see Needs environment.");
