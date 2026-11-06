import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import type { Miniflare, V4WorkerOptions } from "miniflare";
import { accessToken } from "../test/access-token.ts";
import { offlineAnalytics, type OfflineAnalytics } from "./analytics.ts";
import type { Scenario } from "./scenario.ts";
import { describeUnexpected, offlineOutbound, probeUrls, type OfflineOutbound } from "./outbound.ts";
import { readProducerExport, refuseCollisions, seedProducerState, type ProducerExport } from "./producer.ts";
import { CLOUDFLARE_ROOT, OBSERVE_OUTPUT, STATS_OUTPUT, openWorkers, readBuiltWorker, readTestVars, RUN_ALARM_METHOD, FETCH_AT_METHOD, type BuiltWorker, type FetchedAt, type Collector } from "./topology.ts";

export const SCRATCH = join(CLOUDFLARE_ROOT, "../.work/tmp");
export const ACCESS_HEADER = "cf-access-jwt-assertion";
const TOKEN_COMMAND = join(CLOUDFLARE_ROOT, "local/token.ts");

export type DispatchInit = NonNullable<Parameters<Miniflare["dispatchFetch"]>[1]>;
export type DispatchResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;
export type ScheduledOutcome = Awaited<ReturnType<Awaited<ReturnType<Miniflare["getWorker"]>>["scheduled"]>>["outcome"];

export interface StackStart {
  readonly persist?: string;
  readonly nowMs: number | null;
  readonly projectsJson?: string;
  readonly collector?: Collector;
  readonly port?: number;
  readonly localExplorer?: true;
  readonly statsOutput?: string;
  readonly observeOutput?: string;
  readonly producers?: readonly string[];
  readonly producerTail?: V4WorkerOptions;
}

export interface Stack {
  readonly origin: string;
  readonly persist: string;
  readonly stats: BuiltWorker;
  readonly analytics: OfflineAnalytics;
  readonly outbound: OfflineOutbound;
  readonly mf: Miniflare;
  readonly producers: readonly ProducerExport[];
  collect(model: Scenario): Promise<ScheduledOutcome>;
  fetch(path: string, init?: DispatchInit): Promise<DispatchResponse>;
  anonymous(path: string, init?: DispatchInit): Promise<DispatchResponse>;
  observe(service: string, path: string): Promise<unknown>;
  runAlarm(): Promise<void>;
  installationAt(nowMs: number, path: string, init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: Uint8Array }): Promise<FetchedAt>;
  restart(next: { readonly nowMs: number | null }): Promise<Stack>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export function ephemeralPrefix(pid: number): string {
  return `stack-${pid}-`;
}

export interface StatsWorker {
  readonly mf: Miniflare;
  dispose(): Promise<void>;
}

export function openStatsWorker(start: { readonly testNowMs: string; readonly statsOutput?: string }): StatsWorker {
  const { ENVIRONMENT, PROJECTS, WORKER_NAME, TEST_NOW_MS: _fixed, ...secrets } = readTestVars();
  const outbound = offlineOutbound(probeUrls(PROJECTS!));
  const mf = openWorkers(readBuiltWorker(start.statsOutput ?? STATS_OUTPUT), readBuiltWorker(OBSERVE_OUTPUT), {
    text: { ENVIRONMENT: ENVIRONMENT!, PROJECTS: PROJECTS!, WORKER_NAME: WORKER_NAME! },
    secrets: { ...secrets, TEST_NOW_MS: start.testNowMs },
    analytics: "unbound",
    collector: { kind: "absent" },
    outbound: outbound.handler,
    persist: "memory",
    alarms: "platform"
  }, { port: 0, localExplorer: false });
  return {
    mf,
    dispose: async () => {
      await mf.dispose();
      const unexpected = outbound.unexpected();
      if (unexpected.length > 0) throw new Error(describeUnexpected(unexpected));
    }
  };
}

export function productionProjects(stats: BuiltWorker): string {
  const binding = stats.env.get("PROJECTS");
  if (binding?.type !== "text") throw new TypeError(`${stats.name} has no PROJECTS text binding`);
  return binding.value;
}

export function cliEnv(origin: string): Record<string, string> {
  return {
    STATS_URL: origin,
    STATSCTL_AUTH_COMMAND: `node --experimental-strip-types '${TOKEN_COMMAND.replaceAll("'", "'\\''")}'`,
    STATSCTL_AUTH_HEADER: ACCESS_HEADER
  };
}

interface Shared {
  readonly stats: BuiltWorker;
  readonly observe: BuiltWorker;
  readonly analytics: OfflineAnalytics;
  readonly outbound: OfflineOutbound;
  readonly producers: readonly ProducerExport[];
  readonly discard: (() => void) | null;
}

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;

function discardOnExit(directory: string): () => void {
  const remove = (): void => rmSync(directory, { recursive: true, force: true });
  const terminate = (signal: NodeJS.Signals): void => process.exit(128 + constants.signals[signal]);
  process.on("exit", remove);
  for (const signal of TERMINATION_SIGNALS) process.on(signal, terminate);
  return () => {
    process.off("exit", remove);
    for (const signal of TERMINATION_SIGNALS) process.off(signal, terminate);
    remove();
  };
}

async function launch(shared: Shared, start: StackStart & { readonly persist: string }): Promise<Stack> {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_JWKS_JSON } = readTestVars();
  const mf = openWorkers(shared.stats, shared.observe, {
    text: { ENVIRONMENT: "test", ...(start.projectsJson === undefined ? {} : { PROJECTS: start.projectsJson }) },
    secrets: {
      ACCESS_TEAM_DOMAIN: ACCESS_TEAM_DOMAIN!,
      ACCESS_AUD: ACCESS_AUD!,
      ACCESS_JWKS_JSON: ACCESS_JWKS_JSON!,
      ...(start.nowMs === null ? {} : { TEST_NOW_MS: String(start.nowMs) })
    },
    analytics: shared.analytics.binding,
    collector: start.collector ?? { kind: "attached" },
    outbound: shared.outbound.handler,
    persist: { directory: start.persist },
    extraWorkers: [shared.analytics.worker],
    producers: shared.producers,
    ...(start.producerTail === undefined ? {} : { producerTail: start.producerTail }),
    alarms: "rpc"
  }, { port: start.port ?? 0, localExplorer: start.localExplorer === true });
  let origin: string;
  let worker: Awaited<ReturnType<Miniflare["getWorker"]>>;
  try {
    origin = (await mf.ready).origin.replace(/\/$/u, "");
    worker = await mf.getWorker(shared.stats.name);
  } catch (error) {
    await mf.dispose();
    throw error;
  }
  type InstallationStub = {
    [RUN_ALARM_METHOD](): Promise<void>;
    [FETCH_AT_METHOD](nowMs: number, url: string, init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: Uint8Array }): Promise<FetchedAt & Partial<Disposable>>;
  };
  let stub: InstallationStub | null = null;
  const installation = async (): Promise<InstallationStub> => {
    if (stub === null) {
      const namespace = await mf.getDurableObjectNamespace("INSTALLATION", shared.stats.name);
      stub = namespace.get(namespace.idFromName("installation")) as unknown as InstallationStub;
    }
    return stub;
  };
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await mf.dispose();
  };
  return {
    origin,
    persist: start.persist,
    stats: shared.stats,
    analytics: shared.analytics,
    outbound: shared.outbound,
    mf,
    producers: shared.producers,
    collect: async model => {
      shared.analytics.use(model);
      shared.outbound.scenario = `collection at ${new Date(model.nowMs).toISOString()}`;
      return (await worker.scheduled({ cron: shared.stats.crons[0]!, scheduledTime: new Date(model.nowMs) })).outcome;
    },
    fetch: async (path, init = {}) => mf.dispatchFetch(`${origin}${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers as HeadersInit | undefined)), [ACCESS_HEADER]: await accessToken() } }),
    anonymous: async (path, init) => mf.dispatchFetch(`${origin}${path}`, init),
    observe: async (service, path) => (await (await mf.getWorker(shared.observe.name)).fetch(`https://observe/${service}${path}`)).json(),
    runAlarm: async () => {
      await (await installation())[RUN_ALARM_METHOD]();
    },
    installationAt: async (nowMs, path, init) => {
      const result = await (await installation())[FETCH_AT_METHOD](nowMs, `https://installation${path}`, init);
      try {
        return { status: result.status, body: result.body.slice(0), published: structuredClone(result.published) };
      } finally {
        result[Symbol.dispose]?.();
      }
    },
    restart: async next => {
      await stop();
      return launch(shared, { ...start, nowMs: next.nowMs });
    },
    stop,
    dispose: async () => {
      await stop();
      shared.discard?.();
      const unexpected = shared.outbound.unexpected();
      if (unexpected.length > 0) throw new Error(describeUnexpected(unexpected));
    }
  };
}

export async function startStack(start: StackStart): Promise<Stack> {
  const stats = readBuiltWorker(start.statsOutput ?? STATS_OUTPUT);
  const observe = readBuiltWorker(start.observeOutput ?? OBSERVE_OUTPUT);
  const producers = (start.producers ?? []).map(readProducerExport);
  refuseCollisions(producers, [stats.name, observe.name], start.port ?? 0);
  mkdirSync(SCRATCH, { recursive: true });
  const persist = start.persist ?? mkdtempSync(join(SCRATCH, ephemeralPrefix(process.pid)));
  mkdirSync(persist, { recursive: true });
  const outbound = offlineOutbound(probeUrls(start.projectsJson ?? productionProjects(stats)));
  const discard = start.persist === undefined ? discardOnExit(persist) : null;
  try {
    for (const producer of producers) seedProducerState(producer, persist);
    return await launch({ stats, observe, analytics: offlineAnalytics(stats), outbound, producers, discard }, { ...start, persist });
  } catch (error) {
    discard?.();
    throw error;
  }
}
