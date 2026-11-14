import { randomBytes } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from "../src/cloudflare/gateway.ts";

export const LOCAL_IDENTITY = "user:local@localhost";

const ASSERTED = new Set([GATEWAY_SECRET_HEADER.toLowerCase(), GATEWAY_IDENTITY_HEADER.toLowerCase()]);

export function gatewaySecret(): string {
  return randomBytes(32).toString("hex");
}

export function gatewayAssertion(secret: string, identity = LOCAL_IDENTITY): Record<string, string> {
  return { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: identity };
}

export function asserted(headers: IncomingHttpHeaders, secret: string): IncomingHttpHeaders {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !ASSERTED.has(name) && !name.startsWith("tailscale-")));
  return { ...kept, ...gatewayAssertion(secret) };
}

export interface LocalGateway {
  readonly origin: string;
  close(): Promise<void>;
}

export async function startGateway(upstream: string, secret: string, port = 0): Promise<LocalGateway> {
  const target = new URL(upstream);
  const server = createServer((incoming, outgoing) => {
    const proxied = request({ hostname: target.hostname, port: target.port, method: incoming.method, path: incoming.url, headers: asserted(incoming.headers, secret) }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    proxied.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on("aborted", () => proxied.destroy());
    outgoing.on("close", () => proxied.destroy());
    incoming.pipe(proxied);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const bound = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${bound}`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}
