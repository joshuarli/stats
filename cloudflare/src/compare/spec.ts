import { PRICING_REVISION } from "../cost/pricing.ts";
import { OBSERVE_FILTER_REVISION } from "../observe/core/limits.ts";
import type { OperationId } from "../observe/producer/channel.ts";

export const MEASUREMENT_REVISION = 1;

export type ComparableOperation = Exclude<OperationId, "deployments.poll" | "cleanup.retention">;
export type ClasslessOperation = Exclude<ComparableOperation, "host.history" | "project.history">;
export type ClassedOperation = Exclude<ComparableOperation, ClasslessOperation>;

export type ComparisonScope =
  | { readonly operation: ClasslessOperation; readonly workloadClass: null }
  | { readonly operation: ClassedOperation; readonly workloadClass: string };

export interface ComparisonSide {
  readonly deploymentId: string | null;
  readonly versionIds: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
}

export interface MeasurementIdentity {
  readonly measurement: number;
  readonly observeFilter: number;
  readonly pricing: string;
}

export interface ComparisonSpec {
  readonly before: ComparisonSide;
  readonly after: ComparisonSide;
  readonly scope: ComparisonScope | null;
  readonly measurementRevision: MeasurementIdentity;
}

export interface SpecWindowQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly operation?: ComparableOperation;
}

export function measurementIdentity(): MeasurementIdentity {
  return { measurement: MEASUREMENT_REVISION, observeFilter: OBSERVE_FILTER_REVISION, pricing: PRICING_REVISION };
}

export function buildComparisonSpec(input: { readonly before: ComparisonSide; readonly after: ComparisonSide; readonly scope?: ComparisonScope }): ComparisonSpec {
  return { before: input.before, after: input.after, scope: input.scope ?? null, measurementRevision: measurementIdentity() };
}

export function scopeSpec(spec: ComparisonSpec, scope: ComparisonScope): ComparisonSpec {
  return { ...spec, scope };
}

/** Query for `/api/observe/<service>/window` with the spec's exact bounds; the class filter is left off so workload shares stay computable. */
export function windowQuery(spec: ComparisonSpec, side: "before" | "after"): SpecWindowQuery {
  const { fromMs, toMs } = spec[side];
  return spec.scope === null ? { fromMs, toMs } : { fromMs, toMs, operation: spec.scope.operation };
}
