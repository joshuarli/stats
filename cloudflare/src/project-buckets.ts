import { HOUR_MS, MAX_POINTS, MINUTE_MS } from "./limits.ts";

export const PROJECT_BASE_BUCKET_MS = 5 * MINUTE_MS;
export const PROJECT_BUCKET_WIDTHS_MS = [PROJECT_BASE_BUCKET_MS, 15 * MINUTE_MS, HOUR_MS, 3 * HOUR_MS] as const;

export function projectBucketWidthMs(rangeMs: number): number {
  const width = PROJECT_BUCKET_WIDTHS_MS.find(candidate => rangeMs / candidate <= MAX_POINTS);
  if (width === undefined) throw new RangeError("range is too long for the widest bucket");
  return width;
}
