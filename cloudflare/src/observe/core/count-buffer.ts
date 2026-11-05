import { addCount, countBucket } from "./counts.ts";
import type { CountDelta, OutcomeEvent, Preparation } from "./model.ts";

export const COUNT_FLUSH_INTERVAL_MS = 60_000;
export const MAX_BUFFERED_COUNT_KEYS = 1_000;

export class CountBuffer {
  readonly intervalMs: number;
  #counts = new Map<string, CountDelta>();
  #startedAtMs = 0;
  #generation = 0;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  get size(): number {
    return this.#counts.size;
  }

  get generation(): number {
    return this.#generation;
  }

  isDue(nowMs: number): boolean {
    if (this.#counts.size === 0) return false;
    return this.#counts.size >= MAX_BUFFERED_COUNT_KEYS || nowMs - this.#startedAtMs >= this.intervalMs || countBucket(nowMs, nowMs) !== countBucket(this.#startedAtMs, this.#startedAtMs);
  }

  add(counts: readonly CountDelta[], nowMs: number): void {
    if (counts.length === 0) return;
    if (this.#counts.size === 0) this.#startedAtMs = nowMs;
    for (const count of counts) addCount(this.#counts, count);
  }

  drain(): CountDelta[] {
    const drained = [...this.#counts.values()];
    this.#counts.clear();
    this.#generation++;
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
  readonly sink: CountSink;
  readonly defer: (work: Promise<void>) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onDeferredFailure: (error: unknown) => void;
}

/**
 * A batch whose events were all sampled out reaches no store at all while the buffer is young. Once it is due, the next batch
 * of any kind carries it, and a lone timer carries it if no batch comes. A drained buffer is gone even if the call fails.
 */
export async function deliverSampled(delivery: SampledDelivery): Promise<void> {
  const { buffer, batch, nowMs, sink } = delivery;
  const due = buffer.isDue(nowMs);
  const wasEmpty = buffer.size === 0;
  buffer.add(batch.counts, nowMs);
  if (due) {
    await sink.ingest(batch.preparations, batch.outcomes, buffer.drain());
    return;
  }
  if (batch.preparations.length > 0 || batch.outcomes.length > 0) await sink.ingest(batch.preparations, batch.outcomes, []);
  if (wasEmpty && buffer.size > 0) {
    const generation = buffer.generation;
    delivery.defer(delivery.sleep(buffer.intervalMs).then(async () => {
      if (buffer.generation === generation && buffer.size > 0) await sink.ingest([], [], buffer.drain());
    }).catch(delivery.onDeferredFailure));
  }
}
