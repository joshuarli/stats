import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFrame } from "../../src/ingest/frame.ts";
import { batches, malformedFrame, readBytes, readJson, type MalformedCase } from "./corpus.ts";

const cases = readJson<{ cases: MalformedCase[] }>("malformed.json").cases;

await test("every malformed frame is rejected whole with its documented code", () => {
  assert.ok(cases.length >= 50);
  for (const entry of cases) {
    const result = decodeFrame(malformedFrame(entry));
    assert.equal(result.ok, false, entry.name);
    if (!result.ok) assert.equal(result.code, entry.code, `${entry.name}: ${result.message}`);
  }
});

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

await test("every strict prefix of every golden frame is rejected", () => {
  for (const entry of batches()) {
    const bytes = readBytes(entry.frame);
    const step = Math.max(1, Math.floor(bytes.length / 400));
    for (let length = 0; length < bytes.length; length += length < 64 ? 1 : step) {
      const result = decodeFrame(bytes.subarray(0, length));
      assert.equal(result.ok, false, `${entry.name} cut at ${length}`);
    }
  }
});

await test("seeded byte mutations of golden frames decode or reject without throwing, in bounded time", () => {
  const next = random(0x51a7_2026);
  const frames = batches().map(entry => readBytes(entry.frame));
  const started = performance.now();
  let rejected = 0;
  for (let round = 0; round < 20_000; round += 1) {
    const bytes = frames[Math.floor(next() * frames.length)]!.slice();
    const edits = 1 + Math.floor(next() * 4);
    for (let edit = 0; edit < edits; edit += 1) {
      const offset = Math.floor(next() * bytes.length);
      bytes[offset] = next() < 0.5 ? bytes[offset]! ^ (1 << Math.floor(next() * 8)) : Math.floor(next() * 256);
    }
    const result = decodeFrame(bytes);
    if (!result.ok) {
      rejected += 1;
      assert.ok(["invalid_frame", "unknown_version", "invalid_batch"].includes(result.code));
    } else {
      assert.ok(result.batch.samples.length >= 1 && result.batch.samples.length <= 16);
    }
  }
  assert.ok(rejected > 10_000);
  assert.ok(performance.now() - started < 20_000);
});
