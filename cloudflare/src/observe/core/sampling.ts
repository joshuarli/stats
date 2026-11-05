import type { ObservedInvocation } from "./model.ts";

export const MILLION = 1_000_000;

export type Sampling =
  | { readonly kind: "all" }
  | { readonly kind: "sampled"; readonly keepPerMillion: number; readonly slowWallMs: number; readonly slowCpuMs: number };

export type SampledPolicy = Extract<Sampling, { kind: "sampled" }>;

export const KEEP_ALL: Sampling = { kind: "all" };

export function sampled(policy: Omit<SampledPolicy, "kind">): SampledPolicy {
  const { keepPerMillion, slowWallMs, slowCpuMs } = policy;
  if (!Number.isSafeInteger(keepPerMillion) || keepPerMillion < 0 || keepPerMillion > MILLION) throw new RangeError("keepPerMillion must be an integer from 0 to 1000000");
  if (!Number.isSafeInteger(slowWallMs) || slowWallMs < 1) throw new RangeError("slowWallMs must be a positive integer");
  if (!Number.isSafeInteger(slowCpuMs) || slowCpuMs < 1) throw new RangeError("slowCpuMs must be a positive integer");
  return { kind: "sampled", keepPerMillion, slowWallMs, slowCpuMs };
}

export const KEEP_REASONS = ["all", "uncaught", "reported", "status", "outcome", "slow-wall", "slow-cpu", "untraced", "trace-hash"] as const;
export type KeepReason = typeof KEEP_REASONS[number];

export type SamplingSubject = Pick<ObservedInvocation, "trace" | "errors" | "status" | "outcome" | "wallMs" | "cpuMs">;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  return hash;
}

export function keepReason(subject: SamplingSubject, sampling: Sampling): KeepReason | null {
  if (sampling.kind === "all") return "all";
  if (subject.errors.some(error => error.source === "uncaught")) return "uncaught";
  if (subject.errors.length > 0) return "reported";
  if (subject.status !== null && subject.status >= 500) return "status";
  if (subject.outcome !== "ok") return "outcome";
  if (subject.wallMs >= sampling.slowWallMs) return "slow-wall";
  if (subject.cpuMs >= sampling.slowCpuMs) return "slow-cpu";
  if (subject.trace === null) return "untraced";
  return fnv1a32(subject.trace.traceId) % MILLION < sampling.keepPerMillion ? "trace-hash" : null;
}
