import test from "node:test";
import assert from "node:assert/strict";
import { fnv1a32, keepReason, sampled, KEEP_ALL, type SamplingSubject } from "../../src/observe/core/sampling.ts";
import { traceId } from "./support.ts";

const POLICY = sampled({ keepPerMillion: 10_000, slowWallMs: 100, slowCpuMs: 10 });
const NEVER = sampled({ keepPerMillion: 0, slowWallMs: 100, slowCpuMs: 10 });
const ALWAYS = sampled({ keepPerMillion: 1_000_000, slowWallMs: 100, slowCpuMs: 10 });

function subject(overrides: Partial<SamplingSubject> = {}): SamplingSubject {
  return { trace: { traceId: traceId(1), spanId: "00000000000000a1" }, errors: [], status: 200, outcome: "ok", wallMs: 5, cpuMs: 1, ...overrides };
}

await test("fnv1a32 matches the published 32-bit FNV-1a vectors", () => {
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.equal(fnv1a32("a"), 0xe40c292c);
  assert.equal(fnv1a32("foobar"), 0xbf9cf968);
});

await test("every failure, slow invocation, and untraced invocation is kept even at a keep rate of zero", () => {
  const error = { name: "TypeError", message: "", stack: null };
  const cases: [Partial<SamplingSubject>, string][] = [
    [{ errors: [{ ...error, source: "uncaught", operation: null }] }, "uncaught"],
    [{ errors: [{ ...error, source: "caught", operation: "catalog.load" }] }, "reported"],
    [{ status: 500 }, "status"],
    [{ status: 503 }, "status"],
    [{ outcome: "exception" }, "outcome"],
    [{ outcome: "canceled", status: 499 }, "outcome"],
    [{ wallMs: 100 }, "slow-wall"],
    [{ cpuMs: 10 }, "slow-cpu"],
    [{ trace: null }, "untraced"]
  ];
  for (const [overrides, reason] of cases) assert.equal(keepReason(subject(overrides), NEVER), reason, JSON.stringify(overrides));
});

await test("an ok invocation just under both thresholds is kept only by its trace hash", () => {
  const quick = subject({ wallMs: 99, cpuMs: 9, status: 499 });
  assert.equal(keepReason(quick, NEVER), null);
  assert.equal(keepReason(quick, ALWAYS), "trace-hash");
});

await test("the decision depends only on the trace id, so a Worker and its Durable Object invocation agree", () => {
  for (let n = 0; n < 2_000; n++) {
    const worker = subject({ trace: { traceId: traceId(n), spanId: "00000000000000a1" }, wallMs: 3 });
    const object = subject({ trace: { traceId: traceId(n), spanId: "00000000000000b2" }, wallMs: 40, cpuMs: 2, status: null });
    assert.equal(keepReason(worker, POLICY), keepReason(object, POLICY), traceId(n));
  }
});

await test("the kept share of ok invocations tracks keepPerMillion", () => {
  const total = 200_000;
  let kept = 0;
  for (let n = 0; n < total; n++) {
    const id = (BigInt(n) * 0x9e3779b97f4a7c15n + 1n).toString(16).padStart(32, "0").slice(-32);
    if (keepReason(subject({ trace: { traceId: id, spanId: "00000000000000a1" } }), POLICY) !== null) kept++;
  }
  const expected = total * POLICY.keepPerMillion / 1_000_000;
  assert.ok(Math.abs(kept - expected) < 5 * Math.sqrt(expected), `${kept} kept of ${total}, expected about ${expected}`);
});

await test("a service that keeps everything never samples out", () => {
  assert.equal(keepReason(subject(), KEEP_ALL), "all");
  assert.equal(keepReason(subject({ trace: null, status: 500 }), KEEP_ALL), "all");
});
