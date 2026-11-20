import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readdirSync, constants, type Dirent } from "node:fs";
import { join } from "node:path";
import { usageError } from "../exit.ts";
import { resolveInvocationPath } from "./files.ts";

type Shape = string | readonly [Shape] | { readonly [key: string]: Shape };
const id = "id", num = "number", count = "count", bool = "boolean", hash = "hash";
const checkpoint = { startedAtMs: count, atMs: count, accepted: count, dropped: count, queued: count };
const source = { source: id, producer: id, releaseId: id, lastSeenMs: count, sequenceStart: checkpoint, sequenceEnd: checkpoint, received: count, "families?": "families" };
const cohort = { releaseId: id, workloadId: id, attempted: count, succeeded: count, failures: "counts", bodyMismatches: count, acknowledgedWrites: count, readbackVerified: count, lostWrites: count, duplicateMismatches: count, history: { samples: "samples", phases: [{ phase: id, expected: count, verified: count, missing: count, mismatched: count }] as const }, histogram: { relativeError: num, buckets: "buckets" }, windowStartMs: count, windowEndMs: count, truncated: bool };
const observation = { observer: { status: "observer", checkedAtMs: count }, sources: [source] as const, truncated: bool, hostConfounded: bool, resources: { cpuSeconds: "nullable-number", memoryPeakBytes: "nullable-count", restarts: "nullable-count" } };
const schemas: Record<string, Shape> = {
  "policy.json": { schema: "policy-schema", id, profile: { name: "profile", definitionSha256: hash }, baselineRelease: id, candidateRelease: id, workloadId: id, workloadSha256: hash, requiredSources: [{ source: id, producer: id, families: [id] }], windows: { warmupMs: count, measureMs: count, startMs: count }, minimums: { measureMs: count, requests: count }, maxEvidenceAgeMs: count, absolute: { maxErrorShare: num, p95Ms: num, p99Ms: num, maxLostWrites: count, maxHistoryMismatches: count, maxCpuSecondsPerKRequests: num, maxMemoryPeakBytes: count, maxRestarts: count }, regression: { latency: { maxRelativeIncreasePercent: num, absoluteFloorMs: num }, maxCpuRelativeIncreasePercent: num, maxMemoryRelativeIncreasePercent: num }, histogramMaxRelativeError: num, recovery: { required: "true", method: id }, "improvement?": { metric: "metric", direction: "direction", minChangePercent: num } },
  "baseline.manifest.json": { releaseId: id, artifactDigest: "sha256-digest", components: "digests" },
  "candidate.manifest.json": { releaseId: id, artifactDigest: "sha256-digest", components: "digests" },
  "workload.json": { id, corpusSha256: hash, seed: count, requestMix: "counts", concurrency: count, payloadSizes: [count] },
  "ledger.json": { schema: "evidence-schema", baseline: cohort, candidate: cohort },
  "observations.json": { schema: "evidence-schema", baseline: observation, candidate: observation },
  "recovery.json": { method: id, verifiedAtMs: count, previousRelease: id, readbackVerified: bool },
  "decision.json": { evaluatedAtMs: count, verdict: "verdict", reasonCodes: [id] }
};

function validate(value: unknown, shape: Shape, path: string): void {
  const fail = (): never => { throw usageError(`${path} is invalid`); };
  if (typeof shape === "string") {
    if (shape === id) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) fail(); }
    else if (shape === hash) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(); }
    else if (shape === count || shape === "nullable-count") { if (!(shape === "nullable-count" && value === null) && (!Number.isSafeInteger(value) || (value as number) < 0)) fail(); }
    else if (shape === num || shape === "nullable-number") { if (!(shape === "nullable-number" && value === null) && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) fail(); }
    else if (shape === "u64") { if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) fail(); }
    else if (shape === "sha256-digest") { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail(); }
    else if (shape === "samples") { if (!Array.isArray(value) || value.length > 4096) fail(); for (const sample of value as unknown[]) validate(sample, { host: id, boot: id, sample: { seq: "u64", atMs: "u64", monoMs: "u64", cpuCount: count, uptimeMs: "u64", cpu: { user: "u64", system: "u64", idle: "u64", total: "u64" } } }, path); }
    else if (shape === "families") { if (typeof value !== "object" || value === null || Array.isArray(value)) fail(); for (const [key, entry] of Object.entries(value as Record<string, unknown>)) { validate(key, id, path); validate(entry, { okSamples: count, usable: bool, reason: "family-reason" }, `${path}.${key}`); } }
    else if (shape === bool) { if (typeof value !== "boolean") fail(); }
    else if (shape === "counts" || shape === "digests") {
      if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length > 256) fail();
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) { validate(key, id, path); validate(entry, shape === "counts" ? count : "sha256-digest", `${path}.${key}`); }
    } else if (shape === "buckets") {
      if (!Array.isArray(value) || value.length > 4096) fail();
      for (const pair of value as unknown[]) { if (!Array.isArray(pair) || pair.length !== 2) fail(); validate((pair as unknown[])[0], count, path); validate((pair as unknown[])[1], count, path); }
    } else {
      const allowed: Record<string, readonly unknown[]> = { "policy-schema": ["stats-release-policy/2"], "evidence-schema": ["stats-release-evidence/1"], observer: ["ok", "failed"], profile: ["smoke", "promotion"], "family-reason": [null, "family-missing", "collector-restart", "stale", "window-open"], direction: ["increase", "decrease"], metric: ["p95Ms", "p99Ms", "cpuSeconds", "memoryPeakBytes", "errorShare"], verdict: ["pass", "reject", "pending", "inconclusive"], "true": [true] };
      if (!allowed[shape]?.includes(value)) fail();
    }
    return;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length > 4096) fail();
    for (const item of value as unknown[]) validate(item, (shape as readonly [Shape])[0], path);
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const entries = Object.entries(shape);
  for (const key of Object.keys(record)) if (!entries.some(([field]) => field.replace(/\?$/u, "") === key)) throw usageError(`${path} has unknown field ${key}`);
  for (const [field, spec] of entries) { const optional = field.endsWith("?"); const key = field.replace(/\?$/u, ""); if (!optional || key in record) validate(record[key], spec, `${path}.${key}`); }
}

type Checkpoint = { startedAtMs: number; atMs: number; accepted: number; dropped: number; queued: number };
type Source = { source: string; producer: string; releaseId: string; lastSeenMs: number; sequenceStart: Checkpoint; sequenceEnd: Checkpoint; received: number; families?: Record<string, { okSamples: number; usable: boolean; reason: string | null }> };
type Ledger = { releaseId: string; workloadId: string; attempted: number; succeeded: number; failures: Record<string, number>; bodyMismatches: number; acknowledgedWrites: number; readbackVerified: number; lostWrites: number; duplicateMismatches: number; history: { samples: { host: string; boot: string; sample: { atMs: string; monoMs: string } }[]; phases: { phase: string; expected: number; verified: number; missing: number; mismatched: number }[] }; histogram: { relativeError: number; buckets: [number, number][] }; windowStartMs: number; windowEndMs: number; truncated: boolean };
type Observation = { observer: { status: "ok" | "failed"; checkedAtMs: number }; sources: Source[]; truncated: boolean; hostConfounded: boolean; resources: { cpuSeconds: number | null; memoryPeakBytes: number | null; restarts: number | null } };
export type ReleasePolicy = { id: string; profile: { name: "smoke" | "promotion"; definitionSha256: string }; baselineRelease: string; candidateRelease: string; workloadId: string; workloadSha256: string; requiredSources: { source: string; producer: string; families: string[] }[]; windows: { warmupMs: number; measureMs: number; startMs: number }; minimums: { measureMs: number; requests: number }; maxEvidenceAgeMs: number; absolute: { maxErrorShare: number; p95Ms: number; p99Ms: number; maxLostWrites: number; maxHistoryMismatches: number; maxCpuSecondsPerKRequests: number; maxMemoryPeakBytes: number; maxRestarts: number }; regression: { latency: { maxRelativeIncreasePercent: number; absoluteFloorMs: number }; maxCpuRelativeIncreasePercent: number; maxMemoryRelativeIncreasePercent: number }; histogramMaxRelativeError: number; recovery: { required: true; method: string }; improvement?: { metric: "p95Ms" | "p99Ms" | "cpuSeconds" | "memoryPeakBytes" | "errorShare"; direction: "increase" | "decrease"; minChangePercent: number } };
export type ReleaseEvidence = { policy: ReleasePolicy; baseline: { releaseId: string; artifactDigest: string; components: Record<string, string> }; candidate: { releaseId: string; artifactDigest: string; components: Record<string, string> }; workload: { id: string }; ledger: Record<"baseline" | "candidate", Ledger>; observations: Record<"baseline" | "candidate", Observation>; recovery: { method: string; verifiedAtMs: number; previousRelease: string; readbackVerified: boolean } | null; hashes: Record<string, string>; decision: { evaluatedAtMs: number; verdict: string; reasonCodes: string[] } | null };

export function readReleaseEvidence(directory: string, replay: boolean): ReleaseEvidence {
  const root = resolveInvocationPath(directory);
  let entries: Dirent<string>[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { throw usageError(`cannot read evidence directory ${root}`); }
  for (const entry of entries) if (!entry.isFile() || !Object.hasOwn(schemas, entry.name)) throw usageError(`unexpected evidence file ${entry.name}`);
  const hashes: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const [name, shape] of Object.entries(schemas)) {
    const path = join(root, name);
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((name === "recovery.json" || (name === "decision.json" && !replay)) && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw usageError(`cannot open ${path}`); }
    let bytes: Buffer;
    const limit = name === "ledger.json" ? 8 * 1024 * 1024 : 1024 * 1024;
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > limit) throw usageError(`${path} must be a regular file of at most ${limit} bytes`); bytes = readFileSync(fd); if (bytes.length > limit) throw usageError(`${path} is too large`); } finally { closeSync(fd); }
    hashes[name] = createHash("sha256").update(bytes).digest("hex");
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw usageError(`${path} is not valid JSON`); }
    validate(value, shape, name);
    values[name] = value;
  }
  const result = { policy: values["policy.json"], baseline: values["baseline.manifest.json"], candidate: values["candidate.manifest.json"], workload: values["workload.json"], ledger: values["ledger.json"], observations: values["observations.json"], recovery: values["recovery.json"] ?? null, decision: values["decision.json"] ?? null, hashes } as ReleaseEvidence;
  return result;
}
