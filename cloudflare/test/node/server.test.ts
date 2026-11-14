import assert from "node:assert/strict";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { mock, test } from "node:test";
import { decodeAck } from "../../src/ingest/ack-decode.ts";
import { INGEST_MEDIA_TYPE, INGEST_PATH } from "../../src/ingest/http.ts";
import { openAssets } from "../../src/node/assets.ts";
import { DATABASE_FILE, nodeConfig, NodeConfigError } from "../../src/node/config.ts";
import { statsRequestListener } from "../../src/node/server.ts";
import { fixtureBytes, openHarness, scratchDirectory, withHost } from "./support.ts";

const ALLOWED = "owner@example.com";
const INDEX = "<!doctype html><title>stats</title>";

interface Reply {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly bytes: Uint8Array;
  readonly text: string;
}

interface Served {
  fetch(path: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string }): Promise<Reply>;
  close(): Promise<void>;
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

async function serve(peer: string | null = null, socket = false): Promise<Served & { harness: ReturnType<typeof openHarness>; assets: string }> {
  const harness = openHarness();
  const assets = scratchDirectory("node-assets");
  mkdirSync(join(assets, "assets"));
  writeFileSync(join(assets, "index.html"), INDEX);
  writeFileSync(join(assets, "assets", "app-123.js"), "export {};");
  writeFileSync(join(assets, "..", `${assets.split("/").at(-1)}-secret`), "secret");
  symlinkSync(join(assets, "..", `${assets.split("/").at(-1)}-secret`), join(assets, "escape.txt"));
  const listener = statsRequestListener({ installation: request => harness.core.fetch(request), assets: await openAssets(assets), transport: socket ? "unix" : "tcp" });
  const socketPath = join(scratchDirectory("sock"), "s.sock");
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    if (peer !== null) Object.defineProperty(incoming.socket, "remoteAddress", { value: peer, configurable: true });
    listener(incoming, outgoing);
  });
  await new Promise<void>(resolve => (socket ? server.listen(socketPath, resolve) : server.listen(0, "127.0.0.1", resolve)));
  const port = socket ? 0 : (server.address() as AddressInfo).port;
  return {
    harness,
    assets,
    fetch: (path, init = {}) => new Promise((resolve, reject) => {
      const outgoing = httpRequest({ ...(socket ? { socketPath } : { host: "127.0.0.1", port }), path, method: init.method ?? "GET", headers: init.headers ?? {} }, incoming => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        incoming.on("end", () => {
          const bytes = joined(chunks);
          resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, bytes, text: new TextDecoder().decode(bytes) });
        });
      });
      outgoing.on("error", reject);
      outgoing.end(init.body);
    }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      harness.close();
      rmSync(join(assets, "..", `${assets.split("/").at(-1)}-secret`), { force: true });
      rmSync(assets, { recursive: true, force: true });
      rmSync(dirname(socketPath), { recursive: true, force: true });
    }
  };
}

function errorCode(reply: Reply): string {
  return (JSON.parse(reply.text) as { error: { code: string } }).error.code;
}

const login = (value: string) => ({ "Tailscale-User-Login": value });

await test("a non-loopback peer is rejected before any data is read, even with an allowed Tailscale login", async () => {
  for (const peer of ["203.0.113.7", "::ffff:192.168.1.10", "fd7a:115c:a1e0::1"]) {
    const served = await serve(peer);
    try {
      await served.harness.core.createHost("hidden");
      for (const path of ["/api/v1/hosts", "/api/v1/admin/hosts", "/"]) {
        const reply = await served.fetch(path, { headers: login(ALLOWED) });
        assert.equal(reply.status, 401, `${peer} ${path}`);
        assert.equal(errorCode(reply), "unauthorized");
        assert.doesNotMatch(reply.text, /hidden|h_[0-9a-f]{32}|<!doctype/u);
      }
      assert.equal((await served.fetch("/health")).status, 200, `${peer} health stays open`);
    } finally {
      await served.close();
    }
  }
});

await test("a loopback request without a Tailscale login, or with an empty one, is rejected", async () => {
  const served = await serve();
  try {
    for (const headers of [{}, login("")]) {
      for (const path of ["/api/v1/hosts", "/", "/assets/app-123.js"]) {
        const reply = await served.fetch(path, { headers });
        assert.equal(reply.status, 401, path);
        assert.equal(errorCode(reply), "unauthorized");
      }
    }
  } finally {
    await served.close();
  }
});

await test("any Tailscale login that tailscale serve asserts is admitted", async () => {
  const served = await serve();
  try {
    for (const value of ["intruder@example.com", "Owner@example.com"]) assert.equal((await served.fetch("/api/v1/hosts", { headers: login(value) })).status, 200, value);
  } finally {
    await served.close();
  }
});

await test("cross-site writes to /api/v1 are rejected before any host is created, while same-origin and header-less JSON writes succeed", async () => {
  const served = await serve();
  try {
    const create = (headers: Record<string, string>) => served.fetch("/api/v1/admin/hosts", { method: "POST", headers: { ...login(ALLOWED), ...headers }, body: JSON.stringify({ name: "csrf" }) });
    const crossOrigin = await create({ "Content-Type": "text/plain", Origin: "https://evil.example" });
    assert.equal(crossOrigin.status, 403);
    assert.equal(errorCode(crossOrigin), "forbidden");
    assert.equal((await create({ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await served.fetch("/api/v1/admin/hosts/h_00000000000000000000000000000000", { method: "DELETE", headers: { ...login(ALLOWED), Origin: "https://evil.example" } })).status, 403);
    const text = await create({ "Content-Type": "text/plain" });
    assert.equal(text.status, 415);
    assert.equal(errorCode(text), "unsupported_media_type");
    assert.deepEqual(await served.harness.core.listHosts(), []);
    assert.equal((await create({ "Content-Type": "application/json", Host: "stats.example.ts.net", "X-Forwarded-Proto": "https", Origin: "https://stats.example.ts.net", "Sec-Fetch-Site": "same-origin" })).status, 201);
    assert.equal((await create({ "Content-Type": "application/json", Host: "stats.example.ts.net", "X-Forwarded-Proto": "https", Origin: "http://stats.example.ts.net" })).status, 403);
    assert.equal((await create({ "Content-Type": "application/json" })).status, 201);
  } finally {
    await served.close();
  }
});

await test("on a Unix socket an asserted login is served, a missing login is rejected, and ingest still needs its bearer", async () => {
  const served = await serve(null, true);
  try {
    const created = await served.fetch("/api/v1/admin/hosts", { method: "POST", headers: { ...login(ALLOWED), "Content-Type": "application/json" }, body: JSON.stringify({ name: "socket-host" }) });
    assert.equal(created.status, 201);
    assert.equal((await served.fetch("/api/v1/hosts", { headers: login(ALLOWED) })).status, 200);
    assert.equal((await served.fetch("/", { headers: login("second@example.com") })).status, 200);
    for (const headers of [{}, login("")]) {
      const reply = await served.fetch("/api/v1/hosts", { headers });
      assert.equal(reply.status, 401);
      assert.equal(errorCode(reply), "unauthorized");
    }
    const ingest = await served.fetch(INGEST_PATH, { method: "POST", headers: { ...login(ALLOWED), "Content-Type": INGEST_MEDIA_TYPE }, body: "x" });
    assert.equal(ingest.status, 401);
    assert.equal((await served.fetch("/health")).status, 200);
  } finally {
    await served.close();
  }
});

await test("an allowed login from loopback provisions a host, reads its data, and gets the dashboard", async () => {
  const served = await serve();
  try {
    const created = await served.fetch("/api/v1/admin/hosts", { method: "POST", headers: { ...login(ALLOWED), "Content-Type": "application/json" }, body: JSON.stringify({ name: "node-host" }) });
    assert.equal(created.status, 201);
    const host = JSON.parse(created.text) as { hostId: string; token: string };
    const listed = await served.fetch("/api/v1/hosts", { headers: login(ALLOWED) });
    assert.equal(listed.status, 200);
    assert.deepEqual((JSON.parse(listed.text) as { hosts: { hostId: string; name: string }[] }).hosts.map(entry => [entry.hostId, entry.name]), [[host.hostId, "node-host"]]);
    const index = await served.fetch("/", { headers: login("second@example.com") });
    assert.equal(index.status, 200);
    assert.equal(index.text, INDEX);
    assert.equal(index.headers["cache-control"], "no-store");
    const script = await served.fetch("/assets/app-123.js", { headers: login(ALLOWED) });
    assert.equal(script.status, 200);
    assert.equal(script.headers["cache-control"], "private, max-age=31536000, immutable");
    assert.match(String(script.headers["content-type"]), /^text\/javascript/u);
    for (const path of ["/missing.js", "/escape.txt", "/assets/../../x", "/%2e%2e/x"]) {
      assert.equal((await served.fetch(path, { headers: login(ALLOWED) })).status, 404, path);
    }
  } finally {
    await served.close();
  }
});

await test("ingest ignores Tailscale identity: an allowed login without a bearer token is rejected, and a bearer token from a non-loopback peer is accepted", async () => {
  const local = await serve();
  const remote = await serve("203.0.113.7");
  try {
    const frame = fixtureBytes("frames/minimal.stb2");
    const rejected = await local.fetch(INGEST_PATH, { method: "POST", headers: { ...login(ALLOWED), "Content-Type": INGEST_MEDIA_TYPE }, body: frame });
    assert.equal(rejected.status, 401);
    assert.equal(errorCode(rejected), "unauthorized");
    assert.match(rejected.text, /bearer token/u);

    const created = await remote.harness.core.createHost("remote-agent");
    assert.ok(created.ok);
    const accepted = await remote.fetch(INGEST_PATH, { method: "POST", headers: { Authorization: `Bearer ${created.value.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: withHost(frame, created.value.hostId) });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(decodeAck(accepted.bytes, [900000n]).accepted, 1);
  } finally {
    await local.close();
    await remote.close();
  }
});

await test("observe answers unavailable on Node after auth, and a history frame is actually compressed when the response names an encoding", async () => {
  const served = await serve();
  try {
    assert.equal((await served.fetch("/api/observe/stats/issues")).status, 401);
    const observe = await served.fetch("/api/observe/stats/issues", { headers: login(ALLOWED) });
    assert.equal(observe.status, 503);
    assert.equal(errorCode(observe), "unavailable");

    const created = await served.harness.core.createHost("compressed");
    assert.ok(created.ok);
    const frame = withHost(fixtureBytes("frames/minimal.stb2"), created.value.hostId);
    assert.equal((await served.fetch(INGEST_PATH, { method: "POST", headers: { Authorization: `Bearer ${created.value.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: frame })).status, 200);
    const path = `/api/v1/hosts/${created.value.hostId}/history?range=24h&kind=summary`;
    const identity = await served.fetch(path, { headers: { ...login(ALLOWED), "Accept-Encoding": "identity" } });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers["content-encoding"], undefined);
    const brotli = await served.fetch(path, { headers: { ...login(ALLOWED), "Accept-Encoding": "br, gzip" } });
    assert.equal(brotli.headers["content-encoding"], "br");
    assert.deepEqual(new Uint8Array(brotliDecompressSync(brotli.bytes)), identity.bytes);
    const gzip = await served.fetch(path, { headers: { ...login(ALLOWED), "Accept-Encoding": "gzip" } });
    assert.equal(gzip.headers["content-encoding"], "gzip");
    assert.deepEqual(new Uint8Array(gunzipSync(gzip.bytes)), identity.bytes);
  } finally {
    await served.close();
  }
});

await test("the Node configuration fails loudly on a missing or invalid value and defaults the listen address to loopback", () => {
  const directory = scratchDirectory("node-config");
  try {
    const valid = { STATS_DATA_DIR: directory };
    const config = nodeConfig(valid);
    assert.equal(config.databasePath, join(directory, DATABASE_FILE));
    assert.deepEqual(config.listen, { kind: "tcp", host: "127.0.0.1", port: 18791 });
    assert.deepEqual(nodeConfig({ ...valid, STATS_LISTEN: "[::1]:0" }).listen, { kind: "tcp", host: "::1", port: 0 });
    assert.deepEqual(nodeConfig({ ...valid, STATS_LISTEN: `unix:${join(directory, "s.sock")}` }).listen, { kind: "unix", path: join(directory, "s.sock") });
    for (const [env, message] of [
      [{ ...valid, STATS_DATA_DIR: undefined }, /STATS_DATA_DIR is required/u],
      [{ ...valid, STATS_DATA_DIR: join(directory, "absent") }, /does not exist/u],
      [{ ...valid, STATS_LISTEN: "localhost:18791" }, /STATS_LISTEN/u],
      [{ ...valid, STATS_LISTEN: "127.0.0.1:70000" }, /STATS_LISTEN/u],
      [{ ...valid, STATS_LISTEN: "127.0.0.1" }, /STATS_LISTEN/u],
      [{ ...valid, STATS_LISTEN: "unix:relative.sock" }, /absolute/u],
      [{ ...valid, STATS_LISTEN: `unix:${join(directory, "absent", "s.sock")}` }, /directory .* does not exist/u]
    ] as const) {
      assert.throws(() => nodeConfig(env), error => error instanceof NodeConfigError && message.test(error.message));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("a deploy marker needs only its service token, from any peer and without a Tailscale identity, while service reads still need one", async () => {
  for (const [peer, socket] of [["203.0.113.7", false], [null, true]] as const) {
    const served = await serve(peer, socket);
    const log = mock.method(console, "error", () => {});
    try {
      const host = await served.harness.core.createHost("svc-host");
      assert.ok(host.ok);
      const created = await served.harness.core.fetch(new Request("https://installation/admin/services", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "svc", hostIds: [host.value.hostId] }) }));
      assert.equal(created.status, 201);
      const { deployToken, ingestToken } = await created.json() as { deployToken: string; ingestToken: string };
      const marker = { markerId: "m1", version: "1.0.0", hostIds: [host.value.hostId] };
      const post = (credential: string | null) => served.fetch("/ingest/services/svc/deployments", { method: "POST", headers: { ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }), "Content-Type": "application/json" }, body: JSON.stringify(marker) });
      assert.equal((await post(null)).status, 401);
      assert.equal((await post(`nft_${"A".repeat(43)}`)).status, 401);
      assert.equal((await post(ingestToken)).status, 401);
      const rows = () => (served.harness.db.prepare("SELECT COUNT(*) AS count FROM service_deployments").get() as { count: number }).count;
      assert.equal(rows(), 0);
      const first = await post(deployToken);
      assert.equal(first.status, 201, first.text);
      for (const token of [deployToken, ingestToken]) assert.doesNotMatch(first.text, new RegExp(token, "u"));
      assert.equal((await post(deployToken)).status, 200);
      assert.equal(rows(), 1);
      for (const path of ["/api/v1/services", "/api/v1/services/svc", "/api/v1/services/svc/deployments"]) {
        assert.equal((await served.fetch(path)).status, 401, `${String(peer)} ${path}`);
      }
      for (const call of log.mock.calls) {
        for (const token of [deployToken, ingestToken]) assert.doesNotMatch(JSON.stringify(call.arguments), new RegExp(token, "u"));
      }
    } finally {
      log.mock.restore();
      await served.close();
    }
  }
});
