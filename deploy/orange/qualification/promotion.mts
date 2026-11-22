import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { closeSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { appDigest, appReleaseId, manifestDigest, treeManifest } from "./manifest.mts";
import { experimentIdentity } from "./identity.mts";
import { startStack, type Stack } from "../canary/stack.mts";
import { prepare, runWorkload, spec } from "../canary/workload.mts";
import { monitorResources, observe, recover, source, waitCheckpoint, writeBundle } from "../canary/evidence.mts";

const root = resolve(import.meta.dirname, "../../..");
const { values } = parseArgs({ options: { baseline: { type: "string" }, candidate: { type: "string" }, "baseline-app": { type: "string" }, "candidate-app": { type: "string" }, out: { type: "string" }, profile: { type: "string" } } });
if (process.platform !== "linux") throw new Error("qualification requires native Linux and Docker");
if (!values.baseline || !values.candidate || !values["baseline-app"] || !values["candidate-app"] || !values.out) throw new Error("usage: node promotion.mts --baseline RUNTIME_DIR --candidate RUNTIME_DIR --baseline-app APP_DIR --candidate-app APP_DIR --out DIR [--profile FILE]\nPass the same directory for both sides of the layer an experiment holds constant.");
const definitionBytes = readFileSync(resolve(values.profile ?? join(root, "deploy/orange/qualification/profiles/promotion.json")));
const profile = JSON.parse(definitionBytes.toString("utf8")) as { name: string; warmupMs: number; measureMs: number; requestMix: Record<string, number>; requestRatePerSecond?: number; requiredSources: { source: string; producer: string; families: string[] }[] };
if (!["smoke", "promotion"].includes(profile.name) || !Number.isSafeInteger(profile.measureMs) || !Number.isSafeInteger(profile.warmupMs) || profile.measureMs < 1 || profile.warmupMs < 0 || (profile.name === "promotion" && (profile.warmupMs < 60_000 || profile.measureMs < 600_000))) throw new Error("invalid qualification profile");
if (profile.name === "promotion" && !definitionBytes.equals(readFileSync(join(root, "deploy/orange/qualification/profiles/promotion.json")))) throw new Error("promotion must use the frozen promotion definition");
if (JSON.stringify(profile.requestMix) !== JSON.stringify(spec.requestMix)) throw new Error("profile request mix does not match the workload");
const rate = profile.requestRatePerSecond ?? 10;
if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) throw new Error("invalid request rate");
const batchPeriodMs = 10_000 / rate;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digestFile = (file: string) => {
  const hash = createHash("sha256"), fd = openSync(file, "r"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break; hash.update(buffer.subarray(0, count)); } } finally { closeSync(fd); }
  return hash.digest("hex");
};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
mkdirSync(join(root, ".work/tmp"), { recursive: true });
const scratch = mkdtempSync(join(root, ".work/tmp/qualification-"));
let baseline: Stack | undefined, candidate: Stack | undefined;
try {
  const extract = (dir: string, name: string) => {
    const artifact = resolve(dir), archive = join(scratch, `${name}.tar`);
    const build = JSON.parse(readFileSync(join(artifact, "build.json"), "utf8")) as { schema: string; manifest_digest: string; tar_sha256: string; release_id: string };
    if (build.schema !== "openorange-runtime-build-record/1") throw new Error(`${name} build.json is not an openorange-runtime-build-record/1`);
    const manifestHash = manifestDigest(JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")));
    if (`sha256:${manifestHash}` !== build.manifest_digest) throw new Error(`${name} manifest.json differs from its build record`);
    copyFileSync(join(artifact, "runtime.tar"), archive);
    const archiveHash = digestFile(archive);
    if (`sha256:${archiveHash}` !== build.tar_sha256) throw new Error(`${name} runtime.tar differs from its build record`);
    const runtime = join(scratch, `${name}-runtime`); mkdirSync(runtime);
    const extractor = `import pathlib,sys,tarfile\nroot=pathlib.Path(sys.argv[2]).resolve()\nwith tarfile.open(sys.argv[1]) as archive:\n for entry in archive.getmembers():\n  path=pathlib.PurePosixPath(entry.name)\n  if path.is_absolute() or '..' in path.parts: raise ValueError('unsafe archive path')\n archive.extractall(root, filter='data')`;
    execFileSync("python3", ["-c", extractor, archive, runtime], { stdio: "pipe" });
    if (manifestDigest(treeManifest(runtime)) !== manifestHash) throw new Error(`${name} extracted runtime differs from its manifest`);
    if (build.release_id !== `rt-${manifestHash.slice(0, 12)}`) throw new Error(`${name} release id differs from its manifest digest`);
    return { runtime, artifact: { releaseId: build.release_id, artifactDigest: `sha256:${manifestHash}` }, archive: `sha256:${archiveHash}` };
  };
  const copyApp = (dir: string, name: string) => {
    const input = resolve(dir), app = join(scratch, `${name}-app`), declared = appDigest(input);
    cpSync(input, app, { recursive: true, verbatimSymlinks: true });
    if (appDigest(app) !== declared) throw new Error(`${name} app release changed while it was copied`);
    return { app, appArtifact: { releaseId: appReleaseId(declared), artifactDigest: declared } };
  };
  const left = { ...extract(values.baseline, "baseline"), ...copyApp(values["baseline-app"], "baseline") };
  const right = { ...extract(values.candidate, "candidate"), ...copyApp(values["candidate-app"], "candidate") };
  const identity = experimentIdentity({ runtime: left.artifact, app: left.appArtifact }, { runtime: right.artifact, app: right.appArtifact });
  const manifestFor = (side: typeof left, artifact: { releaseId: string; artifactDigest: string }) => ({ ...artifact, components: {
    "runtime-archive": side.archive,
    "runtime-manifest": side.artifact.artifactDigest,
    "app-release": side.appArtifact.artifactDigest,
    "stats-worker": `sha256:${digestFile(join(side.app, "stats/bundle/index.js"))}`,
    "observe-worker": `sha256:${digestFile(join(side.app, "observe/bundle/index.js"))}`,
    "infra-collector": `sha256:${digestFile(join(side.app, "collector/main.mjs"))}`,
    "container-image": "sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5"
  } });
  const leftArtifact = { runtime: left.runtime, app: left.app, manifest: manifestFor(left, identity.baseline) };
  const rightArtifact = { runtime: right.runtime, app: right.app, manifest: manifestFor(right, identity.candidate) };
  console.error(`qualifying a ${identity.layer} change: ${identity.baseline.releaseId} -> ${identity.candidate.releaseId}`);
  const token = `nft_${randomBytes(32).toString("base64url")}`;
  const verifier = digest(Buffer.from(token));
  baseline = await startStack(join(scratch, "baseline"), leftArtifact.manifest.releaseId, false, leftArtifact.runtime, true, verifier, leftArtifact.app);
  candidate = await startStack(join(scratch, "candidate"), rightArtifact.manifest.releaseId, false, rightArtifact.runtime, true, verifier, rightArtifact.app);
  const sides = new Map<Stack, { runtime: string; app: string }>([
    [baseline, { runtime: left.artifact.releaseId, app: left.appArtifact.artifactDigest.replace(/^sha256:/, "").slice(0, 12) }],
    [candidate, { runtime: right.artifact.releaseId, app: right.appArtifact.artifactDigest.replace(/^sha256:/, "").slice(0, 12) }],
  ]);
  const sideOf = (stack: Stack) => sides.get(stack)!;
  const launchCollector = (stack: Stack) => {
    if (!("containerName" in stack.session) || !("metricsPort" in stack.session)) throw new Error("collector requires a container session");
    const tokenFile = join(stack.stateDir, "collector-token"), releaseFile = join(stack.stateDir, "collector-release.json"), config = join(stack.stateDir, "collector.json");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    if (stack.appRoot === undefined) throw new Error("qualification stacks serve an app release");
    const side = sideOf(stack);
    writeFileSync(releaseFile, JSON.stringify({ runtime: side.runtime, app: side.app }));
    const port = new URL(stack.origin).port;
    writeFileSync(config, JSON.stringify({ name: "infra", releaseFile, tokenFile, endpoint: `http://127.0.0.1:${port}/ingest/metrics/v1/batches`, targets: [{ id: "worker:stats:0", url: `http://127.0.0.1:${String(stack.session.metricsPort)}/metrics` }, { id: "worker:stats-observe:1", url: `http://127.0.0.1:${String(Number(stack.session.metricsPort) + 1)}/metrics` }, { id: "engine:live", url: "http://127.0.0.1:6544/metrics" }] }));
    return spawn("docker", ["exec", "-e", `INFRA_COLLECTOR_CONFIG=${config}`, stack.session.containerName, "node", join(stack.appRoot, "collector/main.mjs")], { stdio: ["ignore", "ignore", "inherit"] });
  };
  const collectors = [launchCollector(baseline), launchCollector(candidate)];
  const pools = await Promise.all([baseline, candidate].map(async stack => {
    const items: Awaited<ReturnType<typeof prepare>>[] = [];
    for (let i = 0; i < 30; i++) items.push(await prepare(stack, `-${i}`));
    return items;
  }));
  const from = Date.now() - 60_000;
  const requireSelf = profile.requiredSources.some(item => item.source === "stats" && item.producer === "stats-self");
  if (requireSelf) await Promise.all([waitCheckpoint(baseline, from, from).catch(() => null), waitCheckpoint(candidate, from, from).catch(() => null)]);
  const warmupEnd = Date.now() + profile.warmupMs;
  const warmups: [Awaited<ReturnType<typeof runWorkload>>[], Awaited<ReturnType<typeof runWorkload>>[]] = [[], []];
  let sequence = 0;
  while (Date.now() < warmupEnd) {
    const at = Date.now();
    const pair = await Promise.all([runWorkload(baseline, pools[0]![sequence % 30]!, baseline.origin, sequence), runWorkload(candidate, pools[1]![sequence % 30]!, candidate.origin, sequence)]);
    warmups[0].push(pair[0]); warmups[1].push(pair[1]); sequence++;
    await delay(at + batchPeriodMs - Date.now());
  }
  const start = Date.now();
  const stops = [monitorResources(baseline), monitorResources(candidate)];
  const runs: [Awaited<ReturnType<typeof runWorkload>>[], Awaited<ReturnType<typeof runWorkload>>[]] = [[], []];
  do {
    const at = Date.now();
    const pair = await Promise.all([runWorkload(baseline, pools[0]![sequence % 30]!, baseline.origin, sequence), runWorkload(candidate, pools[1]![sequence % 30]!, candidate.origin, sequence)]);
    runs[0].push(pair[0]); runs[1].push(pair[1]); sequence++;
    await delay(at + batchPeriodMs - Date.now());
  } while (Date.now() - start < profile.measureMs);
  const resources = stops.map(stop => stop());
  const end = Date.now();
  const getSources = async (stack: Stack, child: typeof collectors[number]) => {
    const last = requireSelf ? await waitCheckpoint(stack, from, end).catch(() => observe(stack, from).catch(() => null)) : null;
    const side = sideOf(stack);
    const response = await fetch(`${stack.origin}/api/observe/stats-infra/metrics/sources?from=${start}&to=${end}&release=runtime`, { headers: stack.headers }).catch(() => null);
    const appLabels = new Map<string, string>();
    if (identity.layer !== "runtime") {
      const byApp = await fetch(`${stack.origin}/api/observe/stats-infra/metrics/sources?from=${start}&to=${end}&release=app`, { headers: stack.headers }).catch(() => null);
      if (byApp?.ok) { try { for (const row of (await byApp.json() as { sources: { evidence: { source: string; releaseId: string } | null }[] }).sources) if (row.evidence) appLabels.set(row.evidence.source, row.evidence.releaseId); } catch {} }
    }
    type Family = { okSamples: number; usable: boolean; reason: string | null };
    type MetricSource = Omit<ReturnType<typeof source>, "families"> & { families?: Record<string, Family> };
    let rows: { evidence: MetricSource | null; detail?: { families?: Record<string, Family> } }[] = [];
    let observerOk = false;
    if (response?.ok) {
      try { const body = await response.json() as { sources: typeof rows }; if (Array.isArray(body.sources)) { rows = body.sources; observerOk = true; } } catch {}
    }
    // Each side has its own collector, Engine and metric store, so a source that reports this side's
    // runtime release (and, for Worker targets in an app or combined experiment, its app release)
    // belongs to this side's deployment and carries the experiment identity the evaluator compares.
    const attributable = (evidence: { source: string; releaseId: string }) => evidence.releaseId === side.runtime && (identity.layer === "runtime" || evidence.source.startsWith("engine:") || appLabels.get(evidence.source) === side.app);
    const infra = rows.flatMap(row => row.evidence && attributable(row.evidence) ? [{ ...row.evidence, releaseId: stack.release, families: row.detail?.families ?? {} }] : []);
    const sample = infra[0];
    if (sample && infra.length === 3 && child.exitCode === null && infra.every(item => item.sequenceStart.startedAtMs === sample.sequenceStart.startedAtMs && item.sequenceEnd.startedAtMs === sample.sequenceStart.startedAtMs && item.sequenceStart.atMs <= start && item.sequenceEnd.atMs >= end && item.sequenceEnd.accepted - item.sequenceStart.accepted === item.received && item.sequenceEnd.dropped === item.sequenceStart.dropped && item.sequenceStart.queued === 0 && item.sequenceEnd.queued === 0)) {
      const okSamples = Math.min(...infra.map(item => item.received));
      infra.push({ ...sample, source: "collector:infra", families: { delivery: { okSamples, usable: okSamples > 0, reason: okSamples > 0 ? null : "family-missing" } } });
    }
    let self: ReturnType<typeof source> | null = null;
    if (last) { try { self = source(last.rows, stack.release, start, end); } catch {} }
    return { observer: { status: observerOk ? "ok" : "failed", checkedAtMs: Date.now() }, sources: [...(self ? [self] : []), ...infra], truncated: last?.truncated ?? false, hostConfounded: false };
  };
  await Promise.all([fetch(`${baseline.origin}/api/v1/capabilities`, { headers: baseline.headers }).catch(() => null), fetch(`${candidate.origin}/api/v1/capabilities`, { headers: candidate.headers }).catch(() => null)]);
  await delay(17_000);
  const observed = await Promise.all([getSources(baseline, collectors[0]!), getSources(candidate, collectors[1]!)]);
  const allRuns = [warmups[0].concat(runs[0]), warmups[1].concat(runs[1])] as const;
  await recover(baseline, baseline, join(scratch, "baseline-recovery"), allRuns[0]);
  const recovery = await recover(candidate, baseline, join(scratch, "candidate-recovery"), allRuns[1]);
  const merge = (side: typeof runs[number], all: typeof runs[number]) => {
    const first = structuredClone(side[0]!.ledger);
    const sum = (key: "attempted" | "succeeded" | "bodyMismatches" | "acknowledgedWrites" | "readbackVerified" | "lostWrites" | "duplicateMismatches") => side.reduce((n, run) => n + run.ledger[key], 0);
    for (const key of ["attempted", "succeeded", "bodyMismatches"] as const) first[key] = sum(key);
    for (const key of ["acknowledgedWrites", "readbackVerified", "lostWrites", "duplicateMismatches"] as const) first[key] = all.reduce((n, run) => n + run.ledger[key], 0);
    first.failures = {}; const buckets = new Map<number, number>();
    for (const run of side) { for (const [key, value] of Object.entries(run.ledger.failures)) first.failures[key] = (first.failures[key] ?? 0) + value; for (const [key, value] of run.ledger.histogram.buckets) buckets.set(key, (buckets.get(key) ?? 0) + value); }
    first.histogram.buckets = [...buckets].sort((a, b) => a[0] - b[0]);
    first.history.samples = all.flatMap(run => run.ledger.history.samples);
    first.history.phases = ["before", "after"].map(phase => ({ phase, expected: all.reduce((n, run) => n + (run.ledger.history.phases.find(p => p.phase === phase)?.expected ?? 0), 0), verified: all.reduce((n, run) => n + (run.ledger.history.phases.find(p => p.phase === phase)?.verified ?? 0), 0), missing: all.reduce((n, run) => n + (run.ledger.history.phases.find(p => p.phase === phase)?.missing ?? 0), 0), mismatched: all.reduce((n, run) => n + (run.ledger.history.phases.find(p => p.phase === phase)?.mismatched ?? 0), 0) }));
    return first;
  };
  const result = writeBundle(resolve(values.out), baseline, candidate, { baseline: merge(runs[0], allRuns[0]), candidate: merge(runs[1], allRuns[1]) }, { baseline: { ...observed[0], resources: resources[0] }, candidate: { ...observed[1], resources: resources[1] } }, recovery, start, end, { definitionBytes, baselineManifest: leftArtifact.manifest, candidateManifest: rightArtifact.manifest });
  console.log(JSON.stringify({ verdict: result.decision.verdict, evidence: resolve(values.out) }));
  process.exitCode = result.status;
} finally {
  await candidate?.stop(); await baseline?.stop();
  try { rmSync(scratch, { recursive: true, force: true }); } catch (error) { console.error(`qualification scratch ${scratch} was not removed: ${error instanceof Error ? error.message : String(error)}`); }
}
