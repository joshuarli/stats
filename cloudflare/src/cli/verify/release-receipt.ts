import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { usageError } from "../exit.ts";
import type { ReleaseEvidence } from "./release-evidence.ts";
import { resolveInvocationPath } from "./files.ts";
import type { decideRelease } from "./release-decide.ts";

const expected = new Set(["policy.json", "baseline.manifest.json", "candidate.manifest.json", "workload.json", "ledger.json", "observations.json", "recovery.json", "decision.json"]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function writeReceipt(directory: string, destination: string, evidence: ReleaseEvidence, decision: ReturnType<typeof decideRelease>, createdAtMs: number): void {
  const root = realpathSync(resolveInvocationPath(directory));
  const requested = resolveInvocationPath(destination);
  let output: string;
  try { output = join(realpathSync(dirname(requested)), basename(requested)); } catch { throw usageError("--receipt-out parent directory is unavailable"); }
  const rel = relative(root, resolve(output));
  if (rel === "" || (!rel.startsWith("../") && rel !== "..")) throw usageError("--receipt-out must be outside the evidence directory");
  const script = realpathSync(process.argv[1] ?? "");
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  const version = basename(script).match(/^statsctl-([0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?)\.mjs$/u)?.[1];
  if (script !== modulePath || version === undefined) throw usageError("--receipt-out requires the built statsctl bundle");
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length !== expected.size || entries.some(entry => !entry.isFile() || !expected.has(entry.name))) throw usageError("evidence directory has missing or unexpected files");
  const inputs = entries.map(entry => { const bytes = readFileSync(join(root, entry.name)); return { path: entry.name, sha256: sha(bytes), bytes: bytes.length }; }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (inputs.some(input => evidence.hashes[input.path] !== input.sha256)) throw usageError("evidence changed during evaluation");
  const receipt = {
    schema: "stats-qualification-receipt/1",
    profile: evidence.policy.profile,
    baseline: evidence.baseline,
    candidate: evidence.candidate,
    policy: { id: evidence.policy.id, sha256: evidence.hashes["policy.json"] },
    workload: { id: evidence.workload.id, sha256: evidence.hashes["workload.json"] },
    evaluator: { name: "statsctl verify release", version, sha256: sha(readFileSync(script)) },
    observations: (["baseline", "candidate"] as const).flatMap(side => evidence.observations[side].sources.map(source => ({ source: source.source, producer: source.producer, releaseId: source.releaseId, windowStartMs: evidence.ledger[side].windowStartMs, windowEndMs: evidence.ledger[side].windowEndMs }))),
    inputs,
    decision: { verdict: decision.verdict, reasonCodes: decision.reasons.map(reason => reason.code), evaluatedAtMs: decision.evaluatedAtMs },
    createdAtMs
  };
  const temporary = join(dirname(output), `.${basename(output)}.${randomBytes(12).toString("hex")}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, "wx", 0o444);
    created = true;
    try { writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, output);
  } catch { throw usageError("cannot create --receipt-out; destination must not exist"); }
  finally { if (created) unlinkSync(temporary); }
}
