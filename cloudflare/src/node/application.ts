import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createBindingProducer, type ProducerStats } from "../../../packages/producer/src/index.ts";
import type { OperationSink } from "../operations.ts";
import type { OperationSummary } from "../observe/producer/channel.ts";
import { captureApplicationRequest } from "../observe/application/http.ts";
import type { BrowserJourney } from "../observe/application/journey.ts";
import { postApplicationEvent, toApplicationEvent, type ApplicationEventSinkOptions } from "../observe/application/sink.ts";
import { RELEASE } from "../observe/ingest/model.ts";
import { NodeConfigError } from "./config.ts";
import { handleApi } from "../observe/http/api.ts";
import type { NodeObservations } from "./observations.ts";

interface RequestContext {
  readonly traceId: string;
  readonly atMs: number;
  readonly started: number;
  readonly operations: OperationSummary[];
  invoked: boolean;
  active: boolean;
}

function id(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function traceId(request: Request): string {
  const parent = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/u.exec(request.headers.get("traceparent") ?? "");
  return parent !== null && !/^0+$/u.test(parent[1]!) && !/^0+$/u.test(parent[2]!) ? parent[1]! : id(16);
}

function excluded(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return path === "/health" || path === "/metrics" || path === "/api/v1/runtime" || path.startsWith("/ingest/");
}

export class NodeApplicationEvents {
  private readonly responseTraces = new WeakMap<Response, string>();
  private readonly context = new AsyncLocalStorage<RequestContext | null>();
  private readonly producer: ReturnType<typeof createBindingProducer>;
  private readonly options: ApplicationEventSinkOptions;
  private droppedOperations = 0;
  private admitted = 0;
  private queueHigh = 0;
  readonly operations: OperationSink;

  constructor(observe: NodeObservations, release: string) {
    if (!RELEASE.test(release)) throw new NodeConfigError("APPLICATION_EVENTS_RELEASE is invalid");
    this.producer = createBindingProducer({
      service: "stats", release, queueLimit: 128, batchSize: 64, flushIntervalMs: 1000, timeoutMs: 5000, maxRetries: 1, maxRetryAfterMs: 1000,
      postBatch: (body, signal) => handleApi(new Request("https://observe/ingest/observe/v1/batches", { method: "POST", headers: { "content-type": "application/json" }, body, signal }), "/ingest/observe/v1/batches", observe.forService("stats"), "stats")
    });
    this.options = { release, now: () => Date.now(), post: body => {
      for (const event of body.events) this.record({
        eventId: event.eventId, atMs: event.atMs, release: event.release, operation: event.operation,
        outcome: event.outcome, durationMs: event.durationMs, work: event.work,
        ...(event.operation.startsWith("http.") && this.context.getStore() != null
          ? { trace: { traceId: this.context.getStore()!.traceId, spanId: id(8) } }
          : event.trace === undefined ? {} : { trace: event.trace }),
        ...(event.error === undefined ? {} : { errorCode: event.error.code }),
        ...(event.instance === undefined ? {} : { instance: event.instance })
      });
      return Promise.resolve(true);
    } };
    this.operations = {
      invocation: () => {
        const context = this.context.getStore();
        if (context === null) return;
        if (context?.active) context.invoked = true;
        else this.recordInvocation(id(16), Date.now(), 0, "ok");
      },
      operation: summary => {
        const context = this.context.getStore();
        if (context === null) return;
        if (context?.active) {
          if (context.operations.length === 128) { context.operations.shift(); this.droppedOperations += 1; }
          context.operations.push(summary);
        }
        else {
          const trace = id(16);
          this.recordInvocation(trace, Date.now(), summary.durationMs ?? 0, "ok");
          this.recordOperation(trace, summary, "ok");
        }
      }
    };
  }

  capture(request: Request, run: () => Promise<Response>): Promise<Response> {
    return this.run(request, async () => {
      if (excluded(request) || new URL(request.url).pathname === "/api/v1/ui-journeys") return run();
      const response = await captureApplicationRequest(request, run, { ...this.options, monotonic: () => performance.now() });
      const context = this.context.getStore();
      if (context !== undefined && context !== null) this.responseTraces.set(response, context.traceId);
      return response;
    });
  }

  recordBrowserJourney(journey: BrowserJourney): void {
    postApplicationEvent({ schemaVersion: 1, eventId: crypto.randomUUID(), atMs: journey.startedAtMs,
      operation: `ui.${journey.source}.${journey.range}.${journey.cache ? "cache" : "read"}`, outcome: journey.outcome,
      durationMs: Math.round(journey.durationMs), trace: journey.trace, instance: `browser:${journey.asset}`,
      work: { ...journey.work, transport_dropped: journey.dropped }, service: "stats", release: this.options.release
    }, this.options);
  }

  bodyCompletion(response: Response): ((cancelled: boolean) => void) | undefined {
    const traceId = this.responseTraces.get(response);
    if (traceId === undefined) return undefined;
    const started = performance.now();
    return cancelled => this.record({ atMs: Date.now(), operation: "http.response.body", outcome: cancelled ? "cancelled" : "ok",
      durationMs: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - started))),
      work: { http_status: response.status }, trace: { traceId, spanId: id(8) } });
  }

  async run(request: Request, run: () => Promise<Response>): Promise<Response> {
    if (excluded(request)) return this.context.run(null, run);
    const context: RequestContext = { traceId: traceId(request), atMs: Date.now(), started: performance.now(), operations: [], invoked: false, active: true };
    return this.context.run(context, async () => {
      let outcome = "error";
      try {
        const response = await run();
        outcome = response.status >= 500 ? "error" : "ok";
        return response;
      } finally {
        context.active = false;
        if (context.invoked || context.operations.length > 0) this.recordInvocation(context.traceId, context.atMs, Math.min(86_400_000, Math.max(0, Math.round(performance.now() - context.started))), outcome);
        for (const summary of context.operations) this.recordOperation(context.traceId, summary, outcome);
      }
    });
  }

  private recordInvocation(traceId: string, atMs: number, durationMs: number, outcome: string): void {
    this.record({ atMs, operation: "installation.request", outcome, durationMs, trace: { traceId, spanId: id(8) },
      ...(outcome === "error" ? { errorCode: "installation.request" } : {}) });
  }

  private recordOperation(traceId: string, summary: OperationSummary, outcome: string): void {
    const event = toApplicationEvent(summary, this.options);
    const work = { ...event.work };
    delete work["sql_rows_read"];
    this.record({ atMs: event.atMs, operation: event.operation, outcome, durationMs: event.durationMs,
      work: { ...work, synthetic: summary.synthetic ? 1 : 0 }, trace: { traceId, spanId: id(8) },
      ...(outcome === "error" ? { errorCode: event.operation } : {}) });
  }

  private record(event: Parameters<typeof this.producer.record>[0]): void {
    const before = this.producer.stats();
    this.producer.record(event);
    const after = this.producer.stats();
    if (after.lastError !== "invalid_event" || after.dropped === before.dropped) this.admitted += 1;
    this.queueHigh = Math.max(this.queueHigh, after.queued, Math.min(128, before.queued + 1));
  }

  flush(): Promise<void> { return this.producer.flush(); }
  shutdown(): Promise<void> { return this.producer.shutdown(); }
  stats(): ProducerStats & { admitted: number; queueHigh: number } { const stats = this.producer.stats(); return { ...stats, admitted: this.admitted, queueHigh: this.queueHigh, dropped: stats.dropped + this.droppedOperations }; }
}
