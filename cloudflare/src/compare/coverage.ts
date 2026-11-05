import type { InvocationWindowRow, OutcomeWindowRow } from "../observe/core/store.ts";

export const COVERAGE_TOLERANCE_PERCENT = 5;
export const COVERAGE_BUCKET_MS = 300_000;

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
 * `null` or an empty list means the source lacks the window. A bucket absent from either source is missing, never zero.
 * The tolerance is inclusive: a spread of exactly 5 percent is reconciled.
 */
export function computeCoverage(input: { readonly fromMs: number; readonly toMs: number; readonly observed: readonly BucketCount[] | null; readonly analytics: readonly BucketCount[] | null }): Coverage {
  const { observed, analytics } = input;
  if (observed === null || analytics === null || observed.length === 0 || analytics.length === 0) {
    return { state: "unknown", spread: null, observed: null, analytics: null, missingBuckets: 0 };
  }
  const inWindow = (counts: readonly BucketCount[]) => new Map(counts.filter(item => item.atMs >= input.fromMs && item.atMs < input.toMs && item.atMs % COVERAGE_BUCKET_MS === 0).map(item => [item.atMs, item.value]));
  const seen = inWindow(observed), counted = inWindow(analytics);
  if (seen.size === 0 || counted.size === 0) return { state: "unknown", spread: null, observed: null, analytics: null, missingBuckets: 0 };
  let missingBuckets = 0;
  for (let at = input.fromMs; at < input.toMs; at += COVERAGE_BUCKET_MS) if (!seen.has(at) || !counted.has(at)) missingBuckets += 1;
  const observedTotal = [...seen.values()].reduce((sum, value) => sum + value, 0);
  const analyticsTotal = [...counted.values()].reduce((sum, value) => sum + value, 0);
  const spread = analyticsTotal === 0 ? null : Math.abs(observedTotal - analyticsTotal) / analyticsTotal;
  const within = analyticsTotal > 0 && Math.abs(observedTotal - analyticsTotal) * 100 <= analyticsTotal * COVERAGE_TOLERANCE_PERCENT;
  return { state: missingBuckets === 0 && within ? "reconciled" : "partial", spread, observed: observedTotal, analytics: analyticsTotal, missingBuckets };
}
