import { createServer } from "node:http";
import { spawn } from "node:child_process";

export async function startHealthFixture(container?: string): Promise<{ url(service: string): string; close(): Promise<void> }> {
  if (container !== undefined) {
    const script = `const http = require('node:http'); const server = http.createServer((request, response) => { const name = new URL(request.url, 'http://localhost').searchParams.get('service'); response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ status: 'ok', service: name, checks: {} })); }); server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, pid: process.pid })));`;
    const child = spawn("docker", ["exec", container, "node", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    const started = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("container health fixture did not start")); }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (!output.includes("\n")) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.slice(0, output.indexOf("\n"))) as { port: number; pid: number }); } catch (error) { reject(error); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("container health fixture exited")); });
    });
    if (!Number.isSafeInteger(started.port) || started.port < 1 || !Number.isSafeInteger(started.pid) || started.pid < 1) throw new Error("invalid container health fixture address");
    return {
      url: service => `http://127.0.0.1:${started.port}/health?service=${encodeURIComponent(service)}`,
      close: () => new Promise<void>((resolve, reject) => {
        const stop = spawn("docker", ["exec", container, "sh", "-c", 'kill "$1"', "fixture", String(started.pid)], { stdio: "ignore" });
        stop.once("error", reject);
        stop.once("exit", code => code === 0 ? resolve() : reject(new Error("container health fixture did not stop")));
      })
    };
  }
  const server = createServer((request, response) => {
    const name = new URL(request.url ?? "/", "http://localhost").searchParams.get("service");
    if (request.method !== "GET" || name === null || !/^[a-z][a-z0-9-]{0,31}$/u.test(name)) { response.writeHead(400).end(); return; }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", service: name, checks: {} }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("health fixture did not listen");
  return {
    url: service => `http://127.0.0.1:${address.port}/health?service=${encodeURIComponent(service)}`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}
