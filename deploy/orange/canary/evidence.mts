import { startContainerSession } from "./container.mts";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OBSERVE_OUTPUT, STATS_OUTPUT } from "../../../cloudflare/local/topology.ts";
import { generate } from "../generate.mts";
import { freePort, startSession } from "../session.mts";
import { appOutputs, type Stack } from "./stack.mts";
import { workload } from "./workload.mts";
import { compareHistory, expectedHistory, type Sample } from "./history.mts";

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
  return { source: "stats", producer: "stats-self", releaseId: release, lastSeenMs: last.atMs, sequenceStart: checkpoint(first), sequenceEnd: checkpoint(last), received, families: {} };
}
export function monitorResources(stack: Stack) {
  if (!("containerName" in stack.session) || !("metricsPort" in stack.session)) return () => ({ cpuSeconds: null, memoryPeakBytes: null, restarts: null });
  const { containerName, metricsPort, engineName } = stack.session;
  const script = `const fs=require("fs"); (async()=>{const cpu=Number(fs.readFileSync("/sys/fs/cgroup/cpu.stat","utf8").match(/usage_usec (\\d+)/)[1]);let memory=0;try{memory=Number(fs.readFileSync("/sys/fs/cgroup/memory.current","utf8"))}catch{}const processes=[];let rss=0;for(const pid of fs.readdirSync("/proc").filter(x=>/^\\d+$/.test(x))){try{if(Number(pid)===process.pid)continue;const status=fs.readFileSync("/proc/"+pid+"/status","utf8");rss+=Number(status.match(/^VmRSS:\\s+(\\d+)/m)?.[1]??0)*1024;const stat=fs.readFileSync("/proc/"+pid+"/stat","utf8");const close=stat.lastIndexOf(")");const name=stat.slice(stat.indexOf("(")+1,close);const fields=stat.slice(close+2).split(" ");if(name==="node"||name==="node-MainThread"||name==="rivet-engine")processes.push(pid+":"+fields[19]);}catch(error){if(error.code!=="ENOENT")throw error;}}if(!memory)memory=rss;if(!memory)throw Error("memory unavailable");const workers=process.argv[1] === "engine" ? [] : await Promise.all([0,1].map(async i=>{const text=await(await fetch("http://127.0.0.1:"+(Number(process.argv[1])+i)+"/metrics")).text();const m=text.match(/^openorange_worker_start_time_seconds ([\\d.]+)$/m);if(!m)throw Error("worker incarnation missing");return m[1]}));console.log(JSON.stringify({cpu,memory,processes:processes.sort(),workers}));})().catch(error=>{console.error(error.message);process.exit(1)})`;
  type Sample = { cpu: number; memory: number; processes: string[]; workers: string[] };
  const read = (): Sample => {
    const worker = JSON.parse(execFileSync("docker", ["exec", containerName, "node", "-e", script, String(metricsPort)], { encoding: "utf8", timeout: 5000 })) as Sample;
    const engine = JSON.parse(execFileSync("docker", ["exec", engineName, "node", "-e", script, "engine"], { encoding: "utf8", timeout: 5000 })) as Sample;
    return { cpu: worker.cpu + engine.cpu, memory: worker.memory + engine.memory, processes: [...worker.processes.map(pid => `w:${pid}`), ...engine.processes.map(pid => `e:${pid}`)], workers: worker.workers };
  };
  let first: Sample | undefined, previous: Sample | undefined, peak = 0, restarts = 0, failed = false;
  const sample = () => { try { const current = read(); first ??= current; if (previous) { restarts += previous.processes.filter(pid => !current.processes.includes(pid)).length; restarts += previous.workers.filter((value, index) => value !== current.workers[index]).length; } previous = current; peak = Math.max(peak, current.memory); } catch (error) { if (!failed) console.error(`resource sample failed: ${error instanceof Error ? error.message : String(error)}`); failed = true; } };
  sample();
  const timer = setInterval(sample, 2000);
  timer.unref();
  return () => { clearInterval(timer); sample(); if (failed || !first || !previous || previous.cpu < first.cpu) return { cpuSeconds: null, memoryPeakBytes: null, restarts: null }; return { cpuSeconds: (previous.cpu - first.cpu) / 1e6, memoryPeakBytes: peak, restarts }; };
}
type HistoryRun = { historyPath: string; historyBytes: Uint8Array; eventReadPath: string; event: unknown; hostId: string; samples: Sample[]; ledger: { history: { phases: { phase: string; expected: number; verified: number; missing: number; mismatched: number }[] } } };
export async function recover(candidate: Stack, baseline: Stack, directory: string, result: HistoryRun | readonly HistoryRun[]): Promise<{ method: string; verifiedAtMs: number; previousRelease: string; readbackVerified: boolean }> {
  if (candidate !== baseline && !baseline.recovered && baseline.historyRuns.length) await recover(baseline, baseline, `${directory}-baseline`, baseline.historyRuns as HistoryRun[]);
  await candidate.stop();
  cpSync(candidate.stateDir, directory, { recursive: true });
  generate(directory, { kind: "dev", release: baseline.release, gatewaySecret: baseline.headers["X-Stats-Gateway-Secret"] ?? Object.values(baseline.headers)[0]!, nowMs: null }, "in-place", appOutputs(baseline.appRoot));
  const port = await freePort();
  const session = "containerName" in baseline.session ? await startContainerSession(directory, port, baseline.runtimeRoot) : await startSession(directory, port, { runtimeRoot: baseline.runtimeRoot });
  try {
    let verified = true;
    for (const entry of Array.isArray(result) ? result : [result]) {
      const history = await fetch(session.origin + entry.historyPath, { headers: { ...baseline.headers, "accept-encoding": "identity" } }).catch(() => null);
      if (history === null) { verified = false; continue; }
      const bytes = new Uint8Array(await history.arrayBuffer());
      let phase: ReturnType<typeof compareHistory> | null = null;
      if (history.status === 200) { try { phase = compareHistory(bytes, entry.hostId, expectedHistory(entry.samples), "after"); entry.ledger.history.phases.push(phase); } catch {} }
      const events = await fetch(session.origin + entry.eventReadPath, { headers: baseline.headers }).catch(() => null);
      let matched = false;
      if (events?.status === 200) { try { const body = await events.json() as { events: { event: unknown }[] }; matched = body.events.some(item => JSON.stringify(item.event) === JSON.stringify(entry.event)); } catch {} }
      verified = verified && phase !== null && phase.missing === 0 && phase.mismatched === 0 && matched;
    }
    candidate.recovered = true;
    return { method: "state-copy", verifiedAtMs: Date.now(), previousRelease: baseline.release, readbackVerified: verified };
  } finally { await session.stop(); }
}
export function writeBundle(directory: string, baseline: Stack, candidate: Stack, ledgers: { baseline: any; candidate: any }, observations: { baseline: any; candidate: any }, recovery: unknown, start: number, end: number, options?: { definitionBytes: Buffer; baselineManifest: unknown; candidateManifest: unknown }) {
  mkdirSync(directory);
  const write = (name: string, value: unknown) => { const text = `${JSON.stringify(value, null, 2)}\n`; writeFileSync(join(directory, name), text); return text; };
  const components = (stack: Stack) => ({ ...Object.fromEntries([["orange-package", join(stack.runtimeRoot, "package.json")], ["orange-lock", join(stack.runtimeRoot, "pnpm-lock.yaml")], ["orange-bin", join(stack.runtimeRoot, "node_modules/open-orange/dist/bin.js")], ["workspace-lock", join(root, "pnpm-lock.yaml")], ["stats-bundle", join(STATS_OUTPUT, "bundle/index.js")], ["observe-bundle", join(OBSERVE_OUTPUT, "bundle/index.js")]].map(([name, path]) => [name, hash(readFileSync(path!))])), ...("closureDigest" in stack ? { "runtime-closure": stack.closureDigest } : {}) });
  const workloadBytes = write("workload.json", workload);
  const manifest = (stack: Stack) => {
    const entries = Object.fromEntries(Object.entries(components(stack)).map(([name, digest]) => [name, digest.startsWith("sha256:") ? digest : `sha256:${digest}`]));
    return { releaseId: stack.release, artifactDigest: entries["runtime-closure"] ?? entries["orange-bin"], components: entries };
  };
  write("baseline.manifest.json", options?.baselineManifest ?? manifest(baseline));
  write("candidate.manifest.json", options?.candidateManifest ?? manifest(candidate));
  const definitionBytes = options?.definitionBytes ?? readFileSync(join(root, "deploy/orange/qualification/profiles/smoke.json"));
  const profile = JSON.parse(definitionBytes.toString("utf8"));
  write("policy.json", { schema: "stats-release-policy/2", id: profile.name === "promotion" ? "orange-promotion" : "local-canary", profile: { name: profile.name, definitionSha256: hash(definitionBytes) }, baselineRelease: baseline.release, candidateRelease: candidate.release, workloadId: workload.id, workloadSha256: hash(workloadBytes), requiredSources: profile.requiredSources, windows: { startMs: start - (options ? profile.warmupMs : 0), warmupMs: options ? profile.warmupMs : 0, measureMs: end - start }, minimums: { measureMs: profile.measureMs, requests: profile.minimumRequests }, maxEvidenceAgeMs: profile.maxEvidenceAgeMs, absolute: profile.absolute, regression: profile.regression, histogramMaxRelativeError: 0.01, recovery: { required: true, method: "state-copy" } });
  for (const ledger of Object.values(ledgers)) { ledger.windowStartMs = start; ledger.windowEndMs = end; }
  write("ledger.json", { schema: "stats-release-evidence/1", ...ledgers });
  write("observations.json", { schema: "stats-release-evidence/1", ...observations });
  write("recovery.json", recovery);
  const command = spawnSync("pnpm", ["--dir", "cloudflare", "-s", "statsctl", "verify", "release", "--evidence", directory, "--json"], { cwd: root, encoding: "utf8" });
  if (![0, 5, 6, 7].includes(command.status ?? -1)) throw new Error(`verify failed ${command.status}: ${command.stderr} ${command.stdout}`);
  const decision = (JSON.parse(command.stdout) as { payload: { verdict: string; evaluatedAtMs: number; reasons: { code: string }[] } }).payload;
  write("decision.json", { evaluatedAtMs: decision.evaluatedAtMs, verdict: decision.verdict, reasonCodes: decision.reasons.map((r: {code: string}) => r.code) });
  return { decision, status: command.status };
}
