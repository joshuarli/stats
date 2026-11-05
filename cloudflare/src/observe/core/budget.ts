import { DURABLE_OBJECT_MEMORY_GB, LIST_PRICE_PER_MILLION } from "../../cost/pricing.ts";
import { ALWAYS_KEPT_PER_BUCKET } from "./always-kept-cap.ts";
import { COUNT_BUCKET_MS } from "./limits.ts";

export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const DURABLE_OBJECT_ROWS_WRITTEN_PER_MILLION = 1;
const MILLION = 1_000_000;

export const OBSERVATION_BUDGET = { eventsPerMonth: 29_400_000, maxUsd: 1.1, maxRowsWritten: 1_000_000 } as const;

export interface EventRows {
  readonly ingestRows: number;
  readonly retentionRows: number;
}

export interface FlushRows {
  readonly rowsPerFlush: number;
  readonly retentionRowsPerBucket: number;
  readonly retentionRowsPerHour: number;
}

export interface MeasuredFigures {
  readonly kept: EventRows;
  readonly failed: EventRows;
  readonly rejected: EventRows;
  readonly flush: FlushRows;
  readonly maintenanceRowsPerHour: number;
  readonly maintenanceRequestsPerHour: number;
  readonly tailCpuMsPerEvent: number;
  readonly storeBilledMsPerRequest: number;
}

export interface Workload {
  readonly events: number;
  readonly keepPerMillion: number;
  readonly failedPerMillion: number;
  readonly slowPerMillion: number;
  readonly untracedPerMillion: number;
  readonly rejectedPerMillion: number;
  readonly flushIntervalMs: number;
  readonly tailIsolates: number;
}

export interface Projection {
  readonly keptEvents: number;
  readonly failedEvents: number;
  readonly rejectedEvents: number;
  readonly flushes: number;
  readonly rowsWritten: number;
  readonly storeRequests: number;
  readonly tailCpuMs: number;
  readonly storeGbSeconds: number;
  readonly usd: { readonly rows: number; readonly requests: number; readonly cpu: number; readonly duration: number; readonly total: number };
}

function perMillion(value: number, price: number): number {
  return (value * price) / MILLION;
}

export function project(figures: MeasuredFigures, workload: Workload, periodMs: number = MONTH_MS): Projection {
  const share = (perMillionOfEvents: number) => (workload.events * perMillionOfEvents) / MILLION;
  const keptEvents = share(workload.keepPerMillion + workload.slowPerMillion + workload.untracedPerMillion);
  const failedEvents = share(workload.failedPerMillion);
  const rejectedEvents = share(workload.rejectedPerMillion);
  const flushes = workload.tailIsolates * (periodMs / Math.min(workload.flushIntervalMs, COUNT_BUCKET_MS));
  const buckets = periodMs / COUNT_BUCKET_MS;
  const hours = periodMs / HOUR_MS;
  const { flush } = figures;
  const rowsWritten =
    keptEvents * (figures.kept.ingestRows + figures.kept.retentionRows)
    + failedEvents * (figures.failed.ingestRows + figures.failed.retentionRows)
    + rejectedEvents * (figures.rejected.ingestRows + figures.rejected.retentionRows)
    + flushes * flush.rowsPerFlush
    + buckets * flush.retentionRowsPerBucket
    + hours * (flush.retentionRowsPerHour + figures.maintenanceRowsPerHour);
  const storeRequests = keptEvents + failedEvents + rejectedEvents + flushes + hours * figures.maintenanceRequestsPerHour;
  const tailCpuMs = workload.events * figures.tailCpuMsPerEvent;
  const storeGbSeconds = Math.min(storeRequests * figures.storeBilledMsPerRequest / 1000, periodMs / 1000) * DURABLE_OBJECT_MEMORY_GB;
  const usd = {
    rows: perMillion(rowsWritten, DURABLE_OBJECT_ROWS_WRITTEN_PER_MILLION),
    requests: perMillion(storeRequests, LIST_PRICE_PER_MILLION.durableObjectRequests),
    cpu: perMillion(tailCpuMs, LIST_PRICE_PER_MILLION.workerCpuMs),
    duration: perMillion(storeGbSeconds, LIST_PRICE_PER_MILLION.durableObjectGbSeconds)
  };
  return { keptEvents, failedEvents, rejectedEvents, flushes, rowsWritten, storeRequests, tailCpuMs, storeGbSeconds, usd: { ...usd, total: usd.rows + usd.requests + usd.cpu + usd.duration } };
}

export function alwaysKeptStorm(workload: Workload, periodMs: number = MONTH_MS): Workload {
  const stormEvents = workload.tailIsolates * (periodMs / COUNT_BUCKET_MS) * ALWAYS_KEPT_PER_BUCKET;
  return { ...workload, failedPerMillion: (stormEvents / workload.events) * MILLION, slowPerMillion: 0, untracedPerMillion: 0 };
}

export function fits(projection: Projection, budget: { readonly maxUsd: number; readonly maxRowsWritten: number } = OBSERVATION_BUDGET): boolean {
  return projection.usd.total <= budget.maxUsd && projection.rowsWritten <= budget.maxRowsWritten;
}

export const STATS_OBSERVE_COST_REPORT = {
  workerInvocations: 128_280,
  workerCpuMs: 53_040,
  objectCalls: 199_680,
  objectWallMs: 6_334_162.32
} as const;

export const CLOUDFLARE_TAIL_CPU_MS_PER_INVOCATION = STATS_OBSERVE_COST_REPORT.workerCpuMs / STATS_OBSERVE_COST_REPORT.workerInvocations;
export const CLOUDFLARE_STORE_WALL_MS_PER_CALL = STATS_OBSERVE_COST_REPORT.objectWallMs / STATS_OBSERVE_COST_REPORT.objectCalls;

export const NANOSHOP_ASSUMPTIONS = {
  failedPerMillion: 500,
  slowPerMillion: 1_000,
  untracedPerMillion: 45,
  rejectedPerMillion: 45,
  tailIsolates: 3
} as const;
