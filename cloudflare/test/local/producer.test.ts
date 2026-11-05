import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { Request as MiniflareRequest } from "miniflare";
import { loopbackPassthrough, offlineOutbound } from "../../local/outbound.ts";
import { producerExportDigest, readProducerExport } from "../../local/producer.ts";
import { SCRATCH, startStack } from "../../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../../local/topology.ts";

const PRODUCER_EXPORT = join(CLOUDFLARE_ROOT, "../fixtures/producers/nanoshop-storied");
mkdirSync(SCRATCH, { recursive: true });
const work = mkdtempSync(join(SCRATCH, "producer-"));

type Manifest = Record<string, unknown> & { tenants: (Record<string, unknown> & { worker: Record<string, unknown> & { env: Record<string, Record<string, unknown>> } })[] };

function variant(name: string, edit: (manifest: Manifest) => void): string {
  const dir = join(work, name);
  cpSync(PRODUCER_EXPORT, dir, { recursive: true });
  const path = join(dir, "producer-export.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  edit(manifest);
  writeFileSync(path, JSON.stringify({ ...manifest, digest: producerExportDigest(dir) }));
  return dir;
}

function asFieldhouse(manifest: Manifest): void {
  const [tenant] = manifest.tenants;
  const port = Number(manifest["shopPort"]) + 1;
  Object.assign(manifest, { shopPort: port });
  Object.assign(tenant!, { serviceName: "nanoshop-fieldhouse", shopOrigin: `http://fieldhouse.localhost:${port}`, durableObjectDir: "persist-seed/do/nanoshop-fieldhouse-TenantStore" });
  Object.assign(tenant!.worker, { name: "nanoshop-fieldhouse" });
  tenant!.worker.env["TENANT_STORE"]!["worker"] = "nanoshop-fieldhouse";
}

try {
  await test("two exports of one service are refused before the stack starts", async () => {
    await assert.rejects(startStack({ nowMs: null, producers: [PRODUCER_EXPORT, PRODUCER_EXPORT] }), /both export nanoshop-storied, whose Worker, collector copy, and Durable Object state would be one/u);
  });

  await test("two exports that bind one R2 bucket are refused, and a different bucket name is accepted", async () => {
    const shared = variant("shared-bucket", asFieldhouse);
    await assert.rejects(startStack({ nowMs: null, producers: [PRODUCER_EXPORT, shared] }), /both bind R2 bucket nanoshop-media-storied, whose stored objects would be shared/u);
    const own = variant("own-bucket", manifest => {
      asFieldhouse(manifest);
      manifest.tenants[0]!.worker.env["MEDIA"]!["name"] = "nanoshop-media-fieldhouse";
    });
    assert.deepEqual(readProducerExport(own).buckets, ["nanoshop-media-fieldhouse"]);
  });

  await test("an export whose provider origin is not loopback is refused", () => {
    const remote = variant("remote-stripe", manifest => { manifest.tenants[0]!["stripeOrigin"] = "https://api.stripe.com"; });
    assert.throws(() => readProducerExport(remote), /stripeOrigin https:\/\/api\.stripe\.com\/ is not an http loopback origin with a port/u);
  });

  await test("a declared provider origin is forwarded to 127.0.0.1 with its own Host, and any other origin keeps the offline refusal", async () => {
    const seen: { host: string | undefined; path: string | undefined; body: string }[] = [];
    const provider = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        seen.push({ host: request.headers.host, path: request.url, body });
        response.writeHead(201, { "x-provider": "simulator" }).end("created");
      });
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (provider.address() as { port: number }).port;
      const offline = offlineOutbound([]);
      const outbound = loopbackPassthrough([new URL(`http://stripe-sim.localhost:${port}`)], offline.handler);
      const declared = await outbound(new Request(`http://stripe-sim.localhost:${port}/v1/checkout/sessions?expand=x`, { method: "POST", body: "mode=payment" }) as unknown as MiniflareRequest);
      assert.deepEqual([declared.status, declared.headers.get("x-provider"), await declared.text()], [201, "simulator", "created"]);
      assert.deepEqual(seen, [{ host: `stripe-sim.localhost:${port}`, path: "/v1/checkout/sessions?expand=x", body: "mode=payment" }]);
      for (const url of ["https://api.stripe.com/v1/checkout/sessions", `http://stripe-sim.localhost:${port + 1}/v1/checkout/sessions`]) {
        assert.equal((await outbound(new Request(url) as unknown as MiniflareRequest)).status, 503);
      }
      assert.deepEqual(offline.unexpected().map(request => request.url), ["https://api.stripe.com/v1/checkout/sessions", `http://stripe-sim.localhost:${port + 1}/v1/checkout/sessions`]);
      assert.equal(seen.length, 1);
    } finally {
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
