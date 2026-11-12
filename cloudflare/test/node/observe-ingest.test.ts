import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { openAssets } from "../../src/node/assets.ts";
import { openNodeInstallation, type NodeInstallation } from "../../src/node/installation.ts";
import { observeHandler, statsRequestListener } from "../../src/node/server.ts";
import { OBSERVE_SERVICE, rebasedBatch } from "../support/observe-ingest.ts";
import { scratchDirectory } from "./support.ts";

const LOGIN = "owner@example.com";

interface Served {
  readonly origin: string;
  readonly installation: NodeInstallation;
  close(): Promise<void>;
}

async function serve(now: number, listener?: (incoming: IncomingMessage, outgoing: ServerResponse) => void): Promise<Served> {
  const directory = scratchDirectory("node-observe-ingest");
  const assets = join(directory, "assets");
  mkdirSync(join(assets, "assets"), { recursive: true });
  writeFileSync(join(assets, "index.html"), "<!doctype html>");
  const installation = openNodeInstallation({ path: join(directory, "stats.sqlite"), projects: "[]", clock: { now: () => now } });
  const server = createServer(listener ?? statsRequestListener({
    installation: request => installation.core.fetch(request),
    observe: observeHandler(installation),
    assets: await openAssets(assets),
    allowedLogins: new Set([LOGIN]),
    transport: "tcp"
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    installation,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      installation.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function login(): Record<string, string> {
  return { "tailscale-user-login": LOGIN };
}

async function provision(origin: string): Promise<{ hostId: string; deployToken: string; ingestToken: string }> {
  const host = await fetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...login(), "content-type": "application/json" }, body: JSON.stringify({ name: "tansu-host" }) });
  assert.equal(host.status, 201);
  const { hostId } = await host.json() as { hostId: string };
  const service = await fetch(`${origin}/api/v1/admin/services`, { method: "POST", headers: { ...login(), "content-type": "application/json" }, body: JSON.stringify({ name: OBSERVE_SERVICE, hostIds: [hostId] }) });
  assert.equal(service.status, 201);
  const created = await service.json() as { deployToken: string; ingestToken: string };
  return { hostId, ...created };
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function post(origin: string, token: string | null, body: string): Promise<Response> {
  return fetch(`${origin}/ingest/observe/v1/${OBSERVE_SERVICE}/batches`, {
    method: "POST",
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" },
    body
  });
}

await test("the Node adapter ingests a token-only batch and reads back the same normalized events", async () => {
  const now = Date.now();
  const served = await serve(now);
  try {
    const credentials = await provision(served.origin);
    const batch = rebasedBatch(now);
    const first = await post(served.origin, credentials.ingestToken, batch.text);
    assert.equal(first.status, 202, await first.clone().text());
    assert.deepEqual(await first.json(), { accepted: 2, duplicate: 0 });

    const replay = await post(served.origin, credentials.ingestToken, batch.text);
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.deepEqual(await replay.json(), { accepted: 0, duplicate: 2 });

    const read = await fetch(`${served.origin}/api/observe/${OBSERVE_SERVICE}/external?from=${now - 300_000}&to=${now}`, { headers: login() });
    assert.equal(read.status, 200, await read.clone().text());
    const body = await read.json() as { events: { event: unknown; provenance: string }[] };
    assert.deepEqual(body.events.map(entry => entry.event), batch.events);
    assert.ok(body.events.every(entry => entry.provenance === "application"));

    assert.equal((await post(served.origin, credentials.deployToken, batch.text)).status, 401);
    assert.equal((await post(served.origin, null, batch.text)).status, 401);
    assert.equal((await post(served.origin, credentials.ingestToken, JSON.stringify({ events: [] }))).status, 400);

    const marker = await fetch(`${served.origin}/ingest/services/${OBSERVE_SERVICE}/deployments`, {
      method: "POST",
      headers: { authorization: `Bearer ${credentials.ingestToken}`, "content-type": "application/json" },
      body: JSON.stringify({ markerId: "m1", version: "1.0.0", hostIds: [credentials.hostId] })
    });
    assert.equal(marker.status, 401);

    assert.equal((await fetch(`${served.origin}/api/observe/${OBSERVE_SERVICE}/external`)).status, 401);
    assert.equal((await fetch(`${served.origin}/api/observe/absent/external`, { headers: login() })).status, 404);
    assert.equal((await post(served.origin, credentials.ingestToken, batch.text)).status, 200);
  } finally {
    await served.close();
  }
});

await test("the ingest path ignores the peer's Tailscale identity and authenticates by token only", async () => {
  const now = Date.now();
  const directory = scratchDirectory("node-observe-remote");
  const assets = join(directory, "assets");
  mkdirSync(join(assets, "assets"), { recursive: true });
  writeFileSync(join(assets, "index.html"), "<!doctype html>");
  const installation = openNodeInstallation({ path: join(directory, "stats.sqlite"), projects: "[]", clock: { now: () => now } });
  const listener = statsRequestListener({
    installation: request => installation.core.fetch(request),
    observe: observeHandler(installation),
    assets: await openAssets(assets),
    allowedLogins: new Set([LOGIN]),
    transport: "tcp"
  });
  const server = createServer((incoming, outgoing) => {
    Object.defineProperty(incoming.socket, "remoteAddress", { value: "203.0.113.7", configurable: true });
    listener(incoming, outgoing);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const host = await installation.core.createHost("remote-host");
    assert.ok(host.ok);
    const service = await installation.core.fetch(new Request("https://installation/admin/services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: OBSERVE_SERVICE, hostIds: [host.value.hostId] }) }));
    assert.equal(service.status, 201);
    const { ingestToken } = await service.json() as { ingestToken: string };
    const batch = rebasedBatch(now);
    const reply = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: `/ingest/observe/v1/${OBSERVE_SERVICE}/batches`, method: "POST", headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json", "content-length": new TextEncoder().encode(batch.text).byteLength } }, incoming => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, text: new TextDecoder().decode(joined(chunks)) }));
      });
      request.on("error", reject);
      request.end(batch.text);
    });
    assert.equal(reply.status, 202, reply.text);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    installation.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("Node HTTP issue reads and mutations cannot cross service boundaries", async () => {
  const now = Date.now();
  const served = await serve(now);
  try {
    const credentials = await provision(served.origin);
    const beta = await fetch(`${served.origin}/api/v1/admin/services`, { method: "POST", headers: { ...login(), "content-type": "application/json" }, body: JSON.stringify({ name: "beta", hostIds: [credentials.hostId] }) });
    assert.equal(beta.status, 201);
    const batch = rebasedBatch(now);
    const failure = { ...batch.events[0]!, outcome: "error", error: { code: "db.timeout" } };
    assert.equal((await post(served.origin, credentials.ingestToken, JSON.stringify({ events: [failure] }))).status, 202);
    const read = await fetch(`${served.origin}/api/observe/${OBSERVE_SERVICE}/issues`, { headers: login() });
    const issues = await read.json() as { items: { fingerprint: string; state: string }[] };
    const fingerprint = issues.items[0]!.fingerprint;
    const betaIssues = await fetch(`${served.origin}/api/observe/beta/issues`, { headers: login() });
    assert.deepEqual((await betaIssues.json() as { items: unknown[] }).items, []);
    assert.equal((await fetch(`${served.origin}/api/observe/beta/issues/${fingerprint}`, { headers: login() })).status, 404);
    assert.equal((await fetch(`${served.origin}/api/observe/beta/issues/${fingerprint}/state`, { method: "POST", headers: { ...login(), origin: served.origin, "content-type": "application/json" }, body: JSON.stringify({ state: "resolved" }) })).status, 404);
    const alpha = await fetch(`${served.origin}/api/observe/${OBSERVE_SERVICE}/issues/${fingerprint}`, { headers: login() });
    assert.equal((await alpha.json() as { state: string }).state, "open");
  } finally { await served.close(); }
});
