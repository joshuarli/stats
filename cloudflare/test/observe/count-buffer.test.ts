import test from "node:test";
import assert from "node:assert/strict";
import { prepareTailItems, type TailItem } from "../../src/observe/cloudflare/tail.ts";
import { POLICIES } from "../../src/observe/cloudflare/policies.ts";
import { OBSERVE_CHANNEL } from "../../src/observe/producer/channel.ts";
import { CountBuffer, deliverSampled, IDLE_FLUSH_MS, MAX_BUFFERED_COUNT_KEYS, type CountSink } from "../../src/observe/core/count-buffer.ts";
import { ingest } from "../../src/observe/core/store.ts";
import { fnv1a32, MILLION } from "../../src/observe/core/sampling.ts";
import type { CountDelta, OutcomeEvent, Preparation } from "../../src/observe/core/model.ts";
import { COUNT_BUCKET_MS } from "../../src/observe/core/limits.ts";
import { T0, VERSION, database, hex } from "./support.ts";

const SHOP = POLICIES["nanoshop-storied"];
const START = T0 - (T0 % COUNT_BUCKET_MS);
const INTERVAL = 60_000;

function item(n: number, atMs: number, status = 200): TailItem {
  return {
    event: { request: { url: "https://shop.example/search", method: "GET" }, response: { status } }, eventTimestamp: atMs, exceptions: [],
    diagnosticsChannelEvents: [{ channel: OBSERVE_CHANNEL, message: { kind: "operation", traceId: hex(n + 1, 32), spanId: hex(2 * n + 1, 16), operation: "request.search", synthetic: false, rows: null } }],
    scriptVersion: { id: VERSION }, scriptName: "nanoshop-storied", executionModel: "stateless", outcome: "ok", cpuTime: 1, wallTime: 5
  };
}

const KEEP_PER_MILLION = SHOP.sampling.kind === "sampled" ? SHOP.sampling.keepPerMillion : 0;

function quietItem(n: number, atMs: number): TailItem {
  let traceNumber = n;
  while (fnv1a32(hex(traceNumber + 1, 32)) % MILLION < KEEP_PER_MILLION) traceNumber++;
  return item(traceNumber, atMs);
}

interface Call { readonly preparations: number; readonly outcomes: number; readonly counts: number }

function recorder(calls: Call[], inner: CountSink | null = null): CountSink {
  return {
    ingest: async (preparations, outcomes, counts) => {
      calls.push({ preparations: preparations.length, outcomes: outcomes.length, counts: counts.length });
      await inner?.ingest(preparations, outcomes, counts);
    }
  };
}

interface Harness {
  readonly buffer: CountBuffer;
  readonly calls: Call[];
  readonly timers: (() => void)[];
  readonly sleeps: number[];
  deliver(items: readonly TailItem[], nowMs: number): Promise<void>;
  fire(atMs?: number): Promise<void>;
  fireNext(atMs: number): Promise<void>;
}

function harness(inner: CountSink | null = null, failure: { error: unknown } | null = null): Harness {
  const buffer = new CountBuffer(INTERVAL);
  const calls: Call[] = [];
  const timers: (() => void)[] = [];
  const pending: Promise<void>[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const sink = recorder(calls, inner);
  return {
    buffer, calls, timers, sleeps,
    deliver: async (items, nowMs) => {
      clock = nowMs;
      await deliverSampled({
        buffer, batch: await prepareTailItems(items, SHOP, nowMs), nowMs, now: () => clock, sink,
        defer: work => { pending.push(work); },
        sleep: ms => new Promise<void>(resolve => { sleeps.push(ms); timers.push(resolve); }),
        onDeferredFailure: error => { if (failure !== null) failure.error = error; }
      });
    },
    fireNext: async atMs => {
      clock = atMs;
      timers.shift()?.();
      await pending.shift();
    },
    fire: async atMs => {
      if (atMs !== undefined) clock = atMs;
      for (const resolve of timers.splice(0)) resolve();
      await Promise.all(pending.splice(0));
    }
  };
}

await test("sampled-out events reach no store until the buffer is older than the flush interval, then one call carries them", async () => {
  const h = harness();
  for (let n = 0; n < 50; n++) await h.deliver([quietItem(n, START + n)], START + 1_000 + n * 100);
  assert.deepEqual(h.calls, []);
  assert.equal(h.buffer.size, 1);
  await h.deliver([quietItem(60, START + 61_000)], START + 1_000 + INTERVAL);
  assert.deepEqual(h.calls, [{ preparations: 0, outcomes: 0, counts: 1 }]);
  assert.equal(h.buffer.size, 0);
});

await test("a kept event rides alone while the buffer is young and carries the buffer once it is due", async () => {
  const h = harness();
  await h.deliver([quietItem(1, START)], START + 1_000);
  await h.deliver([item(100, START + 2_000, 500)], START + 2_000);
  assert.deepEqual(h.calls, [{ preparations: 1, outcomes: 0, counts: 0 }]);
  assert.equal(h.buffer.size, 1);
  await h.deliver([item(101, START + 70_000, 500)], START + 1_000 + INTERVAL);
  assert.deepEqual(h.calls.at(-1), { preparations: 1, outcomes: 0, counts: 1 });
  assert.equal(h.calls.length, 2);
  assert.equal(h.buffer.size, 0);
});

await test("a buffer is flushed when an event arrives in a later five-minute bucket, even if it is younger than the interval", async () => {
  const h = harness();
  const nearEnd = START + COUNT_BUCKET_MS - 10_000;
  await h.deliver([quietItem(1, nearEnd)], nearEnd);
  await h.deliver([quietItem(5, nearEnd + 20_000)], nearEnd + 20_000);
  assert.deepEqual(h.calls, [{ preparations: 0, outcomes: 0, counts: 2 }]);
});

await test("an idle isolate flushes by a timer that fits the waitUntil limit, and a flush by an event makes the timer do nothing", async () => {
  const idle = harness();
  await idle.deliver([quietItem(1, START)], START + 1_000);
  await idle.deliver([quietItem(5, START + 1)], START + 2_000);
  assert.equal(idle.timers.length, 1, "a second batch inside half the idle period shares the first timer");
  assert.deepEqual(idle.sleeps, [IDLE_FLUSH_MS]);
  assert.ok(IDLE_FLUSH_MS < 30_000, "the sleep must end before Cloudflare cancels waitUntil work");
  await idle.fire(START + 1_000 + IDLE_FLUSH_MS);
  assert.deepEqual(idle.calls, [{ preparations: 0, outcomes: 0, counts: 1 }]);
  assert.equal(idle.buffer.size, 0);

  const busy = harness();
  await busy.deliver([quietItem(1, START)], START + 1_000);
  await busy.deliver([quietItem(5, START + 1)], START + 1_000 + INTERVAL);
  assert.equal(busy.calls.length, 1);
  await busy.fire(START + 1_000 + INTERVAL + IDLE_FLUSH_MS);
  assert.equal(busy.calls.length, 1, "the stale timer sends nothing");
  await busy.deliver([quietItem(9, START + 2)], START + 3_000 + INTERVAL);
  assert.equal(busy.timers.length, 1, "a new buffered interval arms a new timer");
});

await test("a timer that wakes while batches are still arriving leaves the flush to the timer armed after them", async () => {
  const h = harness();
  const first = START + 1_000;
  await h.deliver([quietItem(1, first)], first);
  await h.deliver([quietItem(2, first + IDLE_FLUSH_MS / 2)], first + IDLE_FLUSH_MS / 2);
  await h.deliver([quietItem(3, first + 0.75 * IDLE_FLUSH_MS)], first + 0.75 * IDLE_FLUSH_MS);
  assert.equal(h.timers.length, 2, "one timer per half idle period of buffering");
  await h.fireNext(first + IDLE_FLUSH_MS);
  assert.deepEqual(h.calls, [], "the first timer finds the buffer fed less than half an idle period ago");
  assert.equal(h.buffer.size, 1);
  await h.fireNext(first + 1.5 * IDLE_FLUSH_MS);
  assert.deepEqual(h.calls, [{ preparations: 0, outcomes: 0, counts: 1 }]);
  assert.equal(h.buffer.size, 0);
});

await test("a failed flush loses the drained counts, a failed timer is reported, and a failed kept write leaves the buffer", async () => {
  const dead: CountSink = { ingest: async () => { throw new Error("store down"); } };
  const never = () => new Promise<void>(() => undefined);
  const deliverTo = (buffer: CountBuffer, items: TailItem[], nowMs: number, sleep: () => Promise<void>, deferred: Promise<void>[] = [], reported: unknown[] = [], wakeMs = nowMs) => prepareTailItems(items, SHOP, nowMs).then(batch => deliverSampled({
    buffer, batch, nowMs, now: () => wakeMs, sink: dead, defer: work => { deferred.push(work); }, sleep, onDeferredFailure: error => { reported.push(error); }
  }));

  const flushed = new CountBuffer(INTERVAL);
  await deliverTo(flushed, [quietItem(1, START)], START + 1_000, never);
  assert.equal(flushed.size, 1);
  await assert.rejects(deliverTo(flushed, [quietItem(2, START)], START + 1_000 + INTERVAL, never), /store down/u);
  assert.equal(flushed.size, 0, "at most once: the counts were drained before the failing call");

  const timed = new CountBuffer(INTERVAL);
  const deferred: Promise<void>[] = [];
  const reported: unknown[] = [];
  await deliverTo(timed, [quietItem(1, START)], START + 1_000, async () => undefined, deferred, reported, START + 1_000 + IDLE_FLUSH_MS);
  await Promise.all(deferred);
  assert.equal(reported.length, 1);
  assert.equal(timed.size, 0);

  const kept = new CountBuffer(INTERVAL);
  await deliverTo(kept, [quietItem(3, START)], START + 2_000, never);
  await assert.rejects(deliverTo(kept, [item(50, START, 500)], START + 3_000, never));
  assert.equal(kept.size, 1, "a kept event's own failure does not touch the buffer");
});

await test("a buffer with too many distinct keys is flushed at once", async () => {
  const buffer = new CountBuffer(INTERVAL);
  const counts: CountDelta[] = Array.from({ length: MAX_BUFFERED_COUNT_KEYS }, (_, n) => ({ bucketAt: START, version: VERSION, stage: "worker", route: `GET /r${n}`, operation: "", outcome: "ok", kept: 0, sampledOut: 1, cpuMsSum: 0, wallMsSum: 0 }));
  buffer.add(counts.slice(0, MAX_BUFFERED_COUNT_KEYS - 1), START);
  assert.equal(buffer.isDue(START), false);
  buffer.add(counts.slice(MAX_BUFFERED_COUNT_KEYS - 1), START);
  assert.equal(buffer.isDue(START), true);
});

await test("10,000 seeded events, delivered one per tail batch with buffering on, sum exactly after a final flush, using a small share of store calls", async () => {
  const db = database();
  const direct: CountSink = {
    ingest: async (preparations: readonly Preparation[], outcomes: readonly OutcomeEvent[], counts: readonly CountDelta[]) => {
      ingest(db, preparations as Preparation[], Date.now(), outcomes, { sampling: SHOP.sampling, counts });
    }
  };
  const h = harness(direct);
  const realNow = Date.now;
  let clock = START;
  Date.now = () => clock;
  try {
    const total = 10_000;
    for (let n = 0; n < total; n++) {
      clock = START + n * 90;
      const status = n % 97 === 0 ? 500 : 200;
      await h.deliver([item(n, clock, status)], clock);
    }
    clock += 2 * INTERVAL;
    await h.deliver([item(total, clock, 500)], clock);
    await h.fire(clock);
    const row = db.rows<{ observed: number }>("SELECT SUM(kept + sampled_out) AS observed FROM observe_counts")[0]!;
    assert.equal(row.observed, total + 1);
    const keptRows = db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations")[0]!.n;
    const keptCount = db.rows<{ n: number }>("SELECT SUM(kept) AS n FROM observe_counts")[0]!.n;
    assert.equal(keptRows, keptCount);
    assert.ok(h.calls.length < (total + 1) * 0.05, `${h.calls.length} store calls for ${total + 1} events`);
    assert.equal(h.buffer.size, 0);
  } finally {
    Date.now = realNow;
  }
});

await test("an evicted isolate loses at most the counts buffered since its last flush", async () => {
  const db = database();
  const direct: CountSink = { ingest: async (preparations, outcomes, counts) => { ingest(db, preparations as Preparation[], START + 10 * INTERVAL, outcomes, { sampling: SHOP.sampling, counts }); } };
  const first = harness(direct);
  let events = 0;
  for (let n = 0; n < 200; n++) { await first.deliver([quietItem(n, START)], START + n * 500); events++; }
  const recorded = db.rows<{ observed: number | null }>("SELECT SUM(kept + sampled_out) AS observed FROM observe_counts")[0]!.observed ?? 0;
    const second = harness(direct);
  await second.deliver([item(9_999, START + 100_000, 500)], START + 100_000);
  const after = db.rows<{ observed: number }>("SELECT SUM(kept + sampled_out) AS observed FROM observe_counts")[0]!.observed;
  assert.equal(after, recorded + 1, "the new isolate never sees the lost buffer");
  const lost = events - recorded;
  assert.ok(lost > 0 && lost <= INTERVAL / 500, `${lost} events lost, at most the ${INTERVAL / 500} that arrive in one flush interval`);
});
