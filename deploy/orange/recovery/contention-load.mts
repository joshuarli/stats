import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from "../../../cloudflare/src/cloudflare/gateway.ts";
import { INGEST_MEDIA_TYPE, INGEST_PATH } from "../../../cloudflare/src/ingest/http.ts";
import { HostSeries } from "../../../cloudflare/test/support/service-data.ts";
import { startHealthFixture } from "../../../cloudflare/test/support/health-fixture.ts";

const usage = `usage: node --experimental-strip-types contention-load.mts --origin URL --gateway-secret-file FILE [--hosts N] [--services N] [--interval-ms MS] [--host-interval-ms MS] [--events N] [--duration-s S] [--prefix NAME]

Creates hosts and services on an isolated Stats origin, then posts one event batch per service every
interval and one agent frame per host every host interval (the server admits six per host per minute). Prints one JSON line per second: request counts by kind and
status, and p50/p99/max latency. Never point it at production; it creates hosts and services.
`;

const { values } = parseArgs({ options: {
  origin: { type: "string" }, "gateway-secret-file": { type: "string" }, hosts: { type: "string", default: "6" }, services: { type: "string", default: "14" },
  "interval-ms": { type: "string", default: "5000" }, "host-interval-ms": { type: "string", default: "10000" }, events: { type: "string", default: "20" }, "duration-s": { type: "string", default: "600" }, prefix: { type: "string", default: "load" }, help: { type: "boolean" }
} });
if (values.help || values.origin === undefined || values["gateway-secret-file"] === undefined) { process.stdout.write(usage); process.exit(values.help ? 0 : 2); }
const origin = values.origin.replace(/\/$/u, "");
const gateway = { [GATEWAY_SECRET_HEADER]: readFileSync(values["gateway-secret-file"], "utf8").trim(), [GATEWAY_IDENTITY_HEADER]: "user:contention-drill@example.com" };
const count = (name: string) => { const value = Number(values[name as keyof typeof values]); if (!Number.isSafeInteger(value) || value < 0) { process.stderr.write(`--${name} must be a non-negative integer\n`); process.exit(2); } return value; };
const hostCount = count("hosts"), serviceCount = count("services"), intervalMs = count("interval-ms"), hostIntervalMs = count("host-interval-ms"), eventsPerBatch = count("events"), durationS = count("duration-s");

async function admin(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(origin + path, { method: "POST", headers: { ...gateway, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status !== 201) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return await response.json() as Record<string, unknown>;
}

const run = `${values.prefix}-${Date.now().toString(36)}`;
const hosts = [];
for (let index = 0; index < hostCount; index++) {
  const created = await admin("/api/v1/admin/hosts", { name: `${run}-h${index}` });
  hosts.push({ hostId: String(created["hostId"]), token: String(created["token"]), series: new HostSeries(String(created["hostId"])), cpuPercent: 10 + 7 * index });
}
const services = [];
const health = await startHealthFixture();
for (let index = 0; index < serviceCount; index++) {
  const name = `${run}-s${index}`.slice(0, 32);
  const created = await admin("/api/v1/admin/services", { name, hostIds: hostCount === 0 ? [] : [hosts[index % hostCount]!.hostId], healthUrl: health.url(name) });
  services.push({ name, token: String(created["ingestToken"]), next: 0 });
}

interface Bucket { readonly counts: Record<string, number>; readonly latencies: number[] }
let bucket: Bucket = { counts: {}, latencies: [] };
async function timed(kind: string, request: () => Promise<Response>): Promise<void> {
  const started = performance.now();
  let key: string;
  try { const response = await request(); await response.arrayBuffer(); key = `${kind}:${response.status}`; }
  catch (error) { key = `${kind}:${error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error"}`; }
  bucket.counts[key] = (bucket.counts[key] ?? 0) + 1;
  bucket.latencies.push(performance.now() - started);
}
const quantile = (sorted: readonly number[], q: number) => sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
const reporter = setInterval(() => {
  const done = bucket;
  bucket = { counts: {}, latencies: [] };
  const sorted = [...done.latencies].sort((left, right) => left - right);
  process.stdout.write(JSON.stringify({ atMs: Date.now(), counts: done.counts, p50Ms: quantile(sorted, 0.5), p99Ms: quantile(sorted, 0.99), maxMs: quantile(sorted, 1) }) + "\n");
}, 1000);

const deadline = Date.now() + durationS * 1000;
const stopAt = new Promise<void>(done => { for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => done()); setTimeout(done, durationS * 1000); });
let hostsDueAt = 0;
const loop = (async () => {
  while (Date.now() < deadline) {
    const started = Date.now();
    const hostsDue = started >= hostsDueAt;
    if (hostsDue) hostsDueAt = started + hostIntervalMs;
    const requests = [
      ...(hostsDue ? hosts : []).map(host => timed("ingest", () => fetch(origin + INGEST_PATH, { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: host.series.sampleFrame(started, { cpuPercent: host.cpuPercent, memoryUsedPercent: 40, netBytesPerSec: 1_000_000, diskBytesPerSec: 500_000, cpuPressure: 1 }), signal: AbortSignal.timeout(30_000) }))),
      ...services.map(service => timed("events", () => {
        const events = Array.from({ length: eventsPerBatch }, () => ({ schemaVersion: 1, eventId: `${service.name}-${service.next++}`, atMs: Date.now(), operation: "drill.op", outcome: "ok", durationMs: 3, work: { rows: 1 }, release: "drill", service: service.name }));
        return fetch(`${origin}/ingest/observe/v1/${service.name}/batches`, { method: "POST", headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ events }), signal: AbortSignal.timeout(30_000) });
      })),
      timed("read", () => fetch(`${origin}/api/v1/hosts`, { headers: gateway, signal: AbortSignal.timeout(30_000) }))
    ];
    await Promise.all(requests);
    await new Promise(done => setTimeout(done, Math.max(0, intervalMs - (Date.now() - started))));
  }
})();
await Promise.race([stopAt, loop]);
clearInterval(reporter);
await health.close();
process.exit(0);
