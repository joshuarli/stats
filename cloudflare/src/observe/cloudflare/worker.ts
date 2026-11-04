import { prepareInvocation, type MessagePolicy, type Preparation } from "../core/model.ts";
import { handleApi } from "../http/api.ts";
import { isObservedService, OBSERVED_SERVICES, type ObservedService } from "../services.ts";
import { POLICIES } from "./policies.ts";
import { reduceTailItem } from "./tail.ts";
import { ObservationStore, type ObserveEnv } from "./store-object.ts";

export { ObservationStore };

const POLICY: MessagePolicy = { safeNames: new Set() };
const SERVICE_PATH = /^\/([a-z][a-z0-9-]{0,31})(\/.*)$/u;

function store(env: ObserveEnv, service: ObservedService): DurableObjectStub<ObservationStore> {
  return env.STORE.getByName(service);
}

async function prepare(items: readonly TraceItem[], service: ObservedService): Promise<Preparation[]> {
  const preparations: Preparation[] = [];
  for (const item of items) {
    const reduction = reduceTailItem(item, POLICIES[service]);
    if (reduction.kind === "excluded") continue;
    preparations.push(reduction.kind === "rejected" ? { ok: false, reason: "invalid_event" } : await prepareInvocation(reduction.invocation, POLICY));
  }
  return preparations;
}

export default {
  async tail(events: TraceItem[], env: ObserveEnv): Promise<void> {
    const byService = new Map<ObservedService, TraceItem[]>();
    let unknown = 0;
    for (const item of events) {
      const service = item.scriptName ?? "";
      if (!isObservedService(service)) { unknown++; continue; }
      byService.set(service, [...byService.get(service) ?? [], item]);
    }
    if (unknown > 0) console.error(JSON.stringify({ event: "observe_unknown_service", count: unknown }));
    await Promise.all([...byService].map(async ([service, items]) => {
      const preparations = await prepare(items, service);
      if (preparations.length > 0) await store(env, service).ingest(preparations);
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
