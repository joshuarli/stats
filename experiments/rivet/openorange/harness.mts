import { spawn, execFileSync } from "node:child_process";
import { join, resolve, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { openHistory } from "../../../cloudflare/src/binary/history.ts";
import { generate, ROOT } from "./generate.mts";

export const EXPERIMENTS = resolve(ROOT, "experiments/rivet");
const effectiveEnv = (): NodeJS.ProcessEnv => { const tmp = process.env.TMPDIR; if (tmp === undefined || isAbsolute(tmp)) return process.env; const abs = resolve(ROOT, tmp); mkdirSync(abs, { recursive: true }); return { ...process.env, TMPDIR: abs }; };
export const BIN = join(EXPERIMENTS, "node_modules", "open-orange", "dist", "bin.js");
export const OFFLINE = join(ROOT, "scripts/offline-run.sh");

export function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => done(typeof address === "object" && address !== null ? address.port : 0)); });
  });
}

export function processTree(rootPid: number): { processes: readonly { pid: number; ppid: number; rssKiB: number; command: string }[] } {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).trim().split("\n")
    .map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line)!).map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4]! }));
  const included = new Set<number>([rootPid]);
  for (let previous = -1; previous !== included.size;) { previous = included.size; for (const row of rows) if (included.has(row.ppid)) included.add(row.pid); }
  return { processes: rows.filter(row => included.has(row.pid)) };
}

export function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (value instanceof Float64Array) return { $f64: [...value] };
  if (value instanceof BigUint64Array) return { $u64: [...value].map(entry => entry.toString()) };
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]));
  return value;
}

export function historyFingerprint(bytes: Uint8Array): string {
  const view = openHistory(bytes).root;
  return JSON.stringify(normalizeValue(view));
}

export interface Session {
  readonly origin: string;
  readonly child: import("node:child_process").ChildProcess;
  readonly readyMs: number;
  readonly logs: readonly string[];
  stop(): Promise<void>;
}

export async function startSession(stateDir: string, port: number, sandbox: boolean): Promise<Session> {
  const args = [BIN, "dev", "--json", "--ip", "127.0.0.1", "--port", String(port), "--config", join(stateDir, "stats.jsonc"), "--config", join(stateDir, "observe.jsonc")];
  const command = sandbox ? OFFLINE : process.execPath;
  const commandArgs = sandbox ? [process.execPath, ...args] : args;
  const child = spawn(command, commandArgs, { cwd: stateDir, env: effectiveEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  let ready: { origin: string; elapsedMs: number } | undefined;
  let failed: Error | undefined;
  const started = performance.now();
  child.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      logs.push(line);
      try {
        const event = JSON.parse(line) as { type?: string; url?: string; elapsedMs?: number; message?: string };
        if (event.type === "ready" && typeof event.url === "string") ready = { origin: event.url, elapsedMs: event.elapsedMs ?? (performance.now() - started) };
        else if (event.type === "error" || event.type === "fatal") failed ??= new Error(event.message ?? line);
      } catch { /* non-JSON output retained in logs */ }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { for (const line of chunk.toString("utf8").split("\n")) if (line.trim() !== "") logs.push(`stderr: ${line}`); });
  child.on("exit", code => { if (ready === undefined) failed ??= new Error(`orange dev exited (${code}) before ready; captured output:\n${logs.slice(-8).join("\n")}`); });
  child.on("error", error => { failed ??= error instanceof Error ? error : new Error(String(error)); });
  const deadline = performance.now() + 120_000;
  while (ready === undefined && failed === undefined && performance.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
  if (failed !== undefined) throw failed;
  if (ready === undefined) throw new Error(`orange dev did not report ready within 120s; logs:\n${logs.join("\n")}`);
  return {
    origin: ready.origin,
    child,
    readyMs: Math.round(ready.elapsedMs),
    logs,
    async stop() {
      child.kill("SIGTERM");
      const deadline = performance.now() + 10_000;
      while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once("exit", () => done()); });
    },
  };
}

export async function waitForHttp(origin: string, path: string, access: Record<string, string>, timeoutMs = 30_000): Promise<Response> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${origin}${path}`, { headers: access });
      return response;
    } catch (error) {
      if (performance.now() > deadline) throw error;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }
}

export { generate, ROOT };
