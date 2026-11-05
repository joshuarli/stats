import { expect, it } from "vitest";
import { arrivalMs, captureOperations, createLoadHost, ingestBatch } from "../test/ingest-load";

const WARMUP = 40;
const BATCHES = 1500;

it("measures the wall time and rows of steady two-sample ingest in the Durable Object", { timeout: 300_000 }, async () => {
  const stop = captureOperations();
  await createLoadHost("bench");
  let written = 0;
  let persisted = 0;
  let started = 0;
  for (let batch = 0; batch < WARMUP + BATCHES; batch += 1) {
    if (batch === WARMUP) started = performance.now();
    const result = await ingestBatch({ indices: [batch * 2, batch * 2 + 1], nowMs: arrivalMs(batch * 2 + 1) });
    expect(result.persisted).toBe(2);
    if (batch < WARMUP) continue;
    written += result.rows.written;
    persisted += result.persisted;
  }
  const elapsed = performance.now() - started;
  stop();
  console.log(`ROWS-BENCH meanMsPerBatch ${(elapsed / BATCHES).toFixed(4)} writtenPerSample ${(written / persisted).toFixed(3)}`);
});
