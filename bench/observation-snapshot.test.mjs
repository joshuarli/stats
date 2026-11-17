import assert from "node:assert/strict";
import { test } from "node:test";
import { captureObjectSnapshot } from "./observation-snapshot.mjs";

test("an admitted fence is restored when its response times out", async () => {
  let state = "open";
  const timeout = new DOMException("fence acknowledgement timed out", "TimeoutError");
  const request = async (_path, body) => {
    if (!body) return { status: 200, body: { state } };
    state = "fenced";
    throw timeout;
  };
  const restore = async () => { state = "open"; };
  await assert.rejects(captureObjectSnapshot({ request, restore }, "observe:stats"), error => error === timeout);
  assert.equal(state, "open");
});

test("a preexisting fence belongs to another operation and stays fenced", async () => {
  const request = async () => ({ status: 200, body: { state: "fenced" } });
  let restored = false;
  const restore = async () => { restored = true; };
  await assert.rejects(captureObjectSnapshot({ request, restore }, "installation"), assert.AssertionError);
  assert.equal(restored, false);
});

test("snapshot and restoration failures are both retained", async () => {
  const failedExport = new Error("export failed"), failedRestore = new Error("restore failed");
  const request = async (path, body) => {
    if (path.endsWith("/export/manifest")) throw failedExport;
    return { status: 200, body: { state: body ? "fenced" : "open" } };
  };
  await assert.rejects(captureObjectSnapshot({ request, restore: async () => { throw failedRestore; } }, "observe:stats"), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failedExport, failedRestore]);
    return true;
  });
});

test("a complete snapshot is returned only after restoration succeeds", async () => {
  const snapshot = { tables: [{ name: "events", rows: 219939, sha256: "a".repeat(64), omitted: true }], schema: ["schema"] };
  let restored = false;
  const request = async (path, body) => path.endsWith("/export/manifest") ? { status: 200, body: snapshot } : { status: 200, body: { state: body ? "fenced" : "open" } };
  const result = await captureObjectSnapshot({ request, restore: async () => { restored = true; } }, "observe:stats");
  assert.equal(restored, true);
  assert.deepEqual(result, { ...snapshot, tables: [{ name: "events", rows: 219939, sha256: "a".repeat(64) }] });
});
