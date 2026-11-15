import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../.work/tmp");
mkdirSync(root, { recursive: true });
const trace = { traceId: "1".repeat(32), spanId: "2".repeat(16) };
const slow = { release: "test", atMs: 1000000, durationMs: 2000, operation: "ui.range.1h.read", outcome: "ok", trace, work: { bootstrap_us: 100000, fetch_us: 1800000, body_us: 10000, decode_us: 10000, render_us: 80000, health_us: 1900000, total_us: 1700000, dispatch_us: 1600000, store_us: 1500000, read_us: 1400000, query_us: 1300000, issues_us: 20000, encode_us: 1000 } };
const paired = { operation: "http.get.application-summary", trace, work: slow.work };
function run(events, toMs = 2000000) {
  const directory = mkdtempSync(join(root, "journey-coverage-"));
  try {
    const input = join(directory, "capture.json"), output = join(directory, "coverage.json");
    writeFileSync(input, JSON.stringify({ complete: true, fromMs: 900000, toMs, events: events.map(event => ({ event })) }));
    execFileSync(process.execPath, [resolve(import.meta.dirname, "journey-coverage.mjs"), "--input", input, "--output", output, "--release", "test"]);
    return JSON.parse(readFileSync(output, "utf8"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test("slow read requires a paired trace and decomposes nested timing without double-counting", () => {
  const report = run([slow, paired]);
  assert.equal(report.pass, true); assert.equal(report.coverage, 1);
  assert.deepEqual(report.dominantPhases, { query: 1 });
  const unpaired = run([slow]);
  assert.equal(unpaired.pass, false); assert.equal(unpaired.coverage, 0);
  assert.equal(unpaired.gaps["missing:paired-http-event"], 1);
  const mismatched = run([slow, { ...paired, work: { ...paired.work, query_us: 100 } }]);
  assert.equal(mismatched.pass, false); assert.equal(mismatched.gaps["mismatched:query_us"], 1);
});
test("cancelled slow journeys with absent phases stay in the coverage denominator", () => {
  const report = run([slow, paired, { ...slow, outcome: "cancelled", work: {} }]);
  assert.equal(report.slowDeliveredJourneys, 2); assert.equal(report.attributed, 1);
  assert.equal(report.coverage, .5); assert.equal(report.pass, false);
});
test("a cached journey can account for render time without inventing server phases", () => {
  const report = run([{ ...slow, operation: "ui.range.1h.cache", work: { render_us: 2000000, health_us: 2000000 } }]);
  assert.equal(report.pass, true); assert.equal(report.cached, 1);
  assert.deepEqual(report.dominantPhases, { render: 1 });
});
test("missing coverage and contradictory timing cannot pass", () => {
  const empty = run([]); assert.equal(empty.coverage, null); assert.equal(empty.pass, false);
  const contradictory = run([{ ...slow, work: { ...slow.work, total_us: 2000000 } }, paired]);
  assert.equal(contradictory.pass, false); assert.equal(contradictory.gaps["inconsistent:fetch-total"], 1);
  const unfinished = run([slow, paired], slow.atMs + 1000);
  assert.equal(unfinished.excludedNotCompletedByCaptureEnd, 1); assert.equal(unfinished.pass, false);
});
