import assert from "node:assert/strict";

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const distribution = values => ({ median: median(values), min: Math.min(...values), max: Math.max(...values), spread: (Math.max(...values) - Math.min(...values)) / median(values) });

export function analyzeOverhead(study) {
  const reasons = [];
  if (study.diagnostic) reasons.push("diagnostic rehearsal is not an acceptance study");
  if (study.error) reasons.push(study.error);
  if (study.fixture?.events !== 203950 || !study.fixture.exactReference) reasons.push("complete tenfold reference missing");
  const gates = (study.gates ?? []).filter(gate => ["disabled", "enabled"].includes(gate.variant));
  if (gates.length !== 40 || gates.some(gate => gate.exitCode !== 0)) reasons.push("perf gate deferred: host busy or unavailable");
  const rounds = study.rounds ?? [];
  if (rounds.some(row => ["mac", "lisa"].some(host => [false, true].some(post => gates.filter(gate => gate.variant === row.variant && gate.round === row.round && gate.host === host && gate.post === post).length !== 1)))) reasons.push("each round requires both host gates before and after measurement");
  if (rounds.some(row => row.requests !== 800 || row.ingested !== 1024)) reasons.push("fixed 800-read and 1024-event workload required in every round");
  const metrics = {};
  for (const variant of ["disabled", "enabled"]) {
    const rows = rounds.filter(row => row.variant === variant);
    if (rows.length < 5 || new Set(rows.map(row => row.round)).size !== rows.length) reasons.push(`${variant}: five distinct rounds required`);
    if (rows.some(row => row.clients !== 10 || row.browserFailures !== 0 || row.requests <= 0 || row.ingested <= 0 || !row.exact || row.memoryOom !== 0)) reasons.push(`${variant}: workload or correctness failure`);
    if (rows.some(row => ["1h", "6h", "24h", "7d"].some(range => row.ranges?.[range]?.uncached !== 200 || row.ranges?.[range]?.cached !== 200))) reasons.push(`${variant}: incomplete per-range browser journeys`);
    if (rows.some(row => !Number.isFinite(row.statsCpuUs) || row.statsCpuUs <= 0 || !Number.isFinite(row.engineCpuUs) || row.engineCpuUs < 0 || !Number.isFinite(row.latencyMs) || row.latencyMs <= 0)) reasons.push(`${variant}: invalid measurements`);
    if (rows.some(row => ["1h", "6h", "24h", "7d"].some(range => !Number.isFinite(row.rangeLatencyMs?.[range]?.p95) || row.rangeLatencyMs[range].p95 <= 0))) reasons.push(`${variant}: per-range p95 latency missing`);
    if (variant === "enabled" && rows.some(row => row.collectorSent <= 0 || row.collectorReceived <= 0)) reasons.push("enabled instrumentation did not deliver observations");
    if (variant === "enabled" && rows.some(row => row.applicationDeliveryFailures !== 0)) reasons.push("application observations failed during measurement");
    if (variant === "enabled" && rows.some(row => !(row.uiDelivery?.attempted > 0) || row.uiDelivery.failed !== 0 || row.uiDelivery.pending !== 0 || row.uiDelivery.dropped !== 0)) reasons.push("browser observation delivery incomplete");
    if (rows.length && rows.every(row => row.statsCpuUs > 0 && row.latencyMs > 0)) metrics[variant] = { statsCpuUs: distribution(rows.map(row => row.statsCpuUs)), engineCpuUs: distribution(rows.map(row => row.engineCpuUs)), latencyMs: distribution(rows.map(row => row.latencyMs)), latencyByRange: Object.fromEntries(["1h", "6h", "24h", "7d"].filter(range => rows.every(row => row.rangeLatencyMs?.[range]?.p95 > 0)).map(range => [range, distribution(rows.map(row => row.rangeLatencyMs[range].p95))])) };
  }
  if (rounds.length !== 10 || rounds.some((row, index) => row.variant !== (index % 2 ? "enabled" : "disabled") || row.round !== Math.floor(index / 2))) reasons.push("five interleaved disabled/enabled pairs required");
  if (!study.collectorFailure?.exactOutcomes || !(study.collectorFailure.failedExports > 0)) reasons.push("collector-failure outcome parity missing");
  const valid = reasons.length === 0;
  let verdict = "inconclusive", cpuOverhead = null, latencyOverhead = null;
  const latencyOverheadByRange = {};
  if (metrics.disabled && metrics.enabled) {
    cpuOverhead = metrics.enabled.statsCpuUs.median / metrics.disabled.statsCpuUs.median - 1;
    for (const range of ["1h", "6h", "24h", "7d"]) if (metrics.enabled.latencyByRange[range] && metrics.disabled.latencyByRange[range]) latencyOverheadByRange[range] = metrics.enabled.latencyByRange[range].median / metrics.disabled.latencyByRange[range].median - 1;
    latencyOverhead = Math.max(...Object.values(latencyOverheadByRange));
    for (const variant of ["disabled", "enabled"]) {
      if (metrics[variant].statsCpuUs.spread > .03) reasons.push(`${variant}: CPU spread exceeds 3%`);
      for (const [range, metric] of Object.entries(metrics[variant].latencyByRange)) if (metric.spread > .05) reasons.push(`${variant}: ${range} p95 latency spread exceeds 5%`);
    }
    if (reasons.length === 0) verdict = cpuOverhead < .03 && latencyOverhead < .05 ? "pass" : "fail";
  }
  return { valid, verdict, cpuOverhead: valid ? cpuOverhead : null, latencyOverhead: valid ? latencyOverhead : null, latencyOverheadByRange: valid ? latencyOverheadByRange : {}, metrics, reasons };
}

export function processCpu(stat) {
  const end = stat.lastIndexOf(")");
  assert.ok(end > 0, "invalid Linux process stat");
  const fields = stat.slice(end + 2).trim().split(/\s+/u);
  const ticks = Number(fields[11]) + Number(fields[12]);
  assert.ok(Number.isSafeInteger(ticks) && ticks >= 0);
  return { ticks, start: fields[19] };
}
