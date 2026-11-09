import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { encodeFrame, type SourceBatch } from "../src/ingest/encode.ts";
import { openNodeInstallation } from "../src/node/installation.ts";
import { arrivalMs, sampleAt } from "../local/samples.ts";
import { CLOUDFLARE_ROOT } from "../local/topology.ts";
import { recordedProbe } from "./collection-replay.ts";

const BATCH = JSON.parse(readFileSync(join(CLOUDFLARE_ROOT, "../fixtures/v2/sources/linux-normal.json"), "utf8")) as SourceBatch;
const TEMPLATE = BATCH.samples[0]!;
const WARMUP = Number(process.env["BENCH_WARMUP"] ?? "200");
const BATCHES = Number(process.env["BENCH_BATCHES"] ?? "2000");
const WORK = join(CLOUDFLARE_ROOT, "../.work/tmp/bench-ingest");

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const clock = { now: arrivalMs(1) };
const installation = openNodeInstallation({ path: join(WORK, "stats.sqlite"), projects: "[]", clock: { now: () => clock.now }, probeFetch: recordedProbe });
try {
  const created = await installation.core.createHost("bench");
  if (!created.ok) throw new Error(created.message);
  const { hostId, token } = created.value;
  const perBatch: number[] = [];
  for (let batch = 0; batch < WARMUP + BATCHES; batch += 1) {
    clock.now = arrivalMs(batch * 2 + 1);
    const body = encodeFrame({ ...BATCH, hostId, samples: [sampleAt(TEMPLATE, batch * 2), sampleAt(TEMPLATE, batch * 2 + 1)] });
    const before = process.cpuUsage();
    const response = await installation.core.fetch(new Request("https://stats.local/ingest", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/vnd.stats.ingest.v2" }, body }));
    await response.arrayBuffer();
    const used = process.cpuUsage(before);
    if (response.status !== 200) throw new Error(`batch ${batch} answered ${response.status}`);
    if (batch >= WARMUP) perBatch.push((used.user + used.system) / 1000);
  }
  perBatch.sort((left, right) => left - right);
  const at = (quantile: number) => perBatch[Math.min(perBatch.length - 1, Math.floor(perBatch.length * quantile))]!.toFixed(3);
  console.log(`ingest | ${BATCHES} two-sample linux-normal batches after ${WARMUP} warmup | CPU ms per batch p50 ${at(0.5)} p90 ${at(0.9)} p99 ${at(0.99)} max ${perBatch.at(-1)!.toFixed(3)}`);
} finally {
  installation.close();
}
