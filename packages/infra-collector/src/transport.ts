import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";

export async function request(url: string, options: { method: "GET" | "POST"; headers?: OutgoingHttpHeaders; body?: string; timeoutMs: number }): Promise<IncomingMessage> {
  const address = new URL(url);
  const send = address.protocol === "https:" ? (await import("node:https")).request : address.protocol === "http:" ? httpRequest : null;
  if (send === null) throw new Error("unsupported protocol");
  return new Promise((resolve, reject) => {
    const outgoing = send(address, { method: options.method, headers: options.headers, signal: AbortSignal.timeout(options.timeoutMs) }, resolve);
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}

export async function responseText(response: IncomingMessage, limit: number): Promise<string> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    const part = chunk as Buffer;
    bytes += part.length;
    if (bytes > limit) {
      response.destroy();
      throw new Error("response too large");
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
}
