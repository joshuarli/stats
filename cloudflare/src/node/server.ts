import { INFRA_SERVICE } from "../../../packages/infra-collector/src/contract.ts";
import { constantTimeEqual, tokenHash } from "../auth.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createBrotliCompress, createGzip } from "node:zlib";
import { gatewayDecision } from "../core/gateway.ts";
import type { NodeAuth } from "./config.ts";
import { handleStatsRequest, type ObserveService, type StatsTarget } from "../core/http.ts";
import { createStatsHealth } from "../core/health.ts";
import { handleApi } from "../observe/http/api.ts";
import type { NodeRuntime } from "./runtime.ts";
import type { NodeApplicationEvents } from "./application.ts";
import type { NodeInstallation } from "./installation.ts";
import type { AssetReader } from "./assets.ts";
import { tailscaleDecision, type Peer } from "./tailscale.ts";

export interface NodeStatsOptions {
  readonly release?: string | undefined;
  readonly trackRequest?: (request: Promise<void>) => void;
  readonly runtime?: NodeRuntime | undefined;
  readonly application?: NodeApplicationEvents | undefined;
  readonly auth?: NodeAuth | undefined;
  readonly metricsVerifier?: string | undefined;
  readonly metrics?: (request: Request) => Promise<Response>;
  readonly installation: (request: Request) => Promise<Response>;
  readonly observe?: ObserveService;
  readonly assets: AssetReader;
  readonly transport: "tcp" | "unix";
}

export function observeHandler(installation: Pick<NodeInstallation, "observe" | "now">): ObserveService {
  return (target, init) => {
    const url = new URL(target);
    const match = /^\/([a-z][a-z0-9-]{0,31})(\/.*)$/u.exec(url.pathname);
    if (match === null) return Promise.resolve(Response.json({ error: { code: "not_found", message: "unknown observe route" } }, { status: 404, headers: { "Cache-Control": "no-store" } }));
    return handleApi(new Request(`https://observe${match[2]}${url.search}`, init), match[2]!, installation.observe.forService(match[1]!), match[1]!, installation.now());
  };
}

const UNAVAILABLE: ObserveService = () => Promise.resolve(Response.json({ error: { code: "unavailable", message: "observability is not available on this target" } }, { status: 503, headers: { "Cache-Control": "no-store" } }));

const FALLBACK_ORIGIN = "http://stats.internal";

function originOf(headers: Headers): string {
  const host = headers.get("Host");
  if (host === null || !/^[A-Za-z0-9.:[\]-]+$/u.test(host)) return FALLBACK_ORIGIN;
  return `${headers.get("X-Forwarded-Proto") === "https" ? "https" : "http"}://${host}`;
}

function requestFrom(incoming: IncomingMessage): Request {
  const headers = new Headers();
  for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
  const origin = originOf(headers);
  const target = new URL(incoming.url ?? "/", origin);
  const url = new URL(`${target.pathname}${target.search}`, origin);
  const method = incoming.method ?? "GET";
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const init = { method, headers, body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" };
  return new Request(url, init as RequestInit);
}

function encoder(coding: string | null): Transform | null {
  if (coding === "br") return createBrotliCompress();
  if (coding === "gzip") return createGzip();
  return null;
}

async function respond(outgoing: ServerResponse, response: Response, method: string, runtime?: NodeRuntime): Promise<void> {
  const headers = new Headers(response.headers);
  // workerd compresses a body whose Content-Encoding it is handed; node:http sends bytes as given.
  const compress = response.body === null ? null : encoder(headers.get("Content-Encoding"));
  if (compress !== null) headers.delete("Content-Length");
  outgoing.writeHead(response.status, response.statusText === "" ? undefined : response.statusText, [...headers]);
  if (response.body === null || method === "HEAD") {
    await response.body?.cancel();
    outgoing.end();
    return;
  }
  const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  const count = new Transform({ transform(chunk: Buffer, _encoding, callback) { runtime?.responseBytes(chunk.byteLength); callback(null, chunk); } });
  runtime?.streamStarted();
  try { await (compress === null ? pipeline(body, count, outgoing) : pipeline(body, compress, count, outgoing)); }
  finally { runtime?.streamFinished(); }
}

function failed(incoming: IncomingMessage, outgoing: ServerResponse, error: unknown): void {
  const path = (incoming.url ?? "").split("?", 1)[0]!.slice(0, 256);
  const detail = error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 200), stack: (error.stack ?? "").split("\n").slice(1, 6).map(line => line.trim().slice(0, 200)) }
    : { name: typeof error };
  console.error(JSON.stringify({ event: "request_failed", method: incoming.method, path, headersSent: outgoing.headersSent, ...detail }));
  if (outgoing.headersSent) {
    outgoing.destroy();
    return;
  }
  outgoing.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code: "internal", message: "internal error" } }));
}

export function statsRequestListener(options: NodeStatsOptions): (incoming: IncomingMessage, outgoing: ServerResponse) => void {
  const shared = { installation: options.installation, assets: options.assets, observe: options.observe ?? UNAVAILABLE };
  const health = createStatsHealth({ installation: options.installation, ...(options.metrics === undefined ? {} : { metrics: options.metrics }), metricsAvailable: /^[a-f0-9]{64}$/u.test(options.metricsVerifier ?? ""), release: options.release });
  return (incoming, outgoing) => {
    options.runtime?.requestStarted();
    outgoing.once("close", () => options.runtime?.requestFinished());
    const peer: Peer = options.transport === "unix" ? { kind: "unix" } : { kind: "tcp", address: incoming.socket.remoteAddress };
    const target: StatsTarget = {
      ...shared,
      health,
      ...(options.runtime === undefined ? {} : { runtime: () => options.runtime!.snapshot() }),
      ...(options.application === undefined ? {} : { recordBrowserJourney: (journey) => options.application!.recordBrowserJourney(journey) }),
      metricsAvailable: /^[a-f0-9]{64}$/u.test(options.metricsVerifier ?? ""),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      capabilities: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true, infraMetrics: /^[a-f0-9]{64}$/u.test(options.metricsVerifier ?? "") },
      authorize: request => Promise.resolve(options.auth?.kind === "gateway" ? gatewayDecision(request.headers, options.auth.secret) : tailscaleDecision(peer, request.headers)),
      authorizeIngest: async (service, token) => {
        if (service === INFRA_SERVICE) return options.metricsVerifier !== undefined && /^[a-f0-9]{64}$/u.test(options.metricsVerifier) && constantTimeEqual(await tokenHash(token), options.metricsVerifier);
        const response = await options.installation(new Request("https://installation/ingest/observe-auth", {
          method: "POST", headers: { "x-observe-service": service, authorization: `Bearer ${token}` }
        }));
        return response.status === 204;
      },
      serviceExists: async service => (await options.installation(new Request(`https://installation/services/${encodeURIComponent(service)}`))).status === 200
    };
    const task = (async () => {
      let request: Request;
      try {
        request = requestFrom(incoming);
      } catch {
        outgoing.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code: "invalid_request", message: "malformed request" } }));
        return;
      }
      const run = () => handleStatsRequest(request, target);
      const response = await (options.application === undefined ? run() : options.application.capture(request, run));
      const complete = options.application?.bodyCompletion(response);
      if (complete !== undefined) {
        let finished = false;
        outgoing.once("finish", () => { finished = true; complete(false); });
        outgoing.once("close", () => { if (!finished) complete(true); });
      }
      await respond(outgoing, response, request.method, options.runtime);
    })().catch((error: unknown) => failed(incoming, outgoing, error));
    options.trackRequest?.(task);
  };
}

export function createStatsServer(options: NodeStatsOptions): Server {
  return createServer(statsRequestListener(options));
}
