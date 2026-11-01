export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const RAW_STEP_MS = 15_000;
export const RAW_RETENTION_MS = 2 * DAY_MS;
export const MINUTE_RETENTION_MS = 7 * DAY_MS;
export const HOUR_RETENTION_MS = 90 * DAY_MS;

export const MAX_POINTS = 900;
export const MAX_BODY_BYTES = 65_536;
export const BLOCK_BUCKETS = 16;
export const BLOCK_BOUNDS_US = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000] as const;

export const RANGES = ["1h", "6h", "24h", "7d", "90d"] as const;
export type RangeKey = (typeof RANGES)[number];

export const RANGE_MS: Record<RangeKey, number> = {
  "1h": HOUR_MS,
  "6h": 6 * HOUR_MS,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "90d": HOUR_RETENTION_MS
};

export const HISTORY_KINDS = ["summary", "disks", "nets", "filesystems", "block"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];
