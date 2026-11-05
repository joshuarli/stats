import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { INGEST_MEDIA_TYPE, INGEST_PATH } from "../../src/ingest/http.ts";
import { openAssets } from "../../src/node/assets.ts";
import { createStatsServer } from "../../src/node/server.ts";
import { tokenHash } from "../../src/auth.ts";
import { accessToken } from "../access-token.ts";
import { fixtureBytes, manifest, openHarness, ROOT, scratchDirectory, withHost } from "./support.ts";

const VARS = (JSON.parse(readFileSync(join(ROOT, "wrangler.test.jsonc"), "utf8")) as { vars: Record<string, string> }).vars;
const LOGIN = "parity@example.com";
const COMPARED_HEADERS = ["content-type", "etag", "cache-control", "vary", "content-encoding", "retry-after", "content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"];
const BATCHES = ["minimal", "system", "linux-normal", "counter-reset", "device-churn", "conflict"];

interface Exchange {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array<ArrayBuffer> | string;
}

function hex(text: string): string {
  return Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(body: string): string {
  return new TextDecoder().decode(Uint8Array.from(body.match(/../gu) ?? [], pair => Number.parseInt(pair, 16)));
}

async function observed(response: Response): Promise<{ status: number; headers: Record<string, string | null>; body: string }> {
  return {
    status: response.status,
    headers: Object.fromEntries(COMPARED_HEADERS.map(name => [name, response.headers.get(name)])),
    body: Array.from(new Uint8Array(await response.arrayBuffer()), byte => byte.toString(16).padStart(2, "0")).join("")
  };
}

await test("the Worker on workerd and the Node server answer health, ingest, host, history, project, service, and rejection routes with identical status, headers, and body bytes", async () => {
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [{
        name: "stats",
        modules: true,
        scriptPath: join(ROOT, ".cloudflare/output/v0/workers/default/bundle/index.js"),
        compatibilityDate: "2026-10-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: VARS,
        durableObjects: { INSTALLATION: { className: "Installation", useSQLite: true } }
      }]
    }),
    host: "127.0.0.1",
    port: 0
  });
  const harness = openHarness(VARS["PROJECTS"]!);
  const assets = scratchDirectory("parity-assets");
  writeFileSync(join(assets, "index.html"), "<!doctype html>");
  const server = createStatsServer({ installation: request => harness.core.fetch(request), assets: await openAssets(assets), allowedLogins: new Set([LOGIN]), transport: "tcp" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const workerOrigin = (await mf.ready).origin;
    const nodeOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const access = { "cf-access-jwt-assertion": await accessToken() };
    const secrets: string[] = [];
    const exchanged = async (path: string, exchange: Exchange, authorized: boolean) => {
      const base = { "accept-encoding": "identity", ...exchange.headers };
      const init = (credentials: Record<string, string>) => ({ method: exchange.method ?? "GET", headers: { ...base, ...(authorized ? credentials : {}) }, ...(exchange.body === undefined ? {} : { body: exchange.body }) });
      const fromWorker = await observed(await mf.dispatchFetch(`${workerOrigin}${path}`, init(access)) as unknown as Response);
      const fromNode = await observed(await fetch(`${nodeOrigin}${path}`, init({ "Tailscale-User-Login": LOGIN })));
      return { fromWorker, fromNode };
    };
    const both = async (path: string, exchange: Exchange = {}, authorized = true) => {
      const { fromWorker, fromNode } = await exchanged(path, exchange, authorized);
      assert.deepEqual(fromNode, fromWorker, `${exchange.method ?? "GET"} ${path}`);
      for (const secret of secrets) assert.ok(!fromWorker.body.includes(hex(secret)), `${exchange.method ?? "GET"} ${path} carries a deploy token`);
      return fromWorker;
    };
    const hostIds: string[] = [];

    await both("/health", {}, false);
    await both(INGEST_PATH, {}, false);
    await both("/ingest/v1/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, false);
    await both(INGEST_PATH, { method: "POST", headers: { "Content-Type": INGEST_MEDIA_TYPE }, body: fixtureBytes("frames/minimal.stb2") }, false);
    await both(INGEST_PATH, { method: "POST", headers: { Authorization: "Bearer nft_smokeSMOKEsmokeSMOKEsmokeSMOKEsmokeSMOKE000", "Content-Type": "application/json" }, body: "{}" }, false);
    await both("/api/v1/unknown");
    await both("/assets/app.js", { method: "PUT", body: "x" });
    await both("/api/v1/projects");
    await both("/api/v1/projects/stuff/deployments");
    await both("/api/v1/projects/absent/deployments");

    for (const name of BATCHES) {
      const entry = manifest.batches.find(batch => batch.name === name);
      assert.ok(entry !== undefined, name);
      const created = await mf.dispatchFetch(`${workerOrigin}/api/v1/admin/hosts`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      assert.equal(created.status, 201);
      const host = await created.json() as { hostId: string; token: string };
      await harness.adoptHost(host.hostId, host.token, name);
      hostIds.push(host.hostId);
      const frame = withHost(fixtureBytes(entry.frame), host.hostId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await both(INGEST_PATH, { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: frame }, false);
      }
      await both(`/api/v1/hosts/${host.hostId}/latest`);
      await both(`/api/v1/hosts/${host.hostId}/system`);
      for (const search of ["range=24h&kind=summary", "range=1h&kinds=summary,disks,nets,filesystems"]) {
        const history = await both(`/api/v1/hosts/${host.hostId}/history?${search}`);
        assert.equal(history.status, 200, `${name} ${search}`);
        await both(`/api/v1/hosts/${host.hostId}/history?${search}`, { headers: { "If-None-Match": history.headers["etag"]! } });
      }
    }
    await both("/api/v1/hosts");

    const json = { "Content-Type": "application/json" };
    const [first, second, foreign] = hostIds as [string, string, string];
    const definition = { name: "web", hostIds: [second, first], healthUrl: "http://web.tail1234.ts.net:8080/health", unit: "web@1.service" };
    const created = await exchanged("/api/v1/admin/services", { method: "POST", headers: json, body: JSON.stringify(definition) }, true);
    const withoutToken = (side: typeof created.fromWorker) => {
      const body = JSON.parse(unhex(side.body)) as Record<string, unknown>;
      assert.match(String(body["token"]), /^nft_[A-Za-z0-9_-]{43}$/u);
      return { ...side, body: { ...body, token: "normalized" } };
    };
    assert.equal(created.fromWorker.status, 201);
    assert.deepEqual(withoutToken(created.fromNode), withoutToken(created.fromWorker), "POST /api/v1/admin/services with the token normalized");
    const token = (JSON.parse(unhex(created.fromWorker.body)) as { token: string }).token;
    const nodeToken = (JSON.parse(unhex(created.fromNode.body)) as { token: string }).token;
    secrets.push(token, nodeToken);
    harness.db.prepare("UPDATE services SET token_hash = ? WHERE name = 'web'").run(await tokenHash(token));

    await both("/api/v1/admin/services", { method: "POST", headers: json, body: JSON.stringify(definition) });
    await both("/api/v1/admin/services", { method: "POST", headers: json, body: JSON.stringify({ ...definition, name: "Web" }) });
    await both("/api/v1/admin/services", { method: "POST", headers: json, body: JSON.stringify({ name: "ghost", hostIds: ["h_00000000000000000000000000000000"] }) });
    await both("/api/v1/admin/services", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    await both("/api/v1/admin/services", { method: "POST", headers: json, body: "{" });
    await both("/api/v1/services");
    await both("/api/v1/services/web");
    await both("/api/v1/services/absent");
    await both("/api/v1/services/absent/deployments");

    const marker = { markerId: "ci-1", version: "1.0.0", message: "first", hostIds: [first] };
    const mark = (credential: string | null, body: string, headers: Record<string, string> = json) => both("/ingest/services/web/deployments", { method: "POST", headers: { ...headers, ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }) }, body }, false);
    await mark(null, JSON.stringify(marker));
    await mark(`nft_${"A".repeat(43)}`, JSON.stringify(marker));
    await both("/ingest/services/absent/deployments", { method: "POST", headers: { ...json, Authorization: `Bearer ${token}` }, body: JSON.stringify(marker) }, false);
    await mark(token, JSON.stringify(marker), { "Content-Type": "text/plain" });
    await mark(token, JSON.stringify({ ...marker, message: "x".repeat(9000) }));
    await mark(token, JSON.stringify({ ...marker, hostIds: [foreign] }));
    await mark(token, JSON.stringify({ ...marker, markerId: "a b" }));
    await mark(token, "{");
    assert.equal((harness.db.prepare("SELECT COUNT(*) AS count FROM service_deployments").get() as { count: number }).count, 0);
    assert.equal((await mark(token, JSON.stringify(marker))).status, 201);
    assert.equal((await mark(token, JSON.stringify(marker))).status, 200);
    assert.equal((await mark(token, JSON.stringify({ ...marker, version: "1.0.1" }))).status, 409);
    assert.equal((await mark(token, JSON.stringify({ markerId: "ci-2", version: "1.0.1", hostIds: [second, first] }))).status, 201);
    assert.equal((harness.db.prepare("SELECT COUNT(*) AS count FROM service_deployments").get() as { count: number }).count, 2);
    const history = await both("/api/v1/services/web/deployments");
    assert.equal(history.status, 200);
    await both("/api/v1/services/web/deployments?window=1h");
    await both("/api/v1/services/web/deployments", { method: "DELETE" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    harness.close();
    await mf.dispose();
    rmSync(assets, { recursive: true, force: true });
  }
});
