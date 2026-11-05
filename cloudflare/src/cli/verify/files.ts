import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CommandError, EXIT, usageError } from "../exit.ts";
import { invocationDirectory } from "../snapshot-store.ts";
import type { SafetyRecord } from "./decide.ts";
import { MAX_POLICY_BYTES, parsePolicyText, PolicyError, type Policy } from "./policy.ts";
import type { Source } from "./readiness.ts";

const MAX_SAFETY_BYTES = 256 * 1024;
const DURATION = /^([1-9][0-9]{0,5})(s|m|h|d)$/u;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const MAX_TIMEOUT_MS = 7 * 86_400_000;

export function resolveInvocationPath(file: string): string {
  return resolve(invocationDirectory(), file);
}

function readCapped(file: string, limit: number, what: string): string {
  const path = resolveInvocationPath(file);
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    throw usageError(`cannot open the ${what} ${path}`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit) throw usageError(`the ${what} ${path} must be a regular file of at most ${limit} bytes`);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function readPolicyFile(file: string): Policy {
  const text = readCapped(file, MAX_POLICY_BYTES, "policy file");
  try {
    return parsePolicyText(text);
  } catch (error) {
    if (error instanceof PolicyError) throw new CommandError(EXIT.usage, "policy_invalid", `${resolveInvocationPath(file)}: ${error.message}`);
    throw error;
  }
}

export function readSafetyFile(file: string, origin: string): SafetyRecord {
  const name = resolveInvocationPath(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readCapped(file, MAX_SAFETY_BYTES, "safety check file"));
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw usageError(`${name} is not valid JSON; save the output of \`statsctl check ingest --json\``);
  }
  const bad = (why: string) => new CommandError(EXIT.usage, "safety_check_invalid", `${name}: ${why}`);
  if (typeof parsed !== "object" || parsed === null) throw bad("expected the JSON document printed by `statsctl check ingest --json`");
  const document = parsed as Record<string, unknown>;
  if (document["schema"] !== "statsctl/1" || document["command"] !== "check ingest") throw bad("not a statsctl/1 `check ingest` document");
  if (document["origin"] !== origin) throw bad(`the check ran against ${String(document["origin"])}, not ${origin}`);
  const payload = document["payload"];
  if (typeof payload !== "object" || payload === null) throw bad("the check did not run to a result; it holds an error, not a payload");
  const fields = payload as Record<string, unknown>;
  const steps = fields["steps"];
  if (typeof fields["ok"] !== "boolean" || typeof fields["hostId"] !== "string" || !Number.isSafeInteger(fields["atMs"]) || !Array.isArray(steps)) throw bad("the payload lacks ok, hostId, atMs, and steps");
  const failed = steps.find((step): step is { name: string } => typeof step === "object" && step !== null && (step as { ok?: unknown }).ok === false && typeof (step as { name?: unknown }).name === "string");
  if (fields["ok"] === true && failed !== undefined) throw bad("ok is true but a step failed");
  return { ok: fields["ok"], atMs: fields["atMs"] as number, hostId: fields["hostId"], origin, failedStep: failed?.name ?? null, file: name };
}

export function parseDuration(value: string): number {
  const match = DURATION.exec(value);
  if (match === null) throw usageError("--timeout must be a number of seconds, minutes, hours, or days such as 90s, 30m, 2h, or 1d");
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (ms > MAX_TIMEOUT_MS) throw usageError("--timeout must be at most 7d");
  return ms;
}

export async function source<T>(read: () => Promise<T>): Promise<Source<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error instanceof CommandError && error.exit !== EXIT.auth) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

export function sleepUntil(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolvePromise => {
    if (signal.aborted) return resolvePromise(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolvePromise(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
