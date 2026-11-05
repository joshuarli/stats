import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { accessToken } from "../test/access-token.ts";
import { offlineAnalytics, type OfflineAnalytics } from "./analytics.ts";
import type { Scenario } from "./scenario.ts";
import { CLOUDFLARE_ROOT, OBSERVE_OUTPUT, STATS_OUTPUT, miniflareOptions, readBuiltWorker, readTestVars, rejectAndRecord, RUN_ALARM_METHOD, type BuiltWorker, type Collector, type RecordingOutbound } from "./topology.ts";

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
}

export interface Stack {
  readonly origin: string;
  readonly persist: string;
  readonly stats: BuiltWorker;
  readonly analytics: OfflineAnalytics;
  readonly outbound: RecordingOutbound;
  readonly mf: Miniflare;
  collect(model: Scenario): Promise<ScheduledOutcome>;
  fetch(path: string, init?: DispatchInit): Promise<DispatchResponse>;
  anonymous(path: string, init?: DispatchInit): Promise<DispatchResponse>;
  observe(service: string, path: string): Promise<unknown>;
  runAlarm(): Promise<void>;
  restart(next: { readonly nowMs: number | null }): Promise<Stack>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
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
  readonly outbound: RecordingOutbound;
  readonly ephemeral: boolean;
}

async function launch(shared: Shared, start: StackStart & { readonly persist: string }): Promise<Stack> {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_JWKS_JSON } = readTestVars();
  const mf = new Miniflare({
    ...miniflareOptions(shared.stats, shared.observe, {
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
      persist: start.persist,
      extraWorkers: [shared.analytics.worker],
      alarms: "rpc"
    }),
    host: "127.0.0.1",
    port: start.port ?? 0
  });
  const origin = (await mf.ready).origin.replace(/\/$/u, "");
  const worker = await mf.getWorker(shared.stats.name);
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
    collect: async model => {
      shared.analytics.use(model);
      return (await worker.scheduled({ cron: shared.stats.crons[0]!, scheduledTime: new Date(model.nowMs) })).outcome;
    },
    fetch: async (path, init = {}) => mf.dispatchFetch(`${origin}${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers as HeadersInit | undefined)), [ACCESS_HEADER]: await accessToken() } }),
    anonymous: async (path, init) => mf.dispatchFetch(`${origin}${path}`, init),
    observe: async (service, path) => (await (await mf.getWorker(shared.observe.name)).fetch(`https://observe/${service}${path}`)).json(),
    runAlarm: async () => {
      const namespace = await mf.getDurableObjectNamespace("INSTALLATION", shared.stats.name);
      const stub = namespace.get(namespace.idFromName("installation")) as unknown as Record<typeof RUN_ALARM_METHOD, () => Promise<void>>;
      await stub[RUN_ALARM_METHOD]();
    },
    restart: async next => {
      await stop();
      return launch(shared, { ...start, nowMs: next.nowMs, port: Number(new URL(origin).port) });
    },
    stop,
    dispose: async () => {
      await stop();
      if (shared.ephemeral) rmSync(start.persist, { recursive: true, force: true });
    }
  };
}

export async function startStack(start: StackStart): Promise<Stack> {
  const stats = readBuiltWorker(STATS_OUTPUT);
  const observe = readBuiltWorker(OBSERVE_OUTPUT);
  mkdirSync(SCRATCH, { recursive: true });
  const persist = start.persist ?? mkdtempSync(join(SCRATCH, "stack-"));
  mkdirSync(persist, { recursive: true });
  return launch({ stats, observe, analytics: offlineAnalytics(stats), outbound: rejectAndRecord(), ephemeral: start.persist === undefined }, { ...start, persist });
}
