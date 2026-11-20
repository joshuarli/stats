import assert from "node:assert/strict";
import { test } from "node:test";
import { boundBatch } from "../../../packages/infra-collector/src/bounds.ts";
import { catalog } from "../../src/metrics/catalog.ts";
import { encodeBatch, type Batch } from "../../src/metrics/codec.ts";
import type { Values } from "../../src/metrics/exposition.ts";

void test("a full collector round stays within the batch cap and counts removed series", () => {
  const values: Values = {};
  for (const [name, family] of Object.entries(catalog)) {
    let labels: Record<string, string>[] = [{}];
    for (const [key, choices] of Object.entries(family.labels)) {
      labels = labels.flatMap(label => choices.map(choice => ({ ...label, [key]: choice })));
    }
    const scalar = family.form === "decimal" ? "99999999999999999999999999999999" : "18446744073709551615";
    const value = family.type === "histogram" ? { buckets: family.buckets!.map(() => "18446744073709551615"), count: "18446744073709551615", sum: "99999999999999999999999999999999" } : scalar;
    values[name] = labels.map(label => [label, value]);
  }
  const expected = Array.from({ length: 16 }, (_, index) => `engine:e${index}`);
  const batch: Batch = {
    schema: "stats-infra-metrics/2", catalog: 1,
    collector: { name: "infra", instance: "0123456789abcdef", startedAtMs: 1 },
    expected, delivery: { atMs: 1, queued: 0, queueHigh: 0, targets: Object.fromEntries(expected.map(target => [target, { scraped: 0, accepted: 0, duplicates: 0, rejected: 0, dropped: 0, failed: 0 }])) },
    scrapes: expected.map(target => ({ target, sequence: 1, atMs: 1, monoMs: 1, outcome: "ok", durationUs: 1, bytes: 1,
      release: { runtime: "rt-0123456789ab", app: null }, process: { startTime: null },
      dropped: { unlisted_family: 0, unlisted_label: 0, non_finite: 0, series_cap: 0 }, values: structuredClone(values) }))
  };
  assert.throws(() => encodeBatch(batch));
  boundBatch(batch);
  assert.ok(new TextEncoder().encode(encodeBatch(batch)).length <= 65536);
  assert.ok(batch.scrapes.some(scrape => scrape.dropped.series_cap > 0));
});
