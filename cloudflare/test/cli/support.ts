import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export const CLOUDFLARE_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const TOKEN = "tok-4f9c2e7a-secret";

export interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCli(args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli/statsctl.ts", ...args], {
      cwd: CLOUDFLARE_DIR,
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}


export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
}

export interface FakeOrigin {
  readonly origin: string;
  readonly seen: Seen[];
  readonly connections: () => number;
  close(): Promise<void>;
}

export type Handler = (request: IncomingMessage, response: ServerResponse, seen: readonly Seen[]) => void;

export async function fakeOrigin(handler: Handler): Promise<FakeOrigin> {
  const seen: Seen[] = [];
  let connections = 0;
  const server: Server = createServer((request, response) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    handler(request, response, seen);
  });
  server.on("connection", socket => {
    connections += 1;
    socket.unref();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    connections: () => connections,
    close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}

export function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export const collector = { lastRunAtMs: 1_700_000_000_000, lastSuccessAtMs: 1_700_000_000_000, lastError: null, stale: false };

export const projectEntry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), worker: `${id}-worker`, workerBilling: "requests-and-cpu" as const, buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector, ...overrides
});

export const deploymentHistory = (projectId: string, overrides: Record<string, unknown> = {}) => ({
  projectId, worker: `${projectId}-worker`, enabled: true, deployments: [], versions: [],
  sync: { lastAttemptAtMs: 1_700_000_000_000, lastSuccessAtMs: 1_700_000_000_000, error: null, truncated: false }, ...overrides
});

export const observeHealth = (newestAtMs: number, overrides: Record<string, unknown> = {}) => ({
  newestAtMs, oldestAtMs: newestAtMs - 86_400_000, liveInvocations: 100, cleanupBacklog: 0, cleanupLagMs: 0, openIssues: 0,
  duplicate: 0, conflict: 0, expired: 0, future: 0, rejected: 0, issueCapacity: 500, evicted: 0, reasons: [],
  writes: { ingestBatches: 10, accepted: 100, ingestRows: 300, cleanupRows: 10 }, databaseBytes: 4096, ...overrides
});

export function authorized(request: IncomingMessage): boolean {
  return request.headers["authorization"] === undefined && request.headers["cf-access-token"] === undefined;
}
