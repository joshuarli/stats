import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const legacy = join(root, "bench", "legacy-v1");
const out = join(root, "fixtures", "v2");
const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") {
  console.error("usage: node scripts/fixture-sources.mjs --write | --check");
  process.exit(2);
}

const HOST = "h_0123456789abcdef0123456789abcdef";
const BOOT = "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f";
const OTHER_BOOT = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const U64_MAX = (1n << 64n) - 1n;
const SAFE = 9_007_199_254_740_991n;
const AT = 1_793_510_400_000n;

function legacyBatch(name) {
  const value = JSON.parse(readFileSync(join(legacy, `${name}.json`), "utf8"));
  delete value.v;
  return value;
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const clone = value => structuredClone(value);
const add = (text, amount) => (BigInt(text) + BigInt(amount)).toString();
const fixed = (value, digits) => `${Math.floor(value / 10 ** digits)}.${String(value % 10 ** digits).padStart(digits, "0")}`;

function advance(sample, index, next, seconds = 15) {
  const step = BigInt(seconds * 1000);
  const value = clone(sample);
  value.atMs = (BigInt(sample.atMs) + step).toString();
  value.monoMs = (BigInt(sample.monoMs) + step).toString();
  value.seq = (BigInt(value.monoMs) / 1000n).toString();
  if (value.uptimeMs !== undefined) value.uptimeMs = add(sample.uptimeMs, step);
  if (value.cpu !== undefined) {
    const user = Math.floor(next() * 3000);
    const system = Math.floor(next() * 800);
    const idle = seconds * 100 * Number(value.cpuCount ?? 8) - user - system;
    value.cpu.user = add(value.cpu.user, user);
    value.cpu.system = add(value.cpu.system, system);
    value.cpu.idle = add(value.cpu.idle, idle);
    let total = user + system + idle;
    if (value.cpu.iowait !== undefined) { const wait = Math.floor(next() * 50); value.cpu.iowait = add(value.cpu.iowait, wait); total += wait; }
    if (value.cpu.steal !== undefined) { const steal = Math.floor(next() * 3); value.cpu.steal = add(value.cpu.steal, steal); total += steal; }
    value.cpu.total = add(value.cpu.total, total);
  }
  if (value.load !== undefined) {
    const drift = () => fixed(Math.max(0, Math.floor(next() * 4000)), 3);
    value.load = { one: drift(), five: value.load.one, fifteen: value.load.five };
  }
  if (value.mem !== undefined) {
    value.mem.available = add(value.mem.available, Math.floor((next() - 0.5) * 64 * 1024 * 1024));
    if (value.mem.swapIn !== undefined) {
      value.mem.swapIn = add(value.mem.swapIn, 4096 * Math.floor(next() * 3));
      value.mem.swapOut = add(value.mem.swapOut, 4096 * Math.floor(next() * 5));
    }
  }
  for (const disk of value.disks ?? []) {
    const reads = Math.floor(next() * 200);
    const writes = Math.floor(next() * 400);
    disk.reads = add(disk.reads, reads);
    disk.readSectors = add(disk.readSectors, reads * 16);
    disk.writes = add(disk.writes, writes);
    disk.writeSectors = add(disk.writeSectors, writes * 24);
    if (disk.ioMs !== undefined) disk.ioMs = add(disk.ioMs, Math.floor(next() * 900));
  }
  for (const net of value.nets ?? []) {
    const rx = Math.floor(next() * 4000);
    const tx = Math.floor(next() * 3000);
    net.rxPackets = add(net.rxPackets, rx);
    net.rxBytes = add(net.rxBytes, rx * 900);
    net.txPackets = add(net.txPackets, tx);
    net.txBytes = add(net.txBytes, tx * 700);
  }
  for (const group of Object.values(value.psi ?? {})) {
    group.total = add(group.total, Math.floor(next() * 20_000));
    group.some10 = fixed(Math.floor(next() * 400), 2);
    if (group.fullTotal !== undefined) group.fullTotal = add(group.fullTotal, Math.floor(next() * 4_000));
  }
  for (const filesystem of value.filesystems ?? []) filesystem.available = add(filesystem.available, -4096 * Math.floor(next() * 64));
  if (value.gpu !== undefined) {
    const total = 360_000_000;
    value.gpu.active = add(value.gpu.active, Math.floor(next() * total));
    value.gpu.total = add(value.gpu.total, total);
  }
  if (value.power !== undefined) {
    if (value.power.gpuNj !== undefined) value.power.gpuNj = add(value.power.gpuNj, Math.floor(next() * 4e9));
    if (value.power.systemMwSum !== undefined && index % 4 === 3) {
      value.power.systemMwSum = add(value.power.systemMwSum, 25_000 + Math.floor(next() * 5000));
      value.power.systemReadings = add(value.power.systemReadings, 1);
    }
  }
  if (value.block !== undefined) {
    const buckets = value.block.buckets.map((_, bucket) => (bucket < 9 ? Math.floor(next() * 40) : 0));
    const count = buckets.reduce((sum, item) => sum + item, 0);
    value.block = count === 0
      ? { buckets: buckets.map(String), count: "0", totalUs: "0", minUs: "0", maxUs: "0" }
      : { buckets: buckets.map(String), count: String(count), totalUs: String(count * 1800), minUs: "120", maxUs: "48000" };
  }
  return value;
}

function series(first, count, seed, seconds = 15) {
  const next = random(seed);
  const samples = [first];
  for (let index = 1; index < count; index += 1) samples.push(advance(samples[index - 1], index, next, seconds));
  return samples;
}

function batch(samples, extra = {}) {
  return { hostId: HOST, bootId: BOOT, ...extra, samples };
}

const full = legacyBatch("batch-full");
const mac = legacyBatch("batch-macos");
const linuxFirst = full.samples[0];
const macFirst = mac.samples[0];
const minimalCpu = legacyBatch("batch-minimal").samples[0];
const system = legacyBatch("batch-system").system;

function sample(seq, extra = {}) {
  const mono = BigInt(seq) * 1000n;
  return { seq: String(seq), atMs: (AT - 60_000n + mono).toString(), monoMs: mono.toString(), ...extra };
}

function cpu(user, total = user + 100) {
  return { user: String(user), system: "10", idle: "50", iowait: "20", steal: "20", total: String(total) };
}

function net(id, base) {
  return { id, rxBytes: String(base * 900), rxPackets: String(base), rxDrops: "0", rxErrors: "0", txBytes: String(base * 700), txPackets: String(base), txErrors: "0", txDrops: "0" };
}

function disk(id, name, base, ioMs = true) {
  return { id, name, reads: String(base), readSectors: String(base * 16), writes: String(base * 2), writeSectors: String(base * 48), ...(ioMs ? { ioMs: String(base * 3) } : {}) };
}

function filesystem(id, type, available) {
  return { id, type, total: "107374182400", available: String(available) };
}

function blockOf(buckets, totalUs, minUs, maxUs, count = buckets.reduce((sum, value) => sum + BigInt(value), 0n)) {
  return { buckets: buckets.map(String), count: String(count), totalUs: String(totalUs), minUs: String(minUs), maxUs: String(maxUs) };
}

const cases = [];
function define(name, label, value, options = {}) {
  cases.push({ name, label, value, samples: options.samples ?? value.samples.map(() => "accept"), ...(options.budget === undefined ? {} : { budget: options.budget }), ...(options.workload === undefined ? {} : { workload: options.workload }) });
}

define("minimal", "fixture-derived", batch([minimalCpu]), { workload: "minimal" });
define("linux-normal", "fixture-derived", batch(full.samples), { budget: 520, workload: "linux-normal" });
define("macos-normal", "fixture-derived", batch(mac.samples), { budget: 370, workload: "macos-normal" });
define("linux-single", "fixture-derived", batch([linuxFirst]), { budget: 345, workload: "linux-single" });
define("macos-single", "fixture-derived", batch([macFirst]), { budget: 240, workload: "macos-single" });
define("system", "fixture-derived", batch([minimalCpu], { system }), { budget: 190, workload: "system" });
define("linux-normal-system", "fixture-derived", batch(full.samples, { system }), { budget: 630, workload: "linux-normal-system" });
define("linux-backlog-16", "synthetic", batch(series(linuxFirst, 16, 0x5eed_0001)), { budget: 3570, workload: "linux-backlog-16" });
define("macos-backlog-16", "synthetic", batch(series(macFirst, 16, 0x5eed_0002)), { budget: 2210, workload: "macos-backlog-16" });

const big = [3n, (1n << 53n) + 1n, U64_MAX - 1n];
define("u64-boundaries", "boundary", batch([
  sample(1, { cpu: { user: String(U64_MAX), system: String(SAFE), idle: String(SAFE + 1n), iowait: "0", steal: String(1n << 63n), total: String(U64_MAX) }, uptimeMs: String(U64_MAX - 1n), gpu: { active: String(big[1]), total: String(big[2]) } }),
  sample(2, { cpu: { user: String(U64_MAX), system: String(SAFE + 1n), idle: String(SAFE + 2n), iowait: "0", steal: String((1n << 63n) + 1n), total: String(U64_MAX) }, uptimeMs: String(U64_MAX), gpu: { active: String(big[1] + 1n), total: String(U64_MAX) } }),
  { seq: String(SAFE), atMs: String(SAFE), monoMs: String(SAFE), cpu: { user: "0", system: "0", idle: "0", total: "0" }, uptimeMs: "0" }
]));
define("fixed-point-boundaries", "boundary", batch([
  sample(1, { load: { one: "0.000", five: "0.001", fifteen: "999999.999" }, psi: { cpu: { some10: "0.00", some60: "100.00", some300: "999999.99", total: "0" } } }),
  sample(2, { load: { one: "1.000", five: "0.999", fifteen: "10.010" }, psi: { cpu: { some10: "0.01", some60: "0.10", some300: "99.99", total: "0", full10: "0.00", full60: "999999.99", full300: "1.00", fullTotal: "0" } } })
]));
define("zero-values", "boundary", batch([
  sample(1, { cpu: { user: "0", system: "0", idle: "0", iowait: "0", steal: "0", total: "0" }, mem: { total: "0", available: "0", swapTotal: "0", swapFree: "0", swapIn: "0", swapOut: "0" }, uptimeMs: "0", disks: [disk("8:0", "sda", 0)], nets: [net("eth0", 0)], gpu: { active: "0", total: "0" }, power: { gpuNj: "0", systemMwSum: "0", systemReadings: "0" } }),
  sample(2, { cpu: { user: "0", system: "0", idle: "0", iowait: "0", steal: "0", total: "0" }, mem: { total: "0", available: "0", swapTotal: "0", swapFree: "0", swapIn: "0", swapOut: "0" }, uptimeMs: "0", disks: [disk("8:0", "sda", 0)], nets: [net("eth0", 0)], gpu: { active: "0", total: "0" }, power: { gpuNj: "0", systemMwSum: "0", systemReadings: "0" } })
]));
define("counter-reset", "fixture-derived", batch(legacyBatch("counter-reset").samples), { workload: "counter-reset" });
define("clock-jump", "fixture-derived", batch(legacyBatch("clock-jump").samples));
define("reboot-before", "fixture-derived", batch(legacyBatch("reboot-before").samples));
define("reboot-after", "fixture-derived", { ...batch(legacyBatch("reboot-after").samples), bootId: OTHER_BOOT });
define("out-of-order-late", "fixture-derived", batch(legacyBatch("out-of-order-late").samples));
define("out-of-order-within-batch", "synthetic", batch([sample(30, { cpu: cpu(3000) }), sample(10, { cpu: cpu(1000) }), sample(20, { cpu: cpu(2000) })]));
define("presence", "synthetic", batch([
  sample(1, { unavailable: ["nets"], disks: [], filesystems: [], uptimeMs: "1000" }),
  sample(2, { unavailable: ["disks", "psi"], uptimeMs: "2000", nets: [] }),
  sample(3, { uptimeMs: "3000", disks: [disk("8:0", "sda", 10)] }),
  sample(4, { unavailable: ["cpu", "load", "mem", "uptime", "disks", "nets", "psi", "filesystems", "gpu", "power"], block: blockOf(Array(16).fill(0), 0, 0, 0) }),
  sample(5, { uptimeMs: "5000", disks: [disk("8:0", "sda", 11)] })
]));
define("device-churn", "synthetic", batch([
  sample(1, { disks: [disk("8:0", "sda", 100), disk("259:0", "nvme0n1", 50)], nets: [net("eth0", 1000)], filesystems: [filesystem("/", "ext4", 500), filesystem("/data", "xfs", 700)] }),
  sample(2, { disks: [disk("259:0", "nvme0n1", 60)], nets: [net("eth0", 1100), net("wg0", 1)], filesystems: [filesystem("/", "ext4", 400)] }),
  sample(3, { disks: [disk("8:0", "sdb", 5), disk("259:0", "nvme0n1", 70)], nets: [net("wg0", 2)], filesystems: [filesystem("/", "ext4", 300), filesystem("/data", "btrfs", 900)] }),
  sample(4, { disks: [disk("8:0", "sdb", 6, false), disk("259:0", "nvme0n1", 80)], nets: [net("eth0", 1200), net("wg0", 3)], filesystems: [filesystem("/data", "btrfs", 800), filesystem("/", "ext4", 200)] })
]));
const wide = (seq, generation) => sample(seq, {
  disks: Array.from({ length: 16 }, (_, index) => disk(`${8 + generation}:${index * 16}`, `sd${generation}x${index}`, 1000 * (index + 1) + seq)),
  nets: Array.from({ length: 16 }, (_, index) => net(`veth${generation}n${index}`, 5000 * (index + 1) + seq)),
  filesystems: Array.from({ length: 16 }, (_, index) => filesystem(`/srv/volume-${generation}-${String(index).padStart(2, "0")}`, "ext4", 1_000_000 + seq))
});
define("device-union", "synthetic", batch([wide(1, 0), wide(2, 1), wide(3, 2), wide(4, 3), wide(5, 0)]), { workload: "device-union" });
define("high-cardinality-16", "synthetic", batch(Array.from({ length: 16 }, (_, index) => wide(index + 1, index % 3))), { budget: 14_400, workload: "high-cardinality-16" });
const histogram = Array.from({ length: 16 }, (_, index) => index + 1);
define("block-histogram", "boundary", batch([
  sample(1, { block: blockOf(histogram, 10_000_000, 1, 9_000_000) }),
  sample(2, { block: blockOf(Array(16).fill(0), 0, 0, 0) }),
  sample(3, { block: blockOf([...Array(15).fill(0), U64_MAX], U64_MAX, 7_000_000, U64_MAX) }),
  sample(4, { block: blockOf(histogram, 10, 1, 9, 135n) }),
  sample(5, { block: blockOf(Array(16).fill(0), 1, 0, 0) }),
  sample(6, { block: blockOf(histogram, 100, 50, 40) }),
  sample(7, { block: blockOf(histogram, 100, 10, 200) })
]), { samples: ["accept", "accept", "accept", "invalid_sample", "invalid_sample", "invalid_sample", "invalid_sample"] });
define("gpu-power", "synthetic", batch([
  sample(1, { gpu: { active: "100", total: "1000" }, power: { gpuNj: "5000" } }),
  sample(2, { gpu: { active: "150", total: "2000" }, power: { gpuNj: "6000", systemMwSum: "25000", systemReadings: "1" } }),
  sample(3, { gpu: { active: "150", total: "3000" }, power: { gpuNj: "7000", systemMwSum: "25000", systemReadings: "1" } }),
  sample(4, { unavailable: ["gpu"], power: { systemMwSum: "50000", systemReadings: "2" } }),
  sample(5, { gpu: { active: "10", total: "20" }, power: { systemMwSum: "50000", systemReadings: "2" } })
]));
const withoutDrops = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "txDrops"));
define("swap-and-optional-counters", "synthetic", batch([
  sample(1, { cpu: { user: "10", system: "5", idle: "80", total: "95" }, mem: { total: "100", available: "50", swapTotal: "10", swapFree: "10" }, nets: [withoutDrops(net("en0", 10))] }),
  sample(2, { cpu: { user: "11", system: "5", idle: "81", iowait: "1", steal: "0", total: "98" }, mem: { total: "100", available: "40", swapTotal: "10", swapFree: "9", swapIn: "4096", swapOut: "8192", pressure: "warn" }, nets: [net("en0", 11)] }),
  sample(3, { cpu: { user: "12", system: "6", idle: "82", iowait: "1", steal: "0", total: "101" }, mem: { total: "100", available: "30", swapTotal: "10", swapFree: "8", swapIn: "8192", swapOut: "8192", pressure: "critical" }, nets: [net("en0", 12)] }),
  sample(4, { cpu: { user: "13", system: "6", idle: "83", iowait: "1", steal: "0", total: "103" }, mem: { total: "100", available: "30", swapTotal: "10", swapFree: "8", swapIn: "0", swapOut: "8192", pressure: "normal" }, nets: [net("en0", 13)] })
]));
define("partial-acceptance", "synthetic", batch([
  sample(1, { cpu: cpu(1000), cpuCount: 0 }),
  sample(2, { cpu: cpu(1010), cpuCount: 8 }),
  { seq: String(SAFE + 1n), atMs: String(AT), monoMs: "3000", cpu: cpu(1020) },
  sample(4, { cpu: cpu(1030) })
]), { samples: ["invalid_sample", "accept", "invalid_sample", "accept"] });
define("semantic-rejects", "boundary", batch([
  sample(1, {}),
  sample(2, { unavailable: ["cpu", "mem"] }),
  sample(3, { cpuCount: 8 }),
  sample(4, { cpu: cpu(1), cpuCount: 4097 }),
  sample(5, { load: { one: "0.000", five: "0.000", fifteen: "1000000.000" } }),
  sample(6, { psi: { io: { some10: "1000000.00", some60: "0.00", some300: "0.00", total: "1" } } }),
  { seq: "7", atMs: String(SAFE + 1n), monoMs: "7000", cpu: cpu(1) },
  { seq: "8", atMs: String(AT), monoMs: String(SAFE + 1n), cpu: cpu(1) }
]), { samples: Array(8).fill("invalid_sample") });
const [first, second] = full.samples;
const earlier = advance(first, 0, random(7), 7);
const reversed = { ...earlier, disks: [...earlier.disks].reverse(), nets: [...earlier.nets].reverse(), filesystems: [...earlier.filesystems].reverse() };
define("rebatch-second-alone", "fixture-derived", batch([second]));
define("rebatch-second-after-other", "synthetic", batch([earlier, second]));
define("rebatch-other-dictionary-order", "synthetic", batch([reversed, second]));
define("conflict", "synthetic", batch([{ ...clone(second), cpu: { ...second.cpu, user: add(second.cpu.user, 1), total: add(second.cpu.total, 1) } }]));

for (const seed of [11, 23, 47, 89, 131, 257]) {
  const next = random(seed);
  const count = 1 + Math.floor(next() * 16);
  const pool = ["eth0", "eth1", "wlan0", "tailscale0", "docker0", "br-1", "veth1a", "veth2b"];
  const samples = [];
  let mono = 1_000_000n + BigInt(Math.floor(next() * 1e6));
  const start = mono;
  const counters = new Map();
  const counter = (key, reset) => {
    const base = counters.get(key) ?? BigInt(Math.floor(next() * 2 ** 40)) * (next() < 0.1 ? 1n << 20n : 1n);
    const value = reset ? BigInt(Math.floor(next() * 100)) : base + BigInt(Math.floor(next() * 5000));
    counters.set(key, value > U64_MAX ? U64_MAX : value);
    return String(counters.get(key));
  };
  for (let index = 0; index < count; index += 1) {
    mono += 15_000n + BigInt(Math.floor((next() - 0.5) * 2000));
    const reset = next() < 0.08;
    const value = { seq: String(mono / 1000n), atMs: String(AT - 3_600_000n + (mono - start) + BigInt(Math.floor((next() - 0.5) * 120_000))), monoMs: String(mono) };
    const unavailable = [];
    if (next() < 0.85) value.cpu = { user: counter("u", reset), system: counter("s", reset), idle: counter("i", reset), ...(next() < 0.7 ? { iowait: counter("w", reset), steal: counter("t", reset) } : {}), total: counter("T", reset) };
    else if (next() < 0.5) unavailable.push("cpu");
    if (next() < 0.8) value.load = { one: fixed(Math.floor(next() * 64_000), 3), five: fixed(Math.floor(next() * 64_000), 3), fifteen: fixed(Math.floor(next() * 64_000), 3) };
    if (next() < 0.8) value.mem = { total: "17179869184", available: String(Math.floor(next() * 17179869184)), swapTotal: "0", swapFree: "0", ...(next() < 0.6 ? { swapIn: counter("si", reset), swapOut: counter("so", reset) } : {}), ...(next() < 0.3 ? { pressure: ["normal", "warn", "critical"][Math.floor(next() * 3)] } : {}) };
    if (next() < 0.8) value.uptimeMs = String(mono);
    if (next() < 0.7) value.cpuCount = 1 + Math.floor(next() * 64);
    if (next() < 0.75) {
      const names = pool.filter(() => next() < 0.5);
      value.nets = names.map(name => ({ id: name, rxBytes: counter(`${name}rb`, reset), rxPackets: counter(`${name}rp`, reset), rxDrops: counter(`${name}rd`, false), rxErrors: "0", txBytes: counter(`${name}tb`, reset), txPackets: counter(`${name}tp`, reset), txErrors: "0", ...(next() < 0.8 ? { txDrops: counter(`${name}td`, false) } : {}) }));
    } else if (next() < 0.5) unavailable.push("nets");
    if (next() < 0.7) {
      const disks = [["8:0", "sda"], ["8:16", next() < 0.2 ? "sdz" : "sdb"], ["259:0", "nvme0n1"], ["253:1", "dm-1"]].filter(() => next() < 0.6);
      value.disks = disks.map(([id, name]) => ({ id, name, reads: counter(`${id}r`, reset), readSectors: counter(`${id}rs`, reset), writes: counter(`${id}w`, reset), writeSectors: counter(`${id}ws`, reset), ...(next() < 0.8 ? { ioMs: counter(`${id}io`, reset) } : {}) }));
    }
    if (next() < 0.6) {
      const group = () => ({ some10: fixed(Math.floor(next() * 10_000), 2), some60: fixed(Math.floor(next() * 10_000), 2), some300: fixed(Math.floor(next() * 10_000), 2), total: counter(`p${index % 2}`, reset), ...(next() < 0.5 ? { full10: "0.00", full60: fixed(Math.floor(next() * 100), 2), full300: "0.01", fullTotal: counter(`pf${index % 2}`, reset) } : {}) });
      const psi = {};
      for (const resource of ["cpu", "memory", "io"]) if (next() < 0.6) psi[resource] = group();
      if (Object.keys(psi).length > 0) value.psi = psi;
    }
    if (next() < 0.6) value.filesystems = ["/", "/home", "/var/lib/docker", "/mnt/media disk"].filter(() => next() < 0.6).map(id => filesystem(id, next() < 0.9 ? "ext4" : "xfs", Math.floor(next() * 1e9)));
    if (next() < 0.3) {
      const buckets = Array.from({ length: 16 }, () => Math.floor(next() * 10));
      const total = buckets.reduce((sum, item) => sum + item, 0);
      value.block = total === 0 ? blockOf(buckets, 0, 0, 0) : blockOf(buckets, total * 900, 50, 5000);
    }
    if (next() < 0.4) value.gpu = { active: counter("ga", reset), total: counter("gt", reset) };
    if (next() < 0.4) value.power = next() < 0.5 ? { gpuNj: counter("gn", reset) } : { gpuNj: counter("gn", reset), systemMwSum: counter("pm", reset), systemReadings: counter("pr", reset) };
    if (unavailable.length > 0) value.unavailable = unavailable;
    if (value.cpu === undefined && value.load === undefined && value.mem === undefined && value.uptimeMs === undefined && value.disks === undefined && value.nets === undefined && value.psi === undefined && value.filesystems === undefined && value.block === undefined && value.gpu === undefined && value.power === undefined) value.uptimeMs = String(mono);
    samples.push(value);
  }
  define(`random-${String(seed).padStart(3, "0")}`, "synthetic", batch(samples, next() < 0.3 ? { system } : {}));
}

const LATER_WORKLOADS = { presence: "missing-groups", "u64-boundaries": "large-counters" };
const manifest = { version: 2, batches: cases.map(({ value, ...entry }) => ({ ...entry, ...(LATER_WORKLOADS[entry.name] === undefined ? {} : { workload: LATER_WORKLOADS[entry.name] }), source: `sources/${entry.name}.json`, frame: `frames/${entry.name}.stb2` })) };
const files = new Map(cases.map(entry => [`sources/${entry.name}.json`, `${JSON.stringify(entry.value, null, 2)}\n`]));
files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

let stale = 0;
mkdirSync(join(out, "sources"), { recursive: true });
for (const [relative, text] of files) {
  const path = join(out, relative);
  let current = null;
  try { current = readFileSync(path, "utf8"); } catch {}
  if (current === text) continue;
  if (mode === "--write") writeFileSync(path, text);
  else { console.error(`${relative}: differs from the generator`); stale += 1; }
}
for (const name of readdirSync(join(out, "sources"))) {
  if (!files.has(`sources/${name}`)) { console.error(`sources/${name}: not produced by the generator`); stale += 1; }
}
if (stale > 0) process.exit(1);
console.log(`fixture sources: ${cases.length} batches ${mode === "--write" ? "written" : "current"}`);
