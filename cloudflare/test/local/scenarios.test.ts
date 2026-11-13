import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { decodeBatch } from "../../src/observe/ingest/codec.ts";
import { openNodeInstallation } from "../../src/node/installation.ts";
import { startStack, SCRATCH, type Stack } from "../../local/stack.ts";
import { addHost } from "../../local/seed.ts";

const STATS = resolve(import.meta.dirname, "../..");
const FIXTURES = resolve(STATS, "../fixtures/observe-ingest");
const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as { readonly service: string; readonly nowMs: number; readonly golden: string };
const golden = readFileSync(join(FIXTURES, manifest.golden), "utf8").trim();
const SERVICE = manifest.service;

async function withWorkerd(body: (stack: Stack) => Promise<void>): Promise<void> {
  const stack = await startStack({ nowMs: null });
  try {
    await body(stack);
  } finally {
    await stack.dispose();
  }
}

async function provision(stack: Stack, name: string): Promise<{ readonly hostId: string; readonly deployToken: string; readonly ingestToken: string }> {
  const host = await addHost(stack, `${name}-host`);
  const response = await stack.fetch("/api/v1/admin/services", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, hostIds: [host.hostId] })
  });
  assert.equal(response.status, 201, await response.clone().text());
  const created = await response.json() as { readonly deployToken: string; readonly ingestToken: string };
  return { hostId: host.hostId, ...created };
}

function batch(now: number): { readonly text: string; readonly events: readonly Record<string, unknown>[] } {
  const decoded = decodeBatch(golden, { service: SERVICE, nowMs: manifest.nowMs });
  assert.equal(decoded.ok, true, "the golden batch decodes");
  const events = decoded.batch.events.map((event, index) => ({ ...event, atMs: now - 120_000 + index * 60_000 }));
  return { text: JSON.stringify({ events }), events };
}

async function ingest(stack: Stack, token: string, text: string) {
  return stack.anonymous(`/ingest/observe/v1/${SERVICE}/batches`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: text
  });
}

async function external(stack: Stack, now: number, service = SERVICE): Promise<readonly Record<string, unknown>[]> {
  const response = await stack.fetch(`/api/observe/${service}/external?from=${now - 300_000}&to=${now}`);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { readonly events: readonly { readonly event: Record<string, unknown> }[] };
  return body.events.map(entry => entry.event);
}

await test("scenario A: a service token ingests one event, reads it back, rotates, and rejects the old token", async () => {
  await withWorkerd(async stack => {
    const now = Date.now();
    const credentials = await provision(stack, SERVICE);
    const payload = batch(now);
    const first = await ingest(stack, credentials.ingestToken, payload.text);
    assert.equal(first.status, 202, await first.clone().text());
    assert.deepEqual(await external(stack, now, SERVICE), payload.events);
    assert.equal((await ingest(stack, credentials.deployToken, payload.text)).status, 401);

    const rotated = await stack.fetch(`/api/v1/admin/services/${SERVICE}/token/rotate`, { method: "POST" });
    assert.equal(rotated.status, 200, await rotated.clone().text());
    const { ingestToken } = await rotated.json() as { readonly ingestToken: string };
    assert.equal((await ingest(stack, credentials.ingestToken, payload.text)).status, 401);
    assert.equal((await ingest(stack, ingestToken, payload.text)).status, 200);
  });
});

await test("scenario D: a marker is recorded once and repeated delivery is a no-op", async () => {
  await withWorkerd(async stack => {
    const credentials = await provision(stack, SERVICE);
    const marker = { markerId: "v-1.0.0", version: "1.0.0", message: "release 1.0.0", hostIds: [credentials.hostId] };
    const first = await stack.anonymous(`/ingest/services/${SERVICE}/deployments`, { method: "POST", headers: { authorization: `Bearer ${credentials.deployToken}`, "content-type": "application/json" }, body: JSON.stringify(marker) });
    assert.equal(first.status, 201);
    const replay = await stack.anonymous(`/ingest/services/${SERVICE}/deployments`, { method: "POST", headers: { authorization: `Bearer ${credentials.deployToken}`, "content-type": "application/json" }, body: JSON.stringify(marker) });
    assert.equal(replay.status, 200);
    const history = await stack.fetch(`/api/v1/services/${SERVICE}/deployments`);
    assert.equal(history.status, 200);
    assert.equal((await history.json() as { readonly deployments: readonly unknown[] }).deployments.length, 1);
  });
});

await test("scenario E: invalid service credentials reject ingest and marker retries remain idempotent", async () => {
  await withWorkerd(async stack => {
    const now = Date.now();
    const credentials = await provision(stack, SERVICE);
    const payload = batch(now);
    assert.equal((await ingest(stack, "not-a-token", payload.text)).status, 401);
    assert.deepEqual(await external(stack, now, SERVICE), []);
    assert.equal((await ingest(stack, credentials.ingestToken, payload.text)).status, 202);
    const marker = { markerId: "retry", version: "1.0.0", hostIds: [credentials.hostId] };
    const post = () => stack.anonymous(`/ingest/services/${SERVICE}/deployments`, { method: "POST", headers: { authorization: `Bearer ${credentials.deployToken}`, "content-type": "application/json" }, body: JSON.stringify(marker) });
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 200);
  });
});

await test("scenario F: content, paths, credentials, and headers from an application never reach stored telemetry", async () => {
  await withWorkerd(async stack => {
    const now = Date.now();
    const credentials = await provision(stack, SERVICE);
    const secret = "DO-NOT-STORE-7f6c";
    const [first] = batch(now).events;
    assert.ok(first !== undefined);
    const malformed = JSON.stringify({ events: [{ ...first, note: secret, path: `/private/${secret}` }] });
    assert.equal((await ingest(stack, credentials.ingestToken, malformed)).status, 400);
    assert.deepEqual(await external(stack, now, SERVICE), []);
    const encoded = await external(stack, now, SERVICE);
    assert.equal(JSON.stringify(encoded).includes(secret), false);
    assert.equal(JSON.stringify(encoded).includes(credentials.ingestToken), false);
  });
});

await test("scenario G: one golden batch reads back normalized on workerd and Node", async () => {
  const now = Date.now();
  const payload = batch(now);
  let cloudflareEvents: readonly Record<string, unknown>[] = [];
  await withWorkerd(async stack => {
    const credentials = await provision(stack, SERVICE);
    assert.equal((await ingest(stack, credentials.ingestToken, payload.text)).status, 202);
    cloudflareEvents = await external(stack, now, SERVICE);
  });
  const decoded = decodeBatch(payload.text, { service: SERVICE, nowMs: now + 1_000 });
  assert.equal(decoded.ok, true);
  const directory = mkdtempSync(join(SCRATCH, "s13-node-"));
  const installation = openNodeInstallation({ path: join(directory, "stats.sqlite"), projects: "[]", clock: { now: () => now } });
  try {
    const ingested = await installation.observe.forService(SERVICE).ingestExternal(SERVICE, decoded.batch.events);
    assert.equal(ingested.ok, true);
    const nodeRecords = await installation.observe.forService(SERVICE).external(SERVICE, { fromMs: now - 300_000, toMs: now });
    assert.deepEqual(nodeRecords.map(record => record.event), cloudflareEvents);
    assert.deepEqual(cloudflareEvents, payload.events);
  } finally {
    installation.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
