import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare, convertV4MiniflareOptions, type V4ModuleDefinition, type V4WorkerOptions } from "miniflare";
import { gatewayHeaders } from "../gateway-headers.ts";
import { encodeFrame, type SourceBatch } from "../../src/ingest/encode.ts";
import { CLOUDFLARE_ROOT, OBSERVE_OUTPUT, STATS_OUTPUT, collectorModules as builtCollectorModules, collectorWorker, openWorkers, workers, readBuiltWorker, readTestVars, type Collector as TopologyCollector } from "../../local/topology.ts";

export const ROOT = CLOUDFLARE_ROOT;
const STATS = readBuiltWorker(STATS_OUTPUT);
const OBSERVE = readBuiltWorker(OBSERVE_OUTPUT);
export const VARS = readTestVars();
export const BATCH = JSON.parse(readFileSync(join(ROOT, "../fixtures/v2/sources/linux-normal.json"), "utf8")) as SourceBatch;
export const ORIGIN = "https://stats.example";
export const HOST_NAME = "host-name-QXZ";
export const SECRET_QUERY = "SECRET_IN_QUERY_7d1f";
const COMPAT = { compatibilityDate: OBSERVE.compatibilityDate, compatibilityFlags: [...OBSERVE.compatibilityFlags] };
const CRASHING_CONSUMER = "export default { tail() { throw new Error('collector down'); }, fetch() { throw new Error('collector down'); } };";

export function collectorModules(scriptName: string) {
  return builtCollectorModules(OBSERVE, scriptName);
}

const MEMORIES_PRODUCER = `
import diagnostics from "node:diagnostics_channel";
import { tracing } from "cloudflare:workers";
const channel = diagnostics.channel("stats.observe");
export default {
  async fetch(request) {
    const span = tracing.getActiveSpan();
    if (span !== undefined) { const context = span.spanContext(); channel.publish({ kind: "invocation", traceId: context.traceId, spanId: context.spanId }); }
    if (new URL(request.url).pathname.startsWith("/api/v1/sync/objects/")) {
      try { throw new TypeError("replacement failed"); }
      catch (error) { channel.publish({ kind: "error", operation: "sync.replace", name: error.name, message: error.message, stack: error.stack ?? null }); }
      return new Response("unavailable", { status: 503 });
    }
    return Response.json({ ok: true });
  }
};`;

export type StatsInit = NonNullable<Parameters<Miniflare["dispatchFetch"]>[1]>;
export type Response = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;
export type Collector = "attached" | "crashing" | "absent";
export type StatsClock = "fixed" | "wall";

export interface Harness {
  readonly mf: Miniflare;
  readonly persist: string;
  stats(path: string, init?: StatsInit): Promise<Response>;
  observe(path: string): Promise<unknown>;
  observeService(service: string, path: string): Promise<unknown>;
  memories(path: string): Promise<Response>;
  scheduled(): Promise<unknown>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export type Outbound = (request: Request) => Response | Promise<Response>;
const UNAVAILABLE: Outbound = () => new Response("upstream unavailable", { status: 503 });

function agentMemoryWorker(directory: string): V4WorkerOptions {
  const output = join(directory, "cloudflare/.cloudflare/output/v0/workers/default");
  const bundle = join(output, "bundle");
  const config = JSON.parse(readFileSync(join(output, "worker.config.json"), "utf8")) as {
    compatibilityDate: string;
    compatibilityFlags: string[];
    manifest: { mainModule: string; modules: Record<string, unknown> };
  };
  const main = config.manifest.mainModule;
  const names = Object.keys(config.manifest.modules).filter(name => name.endsWith(".js")).sort();
  const entry = `
import worker from "./${main}";
export default {
  async fetch(request, env, context) {
    return await worker.fetch(request, env, {
      access: { getIdentity: async () => ({ email: "reader@example.test" }) },
      tracing: context.tracing,
      waitUntil: context.waitUntil?.bind(context),
      passThroughOnException: context.passThroughOnException?.bind(context),
    });
  },
};
`;
  const modules: V4ModuleDefinition[] = [
    { type: "ESModule", path: join(bundle, "entry.js"), contents: entry },
    ...names.map(name => ({
      type: "ESModule" as const,
      path: join(bundle, name),
      contents: readFileSync(join(bundle, name), "utf8"),
    })),
  ];
  return {
    name: "usr-memories",
    modules,
    modulesRoot: bundle,
    compatibilityDate: config.compatibilityDate,
    compatibilityFlags: config.compatibilityFlags,
    bindings: {
      ACCESS_TEAM_DOMAIN: "team.example.test",
      ACCESS_AUD: "test-audience",
      READERS: "reader@example.test",
    },
    access: { aud: "test-audience", identity: { email: "reader@example.test" } },
    d1Databases: ["DB"],
    r2Buckets: ["BUCKET"],
    tails: ["memories-observe"],
  };
}

export async function start(collector: Collector, bindings: Record<string, string> = {}, outbound: Outbound = UNAVAILABLE, clock: StatsClock = "fixed", applicationRelease?: string, portable = false): Promise<Harness> {
  const persist = mkdtempSync(join(tmpdir(), "observe-e2e-"));
  const { ENVIRONMENT, PROJECTS, WORKER_NAME, TEST_NOW_MS, ...secrets } = VARS;
  const statsCollector: TopologyCollector = collector === "crashing" ? { kind: "replaced", script: CRASHING_CONSUMER } : { kind: collector };
  const agentMemory = process.env.AGENT_MEMORY_DIR;
  const memoriesCollector = collector === "crashing"
    ? { name: "memories-observe", modules: true, script: CRASHING_CONSUMER, ...COMPAT }
    : collectorWorker(OBSERVE, "memories-observe", "usr-memories");
  const memoriesWorker = agentMemory === undefined
    ? { name: "usr-memories", modules: true, script: MEMORIES_PRODUCER, ...COMPAT, ...(collector === "absent" ? {} : { tails: ["memories-observe"] }) }
    : agentMemoryWorker(agentMemory);
  const stackOptions = {
    text: { ENVIRONMENT: ENVIRONMENT!, PROJECTS: PROJECTS!, WORKER_NAME: WORKER_NAME!, ...bindings },
    secrets: { ...secrets, ...(applicationRelease === undefined ? {} : { APPLICATION_EVENTS_RELEASE: applicationRelease }), ...(clock === "fixed" ? { TEST_NOW_MS: TEST_NOW_MS! } : {}), DEPLOYMENTS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", DEPLOYMENTS_API_TOKEN: "SECRET_DEPLOY_TOKEN" },
    analytics: "unbound",
    collector: statsCollector,
    outbound,
    persist: { directory: persist },
    alarms: "platform",
    extraWorkers: collector === "absent" ? [memoriesWorker] : [memoriesCollector, memoriesWorker]
  } satisfies Parameters<typeof openWorkers>[2];
  const topology = portable ? workers(STATS, OBSERVE, stackOptions) : null;
  if (topology !== null) {
    const stats = topology[0]!;
    const bundle = join(STATS.output, "bundle");
    const script = readFileSync(join(bundle, "index.js"), "utf8").replace('from "cloudflare:workers"', 'from "./workers-shim.js"');
    topology[0] = { ...stats, scriptPath: undefined, modulesRoot: bundle, modules: [{ type: "ESModule", path: join(bundle, "index.js"), contents: script }, { type: "ESModule", path: join(bundle, "workers-shim.js"), contents: 'export { DurableObject } from "cloudflare:workers"; export const tracing = {};' }], tails: [] };
  }
  const mf = topology === null ? openWorkers(STATS, OBSERVE, stackOptions) : new Miniflare({ ...convertV4MiniflareOptions({ workers: topology }), resourcePersistencePath: persist, enableDevRegistry: false });
  if (agentMemory !== undefined) {
    const db = await mf.getD1Database("DB", "usr-memories");
    const seed = await import(pathToFileURL(join(agentMemory, "cloudflare/bench/seed.mjs")).href) as {
      seedDatabase(db: D1Database): Promise<void>;
    };
    await seed.seedDatabase(db);
  }
  const stats = await mf.getWorker("stats");
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await mf.dispose();
  };
  return {
    mf,
    persist,
    stats: async (path, init) => mf.dispatchFetch(`${ORIGIN}${path}`, init),
    observe: async path => (await (await mf.getWorker("stats-observe")).fetch(`https://observe/stats${path}`)).json(),
    observeService: async (service, path) => (await (await mf.getWorker("stats-observe")).fetch(`https://observe/${service}${path}`)).json(),
    memories: async path => (await mf.getWorker("usr-memories")).fetch(`https://memories.example${path}`),
    scheduled: async () => stats.scheduled({ cron: "*/5 * * * *", scheduledTime: clock === "fixed" ? new Date(Number(TEST_NOW_MS)) : new Date() }),
    stop,
    dispose: async () => { await stop(); rmSync(persist, { recursive: true, force: true }); }
  };
}

export async function accessHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { ...gatewayHeaders(), ...extra };
}

export async function createHost(harness: Harness, name = HOST_NAME): Promise<{ hostId: string; token: string }> {
  const response = await harness.stats("/api/v1/admin/hosts", { method: "POST", headers: await accessHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ name }) });
  assert.equal(response.status, 201);
  return await response.json() as { hostId: string; token: string };
}

export async function ingest(harness: Harness, host: { hostId: string; token: string }, batch: SourceBatch = BATCH): Promise<Response> {
  return harness.stats(`/ingest/v2/batches?token=${SECRET_QUERY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/vnd.stats.ingest.v2", Cookie: "CF_Authorization=SECRET_COOKIE" },
    body: encodeFrame({ ...batch, hostId: host.hostId })
  });
}

export interface Page<T> { readonly items: readonly T[]; readonly next: string | null }
export interface TraceSummary { readonly traceId: string | null; readonly label: string; readonly status: number | null; readonly failed: boolean; readonly objectInvocations: number }
export interface TraceDetail { readonly rootPresent: boolean; readonly invocations: readonly { readonly stage: string; readonly label: string }[]; readonly occurrences: readonly { readonly operation: string | null; readonly name: string }[] }
export interface IssueSummary { readonly fingerprint: string; readonly name: string; readonly operation: string | null; readonly frame: string | null; readonly occurrences: number }
export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 2000)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export async function workerTraces(harness: Harness): Promise<readonly TraceSummary[]> {
  const page = await harness.observe("/traces?limit=100") as Page<TraceSummary>;
  assert.equal(page.next, null);
  return page.items;
}
