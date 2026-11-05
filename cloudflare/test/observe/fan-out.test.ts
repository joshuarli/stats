import test from "node:test";
import assert from "node:assert/strict";
import { awaitEvery } from "../../src/observe/core/fan-out.ts";

await test("one service's failed delivery waits for the others to finish before it is reported", async () => {
  let statsStored = false;
  const stats = new Promise<void>(resolve => setTimeout(() => { statsStored = true; resolve(); }, 20));
  const nanoshop = Promise.reject(new Error("nanoshop store unavailable"));
  await assert.rejects(awaitEvery([nanoshop, stats]), /nanoshop store unavailable/);
  assert.equal(statsStored, true);
});

await test("every failure is reported when several services fail", async () => {
  const failures = awaitEvery([Promise.reject(new Error("first")), Promise.resolve(), Promise.reject(new Error("second"))]);
  await assert.rejects(failures, (error: unknown) => error instanceof AggregateError && error.errors.map(cause => (cause as Error).message).join() === "first,second");
});
