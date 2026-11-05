import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { combineRollups, rollupFromRaw, type RawRow, type RollupPayload } from "../src/aggregate";
import { parseDelta } from "../src/delta";
import type { Installation } from "../src/installation";
import { HOUR_MS, MINUTE_MS } from "../src/limits";
import type { Sample } from "../src/protocol";
import { arrivalMs, captureOperations, createLoadHost, HOST_ID, ingestBatch, MIXED_SEQUENCE, runSequence, stub, SYSTEM_INFO, type Ingested } from "./ingest-load";

let stop = () => {};
beforeEach(async () => {
  stop = captureOperations();
  await createLoadHost();
});
afterEach(() => stop());

const SAMPLE_INDEX_ROWS = 5;

describe("host.ingest writes", () => {
  it("writes each steady two-sample batch in place, inserting a rollup row only when its bucket is new", async () => {
    const batches: Ingested[] = [];
    for (let batch = 0; batch < 60; batch += 1) batches.push(await ingestBatch({ indices: [batch * 2, batch * 2 + 1], nowMs: arrivalMs(batch * 2 + 1), ...(batch === 0 ? { system: SYSTEM_INFO } : {}) }));
    const written = batches.map(entry => entry.rows.written);
    const midMinute = written[1]!;
    expect(batches.every(entry => entry.persisted === 2)).toBe(true);
    expect(midMinute).toBeLessThanOrEqual(2 * SAMPLE_INDEX_ROWS + 4);
    written.forEach((rows, batch) => {
      if (batch === 0) return;
      const newMinute = batch % 2 === 0;
      const newHour = batch === 20;
      expect(rows).toBe(midMinute + (newMinute ? 3 : 0) + (newHour ? 3 : 0));
    });
  });

  it("writes a replay of delivered samples as two rows or fewer", async () => {
    await ingestBatch({ indices: [0, 1], nowMs: arrivalMs(1) });
    const replay = await ingestBatch({ indices: [0, 1], nowMs: arrivalMs(1) });
    expect(replay.persisted).toBe(0);
    expect(replay.ack.duplicates).toBe(2);
    expect(replay.rows.written).toBeLessThanOrEqual(2);
  });

  it("keeps every rollup equal to a rebuild from the stored samples after late, replayed, rebooted, and backlog batches", async () => {
    await runSequence(MIXED_SEQUENCE);
    const { minutes, hours } = await runInDurableObject(stub(), async (_instance: Installation, state) => {
      const sql = state.storage.sql;
      const stored = sql.exec<{ resolution: string; bucket_ms: number; coverage_ms: number; partial: number; payload: string }>("SELECT resolution, bucket_ms, coverage_ms, partial, payload FROM rollups WHERE host_id = ? ORDER BY resolution, bucket_ms", HOST_ID).toArray();
      const rebuilt = (resolution: string, bucketMs: number, payload: RollupPayload | null) => {
        const row = stored.find(entry => entry.resolution === resolution && entry.bucket_ms === bucketMs);
        return payload === null ? row : { ...row, expected: { coverage_ms: payload.coverageMs, partial: payload.partial ? 1 : 0, payload: JSON.stringify(payload) } };
      };
      const minutes = stored.filter(entry => entry.resolution === "1m").map(entry => {
        const rows = sql.exec<{ payload: string; delta: string }>("SELECT payload, delta FROM samples WHERE host_id = ? AND at_ms >= ? AND at_ms < ? ORDER BY mono_ms", HOST_ID, entry.bucket_ms, entry.bucket_ms + MINUTE_MS).toArray();
        const raw: RawRow[] = rows.map(row => ({ sample: JSON.parse(row.payload) as Sample, delta: parseDelta(row.delta) }));
        return rebuilt("1m", entry.bucket_ms, rollupFromRaw(raw, entry.bucket_ms, MINUTE_MS));
      });
      const hours = stored.filter(entry => entry.resolution === "1h").map(entry => {
        const payloads = stored.filter(minute => minute.resolution === "1m" && minute.bucket_ms >= entry.bucket_ms && minute.bucket_ms < entry.bucket_ms + HOUR_MS).map(minute => JSON.parse(minute.payload) as RollupPayload);
        return rebuilt("1h", entry.bucket_ms, combineRollups(payloads, entry.bucket_ms, HOUR_MS));
      });
      return { minutes, hours };
    });
    expect(minutes.length).toBeGreaterThan(5);
    expect(hours.length).toBeGreaterThan(1);
    for (const entry of [...minutes, ...hours]) {
      const { expected, ...row } = entry as { expected: { coverage_ms: number; partial: number; payload: string }; coverage_ms: number; partial: number; payload: string };
      expect({ coverage_ms: row.coverage_ms, partial: row.partial, payload: row.payload }).toEqual(expected);
    }
  });

  it("counts a batch that persists nothing against the request window without marking the host received", async () => {
    for (let request = 0; request < 3; request += 1) await expect(ingestBatch({ indices: [request], nowMs: arrivalMs(0) - 600_000 })).rejects.toThrow(/400/);
    const host = await runInDurableObject(stub(), async (_instance: Installation, state) => state.storage.sql.exec<{ window_count: number; last_received_at_ms: number | null }>("SELECT window_count, last_received_at_ms FROM hosts WHERE host_id = ?", HOST_ID).one());
    expect(host).toEqual({ window_count: 3, last_received_at_ms: null });
  });
});
