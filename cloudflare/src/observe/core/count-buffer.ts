import { addCount, countBucket } from "./counts.ts";
import { COUNT_BUCKET_MS } from "./limits.ts";
import { NOTHING_UNSENT, type CountDelta, type Flush, type OutcomeEvent, type Preparation, type UnsentTally } from "./model.ts";

export const COUNT_FLUSH_INTERVAL_MS = COUNT_BUCKET_MS;
export const IDLE_FLUSH_MS = 20_000;
export const MAX_BUFFERED_COUNT_KEYS = 1_000;
export const MAX_PENDING_BATCHES = 32;

export interface StoreBatch {
  readonly preparations: readonly Preparation[];
  readonly outcomes: readonly OutcomeEvent[];
  readonly counts: readonly CountDelta[];
  readonly flush: Flush | null;
}

function anyUnsent(tally: UnsentTally): boolean {
  return tally.batches + tally.invocations + tally.outcomes + tally.countedEvents > 0;
}

function plusDropped(tally: UnsentTally, batch: StoreBatch): UnsentTally {
  const carried = batch.flush?.unsent ?? NOTHING_UNSENT;
  return {
    batches: tally.batches + carried.batches + 1,
    invocations: tally.invocations + carried.invocations + batch.preparations.length,
    outcomes: tally.outcomes + carried.outcomes + batch.outcomes.length,
    countedEvents: tally.countedEvents + carried.countedEvents + batch.counts.reduce((sum, count) => sum + count.kept + count.sampledOut, 0)
  };
}

export class CountBuffer {
  readonly intervalMs: number;
  #counts = new Map<string, CountDelta>();
  #pending: StoreBatch[] = [];
  #unsent: UnsentTally = NOTHING_UNSENT;
  #ambiguousMarks = 0;
  #startedAtMs = 0;
  #lastAddedAtMs = 0;
  #timerArmedAtMs = Number.NEGATIVE_INFINITY;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  get size(): number {
    return this.#counts.size;
  }

  get pendingBatches(): number {
    return this.#pending.length;
  }

  #holdsWork(): boolean {
    return this.#counts.size > 0 || this.#pending.length > 0;
  }

  needsIdleTimer(nowMs: number): boolean {
    return this.#holdsWork() && nowMs - this.#timerArmedAtMs >= IDLE_FLUSH_MS / 2;
  }

  armIdleTimer(nowMs: number): void {
    this.#timerArmedAtMs = nowMs;
  }

  isIdle(nowMs: number): boolean {
    return this.#holdsWork() && nowMs - this.#lastAddedAtMs >= IDLE_FLUSH_MS / 2;
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

  noteAmbiguousMarks(events: number): void {
    this.#ambiguousMarks += events;
  }

  seal(preparations: readonly Preparation[], outcomes: readonly OutcomeEvent[], drainCounts: boolean): StoreBatch | null {
    const counts = drainCounts ? [...this.#counts.values()] : [];
    if (drainCounts) this.#counts.clear();
    const unsent = this.#unsent;
    const ambiguousMarks = this.#ambiguousMarks;
    this.#unsent = NOTHING_UNSENT;
    this.#ambiguousMarks = 0;
    const replayable = counts.length > 0 || outcomes.length > 0 || anyUnsent(unsent) || ambiguousMarks > 0;
    if (!replayable && preparations.length === 0) return null;
    return { preparations, outcomes, counts, flush: replayable ? { id: crypto.randomUUID(), unsent, ambiguousMarks } : null };
  }

  takePending(): StoreBatch[] {
    return this.#pending.splice(0);
  }

  keepPending(failed: readonly StoreBatch[]): void {
    this.#pending = [...failed, ...this.#pending];
    while (this.#pending.length > MAX_PENDING_BATCHES) {
      const dropped = this.#pending.shift()!;
      this.#unsent = plusDropped(this.#unsent, dropped);
      this.#ambiguousMarks += dropped.flush?.ambiguousMarks ?? 0;
    }
  }
}

export interface CountSink {
  ingest(preparations: readonly Preparation[], outcomes: readonly OutcomeEvent[], counts: readonly CountDelta[], flush: Flush | null): Promise<unknown>;
}

export interface SampledDelivery {
  readonly buffer: CountBuffer;
  readonly batch: { readonly preparations: readonly Preparation[]; readonly outcomes: readonly OutcomeEvent[]; readonly counts: readonly CountDelta[]; readonly ambiguousMarks: number };
  readonly nowMs: number;
  readonly now: () => number;
  readonly sink: CountSink;
  readonly defer: (work: Promise<void>) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onDeferredFailure: (error: unknown) => void;
}

async function send(buffer: CountBuffer, sink: CountSink, current: StoreBatch | null): Promise<void> {
  const queue = [...buffer.takePending(), ...(current === null ? [] : [current])];
  for (const [index, batch] of queue.entries()) {
    try {
      await sink.ingest(batch.preparations, batch.outcomes, batch.counts, batch.flush);
    } catch (error) {
      buffer.keepPending(queue.slice(index));
      throw error;
    }
  }
}

export async function deliverSampled(delivery: SampledDelivery): Promise<void> {
  const { buffer, batch, nowMs, sink } = delivery;
  const due = buffer.isDue(nowMs);
  buffer.add(batch.counts, nowMs);
  buffer.noteAmbiguousMarks(batch.ambiguousMarks);
  try {
    if (due || batch.preparations.length > 0 || batch.outcomes.length > 0) await send(buffer, sink, buffer.seal(batch.preparations, batch.outcomes, due));
  } finally {
    armIdleTimer(delivery);
  }
}

function armIdleTimer(delivery: SampledDelivery): void {
  const { buffer, nowMs, sink } = delivery;
  if (!buffer.needsIdleTimer(nowMs)) return;
  buffer.armIdleTimer(nowMs);
  delivery.defer(delivery.sleep(IDLE_FLUSH_MS).then(async () => {
    if (buffer.isIdle(delivery.now())) await send(buffer, sink, buffer.seal([], [], true));
  }).catch(delivery.onDeferredFailure));
}
