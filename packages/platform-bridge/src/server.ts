import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Producer } from "../../producer/src/index.ts";
import { projectBatch, validatePolicy, type BridgePolicy } from "./project.ts";

export const MAX_OTLP_BYTES = 1024 * 1024;
export interface BridgeCounters { received: number; admitted: number; filtered: number; invalid: number; rejectedRequests: number; }
export function createBridgeServer(options: { readonly producer: Producer; readonly policy: BridgePolicy; readonly token: string }) {
  validatePolicy(options.policy);
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(options.token)) throw new TypeError("invalid OTLP credential");
  const credential = Buffer.from(`Bearer ${options.token}`);
  const counters: BridgeCounters = { received: 0, admitted: 0, filtered: 0, invalid: 0, rejectedRequests: 0 };
  let active = 0;
  const json = (response: ServerResponse, status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/health" && request.method === "GET") { json(response, 200, { ok: true, ...counters, producer: options.producer.stats() }); return; }
    if (request.url !== "/v1/traces") { json(response, 404, { error: "not_found" }); return; }
    if (request.method !== "POST") { json(response, 405, { error: "method_not_allowed" }); return; }
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (authorization.length !== credential.length || !timingSafeEqual(authorization, credential)) { json(response, 403, { error: "forbidden" }); return; }
    if (active >= 4) { counters.rejectedRequests++; json(response, 429, { error: "busy" }); return; }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) { counters.rejectedRequests++; json(response, 415, { error: "unsupported_media_type" }); return; }
    const length = request.headers["content-length"];
    if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_OTLP_BYTES)) { counters.rejectedRequests++; json(response, 413, { error: "too_large" }); return; }
    active++;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += (chunk as Buffer).length;
        if (bytes > MAX_OTLP_BYTES) { counters.rejectedRequests++; json(response, 413, { error: "too_large" }); return; }
        chunks.push(chunk as Buffer);
      }
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
      const projected = projectBatch(body, options.policy);
      counters.received += projected.received;
      counters.filtered += projected.filtered;
      counters.invalid += projected.invalid;
      for (const event of projected.events) options.producer.record(event);
      counters.admitted += projected.events.length;
      json(response, 200, projected.invalid === 0 ? {} : { partialSuccess: { rejectedSpans: String(projected.invalid), errorMessage: "invalid spans discarded" } });
    } catch {
      counters.rejectedRequests++;
      if (!response.headersSent && !response.destroyed) json(response, 400, { error: "invalid_otlp" });
    } finally { active--; }
  };
  const server = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent && !response.destroyed) json(response, 500, { error: "internal" }); }); });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 100;
  const report = () => {
    const delivery = options.producer.stats();
    options.producer.record({ operation: "platform.bridge", outcome: "ok", durationMs: 0, work: { received: counters.received, admitted: counters.admitted, filtered: counters.filtered, invalid: counters.invalid, dropped: delivery.dropped, queued: delivery.queued, sent: delivery.sent, sample_ppm: options.policy.samplePpm } });
  };
  return { server, counters: () => ({ ...counters }), report };
}
