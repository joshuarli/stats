export const ERROR_CODES = [
  "invalid_request",
  "invalid_frame",
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
  "gone",
  "internal"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
