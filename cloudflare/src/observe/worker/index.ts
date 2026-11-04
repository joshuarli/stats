import { prepareInvocation, type MessagePolicy, type Preparation } from "../core/model.ts";
import { handleApi } from "./api.ts";
import { reduceTailItem } from "./reduce.ts";
import { ObservationStore, type ObserveEnv } from "./store-object.ts";

export { ObservationStore };

const POLICY: MessagePolicy = { safeNames: new Set() };

function store(env: ObserveEnv): DurableObjectStub<ObservationStore> {
  return env.STORE.getByName("stats");
}

export default {
  async tail(events: TraceItem[], env: ObserveEnv): Promise<void> {
    const preparations: Preparation[] = [];
    for (const item of events) {
      const reduction = reduceTailItem(item);
      if (reduction.kind === "excluded") continue;
      preparations.push(reduction.kind === "rejected" ? { ok: false, reason: "invalid_event" } : await prepareInvocation(reduction.invocation, POLICY));
    }
    if (preparations.length > 0) await store(env).ingest(preparations);
  },

  async scheduled(_controller: ScheduledController, env: ObserveEnv): Promise<void> {
    await store(env).ensureCleanup();
  },

  async fetch(request: Request, env: ObserveEnv): Promise<Response> {
    return handleApi(request, store(env));
  }
} satisfies ExportedHandler<ObserveEnv>;
