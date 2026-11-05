import test from "node:test";
import assert from "node:assert/strict";
import { POLICIES } from "../../src/observe/cloudflare/policies.ts";
import { sampled } from "../../src/observe/core/sampling.ts";

await test("stats and usr-memories keep every observed invocation, and nanoshop-storied is sampled", () => {
  assert.deepEqual(POLICIES.stats.sampling, { kind: "all" });
  assert.deepEqual(POLICIES["usr-memories"].sampling, { kind: "all" });
  const nanoshop = POLICIES["nanoshop-storied"].sampling;
  if (nanoshop.kind !== "sampled") assert.fail("nanoshop-storied is sampled");
  assert.deepEqual(nanoshop, sampled(nanoshop));
});

await test("a sampled policy accepts only integer rates and positive integer thresholds", () => {
  assert.deepEqual(sampled({ keepPerMillion: 0, slowWallMs: 1, slowCpuMs: 1 }), { kind: "sampled", keepPerMillion: 0, slowWallMs: 1, slowCpuMs: 1 });
  assert.equal(sampled({ keepPerMillion: 1_000_000, slowWallMs: 1, slowCpuMs: 1 }).keepPerMillion, 1_000_000);
  for (const bad of [
    { keepPerMillion: -1, slowWallMs: 100, slowCpuMs: 10 },
    { keepPerMillion: 1_000_001, slowWallMs: 100, slowCpuMs: 10 },
    { keepPerMillion: 0.5, slowWallMs: 100, slowCpuMs: 10 },
    { keepPerMillion: 10_000, slowWallMs: 0, slowCpuMs: 10 },
    { keepPerMillion: 10_000, slowWallMs: 100, slowCpuMs: 1.5 },
    { keepPerMillion: Number.NaN, slowWallMs: 100, slowCpuMs: 10 }
  ]) assert.throws(() => sampled(bad), RangeError, JSON.stringify(bad));
});
