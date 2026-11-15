import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { origin: { type: "string" }, output: { type: "string" }, hours: { type: "string", default: "168" } } });
assert.ok(values.origin && values.output, "--origin HTTPS_ORIGIN --output PRIVATE_FILE are required");
const origin = new URL(values.origin);
assert.ok(origin.protocol === "https:" && origin.pathname === "/" && !origin.search && !origin.hash && !origin.username && !origin.password, "a bare HTTPS origin is required");
const hours = Number(values.hours);
assert.ok(Number.isSafeInteger(hours) && hours >= 1 && hours <= 168);
const capturedAtMs = Date.now(), toMs = capturedAtMs - 300_000, fromMs = capturedAtMs - hours * 3_600_000;
const events = new Map();
let reads = 0;

async function read(path) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, `capture HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    assert.ok(size <= 32 * 1024 * 1024, "capture response byte limit exceeded");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function capture(from, to) {
  assert.ok(++reads <= 128, "capture request limit exceeded");
  const body = await read(`/api/observe/stats/external?from=${from}&to=${to - 1}&limit=5000`);
  assert.ok(Array.isArray(body.events), "capture response has no events");
  if (body.events.length === 5000) {
    assert.ok(to - from > 1, "dense timestamp cannot be partitioned without truncation");
    const middle = Math.floor((from + to) / 2);
    await capture(from, middle);
    await capture(middle, to);
    return;
  }
  for (const row of body.events) {
    const id = row.event.eventId;
    const prior = events.get(id);
    assert.ok(!prior || JSON.stringify(prior) === JSON.stringify(row), "event changed during capture");
    events.set(id, row);
  }
}

await capture(fromMs, toMs);
const summary = await read(`/api/observe/stats/external/telemetry/summary?from=${fromMs}&to=${toMs}`);
assert.equal(summary.totals?.events ?? 0, events.size, "capture count differs from summary");
const rows = [...events.values()].sort((a, b) => a.event.atMs - b.event.atMs || a.event.eventId.localeCompare(b.event.eventId));
const text = JSON.stringify({ capturedAtMs, fromMs, toMs, reads, complete: true, consistency: "fixed historical read window with count cross-check, not a transactional snapshot", summary, events: rows }) + "\n";
writeFileSync(values.output, text, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ capturedAtMs, fromMs, toMs, reads, complete: true, events: rows.length, firstAtMs: summary.totals?.firstAtMs ?? null, lastAtMs: summary.totals?.lastAtMs ?? null, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }));
