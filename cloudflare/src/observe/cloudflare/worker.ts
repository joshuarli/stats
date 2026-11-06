import { OTHER_ROUTE, type OutcomeEvent } from "../core/model.ts";
import { handleApi } from "../http/api.ts";
import { groupByService, isObservedService, OBSERVED_SERVICES, type ObservedService } from "../services.ts";
import { POLICIES } from "../core/policies.ts";
import { outcomeOf, prepareTailItems } from "./tail.ts";
import { COUNT_FLUSH_INTERVAL_MS, CountBuffer, deliverSampled } from "../core/count-buffer.ts";
import { AlwaysKeptCap } from "../core/always-kept-cap.ts";
import { awaitEvery } from "../core/fan-out.ts";
import { ObservationStore, type ObserveEnv } from "./store-object.ts";

export { ObservationStore };

const UNKNOWN_SERVICE_HOME: ObservedService = "stats";
const SERVICE_PATH = /^\/([a-z][a-z0-9-]{0,31})(\/.*)$/u;

const buffers = new Map<ObservedService, CountBuffer>();

function bufferOf(service: ObservedService): CountBuffer {
  let buffer = buffers.get(service);
  if (buffer === undefined) {
    buffer = new CountBuffer(COUNT_FLUSH_INTERVAL_MS);
    buffers.set(service, buffer);
  }
  return buffer;
}

const caps = new Map<ObservedService, AlwaysKeptCap>();

function capOf(service: ObservedService): AlwaysKeptCap {
  let cap = caps.get(service);
  if (cap === undefined) {
    cap = new AlwaysKeptCap();
    caps.set(service, cap);
  }
  return cap;
}

function store(env: ObserveEnv, service: ObservedService): DurableObjectStub<ObservationStore> {
  return env.STORE.getByName(service);
}

export default {
  async tail(events: TraceItem[], env: ObserveEnv, ctx: ExecutionContext): Promise<void> {
    const grouped = groupByService(events);
    const byService = grouped.byService;
    const unknown: OutcomeEvent[] = grouped.unknown.map(item => outcomeOf(item, "unknown-service", OTHER_ROUTE));
    if (unknown.length > 0) console.error(JSON.stringify({ event: "observe_unknown_service", count: unknown.length }));
    const nowMs = Date.now();
    const services = new Map(byService);
    if (unknown.length > 0 && !services.has(UNKNOWN_SERVICE_HOME)) services.set(UNKNOWN_SERVICE_HOME, []);
    await awaitEvery([...services].map(async ([service, items]) => {
      const prepared = await prepareTailItems(items, POLICIES[service], nowMs, capOf(service));
      const batch = service === UNKNOWN_SERVICE_HOME ? { ...prepared, outcomes: [...prepared.outcomes, ...unknown] } : prepared;
      if (POLICIES[service].sampling.kind === "all") {
        await store(env, service).ingest(batch.preparations, batch.outcomes, batch.counts);
        return;
      }
      await deliverSampled({
        buffer: bufferOf(service), batch, nowMs, now: () => Date.now(), sink: store(env, service), defer: work => ctx.waitUntil(work),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        onDeferredFailure: error => console.error(JSON.stringify({ event: "observe_count_flush_failed", service, message: error instanceof Error ? error.message : "unknown" }))
      });
    }));
  },

  async scheduled(_controller: ScheduledController, env: ObserveEnv): Promise<void> {
    await Promise.all(OBSERVED_SERVICES.map(service => store(env, service).ensureCleanup()));
  },

  async fetch(request: Request, env: ObserveEnv): Promise<Response> {
    const match = SERVICE_PATH.exec(new URL(request.url).pathname);
    if (match === null || !isObservedService(match[1]!)) return Response.json({ error: { code: "not_found", message: "unknown observed service" } }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return handleApi(request, match[2]!, store(env, match[1]));
  }
} satisfies ExportedHandler<ObserveEnv>;
