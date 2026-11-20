import { test } from "node:test";
import assert from "node:assert/strict";
import { acknowledgedSamples, expectedHistory } from "./history.mts";

await test("reference history calculates same-boot deltas and leaves counter regressions as gaps", () => {
  const samples = [
    { seq: "1", atMs: "1000", monoMs: "10", cpuCount: 2, uptimeMs: "10", cpu: { user: "10", system: "20", idle: "70", total: "100" } },
    { seq: "2", atMs: "2000", monoMs: "1010", cpuCount: 2, uptimeMs: "1010", cpu: { user: "30", system: "50", idle: "120", total: "200" } },
    { seq: "3", atMs: "3000", monoMs: "2010", cpuCount: 2, uptimeMs: "2010", cpu: { user: "1", system: "2", idle: "3", total: "6" } }
  ];
  assert.deepEqual(acknowledgedSamples(samples, [{ seq: 2n }]).map(sample => sample.seq), ["1", "3"]);
  assert.deepEqual(expectedHistory(samples), [
    { atMs: 1000, coverageMs: 0, partial: 0, cpuCount: 2, uptimeMs: 10 },
    { atMs: 2000, coverageMs: 1000, partial: 0, cpuCount: 2, uptimeMs: 1010, cpu: 1, "cpu.user": 20, "cpu.system": 30, "cpu.idle": 50 },
    { atMs: 3000, coverageMs: 1000, partial: 0, cpuCount: 2, uptimeMs: 2010 }
  ]);
});
