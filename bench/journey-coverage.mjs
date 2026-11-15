import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, release: { type: "string" } } });
assert.ok(values.input && values.output && values.release);
const raw = readFileSync(values.input), capture = JSON.parse(raw);
assert.equal(capture.complete, true);
const events = capture.events.map(row => row.event);
const server = new Map(events.filter(event => event.operation === "http.get.application-summary" && event.trace).map(event => [`${event.trace.traceId}:${event.trace.spanId}`, event]));
const phases = new Map(), gaps = new Map();
let slow = 0, attributed = 0, uncompleted = 0, cached = 0;
const examples = [];
for (const event of events) {
  if (event.release !== values.release || !/^ui\.(navigation|range|refresh)\.(1h|6h|24h|7d|30d)\.(cache|read)$/u.test(event.operation) || event.durationMs <= 1000) continue;
  if (event.atMs + event.durationMs > capture.toMs) { uncompleted++; continue; }
  slow++;
  const work = event.work, failures = [], parts = {};
  const requirePhase = key => { if (!Number.isSafeInteger(work[key]) || work[key] < 0) failures.push(`missing:${key}`); };
  const bound = (name, outer, inner) => {
    if (outer + 2000 < inner) failures.push(`inconsistent:${name}`);
    return Math.max(0, outer - inner);
  };
  if (!/^(?!0{32})[0-9a-f]{32}$/u.test(event.trace?.traceId ?? "") || !/^(?!0{16})[0-9a-f]{16}$/u.test(event.trace?.spanId ?? "")) failures.push("missing:trace");
  if (event.operation.endsWith(".cache")) {
    cached++;
    requirePhase("render_us"); requirePhase("health_us");
    if (Math.abs(event.durationMs * 1000 - work.render_us) > 2000) failures.push("unexplained:cached-duration");
    parts.render = work.render_us;
  } else {
    for (const key of ["bootstrap_us", "fetch_us", "body_us", "decode_us", "render_us", "health_us", "total_us", "dispatch_us", "store_us", "read_us", "query_us", "issues_us", "encode_us"]) requirePhase(key);
    const paired = server.get(`${event.trace?.traceId}:${event.trace?.spanId}`);
    if (!paired) failures.push("missing:paired-http-event");
    else for (const key of ["dispatch_us", "store_us", "read_us", "query_us", "issues_us", "encode_us"]) if (paired.work?.[key] !== work[key]) failures.push(`mismatched:${key}`);
    if (failures.length === 0) {
      parts.bootstrap = work.bootstrap_us; parts.body = work.body_us; parts.decode = work.decode_us; parts.render = work.render_us;
      parts.network = bound("fetch-total", work.fetch_us, work.total_us);
      parts.routing = bound("total-dispatch", work.total_us, work.dispatch_us);
      parts.dispatch = bound("dispatch-store-encode", work.dispatch_us, work.store_us + work.encode_us);
      parts.encode = work.encode_us;
      parts.actor = bound("store-read", work.store_us, work.read_us);
      parts.read = bound("read-query-issues", work.read_us, work.query_us + work.issues_us);
      parts.query = work.query_us; parts.issues = work.issues_us;
      const accounted = work.bootstrap_us + work.fetch_us + work.body_us + work.decode_us + work.render_us;
      if (Math.abs(event.durationMs * 1000 - accounted) > 2000) failures.push("unexplained:browser-duration");
    }
  }
  if (failures.length) {
    for (const gap of failures) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
    if (examples.length < 20) examples.push({ operation: event.operation, outcome: event.outcome, durationMs: event.durationMs, gaps: failures });
  } else {
    const [dominant] = Object.entries(parts).sort((left, right) => right[1] - left[1])[0];
    phases.set(dominant, (phases.get(dominant) ?? 0) + 1); attributed++;
  }
}
const coverage = slow === 0 ? null : attributed / slow;
const report = { release: values.release, sourceSha256: createHash("sha256").update(raw).digest("hex"), fromMs: capture.fromMs, toMs: capture.toMs, capturedEvents: events.length, slowDeliveredJourneys: slow, excludedNotCompletedByCaptureEnd: uncompleted, cached, attributed, coverage, pass: coverage !== null && coverage >= .99, interpretation: "paired stored HTTP trace and complete same-response browser/server timings; nested residuals locate a timing boundary, not a proven cause", toleranceUs: 2000, dominantPhases: Object.fromEntries(phases), gaps: Object.fromEntries(gaps), examples };
writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
