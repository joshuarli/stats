import assert from "node:assert/strict";
import { test } from "node:test";
import { runBench } from "../../bench/local.ts";
import { plantBeside, plantStatsOutput } from "./support.ts";

const SMALL = { warmupBatches: 4, batches: 20 };
const INGEST_HOST_READ = "const current = this.host(sql, parsed.hostId);";

function counts(results: readonly Record<string, unknown>[]): unknown[] {
  return results.map(({ revision: _revision, dirty: _dirty, ...rest }) => rest);
}

await test("the local bench prints identical counts on two runs and moves when ingest runs an extra statement", async () => {
  const first = await runBench(SMALL);
  assert.deepEqual(counts(await runBench(SMALL)), counts(first));
  const ingest = first.find(result => result["workload"] === "ingest")!;
  const planted = plantStatsOutput(plantBeside(INGEST_HOST_READ, `sql.run("SELECT 1");`));
  try {
    const plantedIngest = (await runBench({ ...SMALL, statsOutput: planted.output })).find(result => result["workload"] === "ingest")!;
    assert.equal(plantedIngest["statements"], (ingest["statements"] as number) + SMALL.batches);
  } finally {
    planted.remove();
  }
});
