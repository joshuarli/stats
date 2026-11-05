import { CLOUDFLARE_STORE_WALL_MS_PER_CALL, CLOUDFLARE_TAIL_CPU_MS_PER_INVOCATION, NANOSHOP_ASSUMPTIONS, OBSERVATION_BUDGET, project, type MeasuredFigures } from "../../src/observe/core/budget.ts";
import { COUNT_FLUSH_INTERVAL_MS } from "../../src/observe/core/count-buffer.ts";
import { NANOSHOP_SAMPLING } from "../../src/observe/cloudflare/nanoshop-policy.ts";
import { measure } from "./measure.ts";
import { startRig } from "./workload.ts";

const rig = await startRig();
try {
  const started = Date.now();
  const measurement = await measure(rig, {
    keepPerMillion: NANOSHOP_SAMPLING.keepPerMillion, flushIntervalMs: COUNT_FLUSH_INTERVAL_MS, steadyKeepPerMillion: 50_000,
    steadyFailurePerMillion: 5_000, steadyDurationMs: 20 * 60_000, requestsPerSecond: 10
  });
  const figures: MeasuredFigures = { ...measurement.figures, tailCpuMsPerEvent: CLOUDFLARE_TAIL_CPU_MS_PER_INVOCATION, storeBilledMsPerRequest: CLOUDFLARE_STORE_WALL_MS_PER_CALL };
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, measurement, figures }));
  const grid = [];
  for (const isolates of [1, 3]) for (const interval of [60_000, 120_000, 300_000]) for (const keep of [100, 300, 600, 1_000, 2_000, 5_000, 10_000]) {
    const projection = project(figures, { events: OBSERVATION_BUDGET.eventsPerMonth, keepPerMillion: keep, flushIntervalMs: interval, ...NANOSHOP_ASSUMPTIONS, tailIsolates: isolates });
    grid.push({ isolates, interval, keep, rows: Math.round(projection.rowsWritten), requests: Math.round(projection.storeRequests), usd: Number(projection.usd.total.toFixed(3)), rowsUsd: Number(projection.usd.rows.toFixed(3)) });
  }
  console.log(JSON.stringify(grid));
} finally {
  await rig.dispose();
}
