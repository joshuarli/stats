import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { ORANGE_ROOT } from "./generate.mts";

export const ORANGE_BIN = join(ORANGE_ROOT, "node_modules/open-orange/dist/bin.js");
const READY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;

export interface Session {
  readonly origin: string;
  readonly child: ChildProcess;
  readonly readyMs: number;
  readonly logs: readonly string[];
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

export async function startSession(stateDir: string, port: number): Promise<Session> {
  const args = [ORANGE_BIN, "dev", "--json", "--ip", "127.0.0.1", "--port", String(port), "--config", join(stateDir, "stats.jsonc"), "--config", join(stateDir, "observe.jsonc")];
  const child = spawn(process.execPath, args, { cwd: stateDir, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  const started = performance.now();
  let ready: { origin: string; ms: number } | undefined;
  let failed: Error | undefined;
  child.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      logs.push(line);
      let event: { type?: string; url?: string; message?: string };
      try { event = JSON.parse(line) as typeof event; } catch { continue; }
      if (event.type === "ready" && typeof event.url === "string") ready = { origin: event.url.replace(/\/$/u, ""), ms: performance.now() - started };
      else if (event.type === "error" || event.type === "fatal") failed ??= new Error(event.message ?? line);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { for (const line of chunk.toString("utf8").split("\n")) if (line.trim() !== "") logs.push(`stderr: ${line}`); });
  child.once("exit", code => { if (ready === undefined) failed ??= new Error(`orange dev exited ${code} before ready:\n${logs.slice(-10).join("\n")}`); });
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (ready === undefined && failed === undefined && performance.now() < deadline) await new Promise(wake => setTimeout(wake, 50));
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(done => child.once("exit", () => done()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  };
  if (ready === undefined) {
    await stop();
    throw failed ?? new Error(`orange dev was not ready within ${READY_TIMEOUT_MS} ms:\n${logs.slice(-10).join("\n")}`);
  }
  return { origin: ready.origin, child, readyMs: Math.round(ready.ms), logs, stop };
}
