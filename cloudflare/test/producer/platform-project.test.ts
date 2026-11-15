import assert from "node:assert/strict";
import { test } from "node:test";
import { projectBatch, validatePolicy } from "../../../packages/platform-bridge/src/project.ts";
import { attribute, batch, policy } from "./platform-support.ts";
await test("projects only approved fields with exact timing, trace identity and source release", () => {
  validatePolicy(policy);
  const result = projectBatch(batch(), policy);
  assert.equal(result.received, 1);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], { eventId: `${"a".repeat(32)}-${"b".repeat(16)}`, atMs: 1794700000000, operation: "platform.installation.invoke", release: "stats-123456789abc_oo-1.0.2_rk-3.1.2-rc.1", outcome: "ok", durationMs: 1, work: { duration_us: 1235, sample_ppm: 100000 }, trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) } });
  assert.doesNotMatch(JSON.stringify(result), /secret|SELECT|db.statement|actor.id|actor.key/iu);
});
await test("rejects invalid clocks and trace IDs and filters other actors, scopes and resources", () => {
  for (const change of [(b: ReturnType<typeof batch>) => { b.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId = "0".repeat(32); }, (b: ReturnType<typeof batch>) => { b.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.endTimeUnixNano = "1"; }]) {
    const value = batch(); change(value); const result = projectBatch(value, policy); assert.equal(result.events.length, 0); assert.equal(result.invalid, 1);
  }
  const sink = batch(); sink.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes[1] = attribute("rivet.actor.key", "3".repeat(64));
  assert.equal(projectBatch(sink, policy).filtered, 1);
  const foreign = batch(); foreign.resourceSpans[0]!.resource.attributes[0] = attribute("service.name", "other-app");
  assert.equal(projectBatch(foreign, policy).filtered, 1);
  const duplicate = batch(); duplicate.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.push(attribute("rivet.actor.name", "installation-1234abcd"));
  assert.equal(projectBatch(duplicate, policy).events.length, 0);
});
await test("bounds whole batches before admission and maps failures to fixed codes", () => {
  const failure = batch(); const span = failure.resourceSpans[0]!.scopeSpans[0]!.spans[0]!; span.name = "rivet.sqlite.transaction.execute"; span.status.code = 2;
  assert.equal(projectBatch(failure, policy).events[0]?.errorCode, "platform.sqlite.failed");
  failure.resourceSpans[0]!.scopeSpans[0]!.spans = Array.from({ length: 257 }, () => span);
  assert.throws(() => projectBatch(failure, policy), /span cap/u);
  assert.throws(() => validatePolicy({ ...policy, actors: [policy.actors[0]!] }), /both Stats/u);
});
