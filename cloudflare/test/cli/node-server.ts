import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { CLOUDFLARE_DIR } from "./support.ts";

export const LOGIN = "target-test@example.com";

export interface Node {
  readonly child: ChildProcess;
  readonly port: number;
}

export async function startNode(dataDir: string): Promise<Node> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/node/main.ts"], {
    cwd: CLOUDFLARE_DIR,
    env: { PATH: process.env["PATH"] ?? "", STATS_DATA_DIR: dataDir, STATS_LISTEN: "127.0.0.1:0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stderr!.on("data", chunk => { output += String(chunk); });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not report a port: ${output}`)), 10_000);
    child.stdout!.on("data", chunk => {
      output += String(chunk);
      const match = /"event":"listening","host":"127\.0\.0\.1","port":(\d+)/u.exec(output);
      if (match === null) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    });
    child.once("exit", code => reject(new Error(`server exited with ${code}: ${output}`)));
  });
  return { child, port };
}

export function identityProxy(port: number, seen: IncomingMessage["headers"][]): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    seen.push(incoming.headers);
    const forwarded = request({ host: "127.0.0.1", port, path: incoming.url, method: incoming.method, headers: { ...incoming.headers, "tailscale-user-login": LOGIN } }, reply => {
      outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(outgoing);
    });
    forwarded.on("error", () => outgoing.destroy());
    incoming.pipe(forwarded);
  });
  return new Promise(resolveListen => server.listen(0, "localhost", () => resolveListen(server)));
}
