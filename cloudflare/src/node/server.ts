import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createBrotliCompress, createGzip } from "node:zlib";
import { handleStatsRequest, type StatsTarget } from "../core/http.ts";
import type { AssetReader } from "./assets.ts";
import { tailscaleDecision } from "./tailscale.ts";

export interface NodeStatsOptions {
  readonly installation: (request: Request) => Promise<Response>;
  readonly assets: AssetReader;
  readonly allowedLogins: ReadonlySet<string>;
}

const FALLBACK_ORIGIN = "http://stats.internal";

function originOf(headers: Headers): string {
  const host = headers.get("Host");
  if (host === null || !/^[A-Za-z0-9.:\[\]-]+$/u.test(host)) return FALLBACK_ORIGIN;
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

async function respond(outgoing: ServerResponse, response: Response, method: string): Promise<void> {
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
  await (compress === null ? pipeline(body, outgoing) : pipeline(body, compress, outgoing));
}

function failed(outgoing: ServerResponse, error: unknown): void {
  console.error(JSON.stringify({ event: "request_failed", name: error instanceof Error ? error.name : typeof error }));
  if (outgoing.headersSent) {
    outgoing.destroy();
    return;
  }
  outgoing.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code: "internal", message: "internal error" } }));
}

export function statsRequestListener(options: NodeStatsOptions): (incoming: IncomingMessage, outgoing: ServerResponse) => void {
  const shared = { installation: options.installation, assets: options.assets, observe: null };
  return (incoming, outgoing) => {
    const peer = incoming.socket.remoteAddress;
    const target: StatsTarget = { ...shared, authorize: request => Promise.resolve(tailscaleDecision(peer, request.headers, options.allowedLogins)) };
    void (async () => {
      let request: Request;
      try {
        request = requestFrom(incoming);
      } catch {
        outgoing.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code: "invalid_request", message: "malformed request" } }));
        return;
      }
      await respond(outgoing, await handleStatsRequest(request, target), request.method);
    })().catch((error: unknown) => failed(outgoing, error));
  };
}

export function createStatsServer(options: NodeStatsOptions): Server {
  return createServer(statsRequestListener(options));
}
