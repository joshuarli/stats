import { request as httpRequest } from "node:http";
import type { Request as MiniflareRequest, Response as MiniflareResponse } from "miniflare";
import { parseProjects } from "../src/projects/config.ts";
import type { Outbound } from "./topology.ts";

export interface OutboundRequest {
  readonly url: string;
  readonly scenario: string;
}

export interface OfflineOutbound {
  readonly handler: Outbound;
  readonly requests: readonly OutboundRequest[];
  scenario: string;
  unexpected(): OutboundRequest[];
}

export function probeUrls(projectsJson: string): string[] {
  return parseProjects(projectsJson).flatMap(project => project.probes.map(probe => new URL(probe.url).href));
}

export function offlineOutbound(declared: readonly string[]): OfflineOutbound {
  const expected = new Set(declared.map(url => new URL(url).href));
  const requests: OutboundRequest[] = [];
  const outbound: OfflineOutbound = {
    requests,
    scenario: "startup",
    handler: (request: MiniflareRequest) => {
      requests.push({ url: request.url, scenario: outbound.scenario });
      return new Response(`offline: ${request.url} is not reachable from the local stack`, { status: 503 }) as unknown as MiniflareResponse;
    },
    unexpected: () => requests.filter(request => !expected.has(new URL(request.url).href))
  };
  return outbound;
}

const LOOPBACK_ADDRESS = "127.0.0.1";

function forwardToLoopback(origin: URL, request: MiniflareRequest): Promise<MiniflareResponse> {
  const url = new URL(request.url);
  return request.arrayBuffer().then(body => new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => { if (name !== "transfer-encoding" && name !== "content-length") headers[name] = value; });
    headers["host"] = origin.host;
    if (body.byteLength > 0) headers["content-length"] = String(body.byteLength);
    const forwarded = httpRequest({ host: LOOPBACK_ADDRESS, port: Number(origin.port), method: request.method, path: `${url.pathname}${url.search}`, headers, setHost: false }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const replyHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) replyHeaders.append(name, item);
        }
        const status = response.statusCode ?? 502;
        const empty = status === 204 || status === 304 || request.method === "HEAD";
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: replyHeaders }) as unknown as MiniflareResponse);
      });
    });
    forwarded.on("error", error => reject(new Error(`${origin.origin} is declared by the producer export but did not answer on ${LOOPBACK_ADDRESS}:${origin.port}; start it before the producer calls it`, { cause: error })));
    forwarded.end(body.byteLength === 0 ? undefined : Buffer.from(body));
  }));
}

export function loopbackPassthrough(origins: readonly URL[], offline: Outbound): Outbound {
  const declared = new Map(origins.map(origin => [origin.origin, origin]));
  return request => {
    const origin = declared.get(new URL(request.url).origin);
    return origin === undefined ? offline(request) : forwardToLoopback(origin, request);
  };
}

export function describeUnexpected(requests: readonly OutboundRequest[]): string {
  return `unexpected outbound requests from the local stack: ${requests.map(request => `${request.url} (during ${request.scenario})`).join(", ")}`;
}
