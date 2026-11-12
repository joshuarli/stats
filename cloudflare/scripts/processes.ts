import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";

const SCRATCH = resolve(import.meta.dirname, "../../.work/tmp");

interface ProcessResult { readonly code: number; readonly elapsedMs: number; readonly logPath: string }
interface OwnedProcess {
  readonly child: ChildProcess;
  readonly logPath: string;
  readonly done: Promise<ProcessResult>;
  kill(signal: NodeJS.Signals): void;
}

export function processOwner(label: string) {
  mkdirSync(SCRATCH, { recursive: true });
  const directory = mkdtempSync(join(SCRATCH, `${label}-`));
  const active = new Set<OwnedProcess>();
  const controller = new AbortController();
  let stopping: Promise<void> | undefined;
  async function stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (stopping !== undefined) return stopping;
    controller.abort();
    stopping = Promise.allSettled([...active].map(async record => {
      record.kill(signal);
      const timer = setTimeout(() => record.kill("SIGKILL"), 5000);
      try { await record.done; } finally { clearTimeout(timer); }
    })).then(() => {});
    await stopping;
  }
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const signalHandlers = new Map(signals.map(signal => [signal, () => { process.exitCode = 128 + constants.signals[signal]; void stop(signal); }]));
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  function start(name: string, command: string, args: readonly string[], options: SpawnOptionsWithoutStdio & { readonly stream?: boolean } = {}): OwnedProcess {
    if (controller.signal.aborted) throw new Error(`${label} was cancelled`);
    const logPath = join(directory, `${name.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}.log`);
    const log = createWriteStream(logPath);
    const { stream = true, ...spawnOptions } = options;
    const env = { ...(spawnOptions.env ?? process.env) };
    delete env["NODE_TEST_CONTEXT"];
    const child = spawn(command, args, { ...spawnOptions, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const started = performance.now();
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    };
    const output = (chunk: Buffer): void => {
      log.write(chunk);
      tail = (tail + String(chunk)).slice(-32_768);
      if (stream) process.stderr.write(chunk);
    };
    child.stdout!.on("data", output);
    child.stderr!.on("data", output);
    const done = new Promise<ProcessResult>((resolveDone, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        active.delete(record);
        log.end();
        if (code === 0) resolveDone({ code, elapsedMs: performance.now() - started, logPath });
        else reject(new Error(`${name} exited ${code ?? signal}; log ${logPath}\n${tail}`));
      });
    });
    const record: OwnedProcess = { child, logPath, kill, done };
    void done.catch(() => {});
    active.add(record);
    return record;
  }
  return {
    directory, signal: controller.signal, start,
    run: async (name: string, command: string, args: readonly string[], options?: SpawnOptionsWithoutStdio & { readonly stream?: boolean }) => await start(name, command, args, options).done,
    stop,
    close: async () => {
      await stop();
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    }
  };
}
