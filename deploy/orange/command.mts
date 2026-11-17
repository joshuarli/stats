import { spawn } from "node:child_process";

export const COMMAND_KILL_GRACE_MS = 5000;

export interface CommandOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly capture?: boolean;
  readonly output: (chunk: string | Buffer, visible: boolean) => void;
}

export function runCommand(file: string, args: readonly string[], { timeoutMs, signal, capture = false, output }: CommandOptions): Promise<string> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", failure: Error | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (name: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, name); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), COMMAND_KILL_GRACE_MS);
    };
    const aborted = () => stop(signal?.reason instanceof Error ? signal.reason : new Error("deployment command cancelled", { cause: signal?.reason }));
    const deadline = setTimeout(() => stop(new Error(`${file} exceeded its ${timeoutMs / 1000}s deadline`)), timeoutMs);
    const started = performance.now();
    let lastOutput = started;
    const progress = setInterval(() => {
      if (performance.now() - lastOutput >= 10000) output(`  … waiting for ${file} (${Math.floor((performance.now() - started) / 1000)}s; limit ${timeoutMs / 1000}s)\n`, true);
    }, 10000);
    signal?.addEventListener("abort", aborted, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; lastOutput = performance.now(); output(chunk, !capture); });
    child.stderr.on("data", (chunk: Buffer) => { lastOutput = performance.now(); output(chunk, true); });
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, name) => {
      clearTimeout(deadline); clearTimeout(escalation); clearInterval(progress);
      signal?.removeEventListener("abort", aborted);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${file} exited ${code ?? name}`));
      else resolve(stdout.trim());
    });
  });
}
