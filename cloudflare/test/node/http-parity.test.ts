import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { INGEST_MEDIA_TYPE, INGEST_PATH } from "../../src/ingest/http.ts";
import { openAssets } from "../../src/node/assets.ts";
import { createStatsServer } from "../../src/node/server.ts";
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

async function observed(response: Response): Promise<{ status: number; headers: Record<string, string | null>; body: string }> {
  return {
    status: response.status,
    headers: Object.fromEntries(COMPARED_HEADERS.map(name => [name, response.headers.get(name)])),
    body: Array.from(new Uint8Array(await response.arrayBuffer()), byte => byte.toString(16).padStart(2, "0")).join("")
  };
}

await test("the Worker on workerd and the Node server answer health, ingest, host, history, project, and rejection routes with identical status, headers, and body bytes", async () => {
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
    const both = async (path: string, exchange: Exchange = {}, authorized = true) => {
      const base = { "accept-encoding": "identity", ...exchange.headers };
      const init = (credentials: Record<string, string>) => ({ method: exchange.method ?? "GET", headers: { ...base, ...(authorized ? credentials : {}) }, ...(exchange.body === undefined ? {} : { body: exchange.body }) });
      const fromWorker = await observed(await mf.dispatchFetch(`${workerOrigin}${path}`, init(access)) as unknown as Response);
      const fromNode = await observed(await fetch(`${nodeOrigin}${path}`, init({ "Tailscale-User-Login": LOGIN })));
      assert.deepEqual(fromNode, fromWorker, `${exchange.method ?? "GET"} ${path}`);
      return fromWorker;
    };

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
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    harness.close();
    await mf.dispose();
    rmSync(assets, { recursive: true, force: true });
  }
});
