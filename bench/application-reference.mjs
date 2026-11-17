export function reference(events, fromMs, toMs) {
  const stepMs = Math.max(1000, Math.ceil((toMs - fromMs) / 120000) * 1000);
  const buckets = new Map(), operations = new Map();
  const empty = atMs => ({ events: 0, failed: 0, cancelled: 0, requests: 0, requestDurationMsSum: 0, requestDurationMsMax: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, durationMsSum: 0, durationMsMax: 0, firstAtMs: atMs, lastAtMs: atMs });
  const add = (total, event) => {
    const status = event.work.http_status;
    const http = Number.isInteger(status) && status >= 100 && status <= 599;
    total.events++;
    total.failed += Number(event.outcome !== "ok"); total.cancelled += Number(event.outcome === "cancelled");
    total.requests += Number(http);
    total.requestDurationMsSum += http ? event.durationMs : 0;
    total.requestDurationMsMax = Math.max(total.requestDurationMsMax, http ? event.durationMs : 0);
    for (const code of [2, 3, 4, 5]) total[`status${code}xx`] += Number(http && Math.floor(status / 100) === code);
    total.durationMsSum += event.durationMs; total.durationMsMax = Math.max(total.durationMsMax, event.durationMs);
    total.firstAtMs = Math.min(total.firstAtMs, event.atMs); total.lastAtMs = Math.max(total.lastAtMs, event.atMs);
  };
  let totals = null;
  for (const event of events) {
    if (event.atMs < fromMs || event.atMs >= toMs) continue;
    totals ??= empty(event.atMs); add(totals, event);
    const atMs = Math.floor((event.atMs - fromMs) / stepMs) * stepMs + fromMs;
    const bucket = buckets.get(atMs) ?? { ...empty(event.atMs), atMs }; add(bucket, event); buckets.set(atMs, bucket);
    const operation = operations.get(event.operation) ?? { ...empty(event.atMs), operation: event.operation }; add(operation, event); operations.set(event.operation, operation);
  }
  const ranked = [...operations.values()].sort((left, right) => right.events - left.events || (left.operation < right.operation ? -1 : left.operation > right.operation ? 1 : 0));
  return { provenance: "application", fromMs, toMs, stepMs, totals, openIssues: 0, buckets: [...buckets.values()].sort((left, right) => left.atMs - right.atMs), operations: ranked.slice(0, 20), moreOperations: ranked.length > 20 };
}
