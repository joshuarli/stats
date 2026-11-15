export const APPLICATION_SUMMARY_PATH = /^\/api\/observe\/[a-z][a-z0-9-]{0,31}\/external\/telemetry\/summary$/u;
const READ_TIMINGS: Readonly<Record<string, string>> = { "app-dispatch": "dispatch_us", "app-store": "store_us", "app-query": "query_us", "app-issues": "issues_us", "app-read": "read_us", "app-encode": "encode_us", "app-total": "total_us" };

export function readTimings(header: string | null): Record<string, number> {
  const work: Record<string, number> = {};
  if (header === null || header.length > 512) return work;
  for (const entry of header.split(",")) {
    const match = /^(app-[a-z]+);dur=(\d+(?:\.\d{1,3})?)$/u.exec(entry.trim());
    if (match === null || READ_TIMINGS[match[1]!] === undefined) continue;
    const us = Math.round(Number(match[2]) * 1000);
    if (Number.isSafeInteger(us) && us >= 0 && us <= 86_400_000_000) work[READ_TIMINGS[match[1]!]!] = us;
  }
  return work;
}
