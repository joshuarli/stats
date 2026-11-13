import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { eq } from "../../../experiments/rivet/openorange/parity.mts";

const REPO = resolve(import.meta.dirname, "../../..");

const observed = (body: string, overrides: Record<string, unknown> = {}) => ({ status: 200, contentType: "application/vnd.stats.history.v1", etag: "abc", body, ...overrides }) as Parameters<typeof eq>[0];

await test("write-loss negative control: a byte of acknowledged history going missing fails comparison", () => {
  const complete = observed("0011aa22ff");
  const lostWrite = observed("0011aa22");
  assert.equal(eq(complete, complete), true);
  assert.equal(eq(complete, lostWrite), false);
});

await test("missing-metric negative control: one changed byte in one metric fails comparison", () => {
  const complete = observed("0011aa22ff");
  const missingMetric = observed("0011aa22fe");
  assert.equal(eq(complete, missingMetric), false);
  assert.equal(eq(complete, observed(complete.body, { etag: "def" })), false);
  assert.equal(eq(complete, observed(complete.body, { contentType: "application/octet-stream" })), false);
  assert.equal(eq(complete, observed(complete.body, { status: 206 })), false);
});

await test("unmatched-test negative control: a selector matching no test file fails, never silently passes", () => {
  assert.throws(
    () => execFileSync(process.execPath, ["scripts/run-tests.mjs", "--file", "test/does-not-exist.test.ts"], { cwd: join(REPO, "cloudflare"), encoding: "utf8", stdio: "pipe" }),
    /unmatched test selector: test\/does-not-exist\.test\.ts/u,
  );
});
