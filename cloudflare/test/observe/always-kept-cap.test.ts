import test from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_KEPT_PER_BUCKET, AlwaysKeptCap } from "../../src/observe/core/always-kept-cap.ts";
import { COUNT_BUCKET_MS } from "../../src/observe/core/limits.ts";

await test("a cap admits its limit in a bucket, refuses the rest, and starts over in the next bucket", () => {
  const cap = new AlwaysKeptCap();
  const admitted = (bucketAt: number) => Array.from({ length: ALWAYS_KEPT_PER_BUCKET + 5 }, () => cap.admit(bucketAt)).filter(Boolean).length;
  assert.equal(admitted(COUNT_BUCKET_MS), ALWAYS_KEPT_PER_BUCKET);
  assert.equal(admitted(2 * COUNT_BUCKET_MS), ALWAYS_KEPT_PER_BUCKET);
  assert.equal(cap.admit(2 * COUNT_BUCKET_MS), false);
});

await test("a late event for the previous bucket does not reopen a bucket that is full", () => {
  const cap = new AlwaysKeptCap();
  for (let n = 0; n < ALWAYS_KEPT_PER_BUCKET; n++) cap.admit(COUNT_BUCKET_MS);
  assert.equal(cap.admit(2 * COUNT_BUCKET_MS), true);
  assert.equal(cap.admit(COUNT_BUCKET_MS), false);
});
