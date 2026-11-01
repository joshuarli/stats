export const ERROR_CODES = [
  "invalid_request",
  "invalid_json",
  "unknown_version",
  "invalid_batch",
  "invalid_sample",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "too_large",
  "too_old",
  "conflict",
  "not_found",
  "internal"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const REJECT_CODES = ["too_large", "invalid_json", "unknown_version", "invalid_batch", "invalid_sample"] as const;
export type RejectCode = (typeof REJECT_CODES)[number];
