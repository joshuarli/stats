// Forwards loopback HTTP to a guest's Stats app with the gateway headers production ingress adds,
// so statsctl can check a recreated guest reached over an SSH tunnel.
//   GATEWAY_SECRET=SECRET node gateway-proxy.mjs LISTEN_PORT TARGET_PORT
// The secret comes from the environment and is never logged.
import { request, createServer } from "node:http";

const [listen, target] = process.argv.slice(2).map(Number);
const secret = process.env.GATEWAY_SECRET;
if (!Number.isInteger(listen) || !Number.isInteger(target) || !secret) {
  console.error("usage: GATEWAY_SECRET=SECRET node gateway-proxy.mjs LISTEN_PORT TARGET_PORT");
  process.exit(2);
}
createServer((incoming, outgoing) => {
  const headers = { ...incoming.headers, "stats-gateway-secret": secret, "stats-tailnet-identity": "user:guest-recreation@localhost", host: `127.0.0.1:${target}` };
  const upstream = request({ host: "127.0.0.1", port: target, method: incoming.method, path: incoming.url, headers }, response => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(upstream);
}).listen(listen, "127.0.0.1", () => console.log(`gateway proxy 127.0.0.1:${listen} -> 127.0.0.1:${target}`));
