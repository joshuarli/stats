import { env, runInDurableObject, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Installation } from "../src/installation";
import { encodeFrame, type SourceBatch } from "../src/ingest/encode.ts";

const files = JSON.parse(env.FIXTURES ?? "{}") as Record<string, string>;
const base = JSON.parse(files["sources/linux-normal.json"]!) as SourceBatch;
const REQUESTS = 300;
const WARMUP = 30;

function shifted(hostId: string, offset: number): SourceBatch {
  return { ...base, hostId, samples: base.samples.map(sample => ({ ...sample, seq: String(Number(sample.seq) + offset * 30), monoMs: String(Number(sample.monoMs) + offset * 30_000) })) };
}

it("measures STB2 ingest through the Worker and Durable Object", { timeout: 300_000 }, async () => {
  const stub = env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
  const timings: number[] = [];
  let host = { hostId: "", token: "" };
  for (let index = 0; index < WARMUP + REQUESTS; index += 1) {
    if (index % 6 === 0) {
      const created = await runInDurableObject(stub, async (instance: Installation) => instance.createHost(`bench-${index}`));
      if (!created.ok) throw new Error(created.message);
      host = created.value;
    }
    const body = encodeFrame(shifted(host.hostId, index % 6));
    const started = performance.now();
    const response = await SELF.fetch("https://example.com/ingest/v2/batches", { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/vnd.stats.ingest.v2" }, body });
    await response.arrayBuffer();
    if (index >= WARMUP) timings.push(performance.now() - started);
    expect(response.status).toBe(200);
  }
  const mean = timings.reduce((sum, value) => sum + value, 0) / timings.length;
  timings.sort((left, right) => left - right);
  console.log(`STB2 workerd ingest: ${REQUESTS} requests of ${base.samples.length} samples; mean ${mean.toFixed(3)} ms, median ${timings[REQUESTS / 2]!.toFixed(2)} ms, p90 ${timings[Math.floor(REQUESTS * 0.9)]!.toFixed(2)} ms, min ${timings[0]!.toFixed(2)} ms`);
});
