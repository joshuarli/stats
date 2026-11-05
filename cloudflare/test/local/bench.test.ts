import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runBench } from "../../bench/local.ts";
import { SCRATCH } from "../../local/stack.ts";
import { STATS_OUTPUT } from "../../local/topology.ts";

const SMALL = { warmupBatches: 4, batches: 20 };
const INGEST_HOST_READ = "const current = this.host(sql, parsed.hostId);";

function counts(results: readonly Record<string, unknown>[]): unknown[] {
  return results.map(({ revision: _revision, dirty: _dirty, ...rest }) => rest);
}

await test("the local bench prints identical counts on two runs and moves when ingest runs an extra statement", async () => {
  const first = await runBench(SMALL);
  assert.deepEqual(counts(await runBench(SMALL)), counts(first));
  const ingest = first.find(result => result["workload"] === "ingest")!;
  mkdirSync(SCRATCH, { recursive: true });
  const planted = mkdtempSync(join(SCRATCH, "bench-planted-"));
  try {
    cpSync(STATS_OUTPUT, planted, { recursive: true });
    const bundle = join(planted, "bundle/index.js");
    const source = readFileSync(bundle, "utf8");
    assert.equal(source.split(INGEST_HOST_READ).length, 2, "the built bundle has one ingest host read to plant beside");
    writeFileSync(bundle, source.replace(INGEST_HOST_READ, `sql.run("SELECT 1");\n${INGEST_HOST_READ}`));
    const plantedIngest = (await runBench({ ...SMALL, statsOutput: planted })).find(result => result["workload"] === "ingest")!;
    assert.equal(plantedIngest["statements"], (ingest["statements"] as number) + SMALL.batches);
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
});
