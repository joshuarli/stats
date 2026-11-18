import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeOrigin, runCli, sendJson } from "./support.ts";

await test("check hosts distinguishes real receipts from a successful stale snapshot", async () => {
  const fresh = Date.now() - 1000;
  const stale = fresh - 600_000;
  const hosts = [
    { name: "lisa", revoked: false, lastReceivedAtMs: fresh },
    { name: "threadripper", revoked: false, lastReceivedAtMs: stale },
    { name: "revoked", revoked: true, lastReceivedAtMs: fresh },
    { name: "ambiguous", revoked: false, lastReceivedAtMs: fresh },
    { name: "ambiguous", revoked: false, lastReceivedAtMs: stale }
  ];
  const origin = await fakeOrigin((_, response) => sendJson(response, { hosts }));
  try {
    const check = (expected: string) => runCli(["check", "hosts", "--origin", origin.origin, "--hosts", expected, "--json"]);
    const pass = await check("lisa");
    assert.equal(pass.code, 0, pass.stderr);
    const readHosts = (stdout: string) => (JSON.parse(stdout) as { payload: { hosts: unknown } }).payload.hosts;
    assert.deepEqual(readHosts(pass.stdout), [{ name: "lisa", state: "reporting", lastReceivedAtMs: fresh }]);
    const fail = await check("threadripper,revoked,ambiguous,missing");
    assert.equal(fail.code, 7, fail.stderr);
    assert.deepEqual(readHosts(fail.stdout), [
      { name: "threadripper", state: "stale", lastReceivedAtMs: stale },
      { name: "revoked", state: "revoked", lastReceivedAtMs: fresh },
      { name: "ambiguous", state: "ambiguous", lastReceivedAtMs: null },
      { name: "missing", state: "missing", lastReceivedAtMs: null }
    ]);
    assert.equal((await check("lisa,lisa")).code, 2);
    assert.deepEqual(origin.seen.map(request => [request.method, request.url]), [["GET", "/api/v1/hosts"], ["GET", "/api/v1/hosts"]]);
  } finally {
    await origin.close();
  }
});
