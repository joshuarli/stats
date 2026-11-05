export const LIST_PRICE_PER_MILLION = {
  workerRequests: 0.3,
  workerCpuMs: 0.02,
  durableObjectRequests: 0.15,
  durableObjectGbSeconds: 12.5,
  d1RowsWritten: 1,
  d1RowsRead: 0.001
} as const;

export const LIST_PRICE_PER_GB_MONTH = {
  r2Storage: 0.015,
  d1Storage: 0.75,
  durableObjectStorage: 0.2
} as const;

export const DURABLE_OBJECT_MEMORY_GB = 0.128;
export const BYTES_PER_GB = 1e9;

export const WORKERS_PAID_INCLUDED = {
  workerRequests: 10_000_000,
  workerCpuMs: 30_000_000,
  durableObjectRequests: 1_000_000,
  durableObjectGbSeconds: 400_000,
  d1RowsWritten: 50_000_000,
  d1RowsRead: 25_000_000_000,
  r2Storage: 10,
  d1Storage: 5,
  durableObjectStorage: 5
} as const;

export const WORKERS_PAID_MONTHLY_FEE = 5;

export const PRICING_REVISION = "2026-11-05";

export interface PricingSource {
  readonly url: string;
  readonly verifiedOn: string;
}

const WORKERS_PRICING = "https://developers.cloudflare.com/workers/platform/pricing/";
const DURABLE_OBJECTS_PRICING = "https://developers.cloudflare.com/durable-objects/platform/pricing/";
const D1_PRICING = "https://developers.cloudflare.com/d1/platform/pricing/";
const R2_PRICING = "https://developers.cloudflare.com/r2/pricing/";
const TAIL_WORKERS = "https://developers.cloudflare.com/workers/observability/logs/tail-workers/";

const source = (url: string): PricingSource => ({ url, verifiedOn: PRICING_REVISION });

export const PRICING_SOURCES = {
  workersPaidMonthlyFee: source(WORKERS_PRICING),
  workerRequests: source(WORKERS_PRICING),
  workerCpuMs: source(WORKERS_PRICING),
  tailWorkerCpuMs: source(TAIL_WORKERS),
  durableObjectRequests: source(DURABLE_OBJECTS_PRICING),
  durableObjectGbSeconds: source(DURABLE_OBJECTS_PRICING),
  durableObjectStorage: source(DURABLE_OBJECTS_PRICING),
  d1RowsWritten: source(D1_PRICING),
  d1RowsRead: source(D1_PRICING),
  d1Storage: source(D1_PRICING),
  r2Storage: source(R2_PRICING)
} as const satisfies Record<keyof typeof WORKERS_PAID_INCLUDED | "workersPaidMonthlyFee" | "tailWorkerCpuMs", PricingSource>;
