import { collectAt, seed } from "./seed.ts";
import { startStack, type Stack, type WorkerProducerStart } from "./stack.ts";

export interface BackendStart {
  readonly state: string;
  readonly statsOutput: string;
  readonly observeOutput: string;
  readonly initialize: boolean;
  readonly producers: readonly string[];
  readonly workerProducers: readonly WorkerProducerStart[];
}

export interface BackendReady {
  readonly event: "backend-ready";
  readonly origin: string;
  readonly producers: readonly { readonly service: string; readonly origin: string }[];
}

export type BackendMessage = BackendReady | { readonly event: "backend-error" };
let stack: Stack | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let serial = Promise.resolve();
let collection = Promise.resolve();
let stopping: Promise<void> | undefined;

async function dispose(): Promise<void> {
  clearTimeout(timer);
  await collection;
  const previous = stack;
  stack = undefined;
  await previous?.dispose();
}

async function shutdown(): Promise<void> {
  stopping ??= (async () => {
    clearTimeout(timer);
    await serial;
    await dispose();
    if (process.connected) process.disconnect?.();
  })();
  await stopping;
}

async function activate(options: BackendStart): Promise<void> {
  await dispose();
  stack = await startStack({ nowMs: null, persist: options.state, statsOutput: options.statsOutput, observeOutput: options.observeOutput, localExplorer: true, producers: options.producers, workerProducers: options.workerProducers });
  if (options.initialize) {
    const response = await stack.fetch("/api/v1/hosts");
    if (response.status !== 200) throw new Error(`backend hosts answered ${response.status}`);
    const hosts = await response.json() as { hosts: unknown[] };
    if (hosts.hosts.length === 0) await seed(stack, Date.now());
    else await collectAt(stack, Date.now());
  }
  if ((await stack.anonymous("/health")).status !== 200) throw new Error("backend health failed");
  const schedule = (): void => {
    timer = setTimeout(() => {
      collection = collectAt(stack!, Date.now()).catch(error => { console.error(`dev collection: ${String(error)}`); }).then(() => { if (stopping === undefined) schedule(); });
    }, 300_000 - Date.now() % 300_000);
  };
  if (stopping !== undefined) return;
  schedule();
  process.send?.({ event: "backend-ready", origin: stack.origin, producers: [...stack.producers, ...stack.workerProducers].map(producer => ({ service: producer.service, origin: producer.origin })) } satisfies BackendReady);
}

if (import.meta.main) {
  process.on("message", (message: BackendStart | "shutdown") => {
    if (message === "shutdown") { void shutdown(); return; }
    if (stopping !== undefined) return;
    serial = serial.then(() => activate(message)).catch(async error => {
      console.error(error);
      await dispose();
      process.send?.({ event: "backend-error" } satisfies BackendMessage);
    });
  });
  process.once("disconnect", () => { void shutdown(); });
}
