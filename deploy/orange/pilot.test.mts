import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { openHistory } from "../../cloudflare/src/binary/history.ts";
import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from "../../cloudflare/src/cloudflare/gateway.ts";
import { decodeAck } from "../../cloudflare/src/ingest/ack-decode.ts";
import { encodeFrame } from "../../cloudflare/src/ingest/encode.ts";
import { INGEST_MEDIA_TYPE, INGEST_PATH } from "../../cloudflare/src/ingest/http.ts";
import { fixtureBytes, fixtureSource, manifest, NOW_MS, withHost } from "../../cloudflare/test/node/support.ts";
import { generate } from "./generate.mts";
import { freePort, startSession, type Session } from "./session.mts";

const SCRATCH = resolve(import.meta.dirname, "../../.work/tmp");

await test("the Stats Workers run on OpenOrange with gateway identity, exact ingest, and durable history", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const stateDir = join(SCRATCH, `orange-pilot-${process.pid}`);
  rmSync(stateDir, { recursive: true, force: true });
  const secret = randomBytes(32).toString("hex");
  const generated = generate(stateDir, { kind: "dev", release: "pilot", gatewaySecret: secret, nowMs: String(NOW_MS) });
  assert.deepEqual(generated.dropped.map(entry => entry.item).sort(), ["ANALYTICS_SQL (analytics)", "tail consumer stats-observe"]);
  const statsDescriptor = JSON.parse(readFileSync(generated.stats, "utf8")) as { vars: Record<string, string>; durable_objects: { bindings: { name: string; class_name: string }[] }; services: { binding: string; service: string }[] };
  assert.deepEqual(statsDescriptor.durable_objects.bindings, [{ name: "INSTALLATION", class_name: "Installation" }]);
  assert.deepEqual(statsDescriptor.services, [{ binding: "OBSERVE", service: "stats-observe" }]);

  const identity = { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: "user:pilot@example.com" };
  const tagged = { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: "tags:tag:ci" };
  const batch = manifest.batches.find(entry => entry.name === "linux-normal")!;
  const source = fixtureSource(batch.source);
  const seqs = source.samples.map(sample => BigInt(String((sample as { seq: unknown }).seq)));
  let session: Session | undefined;
  try {
    session = await startSession(stateDir, await freePort());
    const origin = session.origin;
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    for (const forged of [{}, { "Tailscale-User-Login": "pilot@example.com" }, { [GATEWAY_IDENTITY_HEADER]: "user:pilot@example.com" }, { ...identity, [GATEWAY_SECRET_HEADER]: "forged" }]) {
      assert.equal((await fetch(`${origin}/api/v1/hosts`, { headers: forged })).status, 401, JSON.stringify(Object.keys(forged)));
    }
    assert.equal((await fetch(`${origin}/api/v1/hosts`, { headers: tagged })).status, 200);

    const created = await fetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...identity, "Content-Type": "application/json" }, body: JSON.stringify({ name: "orange-pilot" }) });
    assert.equal(created.status, 201);
    const host = await created.json() as { hostId: string; token: string };
    const frame = withHost(fixtureBytes(batch.frame), host.hostId);
    const ingestHeaders = { Authorization: `Bearer ${host.token}`, "Content-Type": INGEST_MEDIA_TYPE };
    const first = await fetch(`${origin}${INGEST_PATH}`, { method: "POST", headers: ingestHeaders, body: frame });
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    if (first.status !== 200) assert.fail(`ingest answered ${first.status}: ${new TextDecoder().decode(firstBytes)}\n${session.logs.slice(-15).join("\n")}`);
    const firstAck = decodeAck(firstBytes, seqs);
    assert.deepEqual([first.status, firstAck.accepted, firstAck.duplicates], [200, seqs.length, 0]);
    const replay = await fetch(`${origin}${INGEST_PATH}`, { method: "POST", headers: ingestHeaders, body: frame });
    const replayAck = decodeAck(new Uint8Array(await replay.arrayBuffer()), seqs);
    assert.deepEqual([replay.status, replayAck.accepted, replayAck.duplicates], [200, 0, seqs.length]);
    const conflicting = { ...source, samples: source.samples.map(sample => ({ ...sample, cpu: { ...(sample.cpu as Record<string, unknown>), total: "999999999999" } })) };
    const conflict = await fetch(`${origin}${INGEST_PATH}`, { method: "POST", headers: ingestHeaders, body: withHost(encodeFrame(conflicting), host.hostId) });
    const conflictBody = await conflict.json() as { rejected?: readonly { code: string }[] };
    assert.equal(conflict.status, 400);
    assert.ok((conflictBody.rejected ?? []).length > 0 && conflictBody.rejected!.every(entry => entry.code === "conflict"));

    const historyPath = `/api/v1/hosts/${host.hostId}/history?range=24h&kind=summary`;
    const before = await fetch(`${origin}${historyPath}`, { headers: { ...identity, "accept-encoding": "identity" } });
    assert.equal(before.status, 200);
    assert.equal(before.headers.get("content-type"), "application/vnd.stats.history.v1");
    const beforeBytes = new Uint8Array(await before.arrayBuffer());
    openHistory(beforeBytes);

    await session.stop();
    session = await startSession(stateDir, await freePort());
    const after = await fetch(`${session.origin}${historyPath}`, { headers: { ...identity, "accept-encoding": "identity" } });
    assert.equal(after.status, 200);
    assert.deepEqual(new Uint8Array(await after.arrayBuffer()), beforeBytes);
    const hosts = await (await fetch(`${session.origin}/api/v1/hosts`, { headers: identity })).json() as { hosts: { hostId: string }[] };
    assert.deepEqual(hosts.hosts.map(entry => entry.hostId), [host.hostId]);
    const replayAfter = await fetch(`${session.origin}${INGEST_PATH}`, { method: "POST", headers: ingestHeaders, body: frame });
    assert.equal(decodeAck(new Uint8Array(await replayAfter.arrayBuffer()), seqs).duplicates, seqs.length);
  } finally {
    await session?.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
