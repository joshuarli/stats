import { createBindingProducer } from "../../../../packages/producer/src/index.ts";
import { APPLICATION_EVENTS_SERVICE, type ApplicationEventSinkOptions } from "./sink.ts";

interface ObservationBinding {
  fetch(request: Request): Promise<Response>;
}

type Post = ApplicationEventSinkOptions["post"];
const sources = new WeakMap<ObservationBinding, { readonly release: string; readonly post: Post }>();

export function bufferedApplicationPost(binding: ObservationBinding, release: string): Post {
  const existing = sources.get(binding);
  if (existing?.release === release) return existing.post;
  const producer = createBindingProducer({
    service: APPLICATION_EVENTS_SERVICE, release, queueLimit: 128, batchSize: 64,
    flushIntervalMs: 1000, timeoutMs: 5000, maxRetries: 1, maxRetryAfterMs: 1000,
    postBatch: (body, signal) => binding.fetch(new Request("https://observe/stats/ingest/observe/v1/batches", {
      method: "POST", headers: { "content-type": "application/json" }, body, signal
    }))
  });
  let pending: Promise<boolean> | null = null;
  let reportedDrops = 0;
  const reportLoss = () => {
    const stats = producer.stats();
    if (stats.dropped <= reportedDrops) return;
    reportedDrops = stats.dropped;
    console.error(JSON.stringify({ event: "application_delivery_loss", dropped: stats.dropped, queued: stats.queued, retries: stats.retries, lastError: stats.lastError }));
  };
  const post: Post = body => {
    if (body.events.some(event => event.service !== APPLICATION_EVENTS_SERVICE)) return Promise.resolve(false);
    if (pending === null) reportLoss();
    const dropped = producer.stats().dropped;
    for (const event of body.events) {
      producer.record({
        eventId: event.eventId, atMs: event.atMs, release: event.release,
        operation: event.operation, outcome: event.outcome, durationMs: event.durationMs, work: event.work,
        ...(event.instance === undefined ? {} : { instance: event.instance }),
        ...(event.host === undefined ? {} : { host: event.host }),
        ...(event.trace === undefined ? {} : { trace: event.trace }),
        ...(event.error === undefined ? {} : { errorCode: event.error.code }),
        ...(event.diagnostics === undefined ? {} : { diagnostics: event.diagnostics })
      });
    }
    if (producer.stats().dropped !== dropped) return Promise.resolve(false);
    if (pending === null) {
      pending = new Promise<void>(resolve => { setTimeout(resolve, 1000); })
        .then(async () => { await producer.flush(); return producer.stats().dropped === dropped; })
        .catch(() => false)
        .finally(() => { reportLoss(); pending = null; });
    }
    return pending;
  };
  sources.set(binding, { release, post });
  return post;
}
