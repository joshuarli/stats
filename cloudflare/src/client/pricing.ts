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
  d1Storage: 0.75
} as const;

export const DURABLE_OBJECT_MEMORY_GB = 0.128;
export const BYTES_PER_GB = 1e9;
