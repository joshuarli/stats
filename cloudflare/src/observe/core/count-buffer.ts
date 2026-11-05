import { addCount, countBucket } from "./counts.ts";
import { COUNT_BUCKET_MS } from "./limits.ts";
import type { CountDelta, OutcomeEvent, Preparation } from "./model.ts";

export const COUNT_FLUSH_INTERVAL_MS = COUNT_BUCKET_MS;
export const IDLE_FLUSH_MS = 20_000;
export const MAX_BUFFERED_COUNT_KEYS = 1_000;

export class CountBuffer {
  readonly intervalMs: number;
  #counts = new Map<string, CountDelta>();
  #startedAtMs = 0;
  #lastAddedAtMs = 0;
  #timerArmedAtMs = Number.NEGATIVE_INFINITY;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  get size(): number {
    return this.#counts.size;
  }

  needsIdleTimer(nowMs: number): boolean {
    return this.#counts.size > 0 && nowMs - this.#timerArmedAtMs >= IDLE_FLUSH_MS / 2;
  }

  armIdleTimer(nowMs: number): void {
    this.#timerArmedAtMs = nowMs;
  }

  isIdle(nowMs: number): boolean {
    return this.#counts.size > 0 && nowMs - this.#lastAddedAtMs >= IDLE_FLUSH_MS / 2;
  }

  isDue(nowMs: number): boolean {
    if (this.#counts.size === 0) return false;
    return this.#counts.size >= MAX_BUFFERED_COUNT_KEYS || nowMs - this.#startedAtMs >= this.intervalMs || countBucket(nowMs, nowMs) !== countBucket(this.#startedAtMs, this.#startedAtMs);
  }

  add(counts: readonly CountDelta[], nowMs: number): void {
    if (counts.length === 0) return;
    if (this.#counts.size === 0) this.#startedAtMs = nowMs;
    this.#lastAddedAtMs = nowMs;
    for (const count of counts) addCount(this.#counts, count);
  }

  drain(): CountDelta[] {
    const drained = [...this.#counts.values()];
    this.#counts.clear();
    return drained;
  }
}

export interface CountSink {
  ingest(preparations: readonly Preparation[], outcomes: readonly OutcomeEvent[], counts: readonly CountDelta[]): Promise<unknown>;
}

export interface SampledDelivery {
  readonly buffer: CountBuffer;
  readonly batch: { readonly preparations: readonly Preparation[]; readonly outcomes: readonly OutcomeEvent[]; readonly counts: readonly CountDelta[] };
  readonly nowMs: number;
  readonly now: () => number;
  readonly sink: CountSink;
  readonly defer: (work: Promise<void>) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onDeferredFailure: (error: unknown) => void;
}

/**
 * A batch whose events were all sampled out reaches no store at all while the buffer is young. Once it is due, the next batch
 * of any kind carries it. A drained buffer is gone even if the call fails. Each buffering batch also arms an idle timer unless
 * a timer armed within the last half idle period already covers it; the timer sleeps IDLE_FLUSH_MS, which fits inside the
 * time Cloudflare lets waitUntil work run after an invocation ends, and flushes only if no batch has added counts for half
 * that period.
 */
export async function deliverSampled(delivery: SampledDelivery): Promise<void> {
  const { buffer, batch, nowMs, sink } = delivery;
  const due = buffer.isDue(nowMs);
  buffer.add(batch.counts, nowMs);
  if (due) {
    await sink.ingest(batch.preparations, batch.outcomes, buffer.drain());
    return;
  }
  if (batch.preparations.length > 0 || batch.outcomes.length > 0) await sink.ingest(batch.preparations, batch.outcomes, []);
  if (buffer.needsIdleTimer(nowMs)) {
    buffer.armIdleTimer(nowMs);
    delivery.defer(delivery.sleep(IDLE_FLUSH_MS).then(async () => {
      if (buffer.isIdle(delivery.now())) await sink.ingest([], [], buffer.drain());
    }).catch(delivery.onDeferredFailure));
  }
}
