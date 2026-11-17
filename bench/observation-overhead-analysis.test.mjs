import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeOverhead, processCpu } from "./observation-overhead-analysis.mjs";

function study() {
  return { fixture: { events: 203950, exactReference: true }, gates: Array.from({ length: 10 }, (_, index) => ["mac", "lisa"].flatMap(host => [false, true].map(post => ({ round: Math.floor(index / 2), variant: index % 2 ? "enabled" : "disabled", host, post, exitCode: 0 })))).flat(),
    rounds: Array.from({ length: 10 }, (_, index) => ({ round: Math.floor(index / 2), variant: index % 2 ? "enabled" : "disabled", clients: 10, browserFailures: 0, requests: 800, ingested: 1024, ranges: Object.fromEntries(["1h", "6h", "24h", "7d"].map(range => [range, { cached: 200, uncached: 200 }])), rangeLatencyMs: Object.fromEntries(["1h", "6h", "24h", "7d"].map(range => [range, { p95: index % 2 ? 102 : 100 }])), exact: true, memoryOom: 0, applicationDeliveryFailures: 0, uiDelivery: { attempted: 1600, failed: 0, pending: 0, dropped: 0 }, statsCpuUs: index % 2 ? 1010000 : 1000000, engineCpuUs: 200000, latencyMs: index % 2 ? 102 : 100, collectorSent: 10, collectorReceived: 12 })),
    collectorFailure: { exactOutcomes: true, failedExports: 2 } };
}
test("overhead requires exact delivered work and resolves only within its precision", () => {
  const good = study();
  assert.equal(analyzeOverhead(good).verdict, "pass");
  const diagnostic = structuredClone(good); diagnostic.diagnostic = true;
  assert.equal(analyzeOverhead(diagnostic).verdict, "inconclusive");
  const incomplete = structuredClone(good); incomplete.rounds[0].ranges["7d"].uncached--;
  assert.equal(analyzeOverhead(incomplete).verdict, "inconclusive");
  const noisy = structuredClone(good); noisy.rounds[0].statsCpuUs *= 1.1;
  assert.equal(analyzeOverhead(noisy).verdict, "inconclusive");
  assert.equal(analyzeOverhead(noisy).valid, true);
  const regression = structuredClone(good);
  for (const row of regression.rounds.filter(row => row.variant === "enabled")) row.statsCpuUs *= 1.1;
  assert.equal(analyzeOverhead(regression).verdict, "fail");
  const hidden = structuredClone(good);
  for (const row of hidden.rounds.filter(row => row.variant === "enabled")) row.rangeLatencyMs["7d"].p95 = 110;
  assert.equal(analyzeOverhead(hidden).verdict, "fail", "an aggregate latency improvement cannot hide a range regression");
  const rangeNoise = structuredClone(good); rangeNoise.rounds[0].rangeLatencyMs["1h"].p95 = 110;
  assert.equal(analyzeOverhead(rangeNoise).verdict, "inconclusive");
  const lost = structuredClone(good); lost.rounds[1].uiDelivery.dropped = 1;
  assert.equal(analyzeOverhead(lost).valid, false);
  const duplicateGate = structuredClone(good); duplicateGate.gates[0] = structuredClone(duplicateGate.gates[1]);
  assert.equal(analyzeOverhead(duplicateGate).valid, false);
  for (const mutate of [s => { s.gates[3].exitCode = 75; }, s => { s.rounds.pop(); }, s => { s.rounds[1].collectorSent = 0; }, s => { s.rounds[0].ingested = 0; }, s => { s.rounds[0].exact = false; }, s => { s.rounds[0].browserFailures++; }, s => { s.collectorFailure.exactOutcomes = false; }, s => { s.collectorFailure.failedExports = 0; }, s => { s.rounds[0].statsCpuUs = NaN; }, s => { s.rounds.reverse(); }]) {
    const invalid = structuredClone(good); mutate(invalid);
    assert.equal(analyzeOverhead(invalid).verdict, "inconclusive");
    assert.equal(analyzeOverhead(invalid).valid, false);
  }
});
test("Linux CPU accounting handles process names containing spaces and parentheses", () => {
  const fields = Array(30).fill("0"); fields[0] = "S"; fields[11] = "123"; fields[12] = "45"; fields[19] = "98765";
  assert.deepEqual(processCpu(`42 (node (worker)) ${fields.join(" ")}`), { ticks: 168, start: "98765" });
});
