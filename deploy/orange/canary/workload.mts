import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { encodeFrame } from "../../../cloudflare/src/ingest/encode.ts";
import { decodeAck } from "../../../cloudflare/src/ingest/ack-decode.ts";
import { INGEST_MEDIA_TYPE, INGEST_PATH } from "../../../cloudflare/src/ingest/http.ts";
import { acknowledgedSamples, compareHistory, expectedHistory, type Sample } from "./history.mts";
import { fixtureSource, manifest } from "../../../cloudflare/test/node/support.ts";
import type { Stack } from "./stack.mts";
import { startHealthFixture } from "../../../cloudflare/test/support/health-fixture.ts";

const fixtures = new WeakMap<Stack, Promise<Awaited<ReturnType<typeof startHealthFixture>>>>();

export const spec = { id: "canary-v1", seed: 43829, requestMix: { hostIngest: 1, hostReplay: 1, history: 1, eventIngest: 1, eventReplay: 1, eventConflict: 1, eventRead: 1, capabilities: 1, hosts: 1, services: 1 }, concurrency: 1, payloadSizes: [128] };
export function corpus() {
  let value = spec.seed;
  const data = Array.from({ length: spec.payloadSizes[0]! }, () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value & 255; });
  return Buffer.from(data);
}
export const workload = { ...spec, corpusSha256: createHash("sha256").update(corpus()).digest("hex") };

export async function prepare(stack: Stack, suffix = "") {
  const serviceName = `canary${suffix}`;
  let fixture = fixtures.get(stack);
  if (fixture === undefined) {
    fixture = startHealthFixture(stack.session !== undefined && "containerName" in stack.session ? stack.session.containerName : undefined);
    fixtures.set(stack, fixture);
    if (typeof stack.stop === "function") {
      const stop = stack.stop;
      let closed = false;
      stack.stop = async () => { if (closed) return; closed = true; try { await (await fixture!).close(); } finally { await stop(); } };
    }
  }
  const post = (path: string, body: unknown) => fetch(stack.origin + path, { method: "POST", headers: { ...stack.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const hostResponse = await post("/api/v1/admin/hosts", { name: serviceName });
  if (hostResponse.status !== 201) throw new Error(`host setup: ${hostResponse.status} ${await hostResponse.text()}`);
  const host = await hostResponse.json() as { hostId: string; token: string };
  const serviceResponse = await post("/api/v1/admin/services", { name: serviceName, hostIds: [host.hostId], healthUrl: (await fixture).url(serviceName) });
  if (serviceResponse.status !== 201) throw new Error(`service setup: ${serviceResponse.status} ${await serviceResponse.text()}`);
  const service = await serviceResponse.json() as { ingestToken: string };
  return { host, service, serviceName };
}
export type Credentials = Awaited<ReturnType<typeof prepare>>;

export async function runWorkload(stack: Stack, credentials: Credentials, origin: string, iteration = 0) {
  const buckets = new Map<number, number>();
  const ledger = { releaseId: stack.release, workloadId: spec.id, attempted: 0, succeeded: 0, failures: {} as Record<string, number>, bodyMismatches: 0, acknowledgedWrites: 0, readbackVerified: 0, lostWrites: 0, duplicateMismatches: 0, history: { samples: [] as { host: string; boot: string; sample: Sample }[], phases: [] as { phase: string; expected: number; verified: number; missing: number; mismatched: number }[] }, histogram: { relativeError: 0.01, buckets: [] as [number, number][] }, windowStartMs: 0, windowEndMs: 0, truncated: false };
  const call = async (path: string, init: RequestInit, status: number, validate: (body: Uint8Array) => boolean) => {
    const start = performance.now();
    ledger.attempted++;
    try {
      const response = await fetch(origin + path, init);
      const body = new Uint8Array(await response.arrayBuffer());
      if (response.status !== status) { const key = `http-${response.status}`; ledger.failures[key] = (ledger.failures[key] ?? 0) + 1; return false; }
      ledger.succeeded++;
      let valid = false;
      try { valid = validate(body); } catch { valid = false; }
      if (!valid) ledger.bodyMismatches++;
      return valid;
    } catch { ledger.failures.network = (ledger.failures.network ?? 0) + 1; return false; }
    finally { const us = Math.max(1, Math.ceil((performance.now() - start) * 1000)); const upper = Math.max(us, Math.floor(1.009 ** Math.ceil(Math.log(us) / Math.log(1.009)))); buckets.set(upper, (buckets.get(upper) ?? 0) + 1); }
  };
  const json = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value));
  const { host, service, serviceName } = credentials;
  const fixture = manifest.batches.find(entry => entry.name === "linux-normal")!;
  const original = fixtureSource(fixture.source);
  const now = Date.now();
  const samples: Sample[] = [
    { atMs: String(now - 500), monoMs: "100000", seq: "100", cpuCount: 2, uptimeMs: "100000", cpu: { user: "10", system: "20", idle: "70", total: "100" } },
    { atMs: String(now - 250), monoMs: "115000", seq: "115", cpuCount: 2, uptimeMs: "115000", cpu: { user: "30", system: "50", idle: "120", total: "200" } }
  ];
  const source = { ...original, bootId: randomUUID(), samples };
  const frame = encodeFrame({ ...source, hostId: host.hostId });
  const seqs = source.samples.map(sample => BigInt(String(sample.seq)));
  const ingest = { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: frame };
  const ack = (bytes: Uint8Array, accepted: number, duplicates: number) => { const result = decodeAck(bytes, seqs); return result.accepted === accepted && result.duplicates === duplicates && result.rejected.length === 0; };
  let acknowledged: Sample[] = [];
  await call(INGEST_PATH, ingest, 200, b => {
    const result = decodeAck(b, seqs);
    acknowledged = acknowledgedSamples(samples, result.rejected);
    return result.accepted === seqs.length && result.duplicates === 0 && result.rejected.length === 0;
  });
  if (acknowledged.length > 0) { ledger.acknowledgedWrites++; ledger.history.samples = acknowledged.map(sample => ({ host: host.hostId, boot: source.bootId, sample })); }
  if (!await call(INGEST_PATH, ingest, 200, b => ack(b, 0, seqs.length))) ledger.duplicateMismatches++;
  let historyBytes = new Uint8Array();
  const historyPath = `/api/v1/hosts/${host.hostId}/history?from=${now - 600}&to=${now}&kind=summary`;
  const historyOk = await call(historyPath, { headers: { ...stack.headers, "accept-encoding": "identity" } }, 200, b => { historyBytes = b; const phase = compareHistory(b, host.hostId, expectedHistory(acknowledged), "before"); ledger.history.phases.push(phase); return phase.missing === 0 && phase.mismatched === 0; });
  if (acknowledged.length > 0) historyOk ? ledger.readbackVerified++ : ledger.lostWrites++;
  const event = { schemaVersion: 1, eventId: `canary-${spec.seed}-${iteration}`, atMs: now - 1, operation: "canary.run", outcome: "ok", durationMs: 1, work: { bytes: corpus().length, checksum: corpus().readUInt32BE(0) }, release: stack.release, service: serviceName };
  const eventPath = `/ingest/observe/v1/${serviceName}/batches`;
  const eventInit = (e: unknown) => ({ method: "POST", headers: { Authorization: `Bearer ${service.ingestToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ events: [e] }) });
  const eventAck = await call(eventPath, eventInit(event), 202, b => isDeepStrictEqual(json(b), { accepted: 1, duplicate: 0 }));
  if (eventAck) ledger.acknowledgedWrites++;
  if (!await call(eventPath, eventInit(event), 200, b => isDeepStrictEqual(json(b), { accepted: 0, duplicate: 1 }))) ledger.duplicateMismatches++;
  if (!await call(eventPath, eventInit({ ...event, durationMs: 2 }), 409, b => JSON.stringify(json(b)).includes("event_conflict"))) ledger.duplicateMismatches++;
  const eventReadPath = `/api/observe/${serviceName}/external?from=${now - 600}&to=${now + 600}`;
  const eventOk = await call(eventReadPath, { headers: stack.headers }, 200, b => { const rows = json(b).events; return Array.isArray(rows) && rows.length === 1 && isDeepStrictEqual(rows[0].event, event); });
  if (eventAck) eventOk ? ledger.readbackVerified++ : ledger.lostWrites++;
  await call("/api/v1/capabilities", { headers: stack.headers }, 200, b => isDeepStrictEqual(json(b), { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true, infraMetrics: stack.infraEnabled }));
  await call("/api/v1/hosts", { headers: stack.headers }, 200, b => json(b).hosts.some((h: {hostId: string}) => h.hostId === host.hostId));
  await call("/api/v1/services", { headers: stack.headers }, 200, b => json(b).services.some((s: {name: string}) => s.name === serviceName));
  ledger.histogram.buckets = [...buckets].sort((a, b) => a[0] - b[0]);
  const result = { ledger, historyPath, historyBytes, eventReadPath, event, hostId: host.hostId, samples: acknowledged };
  stack.historyRuns.push(result);
  return result;
}
