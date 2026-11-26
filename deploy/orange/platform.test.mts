import { createProducer } from "../../packages/producer/src/index.ts";
import { createBridgeServer } from "../../packages/platform-bridge/src/server.ts";
import type { BridgePolicy } from "../../packages/platform-bridge/src/project.ts";
import type { PlatformTelemetry } from "../../packages/platform-bridge/src/contract.ts";
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

await test("native runtime spans reach Stats without recursive ingestion and collector loss is fail-open", async () => {
  const directory = resolve(import.meta.dirname, `../../.work/tmp/platform-native-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const batches: Batch[] = [];
  const otlpToken = randomBytes(32).toString("base64url");
  let forwardOrigin: string | undefined;
  let forwardFailures = 0;
  let bridge: ReturnType<typeof createBridgeServer> | undefined;
  let producer: ReturnType<typeof createProducer> | undefined;
  const collector = createServer(async (request, response) => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    if (batches.length >= 128) { response.writeHead(429).end(); return; }
    batches.push(JSON.parse(body.toString()) as Batch);
    if (forwardOrigin !== undefined) {
      try {
        const forwarded = await fetch(`${forwardOrigin}/v1/traces`, { method: "POST", headers: { "content-type": "application/json", authorization: request.headers.authorization ?? "" }, body, signal: AbortSignal.timeout(2000) });
        if (!forwarded.ok) forwardFailures++;
        response.writeHead(forwarded.status, { "content-type": "application/json" }).end(await forwarded.text());
      } catch { forwardFailures++; response.writeHead(503).end(); }
      return;
    }
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
  config.vars["PROJECTS"] = "[";
  writeFileSync(generated.stats, JSON.stringify(config), { mode: 0o600 });
  const headers = { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: "user:platform@example.com", "content-type": "application/json" };
  let session: Session | undefined;
  const spans = () => batches.flatMap(batch => batch.resourceSpans).flatMap(resource => resource.scopeSpans).flatMap(scope => scope.spans);
  try {
    session = await startSession(directory, await freePort(), { environment: {
      OTEL_SERVICE_NAME: "stats-runtime-proof", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json", OTEL_TRACES_SAMPLER: "always_on", OTEL_BSP_SCHEDULE_DELAY: "100", OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "64", OTEL_RESOURCE_ATTRIBUTES: "service.version=platform-proof,openorange.version=1.0.2", OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${otlpToken}`, OTEL_BSP_MAX_QUEUE_SIZE: "256", OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: "1000"
    } });
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${session!.origin}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const hostResponse = await post("/api/v1/admin/hosts", { name: "platform-native" });
    assert.equal(hostResponse.status, 201);
    const { hostId } = await hostResponse.json() as { hostId: string };
    const statsService = await post("/api/v1/admin/services", { name: "stats", hostIds: [hostId], healthUrl: `${session!.origin}/health` });
    assert.equal(statsService.status, 201);
    const serviceResponse = await post("/api/v1/admin/services", { name: PLATFORM_SERVICE, hostIds: [hostId], healthUrl: "https://platform.example/health" });
    assert.equal(serviceResponse.status, 400, "platform credentials have one owner outside the service registry");
    const installation = () => spans().filter(span => /^installation-[a-f0-9]+\/onRequest$/u.test(span.name));
    const observationKeys = () => new Set(spans().filter(span => /^observation-store-[a-f0-9]+\/onRequest$/u.test(span.name)).flatMap(span => span.attributes.filter(attribute => attribute.key === "rivet.actor.key").map(attribute => attribute.value.stringValue)));
    const readyDeadline = Date.now() + 10_000;
    while ((installation().length < 3 || observationKeys().size < 1) && Date.now() < readyDeadline) await new Promise(done => setTimeout(done, 50));
    const before = installation().length;
    assert.equal(before, 3);
    assert.equal(observationKeys().size, 1);
    const identity = (span: Span) => ({ name: span.attributes.find(attribute => attribute.key === "rivet.actor.name")!.value.stringValue!, key: span.attributes.find(attribute => attribute.key === "rivet.actor.key")!.value.stringValue! });
    const installationSource = spans().find(span => /^installation-[a-f0-9]+\/onRequest$/u.test(span.name))!;
    const observationSource = spans().find(span => /^observation-store-[a-f0-9]+\/onRequest$/u.test(span.name))!;
    const policy: BridgePolicy = { resourceService: "stats-runtime-proof", openorangeVersion: "1.0.2", rivetkitVersion: "3.1.2-rc.1", nativeVersion: "3.1.1", samplePpm: 1_000_000, actors: [{ role: "installation", ...identity(installationSource) }, { role: "observation", ...identity(observationSource) }] };
    producer = createProducer({ endpoint: session.origin, service: PLATFORM_SERVICE, token: ingestToken, release: "bridge-proof", flushIntervalMs: 100, queueLimit: 128, maxRetries: 0 });
    bridge = createBridgeServer({ producer, policy, token: otlpToken });
    await new Promise<void>(done => bridge!.server.listen(0, "127.0.0.1", done));
    const bridgeAddress = bridge.server.address();
    assert.ok(bridgeAddress !== null && typeof bridgeAddress !== "string");
    forwardOrigin = `http://127.0.0.1:${bridgeAddress.port}`;
    const wrong = await post(`/ingest/observe/v1/${PLATFORM_SERVICE}/batches`, { events: [] }, { authorization: `Bearer ${generateToken()}` });
    assert.equal(wrong.status, 401);
    const ingested = await post(`/ingest/observe/v1/${PLATFORM_SERVICE}/batches`, { events: [{ schemaVersion: 1, eventId: "platform-proof", service: PLATFORM_SERVICE, release: "proof", atMs: Date.now(), operation: "platform.proof", durationMs: 1, outcome: "ok", work: {} }] }, { authorization: `Bearer ${ingestToken}` });
    assert.equal(ingested.status, 202, await ingested.clone().text());
    const deadline = Date.now() + 10_000;
    while (observationKeys().size < 2 && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    assert.ok(spans().some(span => /^installation-[a-f0-9]+\/onRequest$/u.test(span.name)));
    assert.ok(spans().some(span => span.name === "rivet.sqlite.execute"));
    assert.equal(observationKeys().size, 2, "the platform sink has a separate actor identity");
    assert.equal(installation().length, before, "platform transport authentication must not invoke Installation");
    assert.equal((await fetch(`${session.origin}/api/v1/projects`, { headers })).status, 503, "the fixture produces a real observed actor failure");
    const summaryAtMs = Date.now();
    const summaryTrace = { traceId: "1".repeat(32), spanId: "2".repeat(16) };
    const summaryResponse = await fetch(`${session.origin}/api/observe/stats/external/telemetry/summary`, { headers: { ...headers, traceparent: `00-${summaryTrace.traceId}-${summaryTrace.spanId}-00` } });
    assert.equal(summaryResponse.status, 200);
    assert.match(summaryResponse.headers.get("Server-Timing")!, /app-query;dur=\d+\.\d{3}/u);
    assert.match(summaryResponse.headers.get("Server-Timing")!, /app-dispatch;dur=\d+\.\d{3}/u);
    assert.match(summaryResponse.headers.get("Server-Timing")!, /app-total;dur=\d+\.\d{3}/u);
    assert.equal(summaryResponse.headers.get("Stats-Ui-Observations"), "1");
    const browserTrace = { traceId: "3".repeat(32), spanId: "4".repeat(16) };
    const browserResponse = await post("/api/v1/ui-journeys", { schemaVersion: 1, source: "range", range: "6h", cache: false, outcome: "ok", startedAtMs: Date.now(), durationMs: 1500, trace: browserTrace, work: { query_us: 1_400_000, fetch_us: 1_490_000, render_us: 10_000 }, asset: "index-proof.js", dropped: 2 });
    assert.equal(browserResponse.status, 202);
    assert.deepEqual(await browserResponse.json(), { admitted: true });
    const deliveryDeadline = Date.now() + 10_000;
    while (bridge.counters().admitted < 4 && Date.now() < deliveryDeadline) await new Promise(done => setTimeout(done, 50));
    assert.ok(bridge.counters().admitted >= 4, "real native spans reach the translator");
    let last = -1, quietSince = Date.now();
    const quietDeadline = Date.now() + 8000;
    while (Date.now() < quietDeadline) {
      await producer.flush();
      const current = bridge.counters().admitted;
      if (current !== last) { last = current; quietSince = Date.now(); }
      if (Date.now() - quietSince >= 1000 && producer.stats().queued === 0) break;
      await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(Date.now() - quietSince >= 1000, "translated telemetry must settle rather than recursively generate more source spans");
    assert.equal(installation().length, before + 1, "only the projects read invokes Installation; the built-in Stats query requires no registry lookup");
    bridge.report();
    await producer.flush();
    const result = await fetch(`${session.origin}/api/observe/${PLATFORM_SERVICE}/platform`, { headers });
    assert.equal(result.status, 200, await result.clone().text());
    const telemetry = await result.json() as PlatformTelemetry;
    assert.ok(telemetry.operations.some(row => row.operation === "platform.installation.invoke" && row.failed > 0));
    assert.ok(telemetry.operations.some(row => row.operation === "platform.observation.invoke"));
    assert.ok(telemetry.operations.some(row => row.operation.includes(".sqlite.")));
    assert.equal(telemetry.delivery?.samplePpm, 1_000_000);
    assert.equal(telemetry.delivery.exporterLoss, "unknown");
    assert.ok(telemetry.operations.every(row => row.release === "platform-proof_oo-1.0.2_rk-3.1.2-rc.1_nr-3.1.1"));
    assert.equal(forwardFailures, 0, "the real native exporter must authenticate to the bridge");
    const correlated = await fetch(`${session.origin}/api/observe/stats/external?from=${summaryAtMs}&to=${Date.now() + 1}`, { headers });
    assert.equal(correlated.status, 200);
    const correlation = await correlated.json() as { events: { event: { operation: string; trace?: typeof summaryTrace; work: Record<string, number> } }[] };
    const measuredRead = correlation.events.find(row => row.event.operation === "http.get.application-summary");
    assert.deepEqual(measuredRead?.event.trace, summaryTrace);
    assert.ok(measuredRead!.event.work["query_us"]! >= 0);
    assert.ok(measuredRead!.event.work["dispatch_us"]! >= 0);
    const browserRead = correlation.events.filter(row => row.event.operation === "ui.range.6h.read");
    assert.equal(browserRead.length, 1, "one browser event is persisted without recursive HTTP transport events");
    assert.deepEqual(browserRead[0]!.event.trace, browserTrace);
    assert.equal(browserRead[0]!.event.work["query_us"], 1_400_000);
    assert.equal(browserRead[0]!.event.work["transport_dropped"], 2);
    const burstAtMs = Date.now();
    const burst = await Promise.all(Array.from({ length: 16 }, () => fetch(`${session!.origin}/api/v1/capabilities`, { headers })));
    assert.ok(burst.every(response => response.status === 200));
    let captured: { event: { operation: string; delivery?: { id: string; sequence: number; accepted: number } } }[] = [];
    const burstDeadline = Date.now() + 10_000;
    while (Date.now() < burstDeadline) {
      const response = await fetch(`${session.origin}/api/observe/stats/external?from=${burstAtMs}&to=${Date.now() + 1}`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { events: typeof captured };
      captured = body.events.filter(row => row.event.operation === "http.get.capabilities");
      if (captured.length === 16) break;
      await new Promise(done => setTimeout(done, 50));
    }
    assert.equal(captured.length, 16, "every real HTTP response eventually retains its observation");
    assert.ok(captured.every(row => row.event.delivery !== undefined));
    assert.equal(new Set(captured.map(row => row.event.delivery!.id)).size, 1, "native requests reuse the same bounded producer");
    assert.equal(new Set(captured.map(row => row.event.delivery!.sequence)).size, 16);
    assert.ok(new Set(captured.map(row => row.event.delivery!.accepted)).size < 16, "the real binding combines events across HTTP requests");
    collector.closeAllConnections();
    await new Promise<void>(done => collector.close(() => done()));
    for (let n = 0; n < 30; n++) assert.equal((await fetch(`${session.origin}/api/v1/hosts`, { headers })).status, 200, "collector failure must not fail actor requests");

  } finally {
    writeFileSync(resolve(directory, "../platform-native-loop-capture.json"), JSON.stringify(batches), { mode: 0o600 });
    writeFileSync(resolve(directory, "../platform-native-loop-counters.json"), JSON.stringify({ bridge: bridge?.counters(), producer: producer?.stats(), forwardFailures }), { mode: 0o600 });
    await session?.stop();
    if (bridge !== undefined) { bridge.server.closeAllConnections(); await new Promise<void>(done => bridge!.server.close(() => done())); }
    await producer?.shutdown();
    collector.closeAllConnections();
    await new Promise<void>(done => collector.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
