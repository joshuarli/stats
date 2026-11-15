import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string" }, output: { type: "string" }, rounds: { type: "string", default: "5" }, hours: { type: "string" }, compare: { type: "boolean", default: false } } });
assert.ok(values.root && values.output);
const rounds = Number(values.rounds); assert.ok(Number.isSafeInteger(rounds) && rounds >= 0 && rounds <= 5);
const proof = JSON.parse(readFileSync(`${values.root}/native-scale-preparation.json`, "utf8"));
const auth = JSON.parse(readFileSync(`${values.root}/native-scale-state/fixture-auth.json`, "utf8"));
const headers = { "Stats-Gateway-Secret": auth.secret, "Stats-Tailnet-Identity": "user:benchmark@example.invalid" };
const expected = new Map(), records = [];
const readiness = { attempts: [], ms: null };
const windows = values.hours === undefined ? [1, 6, 24, 144] : [Number(values.hours)];
assert.ok(windows.every(hours => [1, 6, 24, 144].includes(hours)));
const counts = new Map(proof.referenceWindows.map(window => [window.hours, window.events])); counts.set(144, proof.events);
let ready = false;
for (let attempt = 0; attempt < 1200; attempt++) {
  try { const response = await fetch("http://127.0.0.1:8787/health", { signal: AbortSignal.timeout(1000) }); if (response.status === 200) { ready = true; break; } } catch {}
  await new Promise(done => setTimeout(done, 100));
}
assert.ok(ready, "isolated application did not become ready");
const readinessStarted = performance.now();
ready = false;
for (let attempt = 0; attempt < 120; attempt++) {
  let response;
  try { response = await fetch("http://127.0.0.1:8787/api/v1/admin/objects/observe:stats/maintenance", { headers, signal: AbortSignal.timeout(10000) }); }
  catch (error) { readiness.attempts.push({ error: error.name }); }
  if (response) {
    readiness.attempts.push({ status: response.status });
    if (response.status === 200) { assert.equal((await response.json()).state, "open"); ready = true; break; }
    await response.body?.cancel();
    assert.ok([502, 503, 504].includes(response.status), `unexpected readiness status ${response.status}`);
  }
  if (performance.now() - readinessStarted > 120000) break;
  await new Promise(done => setTimeout(done, 100));
}
readiness.ms = performance.now() - readinessStarted;
assert.ok(ready, "fixture actor did not become ready; no summary timing samples accepted");
const variants = values.compare ? ["payload", "projection"] : [undefined];
for (let round = -1; round < rounds; round++) for (const hours of windows) for (const variant of (round >= 0 && round % 2 ? [...variants].reverse() : variants)) {
  const toMs = proof.toMs, fromMs = toMs - hours * 3600000;
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:8787/api/observe/stats/external/telemetry/summary?from=${fromMs}&to=${toMs}${variant === undefined ? "" : `&__prototype=${variant}`}`, { headers, signal: AbortSignal.timeout(120000) });
  const text = await response.text(), ms = performance.now() - started;
  assert.equal(response.status, 200);
  if (variant !== undefined) assert.equal(response.headers.get("Stats-Prototype-Source"), variant, "actual actor query source must match the requested variant");
  const data = JSON.parse(text);
  assert.equal(data.fromMs, fromMs); assert.equal(data.toMs, toMs);
  assert.equal(data.totals.events, counts.get(hours)); assert.ok(data.buckets.length && data.operations.length);
  const hash = createHash("sha256").update(text).digest("hex");
  if (expected.has(hours)) assert.equal(hash, expected.get(hours), "complete response changed"); else expected.set(hours, hash);
  records.push({ round, condition: round === -1 ? "first-ranges-after-actor-readiness" : "awake-repeated", variant, actualSource: response.headers.get("Stats-Prototype-Source"), hours, ms, timing: response.headers.get("server-timing"), events: data.totals.events, responseSha256: hash });
  writeFileSync(values.output, JSON.stringify({ diagnostic: true, hostGates: "recorded separately; not percentile acceptance", sourceImage: proof.sourceImage, fixtureSha256: proof.fixtureSha256, events: proof.events, readiness, state: "production image with embedded Engine, two Workers, instrumentation disabled, separate small client; historical fixed windows; 144h covers full corpus and is not seven-day acceptance; metadata-only actor readiness precedes all range timing", records }) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(records.at(-1)));
}
