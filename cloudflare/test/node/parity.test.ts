import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { HISTORY_KINDS } from "../../src/limits.ts";
import { accessToken } from "../access-token.ts";
import { fixtureBytes, manifest, openHarness, ROOT, withHost } from "./support.ts";

const VARS = (JSON.parse(readFileSync(join(ROOT, "wrangler.test.jsonc"), "utf8")) as { vars: Record<string, string> }).vars;
const RANGES = ["1h", "6h", "24h", "7d", "30d"];
const INGEST_TYPE = "application/vnd.stats.ingest.v2";

interface Observed {
  readonly status: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly body: string;
}

async function observe(response: Response): Promise<Observed> {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    body: Array.from(new Uint8Array(await response.arrayBuffer()), byte => byte.toString(16).padStart(2, "0")).join("")
  };
}

await test("the same fixture frames give identical acknowledgment bytes, history frame bytes, and stored host rows in the Worker on workerd and the core on node:sqlite", async () => {
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
  const node = openHarness(VARS["PROJECTS"]!);
  try {
    const origin = (await mf.ready).origin;
    const access = { "cf-access-jwt-assertion": await accessToken() };
    const worker = async (path: string, init: { method: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> } | null = null) =>
      observe(await mf.dispatchFetch(`${origin}${path}`, init === null ? { headers: { "accept-encoding": "identity", ...access } } : { ...init, headers: { "accept-encoding": "identity", ...access, ...init.headers } }) as unknown as Response);
    const core = async (path: string, init: { method: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> } | null = null) =>
      observe(await node.core.fetch(init === null ? new Request(`https://installation${path}`) : new Request(`https://installation${path}`, init)));

    const compared: string[] = [];
    let frames = 0;
    for (const entry of manifest.batches) {
      const created = await mf.dispatchFetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name: entry.name }) });
      assert.equal(created.status, 201, entry.name);
      const host = await created.json() as { hostId: string; token: string };
      await node.adoptHost(host.hostId, host.token, entry.name);

      const frame = withHost(fixtureBytes(entry.frame), host.hostId);
      const headers = { Authorization: `Bearer ${host.token}`, "Content-Type": INGEST_TYPE };
      for (const attempt of ["first delivery", "replay"]) {
        const fromWorker = await worker("/ingest/v2/batches", { method: "POST", headers, body: frame });
        const fromCore = await core("/ingest", { method: "POST", headers, body: frame });
        assert.deepEqual(fromCore, fromWorker, `${entry.name} ${attempt} acknowledgment`);
      }

      for (const range of RANGES) {
        for (const kind of HISTORY_KINDS) {
          const search = `range=${range}&kind=${kind}`;
          const fromCore = await core(`/hosts/${host.hostId}/history?${search}`);
          assert.deepEqual(fromCore, await worker(`/api/v1/hosts/${host.hostId}/history?${search}`), `${entry.name} history ${search}`);
          if (fromCore.status === 200) frames += 1;
        }
        const bundle = `range=${range}&kinds=${HISTORY_KINDS.join("+")}`;
        assert.deepEqual(await core(`/hosts/${host.hostId}/history?${bundle}`), await worker(`/api/v1/hosts/${host.hostId}/history?${bundle}`), `${entry.name} history ${bundle}`);
      }

      for (const suffix of ["latest", "system"]) {
        assert.deepEqual(await core(`/hosts/${host.hostId}/${suffix}`), await worker(`/api/v1/hosts/${host.hostId}/${suffix}`), `${entry.name} ${suffix}`);
      }
      compared.push(entry.name);
    }
    assert.equal(compared.length, manifest.batches.length);
    assert.ok(frames > manifest.batches.length, `only ${frames} history frames were compared`);
    assert.deepEqual(await core("/hosts"), await worker("/api/v1/hosts"), "host list");
  } finally {
    node.close();
    await mf.dispose();
  }
});
