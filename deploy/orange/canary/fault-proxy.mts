import { createServer, request } from "node:http";

export async function faultProxy(origin: string) {
  let altered = false;
  const server = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url!, origin);
    const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        let body = Buffer.concat(chunks);
        const headers = { ...response.headers };
        if (!altered && response.statusCode === 200 && incoming.url === "/api/v1/capabilities") {
          altered = true;
          body = Buffer.from("{}");
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          headers["content-length"] = String(body.length);
        }
        outgoing.writeHead(response.statusCode!, headers).end(body);
      });
    });
    upstream.on("error", error => outgoing.destroy(error));
    incoming.pipe(upstream);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("proxy did not bind");
  return { origin: `http://127.0.0.1:${address.port}`, altered: () => altered, stop: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
