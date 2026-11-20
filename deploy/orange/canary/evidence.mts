import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OBSERVE_OUTPUT, STATS_OUTPUT } from "../../../cloudflare/local/topology.ts";
import { generate } from "../generate.mts";
import { freePort, startSession } from "../session.mts";
import type { Stack } from "./stack.mts";
import { workload } from "./workload.mts";

const root = resolve(import.meta.dirname, "../../..");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const checkpoint = (d: Delivery) => ({ startedAtMs: d.startedAtMs, atMs: d.atMs, accepted: d.accepted, dropped: d.dropped, queued: d.queued });
type Delivery = { id: string; sequence: number; startedAtMs: number; atMs: number; accepted: number; dropped: number; queued: number };
type Row = { event: { release: string; delivery?: Delivery } };

export async function observe(stack: Stack, from: number) {
  const response = await fetch(`${stack.origin}/api/observe/stats/external?from=${from}&to=${Date.now() + 1000}`, { headers: stack.headers });
  const checkedAtMs = Date.now();
  if (!response.ok) throw new Error(`observation ${response.status}: ${await response.text()}`);
  const body = await response.json() as { events: Row[]; truncated?: boolean };
  return { rows: body.events, checkedAtMs, truncated: body.truncated === true };
}
export async function waitCheckpoint(stack: Stack, from: number, after: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await observe(stack, from);
    if (result.rows.some(row => row.event.delivery && row.event.delivery.queued === 0 && row.event.delivery.atMs >= after)) return result;
    await sleep(300);
  }
  throw new Error(`no delivery checkpoint for ${stack.release}`);
}
export function source(rows: Row[], release: string, start: number, end: number) {
  const deliveries = rows.filter(row => row.event.release === release && row.event.delivery !== undefined).map(row => row.event.delivery!).sort((a, b) => a.sequence - b.sequence);
  const ids = new Set(deliveries.map(d => d.id));
  if (ids.size !== 1) throw new Error(`expected one producer session for ${release}, got ${ids.size}`);
  const first = deliveries.filter(d => d.atMs < start && d.queued === 0).at(-1);
  const last = deliveries.filter(d => d.atMs >= end && d.queued === 0).at(-1);
  if (!first || !last) throw new Error(`missing delivery boundary for ${release}`);
  const received = new Set(deliveries.filter(d => d.sequence > first.accepted && d.sequence <= last.accepted).map(d => d.sequence)).size;
  return { source: "stats", producer: "stats-self", releaseId: release, lastSeenMs: last.atMs, sequenceStart: checkpoint(first), sequenceEnd: checkpoint(last), received };
}
export function resources(stack: Stack) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/u));
  const pids = new Set([stack.session.child.pid!]);
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (pids.has(Number(row[1])) && !pids.has(Number(row[0]))) { pids.add(Number(row[0])); changed = true; } }
  let cpuSeconds = 0, memoryPeakBytes = 0;
  for (const row of rows) if (pids.has(Number(row[0]))) { memoryPeakBytes += Number(row[2]) * 1024; const parts = row[3]!.split(":").map(Number); cpuSeconds += parts.reduce((a, b) => a * 60 + b, 0); }
  if (!cpuSeconds || !memoryPeakBytes) throw new Error("process resources unavailable");
  return { cpuSeconds, memoryPeakBytes, restarts: 0 };
}
export function monitorResources(stack: Stack) {
  let latest = resources(stack);
  let peak = latest.memoryPeakBytes;
  const sample = () => { latest = resources(stack); peak = Math.max(peak, latest.memoryPeakBytes); };
  const timer = setInterval(sample, 250);
  timer.unref();
  return () => { clearInterval(timer); sample(); return { ...latest, memoryPeakBytes: peak }; };
}
export async function recover(candidate: Stack, baseline: Stack, directory: string, result: { historyPath: string; historyBytes: Uint8Array; eventReadPath: string; event: unknown }) {
  await candidate.stop();
  cpSync(candidate.stateDir, directory, { recursive: true });
  generate(directory, { kind: "dev", release: baseline.release, gatewaySecret: baseline.headers["X-Stats-Gateway-Secret"] ?? Object.values(baseline.headers)[0]!, nowMs: null });
  const session = await startSession(directory, await freePort());
  try {
    const history = await fetch(session.origin + result.historyPath, { headers: { ...baseline.headers, "accept-encoding": "identity" } });
    const bytes = new Uint8Array(await history.arrayBuffer());
    const events = await fetch(session.origin + result.eventReadPath, { headers: baseline.headers });
    const body = await events.json() as { events: { event: unknown }[] };
    return { method: "state-copy", verifiedAtMs: Date.now(), previousRelease: baseline.release, readbackVerified: history.status === 200 && Buffer.from(bytes).equals(result.historyBytes) && events.status === 200 && JSON.stringify(body.events[0]?.event) === JSON.stringify(result.event) };
  } finally { await session.stop(); }
}
export function writeBundle(directory: string, baseline: Stack, candidate: Stack, ledgers: { baseline: any; candidate: any }, observations: { baseline: any; candidate: any }, recovery: unknown, start: number, end: number) {
  mkdirSync(directory, { recursive: true });
  const write = (name: string, value: unknown) => { const text = `${JSON.stringify(value, null, 2)}\n`; writeFileSync(join(directory, name), text); return text; };
  const components = Object.fromEntries([["orange-package", join(root, "deploy/orange/package.json")], ["orange-lock", join(root, "deploy/orange/pnpm-lock.yaml")], ["workspace-lock", join(root, "pnpm-lock.yaml")], ["stats-bundle", join(STATS_OUTPUT, "bundle/index.js")], ["observe-bundle", join(OBSERVE_OUTPUT, "bundle/index.js")]].map(([name, path]) => [name, hash(readFileSync(path!))]));
  const workloadBytes = write("workload.json", workload);
  write("baseline.manifest.json", { releaseId: baseline.release, components });
  write("candidate.manifest.json", { releaseId: candidate.release, components });
  write("policy.json", { schema: "stats-release-policy/1", id: "local-canary", baselineRelease: baseline.release, candidateRelease: candidate.release, workloadId: workload.id, workloadSha256: hash(workloadBytes), requiredSources: [{ source: "stats", producer: "stats-self" }], windows: { startMs: start, warmupMs: 0, measureMs: end - start }, minRequests: 1, maxEvidenceAgeMs: 300_000, limits: { maxErrorShare: 0, latency: { p95Ms: 1e9, p99Ms: 1e9, maxRelativeIncreasePercent: 1e9, absoluteFloorMs: 1e9 }, maxCpuRelativeIncreasePercent: 1e9, maxMemoryRelativeIncreasePercent: 1e9, maxRestarts: 0, maxQueueDepth: 0 }, histogramMaxRelativeError: 0.01, recovery: { required: true, method: "state-copy" } });
  for (const ledger of Object.values(ledgers)) { ledger.windowStartMs = start; ledger.windowEndMs = end; }
  write("ledger.json", { schema: "stats-release-evidence/1", ...ledgers });
  write("observations.json", { schema: "stats-release-evidence/1", ...observations });
  write("recovery.json", recovery);
  const command = spawnSync("pnpm", ["--dir", "cloudflare", "-s", "statsctl", "verify", "release", "--evidence", directory, "--json"], { cwd: root, encoding: "utf8" });
  if (![0, 5, 6, 7].includes(command.status ?? -1)) throw new Error(`verify failed ${command.status}: ${command.stderr} ${command.stdout}`);
  const decision = JSON.parse(command.stdout).payload;
  write("decision.json", { evaluatedAtMs: decision.evaluatedAtMs, verdict: decision.verdict, reasonCodes: decision.reasons.map((r: {code: string}) => r.code) });
  return { decision, status: command.status };
}
