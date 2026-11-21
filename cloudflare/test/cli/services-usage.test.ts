import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeOrigin, runCli, sendJson } from "./support.ts";

const WEB = `h_${"a".repeat(32)}`;
const BATCH = `h_${"b".repeat(32)}`;
const service = (name: string, hostIds: string[]) => ({ name, hostIds, healthUrl: null, unit: null, createdAtMs: 1_700_000_000_000 });
const CPU: Record<string, Record<string, number>> = { [WEB]: { web: 0.5, cache: 0.1 }, [BATCH]: { batch: 2, cache: 0.3 } };

await test("services usage groups services under their hosts, busiest host first, on one CPU scale", async () => {
  const windows: { fromMs: number; toMs: number }[] = [];
  const origin = await fakeOrigin((request, response) => {
    const url = new URL(request.url ?? "/", "http://origin");
    if (url.pathname === "/api/v1/services") return sendJson(response, { services: [service("web", [WEB]), service("batch", [BATCH]), service("cache", [WEB, BATCH]), service("idle", [])] });
    if (url.pathname === "/api/v1/hosts") return sendJson(response, { hosts: [{ hostId: WEB, name: "web-1" }, { hostId: BATCH, name: "batch-1" }] });
    const hostId = /^\/api\/v1\/hosts\/(h_[0-9a-f]{32})\/services$/u.exec(url.pathname)?.[1];
    if (hostId === undefined) return sendJson(response, { error: { code: "not_found", message: url.pathname } }, 404);
    const fromMs = Number(url.searchParams.get("fromMs"));
    const toMs = Number(url.searchParams.get("toMs"));
    windows.push({ fromMs, toMs });
    const services = Object.entries(CPU[hostId] ?? {}).map(([name, cores]) => ({ name, points: [cores / 2, cores * 1.5].map((cpuCores, index) => ({ atMs: toMs - (2 - index) * 60_000, cpuCores, memoryBytes: 1_048_576, ioBytesPerSec: 0 })) }));
    return sendJson(response, { hostId, fromMs, toMs, stepMs: 60_000, resolution: "1m", services });
  });
  try {
    const run = await runCli(["services", "usage", "--window", "6h", "--origin", origin.origin, "--json"]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const { payload } = JSON.parse(run.stdout) as { payload: { window: string; hosts: { name: string; cpuMeanCores: number | null; memoryBytes: number | null; services: { service: string; reported: boolean; cpuMeanCores: number | null; cpuPeakCores: number | null; cpuShareOfBusiest: number | null }[] }[] } };
    assert.equal(payload.window, "6h");
    assert.deepEqual(windows.map(window => window.toMs - window.fromMs), [6 * 3_600_000, 6 * 3_600_000]);
    assert.deepEqual(payload.hosts.map(host => [host.name, host.cpuMeanCores === null ? null : Number(host.cpuMeanCores.toFixed(2)), host.memoryBytes]), [["batch-1", 2.3, 2_097_152], ["web-1", 0.6, 2_097_152], ["No host assigned", null, null]]);
    assert.deepEqual(payload.hosts[0]!.services.map(row => [row.service, row.cpuPeakCores === null ? null : Number(row.cpuPeakCores.toFixed(2)), row.cpuShareOfBusiest === null ? null : Number(row.cpuShareOfBusiest.toFixed(2))]), [["batch", 3, 1], ["cache", 0.45, 0.15]]);
    assert.deepEqual(payload.hosts[1]!.services.map(row => [row.service, row.cpuShareOfBusiest === null ? null : Number(row.cpuShareOfBusiest.toFixed(2))]), [["web", 0.25], ["cache", 0.05]]);
    assert.deepEqual(payload.hosts[2]!.services, [{ service: "idle", reported: false, cpuMeanCores: null, cpuPeakCores: null, memoryBytes: null, cpuShareOfBusiest: null }]);

    const text = await runCli(["services", "usage", "--origin", origin.origin]);
    assert.equal(text.code, 0, text.stderr);
    const lines = text.stdout.trimEnd().split("\n");
    assert.match(lines[0]!, /^services by host over 1h ending /u);
    assert.match(lines[2]!, /^batch-1\s+2 services\s+2\.30\s+2 MiB$/u);
    assert.match(lines[3]!, /^\s+batch\s+2\.00\s+3\.00\s+100%\s+1 MiB$/u);
    assert.match(lines.at(-1)!, /^\s+idle\s+no cgroup data$/u);
  } finally {
    await origin.close();
  }
});
