import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeDeploymentComparison } from "../../deployments/decode.ts";
import { COMPARISON_WINDOWS, type ComparisonWindow } from "../../deployments/compare.ts";
import { UUID } from "../../deployments/model.ts";
import { decodeStatsWindow } from "../../observe/client/decode.ts";
import { transportError } from "../exit.ts";
import { REPOSITORY_ROOT } from "../snapshot-store.ts";
import type { Evidence, IssueCheck, SafetyRecord, VerifyVerdict } from "./decide.ts";
import { VERDICTS } from "./decide.ts";
import { parsePolicy, policyHash, PolicyError, type Policy } from "./policy.ts";

export const STATE_SCHEMA = "statsctl-verify-state/1";
export const DEFAULT_STATE_DIRECTORY = join(REPOSITORY_ROOT, ".work", "statsctl", "verify");
export const MAX_STATE_BYTES = 32 * 1024 * 1024;

export interface LastEvaluation {
  readonly evaluatedAtMs: number;
  readonly verdict: VerifyVerdict;
}

export interface VerifyState {
  readonly schema: typeof STATE_SCHEMA;
  readonly origin: string;
  readonly project: string;
  readonly requested: string;
  readonly deploymentId: string;
  readonly window: ComparisonWindow;
  readonly policy: Policy;
  readonly policyHash: string;
  readonly pinnedAtMs: number;
  readonly polls: number;
  readonly requests: number;
  readonly etags: Readonly<Record<string, string>>;
  readonly safety: SafetyRecord | null;
  readonly evidence: Evidence | null;
  readonly last: LastEvaluation | null;
}

export function statePath(directory: string, deploymentId: string): string {
  return join(directory, `${deploymentId}.json`);
}

export function writeState(directory: string, state: VerifyState): string {
  const path = statePath(directory, state.deploymentId);
  const scratch = join(directory, `.${state.deploymentId}.${process.pid}.tmp`);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(scratch, text, { mode: 0o600 });
    renameSync(scratch, path);
    return path;
  } catch (error) {
    rmSync(scratch, { force: true });
    throw transportError("state_unwritable", `cannot write ${path}: ${error instanceof Error ? error.message : "failed"}`);
  }
}

export function readStateText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw transportError("state_unreadable", `cannot read ${path}: ${error instanceof Error ? error.message : "failed"}`);
  }
}

function fail(path: string, why: string): never {
  throw transportError("state_invalid", `${path} is not a valid verify state: ${why}`);
}

function record(value: unknown, path: string, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, `${where} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function integer(value: unknown, path: string, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(path, `${where} must be a non-negative integer`);
  return value;
}

function stringValue(value: unknown, path: string, where: string): string {
  if (typeof value !== "string" || value === "" || value.length > 2048) fail(path, `${where} must be a non-empty string`);
  return value;
}

function decodeSafety(value: unknown, path: string): SafetyRecord | null {
  if (value === null) return null;
  const fields = record(value, path, "safety");
  if (typeof fields["ok"] !== "boolean") fail(path, "safety.ok must be a boolean");
  const failedStep = fields["failedStep"];
  if (failedStep !== null && typeof failedStep !== "string") fail(path, "safety.failedStep must be a string or null");
  return { ok: fields["ok"], atMs: integer(fields["atMs"], path, "safety.atMs"), hostId: stringValue(fields["hostId"], path, "safety.hostId"), origin: stringValue(fields["origin"], path, "safety.origin"), failedStep, file: stringValue(fields["file"], path, "safety.file") };
}

function decodeIssues(value: unknown, path: string): IssueCheck | null {
  if (value === null) return null;
  const fields = record(value, path, "issues");
  if (!Array.isArray(fields["versions"]) || !Array.isArray(fields["skipped"])) fail(path, "issues must list versions and skipped");
  return {
    versions: fields["versions"].map(item => { const entry = record(item, path, "issue version"); return { versionId: stringValue(entry["versionId"], path, "issue versionId"), groups: integer(entry["groups"], path, "issue groups") }; }),
    skipped: fields["skipped"].map(item => stringValue(item, path, "skipped version"))
  };
}

function decodeEvidence(value: unknown, path: string, deploymentId: string, window: ComparisonWindow): Evidence | null {
  if (value === null) return null;
  const fields = record(value, path, "evidence");
  const windows = fields["windows"] === null ? null : (() => {
    const pair = record(fields["windows"], path, "windows");
    return { before: decodeStatsWindow(pair["before"]), after: decodeStatsWindow(pair["after"]) };
  })();
  const probes = fields["probes"] === null ? null : Array.isArray(fields["probes"]) ? fields["probes"].map(item => stringValue(item, path, "probe")) : fail(path, "probes must be a list or null");
  return { comparison: decodeDeploymentComparison(fields["comparison"], deploymentId, window), windows, issues: decodeIssues(fields["issues"], path), probes };
}

export function decodeState(text: string, path: string): VerifyState {
  if (text.length > MAX_STATE_BYTES) fail(path, "the file is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(path, "not valid JSON");
  }
  const fields = record(parsed, path, "the state");
  if (fields["schema"] !== STATE_SCHEMA) fail(path, `schema must be ${STATE_SCHEMA}`);
  let policy: Policy;
  try {
    policy = parsePolicy(fields["policy"]);
  } catch (error) {
    if (error instanceof PolicyError) fail(path, `policy: ${error.message}`);
    throw error;
  }
  if (fields["policyHash"] !== policyHash(policy)) fail(path, "policyHash does not match the stored policy");
  const deploymentId = stringValue(fields["deploymentId"], path, "deploymentId");
  if (!UUID.test(deploymentId)) fail(path, "deploymentId is not a deployment id");
  const window = fields["window"];
  if (typeof window !== "string" || !Object.hasOwn(COMPARISON_WINDOWS, window)) fail(path, "window must be 1h, 6h, or 24h");
  const etags = record(fields["etags"], path, "etags");
  const lastFields = fields["last"] === null ? null : record(fields["last"], path, "last");
  const verdict = lastFields === null ? null : VERDICTS.find(item => item === lastFields["verdict"]);
  if (lastFields !== null && verdict === undefined) fail(path, "last.verdict is unknown");
  return {
    schema: STATE_SCHEMA,
    origin: stringValue(fields["origin"], path, "origin"),
    project: stringValue(fields["project"], path, "project"),
    requested: stringValue(fields["requested"], path, "requested"),
    deploymentId,
    window: window as ComparisonWindow,
    policy,
    policyHash: policyHash(policy),
    pinnedAtMs: integer(fields["pinnedAtMs"], path, "pinnedAtMs"),
    polls: integer(fields["polls"], path, "polls"),
    requests: integer(fields["requests"], path, "requests"),
    etags: Object.fromEntries(Object.entries(etags).map(([key, value]) => [key, stringValue(value, path, "etag")])),
    safety: decodeSafety(fields["safety"], path),
    evidence: decodeEvidence(fields["evidence"], path, deploymentId, window as ComparisonWindow),
    last: lastFields === null || verdict === null || verdict === undefined ? null : { evaluatedAtMs: integer(lastFields["evaluatedAtMs"], path, "last.evaluatedAtMs"), verdict }
  };
}
