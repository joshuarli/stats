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
