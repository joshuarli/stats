import test from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_KEPT_PER_BUCKET } from "../../src/observe/core/always-kept-cap.ts";
import { alwaysKeptStorm, CLOUDFLARE_STORE_WALL_MS_PER_CALL, CLOUDFLARE_TAIL_CPU_MS_PER_INVOCATION, MONTH_MS, NANOSHOP_ASSUMPTIONS, OBSERVATION_BUDGET, fits, project, type MeasuredFigures, type Workload } from "../../src/observe/core/budget.ts";
import { COUNT_BUCKET_MS } from "../../src/observe/core/limits.ts";
import { COUNT_FLUSH_INTERVAL_MS } from "../../src/observe/core/count-buffer.ts";
import { NANOSHOP_SAMPLING } from "../../src/observe/cloudflare/nanoshop-policy.ts";
import { MILLION } from "../../src/observe/core/sampling.ts";
import { measure, type Measurement } from "./measure.ts";
import { startRig, type Rig } from "./workload.ts";

let rig: Rig | null = null;
let measurement: Measurement | null = null;

async function measured(): Promise<{ readonly measurement: Measurement; readonly figures: MeasuredFigures }> {
  if (measurement === null) {
    rig = await startRig();
    measurement = await measure(rig, {
      keepPerMillion: NANOSHOP_SAMPLING.keepPerMillion, flushIntervalMs: COUNT_FLUSH_INTERVAL_MS, steadyKeepPerMillion: 50_000,
      steadyFailurePerMillion: 5_000, steadyDurationMs: 20 * 60_000, requestsPerSecond: 10
    });
  }
  return { measurement, figures: { ...measurement.figures, tailCpuMsPerEvent: CLOUDFLARE_TAIL_CPU_MS_PER_INVOCATION, storeBilledMsPerRequest: CLOUDFLARE_STORE_WALL_MS_PER_CALL } };
}

test.after(async () => { await rig?.dispose(); });

function shipped(tailIsolates: number, keepPerMillion: number = NANOSHOP_SAMPLING.keepPerMillion): Workload {
  return { events: OBSERVATION_BUDGET.eventsPerMonth, keepPerMillion, flushIntervalMs: COUNT_FLUSH_INTERVAL_MS, ...NANOSHOP_ASSUMPTIONS, tailIsolates };
}

await test("the shipped sampling policy keeps Nanoshop's observation within the dollar and row budget", async () => {
  const { figures } = await measured();
  for (const isolates of [1, NANOSHOP_ASSUMPTIONS.tailIsolates]) {
    const projection = project(figures, shipped(isolates));
    assert.ok(projection.usd.total <= OBSERVATION_BUDGET.maxUsd, `${isolates} isolates: $${projection.usd.total.toFixed(3)} exceeds $${OBSERVATION_BUDGET.maxUsd}`);
    assert.ok(projection.rowsWritten <= OBSERVATION_BUDGET.maxRowsWritten, `${isolates} isolates: ${Math.round(projection.rowsWritten)} rows exceed ${OBSERVATION_BUDGET.maxRowsWritten}`);
  }
});

await test("every tail isolate hitting the always-kept cap in every bucket all month still fits $5.00 at three isolates", async () => {
  const { figures } = await measured();
  const storm = project(figures, alwaysKeptStorm(shipped(NANOSHOP_ASSUMPTIONS.tailIsolates)));
  const stormEvents = NANOSHOP_ASSUMPTIONS.tailIsolates * (MONTH_MS / COUNT_BUCKET_MS) * ALWAYS_KEPT_PER_BUCKET;
  assert.ok(Math.abs(storm.failedEvents - stormEvents) < 1, `${storm.failedEvents} failed events, expected ${stormEvents}`);
  console.log(`always-kept storm at ${NANOSHOP_ASSUMPTIONS.tailIsolates} isolates: $${storm.usd.total.toFixed(3)}, ${Math.round(storm.rowsWritten)} rows`);
  assert.ok(storm.usd.total <= 5, `$${storm.usd.total.toFixed(3)} exceeds $5.00`);
});

await test("keeping a quarter more invocations than shipped would exceed the budget at three tail isolates", async () => {
  const { figures } = await measured();
  assert.equal(fits(project(figures, shipped(NANOSHOP_ASSUMPTIONS.tailIsolates, NANOSHOP_SAMPLING.keepPerMillion * 1.25))), false);
});

await test("the projection predicts the rows and store requests of a simulated steady workload within 5%", async () => {
  const { measurement: run, figures } = await measured();
  const steady = run.steady;
  const projection = project(figures, {
    events: steady.events, keepPerMillion: (steady.keptEvents / steady.events) * MILLION, failedPerMillion: (steady.failedEvents / steady.events) * MILLION,
    slowPerMillion: 0, untracedPerMillion: 0, rejectedPerMillion: 0, flushIntervalMs: COUNT_FLUSH_INTERVAL_MS, tailIsolates: 1
  }, steady.durationMs);
  const rows = steady.ingest.rowsWritten + steady.retention.rowsWritten;
  const requests = steady.ingest.requests["ingest"] ?? 0;
  assert.ok(Math.abs(projection.rowsWritten - rows) / rows <= 0.05, `predicted ${Math.round(projection.rowsWritten)} rows, measured ${rows}`);
  assert.ok(Math.abs(projection.storeRequests - requests) / requests <= 0.05, `predicted ${Math.round(projection.storeRequests)} requests, measured ${requests}`);
});
