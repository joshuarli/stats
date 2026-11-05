import { prepareTailItems } from "../../src/observe/cloudflare/tail.ts";
import { AlwaysKeptCap } from "../../src/observe/core/always-kept-cap.ts";
import { POLICIES } from "../../src/observe/cloudflare/policies.ts";
import { CountBuffer, COUNT_FLUSH_INTERVAL_MS, deliverSampled } from "../../src/observe/core/count-buffer.ts";
import { ALL_SHAPES, objectEntry, random, traceFor, workerEntry, type Fate } from "./workload.ts";
import type { TailItem } from "../../src/observe/cloudflare/tail.ts";

const POLICY = POLICIES["nanoshop-storied"];
const KEEP = POLICY.sampling.kind === "sampled" ? POLICY.sampling.keepPerMillion : 0;
const EVENTS = 20_000;
const RUNS = 12;
const START = Date.UTC(2026, 10, 4, 12);

function items(fate: Fate, seed: number): TailItem[] {
  const rng = random(seed);
  const result: TailItem[] = [];
  while (result.length < EVENTS) {
    const shape = ALL_SHAPES[Math.floor(rng() * ALL_SHAPES.length)]!;
    const invocation = { atMs: START + result.length, traceId: traceFor(rng, KEEP, fate), shape };
    result.push(workerEntry(rng, invocation).item);
    if (shape.rpc !== null) result.push(objectEntry(rng, invocation).item);
  }
  return result.slice(0, EVENTS);
}

async function run(batch: readonly TailItem[]): Promise<number> {
  const buffer = new CountBuffer(COUNT_FLUSH_INTERVAL_MS);
  const sink = { ingest: async () => ({}) };
  const started = process.hrtime.bigint();
  for (const item of batch) {
    const nowMs = item.eventTimestamp! + 5;
    await deliverSampled({ buffer, batch: await prepareTailItems([item], POLICY, nowMs, new AlwaysKeptCap()), nowMs, now: () => nowMs, sink, defer: () => undefined, sleep: () => new Promise<void>(() => undefined), onDeferredFailure: () => undefined });
  }
  return Number(process.hrtime.bigint() - started) / batch.length / 1000;
}

const sets = { "sampled-out": items("dropped", 1), kept: items("kept", 2) };
for (const set of Object.values(sets)) await run(set.slice(0, 2_000));
const samples: Record<string, number[]> = { "sampled-out": [], kept: [] };
for (let round = 0; round < RUNS; round++) {
  const order = round % 2 === 0 ? ["sampled-out", "kept"] as const : ["kept", "sampled-out"] as const;
  for (const name of order) samples[name]!.push(await run(sets[name]));
}
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]!;
for (const [name, values] of Object.entries(samples)) {
  console.log(JSON.stringify({
    source: "node", node: process.version, class: name, runs: RUNS, eventsPerRun: EVENTS, unit: "us per event",
    median: Number(quantile(values, 0.5).toFixed(2)), min: Number(Math.min(...values).toFixed(2)), max: Number(Math.max(...values).toFixed(2)),
    q1: Number(quantile(values, 0.25).toFixed(2)), q3: Number(quantile(values, 0.75).toFixed(2))
  }));
}
