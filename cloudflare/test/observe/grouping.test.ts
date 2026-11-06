import test from "node:test";
import assert from "node:assert/strict";
import { prepareInvocation, truncateUtf8, type MessagePolicy, type ObservedError, type PreparedInvocation } from "../../src/observe/core/model.ts";
import { parseStack } from "../../src/observe/core/stack.ts";
import { POLICIES } from "../../src/observe/core/policies.ts";
import { BUNDLE_STACK, DO_STACK, worker } from "./support.ts";

const SAFE: MessagePolicy = { safeNames: new Set(["ValidationError"]) };

async function prepared(errors: ObservedError[], policy: MessagePolicy = SAFE): Promise<PreparedInvocation> {
  const result = await prepareInvocation(worker(1, { errors, outcome: "exception" }), policy);
  assert.ok(result.ok);
  return result.invocation;
}

async function fingerprintOf(error: Partial<ObservedError>): Promise<string> {
  const invocation = await prepared([{ source: "caught", operation: "ingest.store", name: "AppError", message: "boom", stack: BUNDLE_STACK, ...error }]);
  return invocation.errors[0]!.fingerprint;
}

await test("stack frames from production, bundled, and local stacks normalize to stable files", () => {
  assert.deepEqual(parseStack(DO_STACK), [
    { fn: "failB", file: "src/index.ts", line: 15, column: 13 },
    { fn: "Store.fetch", file: "src/index.ts", line: 36, column: 34 }
  ]);
  assert.deepEqual(parseStack(BUNDLE_STACK).map(frame => [frame.fn, frame.file]), [["failA", "index.js"], ["fetch", "index.js"]]);
  assert.deepEqual(parseStack("    at deepThrow (file:///Users/someone/project/src/producer.mjs:9:27)\n    at async node:internal/run:1:1")[0],
    { fn: "deepThrow", file: "src/producer.mjs", line: 9, column: 27 });
});

await test("the same failure at different bundle positions groups together", async () => {
  const moved = BUNDLE_STACK.replace("index.js:183:27", "index.js:991:3").replace("index.js:1130:15", "index.js:2004:9");
  assert.equal(await fingerprintOf({ stack: moved }), await fingerprintOf({}));
});

await test("messages do not split a group that has a stack", async () => {
  assert.equal(await fingerprintOf({ message: "request 7f3a9c01 failed" }), await fingerprintOf({ message: "other" }));
});

await test("distinct call paths, operations, and error names stay distinct", async () => {
  const base = await fingerprintOf({});
  assert.notEqual(await fingerprintOf({ stack: "    at failB (index.js:10:1)\n    at Object.fetch (index.js:1130:15)" }), base);
  assert.notEqual(await fingerprintOf({ operation: "deployments.poll" }), base);
  assert.notEqual(await fingerprintOf({ name: "TypeError" }), base);
});

await test("without a stack, a safe message groups after normalizing ids and numbers", async () => {
  const a = await fingerprintOf({ name: "ValidationError", stack: null, message: "host 4f2a99c0d1 sent 12 samples" });
  const b = await fingerprintOf({ name: "ValidationError", stack: null, message: "host 0b9e11aa77 sent 3 samples" });
  const c = await fingerprintOf({ name: "ValidationError", stack: null, message: "host 0b9e11aa77 missing" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

await test("messages of unlisted error names are redacted before storage and grouping", async () => {
  const invocation = await prepared([{ source: "caught", operation: null, name: "AppError", message: "cause a token=SECRET_IN_MESSAGE", stack: BUNDLE_STACK }]);
  assert.equal(invocation.errors[0]!.message, null);
  assert.ok(!JSON.stringify(invocation).includes("SECRET_IN_MESSAGE"));
  const kept = await prepared([{ source: "caught", operation: null, name: "ValidationError", message: "bad sample", stack: null }]);
  assert.equal(kept.errors[0]!.message, "bad sample");
});

await test("errors beyond the per-invocation bound are counted, not stored", async () => {
  const error: ObservedError = { source: "uncaught", operation: null, name: "TypeError", message: "x", stack: DO_STACK };
  const invocation = await prepared(Array.from({ length: 6 }, () => error));
  assert.equal(invocation.errorCount, 6);
  assert.equal(invocation.errors.length, 4);
});

await test("utf-8 truncation never splits a character", () => {
  assert.equal(truncateUtf8("aé😀b", 1), "a");
  assert.equal(truncateUtf8("aé😀b", 2), "a");
  assert.equal(truncateUtf8("aé😀b", 3), "aé");
  assert.equal(truncateUtf8("aé😀b", 6), "aé");
  assert.equal(truncateUtf8("aé😀b", 7), "aé😀");
});

await test("malformed invocations are rejected with a reason", async () => {
  const cases: [Partial<Parameters<typeof worker>[1]>, string][] = [
    [{ trace: { traceId: "0".repeat(32), spanId: "1".repeat(16) } }, "invalid_trace"],
    [{ trace: { traceId: "A".repeat(32), spanId: "1".repeat(16) } }, "invalid_trace"],
    [{ version: "worker js" }, "invalid_version"],
    [{ version: "" }, "invalid_version"],
    [{ stage: "object" }, "invalid_object"],
    [{ objectId: "ab" }, "invalid_object"],
    [{ label: "GET /x\nInjected: 1" }, "invalid_label"],
    [{ label: "" }, "invalid_label"],
    [{ status: 42 }, "invalid_status"],
    [{ outcome: "ok; DROP" }, "invalid_outcome"],
    [{ cpuMs: -1 }, "invalid_timing"],
    [{ eventAtMs: 2 ** 60 }, "invalid_timing"],
    [{ errors: [{ source: "caught", operation: "Bad Op", name: "E", message: "", stack: null }] }, "invalid_operation"]
  ];
  for (const [overrides, reason] of cases) {
    assert.deepEqual(await prepareInvocation(worker(1, overrides), SAFE), { ok: false, reason }, reason);
  }
});

await test("an invocation without trace context gets a stable key from its identity", async () => {
  const a = await prepareInvocation(worker(1, { trace: null }), SAFE);
  const b = await prepareInvocation(worker(1, { trace: null }), SAFE);
  const c = await prepareInvocation(worker(1, { trace: null, eventAtMs: worker(1).eventAtMs + 1 }), SAFE);
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(a.invocation.key, b.invocation.key);
  assert.notEqual(a.invocation.key, c.invocation.key);
  assert.match(a.invocation.key, /^[0-9a-f]{32}$/u);
});

await test("every operation any service policy allows passes invocation validation", async () => {
  for (const [service, policy] of Object.entries(POLICIES)) {
    assert.ok(policy.operations.size > 0, service);
    for (const operation of policy.operations) {
      const result = await prepareInvocation(worker(1, { errors: [{ source: "caught", operation, name: "AppError", message: "boom", stack: null }], outcome: "exception" }), SAFE);
      assert.ok(result.ok, `${service} ${operation}`);
    }
  }
  for (const operation of ["Request.cart", "1request", "request cart", "request.cart/x", `r${"a".repeat(64)}`]) {
    const result = await prepareInvocation(worker(1, { errors: [{ source: "caught", operation, name: "AppError", message: "boom", stack: null }] }), SAFE);
    assert.deepEqual(result, { ok: false, reason: "invalid_operation" }, operation);
  }
});
