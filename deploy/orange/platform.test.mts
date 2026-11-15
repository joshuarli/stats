import { generateToken, tokenHash } from "../../cloudflare/src/auth.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from "../../cloudflare/src/cloudflare/gateway.ts";
import { PLATFORM_SERVICE } from "../../packages/platform-bridge/src/contract.ts";
import { generate } from "./generate.mts";
import { freePort, startSession, type Session } from "./session.mts";

type Span = { name: string; attributes: { key: string; value: { stringValue?: string } }[] };
type Batch = { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] };

await test("native Stats exports actors and SQLite without observing platform credential checks", async () => {
  const directory = resolve(import.meta.dirname, `../../.work/tmp/platform-native-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const batches: Batch[] = [];
  const collector = createServer(async (request, response) => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(chunk as Buffer);
    }
    batches.push(JSON.parse(Buffer.concat(chunks).toString()) as Batch);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>(done => collector.listen(0, "127.0.0.1", done));
  const address = collector.address();
  assert.ok(address !== null && typeof address !== "string");
  const secret = randomBytes(32).toString("hex");
  const generated = generate(directory, { kind: "dev", release: "platform-proof", gatewaySecret: secret, nowMs: null });
  const ingestToken = generateToken();
  const config = JSON.parse(readFileSync(generated.stats, "utf8")) as { vars: Record<string, string> };
  config.vars["PLATFORM_BRIDGE_TOKEN_SHA256"] = await tokenHash(ingestToken);
  writeFileSync(generated.stats, JSON.stringify(config), { mode: 0o600 });
  const headers = { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: "user:platform@example.com", "content-type": "application/json" };
  let session: Session | undefined;
  const spans = () => batches.flatMap(batch => batch.resourceSpans).flatMap(resource => resource.scopeSpans).flatMap(scope => scope.spans);
  try {
    session = await startSession(directory, await freePort(), { environment: {
      OTEL_SERVICE_NAME: "stats-runtime-proof", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json", OTEL_TRACES_SAMPLER: "always_on", OTEL_BSP_SCHEDULE_DELAY: "100", OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "64", OTEL_RESOURCE_ATTRIBUTES: "service.version=platform-proof,openorange.version=1.0.2"
    } });
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${session!.origin}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const hostResponse = await post("/api/v1/admin/hosts", { name: "platform-native" });
    assert.equal(hostResponse.status, 201);
    const { hostId } = await hostResponse.json() as { hostId: string };
    const serviceResponse = await post("/api/v1/admin/services", { name: PLATFORM_SERVICE, hostIds: [hostId] });
    assert.equal(serviceResponse.status, 400, "platform credentials have one owner outside the service registry");
    const installation = () => spans().filter(span => /^installation-[a-f0-9]+\/onRequest$/u.test(span.name));
    const observationKeys = () => new Set(spans().filter(span => /^observation-store-[a-f0-9]+\/onRequest$/u.test(span.name)).flatMap(span => span.attributes.filter(attribute => attribute.key === "rivet.actor.key").map(attribute => attribute.value.stringValue)));
    const readyDeadline = Date.now() + 10_000;
    while ((installation().length < 2 || observationKeys().size < 1) && Date.now() < readyDeadline) await new Promise(done => setTimeout(done, 50));
    const before = installation().length;
    assert.equal(before, 2);
    assert.equal(observationKeys().size, 1);
    const ingested = await post(`/ingest/observe/v1/${PLATFORM_SERVICE}/batches`, { events: [{ schemaVersion: 1, eventId: "platform-proof", service: PLATFORM_SERVICE, release: "proof", atMs: Date.now(), operation: "platform.proof", durationMs: 1, outcome: "ok", work: {} }] }, { authorization: `Bearer ${ingestToken}` });
    assert.equal(ingested.status, 202, await ingested.clone().text());
    const deadline = Date.now() + 10_000;
    while (observationKeys().size < 2 && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    assert.ok(spans().some(span => /^installation-[a-f0-9]+\/onRequest$/u.test(span.name)));
    assert.ok(spans().some(span => span.name === "rivet.sqlite.execute"));
    assert.equal(observationKeys().size, 2, "the platform sink has a separate actor identity");
    assert.equal(installation().length, before, "platform transport authentication must not invoke Installation");
  } finally {
    await session?.stop();
    collector.closeAllConnections();
    await new Promise<void>(done => collector.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
