import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

export const root = fileURLToPath(new URL("../../..", import.meta.url));
export function captures() {
  const directory = join(root, "cloudflare/test/ui/captures");
  const result = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.json$/u.test(entry.name)) {
        const value = JSON.parse(readFileSync(file, "utf8"));
        if (value !== null && typeof value === "object" && typeof value.kind === "string") result.push({ name: relative(root, file), value });
      }
    }
  }
  visit(directory);
  return result;
}

export function histories(count = 240) {
  const start = 1793510400000;
  const base = { hostId: "h_0123456789abcdef0123456789abcdef", fromMs: start, toMs: start + count * 15000, stepMs: 15000, resolution: "raw" };
  const times = Array.from({ length: count }, (_, index) => start + index * 15000);
  const summary = { ...base, kind: "summary", points: times.map((atMs, index) => ({
    atMs, coverageMs: index === 0 ? 0 : 15000, partial: index % 37 === 0, cpuCount: 32, uptimeMs: index < 50 ? 900000 + index * 15000 : (index - 50) * 15000,
    ...(index % 19 === 0 ? {} : { cpu: { user: (index % 100) / 3, system: 3.123, idle: 60.125, ...(index % 2 === 0 ? { iowait: 0, steal: 0 } : {}) } }),
    load: { one: (index % 37) / 1000, five: 1.234, fifteen: 0 },
    mem: { total: 68719476736, available: 34359738368 - index * 65536, swapUsed: 0, ...(index % 5 === 0 ? { swapInBytesPerSec: 0, swapOutBytesPerSec: 1.125 } : {}), ...(index % 3 === 0 ? { pressure: { warnPct: 0, criticalPct: 0 } } : {}) },
    ...(index % 2 === 0 ? { psi: { cpu: { some10: 0, some60: 1.25, some300: 0.05 } } } : { psi: {} }),
    ...(index % 7 === 0 ? { gpu: { busyPct: 0.125 }, power: { gpuWatts: 1.125, systemWatts: 32.75 } } : {})
  })) };
  const disks = { ...base, kind: "disks", series: ["259:0", "8:0"].map((id, device) => ({ id, name: device ? "sda" : "nvme0n1", points: times.filter((_, index) => device === 0 || index % 17 !== 0).map((atMs, index) => ({ atMs, readBytesPerSec: index * 512.125, writeBytesPerSec: 0, readsPerSec: index / 15, writesPerSec: 0, ...(device === 0 ? { busyPct: index % 120 } : {}) })) })) };
  const nets = { ...base, kind: "nets", series: ["eth0", "tailscale0", "veth-churn"].map((id, device) => ({ id, points: times.filter((_, index) => device !== 2 || index % 13 < 3).map((atMs, index) => ({ atMs, rxBytesPerSec: index * 1.125, txBytesPerSec: 0, rxPacketsPerSec: index / 15, txPacketsPerSec: 0, rxDropsPerSec: 0, rxErrorsPerSec: 0, txErrorsPerSec: 0, ...(device === 0 ? { txDropsPerSec: 0 } : {}) })) })) };
  const filesystems = { ...base, kind: "filesystems", series: [{ id: "/", points: times.map(atMs => ({ atMs, total: 1099511627776, available: 987654321000 })) }] };
  const block = { ...base, kind: "block", series: [{ id: "block", points: times.filter((_, index) => index % 2 === 0).map(atMs => ({ atMs, count: 110, totalUs: 600000, minUs: 1500, maxUs: 45000, p50Us: 10000, p95Us: 50000, p99Us: 50000 })) }] };
  const project = { projectId: "stuff", range: "1h", kind: "worker", fromMs: start, toMs: base.toMs, stepMs: 300000, series: ["worker.invocations", "worker.cpuMsSum"].map(metric => ({ metric, values: times.map((_, index) => index % 13 === 0 ? null : index % 3 === 0 ? 0 : index * 1.234) })) };
  return { summary, disks, nets, filesystems, block, project };
}

export function syntheticCases() {
  return [240, 900].flatMap(count => {
    const data = histories(count);
    const { project, ...host } = data;
    return [
      { name: `synthetic/summary-${count}`, value: data.summary },
      { name: `synthetic/host-bundle-${count}`, value: { hostId: data.summary.hostId, histories: host } },
      { name: `synthetic/project-${count}`, value: project }
    ];
  });
}
