import type { InvocationWindowRow, OutcomeWindowRow } from "../observe/core/store.ts";

export const COVERAGE_TOLERANCE_PERCENT = 5;
export const COVERAGE_BUCKET_MS = 300_000;
export const COVERAGE_SAMPLING_DEVIATIONS = 3;
export const ANALYTICS_COUNTED_STAGES = ["worker"] as const;
export const STATS_ANALYTICS_SAMPLE_RATE = 0.1;

export type CoverageState = "reconciled" | "partial" | "unknown";
export type CoverageStage = InvocationWindowRow["stage"] | OutcomeWindowRow["stage"];

export interface BucketCount {
  readonly atMs: number;
  readonly value: number;
}

export interface Coverage {
  readonly state: CoverageState;
  readonly spread: number | null;
  readonly observed: number | null;
  readonly analytics: number | null;
  readonly bound: number | null;
  readonly missingBuckets: number;
}

/** Observed invocations plus every outcome class, per event-time bucket, for the stages that the analytics source counts. */
export function observedEventTotals(window: { readonly invocations: readonly InvocationWindowRow[]; readonly outcomes: readonly OutcomeWindowRow[] }, stages: readonly CoverageStage[]): BucketCount[] {
  const totals = new Map<number, number>();
  for (const row of window.invocations) if (stages.includes(row.stage)) totals.set(row.bucketAt, (totals.get(row.bucketAt) ?? 0) + row.count);
  for (const row of window.outcomes) if (stages.includes(row.stage)) totals.set(row.bucketAt, (totals.get(row.bucketAt) ?? 0) + row.count);
  return [...totals].sort((a, b) => a[0] - b[0]).map(([atMs, value]) => ({ atMs, value }));
}

/**
 * `null` or an empty list means the source lacks the window. A bucket absent from the observed source is missing, never zero.
 * An analytics source sampled at `analyticsSampleRate` below 1 omits a bucket in which no event was sampled, so that bucket counts as zero sampled events.
 * The bound is the larger of 5 percent of the analytics total and three standard errors of the sampled estimate; the tolerance is inclusive.
 */
export function computeCoverage(input: { readonly fromMs: number; readonly toMs: number; readonly analyticsSampleRate: number; readonly observed: readonly BucketCount[] | null; readonly analytics: readonly BucketCount[] | null }): Coverage {
  const { observed, analytics, analyticsSampleRate: rate } = input;
  if (!(rate > 0 && rate <= 1)) throw new RangeError("analytics sample rate must be in (0, 1]");
  const unknown: Coverage = { state: "unknown", spread: null, observed: null, analytics: null, bound: null, missingBuckets: 0 };
  if (observed === null || analytics === null || observed.length === 0 || analytics.length === 0) return unknown;
  const inWindow = (counts: readonly BucketCount[]) => new Map(counts.filter(item => item.atMs >= input.fromMs && item.atMs < input.toMs && item.atMs % COVERAGE_BUCKET_MS === 0).map(item => [item.atMs, item.value]));
  const seen = inWindow(observed), counted = inWindow(analytics);
  if (seen.size === 0 || counted.size === 0) return unknown;
  let missingBuckets = 0;
  for (let at = input.fromMs; at < input.toMs; at += COVERAGE_BUCKET_MS) if (!seen.has(at) || (rate === 1 && !counted.has(at))) missingBuckets += 1;
  const observedTotal = [...seen.values()].reduce((sum, value) => sum + value, 0);
  const analyticsTotal = [...counted.values()].reduce((sum, value) => sum + value, 0);
  const spread = analyticsTotal === 0 ? null : Math.abs(observedTotal - analyticsTotal) / analyticsTotal;
  const bound = Math.max(analyticsTotal * COVERAGE_TOLERANCE_PERCENT / 100, COVERAGE_SAMPLING_DEVIATIONS * Math.sqrt(observedTotal * (1 - rate) / rate));
  const within = analyticsTotal > 0 && Math.abs(observedTotal - analyticsTotal) <= bound;
  return { state: missingBuckets === 0 && within ? "reconciled" : "partial", spread, observed: observedTotal, analytics: analyticsTotal, bound, missingBuckets };
}
