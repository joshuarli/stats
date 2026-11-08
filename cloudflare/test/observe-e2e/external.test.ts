import assert from "node:assert/strict";
import { test } from "node:test";
import { OBSERVE_SERVICE, rebasedBatch } from "../support/observe-ingest.ts";
import { accessHeaders, createHost, start } from "./harness.ts";

await test("the same external batch reads back normalized on workerd", async () => {
  const harness = await start("attached");
  try {
    const host = await createHost(harness, "tansu-host");
    const created = await harness.stats("/api/v1/admin/services", {
      method: "POST",
      headers: await accessHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: OBSERVE_SERVICE, hostIds: [host.hostId] })
    });
    assert.equal(created.status, 201, await created.clone().text());
    const { ingestToken, deployToken } = await created.json() as { ingestToken: string; deployToken: string };
    const now = Date.now();
    const batch = rebasedBatch(now);
    const post = (token: string | null, body: string) => harness.stats(`/ingest/observe/v1/${OBSERVE_SERVICE}/batches`, {
      method: "POST",
      headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
      body
    });

    const first = await post(ingestToken, batch.text);
    assert.equal(first.status, 202, await first.clone().text());
    assert.deepEqual(await first.json(), { accepted: 2, duplicate: 0 });
    const replay = await post(ingestToken, batch.text);
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.deepEqual(await replay.json(), { accepted: 0, duplicate: 2 });

    const read = await harness.stats(`/api/observe/${OBSERVE_SERVICE}/external?from=${now - 300_000}&to=${now}`, { headers: await accessHeaders() });
    assert.equal(read.status, 200, await read.clone().text());
    const body = await read.json() as { events: { event: unknown; provenance: string }[] };
    assert.deepEqual(body.events.map(entry => entry.event), batch.events);
    assert.ok(body.events.every(entry => entry.provenance === "application"));

    const totals = await harness.stats(`/api/observe/${OBSERVE_SERVICE}/external/operations?from=${now - 300_000}&to=${now}`, { headers: await accessHeaders() });
    assert.equal(totals.status, 200, await totals.clone().text());
    const summary = await totals.json() as { operations: { operation: string; events: number }[] };
    assert.equal(summary.operations.reduce((sum, row) => sum + row.events, 0), batch.events.length);

    assert.equal((await post(deployToken, batch.text)).status, 401);
    assert.equal((await post(null, batch.text)).status, 401);
    assert.equal((await post(ingestToken, JSON.stringify({ events: [] }))).status, 400);
    assert.equal((await harness.stats("/api/observe/absent/external", { headers: await accessHeaders() })).status, 404);
  } finally {
    await harness.dispose();
  }
});
