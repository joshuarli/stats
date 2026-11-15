import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, factor: { type: "string", default: "10" } } });
assert.ok(values.input && values.output, "--input PRIVATE_CORPUS --output PRIVATE_FIXTURE are required");
const factor = Number(values.factor);
assert.ok(Number.isSafeInteger(factor) && factor >= 1 && factor <= 10);
const source = readFileSync(values.input);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceSha256 = sha256(source);
assert.equal(sourceSha256, "4ef33788757e84e614b35dd2509a942987b7e5350d634bc327a4055d5dd3e006");
const capture = JSON.parse(source);
assert.equal(capture.complete, true);
assert.equal(capture.events.length, 20395);
const events = [], identities = new Set();
let sourceEventBytes = 0, scaledEventBytes = 0;
for (const row of capture.events) sourceEventBytes += Buffer.byteLength(JSON.stringify(row.event));
for (let copy = 0; copy < factor; copy++) for (const { event } of capture.events) {
  const hex = sha256(`${sourceSha256}:${copy}:${event.eventId}`);
  const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  assert.equal(event.eventId.length, 36);
  assert.ok(!identities.has(eventId));
  identities.add(eventId);
  const scaled = { ...event, eventId };
  assert.deepEqual({ ...scaled, eventId: event.eventId }, event);
  scaledEventBytes += Buffer.byteLength(JSON.stringify(scaled));
  events.push(scaled);
}
assert.equal(events.length, capture.events.length * factor);
assert.equal(scaledEventBytes, sourceEventBytes * factor);
const metadata = { sourceSha256, sourceEvents: capture.events.length, factor, events: events.length, sourceEventBytes, scaledEventBytes, fromMs: capture.fromMs, toMs: capture.toMs, firstAtMs: capture.summary.totals.firstAtMs, lastAtMs: capture.summary.totals.lastAtMs, changes: "only eventId; deterministic unique 36-character identities; all other event fields, timestamps and JSON byte lengths preserved" };
const text = JSON.stringify({ metadata, events }) + "\n";
writeFileSync(values.output, text, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ...metadata, bytes: Buffer.byteLength(text), sha256: sha256(text) }));
