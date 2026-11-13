import assert from "node:assert/strict";
import { test } from "node:test";
import { createProducer } from "../../../packages/producer/src/index.ts";

await test("event sizing visits each event once for 64, 128, and near-cap batches", async () => {
  const OriginalEncoder = globalThis.TextEncoder;
  let encodes = 0;
  class CountingEncoder extends OriginalEncoder {
    override encode(input?: string): Uint8Array<ArrayBuffer> {
      encodes += 1;
      return super.encode(input);
    }
  }
  const ack = new OriginalEncoder().encode('{"accepted":0,"duplicate":0}');
  globalThis.TextEncoder = CountingEncoder;
  try {
    for (const scenario of ["64", "128", "near-cap"] as const) {
      encodes = 0;
      const bodies: string[] = [];
      const count = scenario === "64" ? 64 : 128;
      const work = scenario === "near-cap"
        ? Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key${index}${"a".repeat(25)}`, 1_000_000_000_000]))
        : {};
      const producer = createProducer({
        endpoint: "http://127.0.0.1:9", service: "tansu", token: "token", release: "r1",
        batchSize: 128, flushIntervalMs: 60_000, now: () => 1_793_966_340_000,
        fetch: async (_input, init) => {
          bodies.push(init!.body as string);
          return new Response(ack);
        }
      });
      for (let index = 0; index < count; index += 1) {
        producer.record({ operation: "save", outcome: "ok", durationMs: 1, work, eventId: `event-${index}` });
      }
      await producer.flush();
      await producer.shutdown();
      assert.equal(encodes, count);
      assert.equal(bodies.reduce((sum, body) => sum + (JSON.parse(body) as { events: unknown[] }).events.length, 0), count);
      assert.equal(producer.stats().dropped, 0);
      const sizes = bodies.map(body => new OriginalEncoder().encode(body).byteLength);
      assert.ok(sizes.every(size => size <= 64 * 1024));
      console.log(`${scenario}: ${encodes} sizing encodes, ${bodies.length} batch encodings, max body ${Math.max(...sizes)} bytes`);
      if (scenario !== "near-cap") assert.equal(bodies.length, 1);
      else assert.ok(Math.max(...sizes) > 62_000);
    }
  } finally {
    globalThis.TextEncoder = OriginalEncoder;
  }
});
