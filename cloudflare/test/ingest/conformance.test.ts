import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../../src/protocol.ts";
import { encodeFrame, type SourceBatch as EncoderBatch } from "../../src/ingest/encode.ts";
import { decodeFrame } from "../../src/ingest/frame.ts";
import { normalizeSystem, validateSample } from "../../src/ingest/sample.ts";
import { batches, readBytes, readJson, type SourceBatch } from "./corpus.ts";

function decodeCase(frame: string) {
  const decoded = decodeFrame(readBytes(frame));
  if (!decoded.ok) throw new Error(`${frame}: ${decoded.code} ${decoded.message}`);
  return decoded.batch;
}

await test("every Rust-encoded golden frame decodes to its independently stated semantic source", () => {
  const cases = batches();
  assert.ok(cases.length >= 30);
  for (const entry of cases) {
    const source = readJson<SourceBatch>(entry.source);
    for (const frame of [entry.frame, entry.frame.replace(/\.stb2$/u, ".absolute.stb2")]) {
      const batch = decodeCase(frame);
      assert.equal(batch.hostId, source.hostId, frame);
      assert.equal(batch.bootId, source.bootId, frame);
      assert.equal(batch.system === undefined ? undefined : canonicalJson(normalizeSystem(batch.system)), source.system === undefined ? undefined : canonicalJson(source.system), frame);
      assert.equal(batch.samples.length, source.samples.length, frame);
      const results = batch.samples.map(validateSample);
      assert.deepEqual(results.map(result => (result.ok ? "accept" : "invalid_sample")), entry.samples, frame);
      for (const [index, result] of results.entries()) {
        if (result.ok) assert.equal(canonicalJson(result.sample), canonicalJson(source.samples[index]), `${frame}[${index}]`);
        else assert.equal(result.seq, source.samples[index]!.seq, `${frame}[${index}]`);
      }
    }
  }
});

await test("delta and absolute encodings of one batch decode to identical canonical content", () => {
  for (const entry of batches()) {
    const delta = decodeCase(entry.frame).samples.map(validateSample);
    const absolute = decodeCase(entry.frame.replace(/\.stb2$/u, ".absolute.stb2")).samples.map(validateSample);
    assert.deepEqual(delta.map(result => (result.ok ? canonicalJson(result.sample) : result.seq)), absolute.map(result => (result.ok ? canonicalJson(result.sample) : result.seq)), entry.name);
  }
});

await test("the production encoder reproduces every golden frame byte for byte, delta and absolute", () => {
  for (const entry of batches()) {
    const source = readJson<SourceBatch>(entry.source) as EncoderBatch;
    assert.deepEqual(encodeFrame(source), readBytes(entry.frame), entry.name);
    assert.deepEqual(encodeFrame(source, { delta: false }), readBytes(entry.frame.replace(/\.stb2$/u, ".absolute.stb2")), `${entry.name} absolute`);
  }
});
