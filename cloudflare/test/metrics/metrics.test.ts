import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalog } from "../../src/metrics/catalog.ts";
import { decodeBatch, encodeBatch, type Batch } from "../../src/metrics/codec.ts";
import { MAX_SCRAPE_BYTES, parseExposition } from "../../src/metrics/exposition.ts";
import { MetricStore } from "../../src/metrics/store.ts";
import { decideRelease } from "../../src/cli/verify/release-decide.ts";
import type { ReleaseEvidence } from "../../src/cli/verify/release-evidence.ts";

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/metrics/v1/scrapes/${name}.prom`, import.meta.url), "utf8");
const primary = parseExposition(fixture("serve-primary-0-0"));
const peer = parseExposition(fixture("serve-peer-1-1"));
const restarted = parseExposition(fixture("serve-peer-1-3"));
const engine = parseExposition(fixture("standby-engine"));
const start = 1795192000000;
function batch(sequence: number, values = peer.values): Batch {
  const incarnation = values.openorange_worker_start_time_seconds![0]![1] as string;
  return {
    schema: "stats-infra-metrics/2", catalog: 1,
    collector: { name: "infra-standby", instance: "0123456789abcdef", startedAtMs: start - 1000 },
    expected: ["worker:serve-peer:1"],
    delivery: { atMs: start + (sequence - 1) * 15000, queued: 0, queueHigh: 0, targets: { "worker:serve-peer:1": { scraped: sequence - 1, accepted: sequence - 1, duplicates: 0, rejected: 0, dropped: 0, failed: 0 } } },
    scrapes: [{ target: "worker:serve-peer:1", sequence, atMs: start + (sequence - 1) * 15000,
      monoMs: sequence * 15000, outcome: "ok", durationUs: 10, bytes: 27000,
      release: { runtime: "rt-0123456789ab", app: "0123456789ab" },
      process: { startTime: incarnation }, dropped: peer.dropped, values }]
  };
}

void test("real scrapes cover the catalog and retain process identity", () => {
  const names = new Set([...Object.keys(primary.values), ...Object.keys(peer.values), ...Object.keys(engine.values)]);
  for (const name of Object.keys(catalog)) assert.ok(names.has(name), name);
  assert.notEqual(peer.values.openorange_worker_start_time_seconds![0]![1], restarted.values.openorange_worker_start_time_seconds![0]![1]);
  assert.ok(primary.dropped.unlisted_family > 0);
});
void test("parser rejects malformed input and drops a family with unknown labels", () => {
  assert.throws(() => parseExposition(fixture("standby-engine") + "not a sample\n"));
  assert.throws(() => parseExposition("# TYPE rivet_depot_alarm_discovery_rows_total counter\nrivet_depot_alarm_discovery_rows_total NaN\n"));
  assert.throws(() => parseExposition("# TYPE rivet_depot_alarm_discovery_rows_total counter\nrivet_depot_alarm_discovery_rows_total 1\nrivet_depot_alarm_discovery_rows_total 2\n"));
  const unknown = parseExposition("# TYPE rivet_depot_alarm_discovery_rows_total counter\nrivet_depot_alarm_discovery_rows_total{new=\"x\"} 1\n");
  assert.equal(unknown.values.rivet_depot_alarm_discovery_rows_total, undefined);
  assert.equal(unknown.dropped.unlisted_label, 1);
  assert.throws(() => parseExposition(" ".repeat(MAX_SCRAPE_BYTES + 1)));
});
void test("batch codec is strict and preserves exact values", () => {
  const input = batch(1);
  input.scrapes[0]!.values.rivet_rivetkit_envoy_client_actor_queued_requests_overloaded_total = [[{}, "18446744073709551615"]];
  assert.deepEqual(decodeBatch(encodeBatch(input)), input);
  const largestScrape = structuredClone(input);
  largestScrape.scrapes[0]!.bytes = MAX_SCRAPE_BYTES;
  assert.equal(decodeBatch(encodeBatch(largestScrape)).scrapes[0]!.bytes, MAX_SCRAPE_BYTES);
  largestScrape.scrapes[0]!.bytes++;
  assert.throws(() => encodeBatch(largestScrape));
  assert.throws(() => decodeBatch(encodeBatch(input).replace('"catalog":1', '"catalog":2')));
  assert.throws(() => decodeBatch(encodeBatch(input).replace('18446744073709551615', '18446744073709551616')));
  assert.throws(() => decodeBatch(encodeBatch(input).replace('"catalog":1', '"extra":0,"catalog":1')));
});
void test("store deduplicates, retains histogram buckets and records restart and failed scrape", () => {
  const store = new MetricStore();
  try {
    const first = batch(1);
    assert.equal(store.ingest(first, start).accepted, 1);
    assert.equal(store.ingest(first, start + 1).duplicates, 1);
    const conflict = structuredClone(first);
    conflict.scrapes[0]!.durationUs++;
    assert.equal(store.ingest(conflict, start + 2).rejected[0]?.code, "conflict");
    assert.equal(store.ingest(batch(2, restarted.values), start + 15000).accepted, 1);
    const failed = batch(3, restarted.values);
    failed.scrapes[0]!.outcome = "timeout";
    failed.scrapes[0]!.values = {};
    store.ingest(failed, start + 30000);
    const fourth = batch(4, restarted.values);
    fourth.delivery.targets["worker:serve-peer:1"]!.failed = 1;
    store.ingest(fourth, start + 45000);
    const result = store.sources(start, start + 45000, "runtime", start + 45000) as Array<{ evidence: { sequenceStart: { dropped: number }; sequenceEnd: { dropped: number }; received: number }; detail: { resets: number; scrapeFailures: { timeout: number } } }>;
    assert.equal(result[0]!.detail.resets, 1);
    assert.equal(result[0]!.detail.scrapeFailures.timeout, 1);
    assert.equal(result[0]!.evidence.received, 3);
    assert.ok(result[0]!.evidence.sequenceEnd.dropped > result[0]!.evidence.sequenceStart.dropped);
    const row = store.connection.prepare("SELECT payload FROM metric_scrapes WHERE sequence=1").get() as { payload: string };
    const parsed = JSON.parse(row.payload) as { values: Record<string, Array<[object, { buckets: string[] }]>> };
    assert.ok(parsed.values.rivet_rivetkit_envoy_client_actor_start_seconds![0]![1].buckets.length > 1);
    assert.deepEqual(store.sources(start, start + 30000, "runtime", start + 86430001).map((r: unknown) => (r as { evidence: unknown }).evidence), [null]);
  } finally { store.close(); }
});

void test("counter resets are gaps and histogram deltas stay per incarnation", () => {
  const store = new MetricStore();
  const counter = "rivet_rivetkit_envoy_client_actor_queued_requests_overloaded_total";
  const histogram = "rivet_rivetkit_envoy_client_actor_start_seconds";
  try {
    const first = batch(1, structuredClone(peer.values));
    first.scrapes[0]!.values[counter] = [[{}, "18446744073709551614"]];
    const second = batch(2, structuredClone(peer.values));
    second.scrapes[0]!.values[counter] = [[{}, "18446744073709551615"]];
    const third = batch(3, structuredClone(restarted.values));
    third.scrapes[0]!.values[counter] = [[{}, "0"]];
    for (const item of [first, second, third]) store.ingest(item, item.scrapes[0]!.atMs);
    const points = store.series("worker:serve-peer:1", counter, start, start + 30000, start + 30000).points;
    assert.equal(points[0]!.series[0]!.value, null);
    assert.equal(points[1]!.series[0]!.value, "1");
    assert.equal(points[2]!.series[0]!.value, null);
    assert.equal(points[2]!.intervalMs, null);
    const histograms = store.series("worker:serve-peer:1", histogram, start, start + 30000, start + 30000).points;
    assert.equal(histograms[0]!.series[0]!.value, null);
    const interval = histograms[1]!.series[0]!.value;
    assert.ok(interval && typeof interval !== "string");
    assert.equal(interval.buckets.length, catalog[histogram]!.buckets!.length);
    assert.equal(histograms[2]!.series[0]!.value, null);
    assert.notEqual(histograms[1]!.incarnation, histograms[2]!.incarnation);
  } finally {
    store.close();
  }
});

void test("ingest removes expired rows and evicts over the row budget", () => {
  const store = new MetricStore();
  try {
    const insert = store.connection.prepare(`INSERT INTO metric_scrapes VALUES
      ('seed', '0000000000000000', 'engine:seed', ?, ?, ?, ?, ?, 'ok',
       'rt-0123456789ab', NULL, NULL, 1, '{}')`);
    store.connection.exec("BEGIN");
    for (let i = 1; i <= 20001; i++) insert.run(i, start - 1000, i, start - 1000, start + 100000);
    store.connection.exec("COMMIT");
    store.ingest(batch(1, structuredClone(peer.values)), start);
    const rows = store.connection.prepare("SELECT count(*) AS n FROM metric_scrapes").get() as { n: number };
    const evicted = store.connection.prepare("SELECT value FROM metric_meta WHERE key='evicted'").get() as { value: string };
    assert.equal(rows.n, 20000);
    assert.equal(evicted.value, "2");
    store.ingest(batch(2, structuredClone(peer.values)), start + 86430000);
    const expired = store.connection.prepare("SELECT count(*) AS n FROM metric_scrapes WHERE expires_at <= ?").get(start + 86430000) as { n: number };
    assert.equal(expired.n, 19936);
  } finally {
    store.close();
  }
});

void test("failed scrape changes the exact gate checkpoint shape", () => {
  const store = new MetricStore();
  try {
    const first = batch(1, structuredClone(peer.values));
    const failure = batch(2, structuredClone(peer.values));
    failure.scrapes[0]!.outcome = "refused";
    failure.scrapes[0]!.values = {};
    store.ingest(first, start);
    store.ingest(failure, start + 15000);
    const third = batch(3, structuredClone(peer.values));
    third.delivery.targets["worker:serve-peer:1"]!.failed = 1;
    store.ingest(third, start + 30000);
    const result = store.sources(start, start + 30000, "runtime", start + 30000) as Array<{ evidence: Record<string, unknown> }>;
    const evidence = result[0]!.evidence;
    assert.deepEqual(Object.keys(evidence).sort(), ["lastSeenMs", "producer", "received", "releaseId", "sequenceEnd", "sequenceStart", "source"]);
    const begin = evidence.sequenceStart as { dropped: number };
    const end = evidence.sequenceEnd as { dropped: number };
    assert.deepEqual(Object.keys(begin).sort(), ["accepted", "atMs", "dropped", "queued", "startedAtMs"]);
    assert.equal(end.dropped - begin.dropped, 1);
    const releaseId = "rt-0123456789ab";
    const cohort = { releaseId, workloadId: "load", attempted: 1, succeeded: 1, failures: {}, bodyMismatches: 0,
      acknowledgedWrites: 0, readbackVerified: 0, lostWrites: 0, duplicateMismatches: 0,
      history: { samples: [], phases: [{ phase: "before", expected: 0, verified: 0, missing: 0, mismatched: 0 }, { phase: "after", expected: 0, verified: 0, missing: 0, mismatched: 0 }] },
      histogram: { relativeError: 0.01, buckets: [[1000, 1]] }, windowStartMs: start,
      windowEndMs: start + 15000, truncated: false };
    const observation = { observer: { status: "ok", checkedAtMs: start + 15000 }, sources: [evidence],
      truncated: false, hostConfounded: false, resources: { cpuSeconds: 1, memoryPeakBytes: 1, restarts: 0 } };
    const gate = {
      policy: { schema: "stats-release-policy/2", id: "test", profile: { name: "smoke", definitionSha256: "a".repeat(64) },
        baselineRelease: "old", candidateRelease: releaseId, workloadId: "load", workloadSha256: "hash",
        requiredSources: [{ source: "worker:serve-peer:1", producer: "infra-standby", families: [] }],
        windows: { startMs: start, warmupMs: 0, measureMs: 15000 }, minimums: { measureMs: 15000, requests: 1 }, maxEvidenceAgeMs: 100000,
        absolute: { maxErrorShare: 1, p95Ms: 10, p99Ms: 10, maxLostWrites: 0, maxHistoryMismatches: 0, maxCpuSecondsPerKRequests: 1e6, maxMemoryPeakBytes: 1e12, maxRestarts: 1 },
        regression: { latency: { maxRelativeIncreasePercent: 100, absoluteFloorMs: 0 }, maxCpuRelativeIncreasePercent: 100, maxMemoryRelativeIncreasePercent: 100 },
        histogramMaxRelativeError: 0.1, recovery: { required: true, method: "rollback" } },
      baseline: { releaseId: "old" }, candidate: { releaseId }, workload: { id: "load" },
      ledger: { baseline: { ...cohort, releaseId: "old" }, candidate: cohort },
      observations: { baseline: { ...observation, sources: [{ ...evidence, releaseId: "old" }] }, candidate: observation },
      recovery: { method: "rollback", verifiedAtMs: start + 15000, previousRelease: "old", readbackVerified: true },
      hashes: { "workload.json": "hash" }, decision: null
    } as unknown as ReleaseEvidence;
    const decision = decideRelease(gate, start + 15000);
    assert.equal(decision.verdict, "inconclusive");
    assert.ok(decision.reasons.some((reason) => reason.code === "delivery-incomplete"));
  } finally {
    store.close();
  }
});

void test("codec rejects invalid histograms, unknown labels and oversized batches", () => {
  const input = batch(1, structuredClone(peer.values));
  const name = "rivet_rivetkit_envoy_client_actor_start_seconds";
  const histogram = input.scrapes[0]!.values[name]![0]![1];
  assert.ok(typeof histogram !== "string");
  histogram.buckets[0] = "2";
  assert.throws(() => encodeBatch(input));
  const extra = batch(1, structuredClone(peer.values));
  extra.scrapes[0]!.values.openorange_worker_info![0]![0].unexpected = "x";
  assert.throws(() => encodeBatch(extra));
  assert.throws(() => decodeBatch(" ".repeat(65537)));
  const tooMany = batch(1, structuredClone(peer.values));
  tooMany.scrapes = Array.from({ length: 17 }, (_, index) => ({ ...tooMany.scrapes[0]!, sequence: index + 1 }));
  assert.throws(() => encodeBatch(tooMany));
});

void test("same-millisecond deliveries count toward the collector rate limit", () => {
  const store = new MetricStore();
  try {
    const input = batch(1);
    for (let index = 0; index < 12; index++) store.ingest(input, start);
    assert.throws(() => store.ingest(input, start), /rate_limit/);
  } finally {
    store.close();
  }
});

void test("actor roles collapse counters, gauges and histogram buckets without retaining names", () => {
  const name = "rivet_rivetkit_actor_sqlite_transaction_round_trips";
  const source = fixture("live-stats-0");
  const parsed = parseExposition(source);
  assert.ok(parsed.values.rivet_rivetkit_actor_connections_total!.some(([labels, value]) => labels.actor_name === "installation" && BigInt(value as string) > 0n));
  assert.ok(parsed.values.rivet_rivetkit_actor_sqlite_vfs_commit_total!.some(([labels, value]) => labels.actor_name === "installation" && BigInt(value as string) > 0n));
  assert.ok(!JSON.stringify(parsed.values).includes("installation-"));
  const hist = (actor: string, n: number) => [`# TYPE ${name} histogram`, ...catalog[name]!.buckets!.map(le => `${name}_bucket{actor_name="${actor}",le="${le}"} ${n}`), `${name}_count{actor_name="${actor}"} ${n}`, `${name}_sum{actor_name="${actor}"} ${n}`].join("\n");
  const combined = hist("installation-aaaaaaaa", 2) + "\n" + hist("installation-bbbbbbbb", 3).split("\n").slice(1).join("\n");
  const result = parseExposition(combined).values[name]![0]![1];
  assert.notEqual(typeof result, "string");
  assert.equal((result as { count: string }).count, "5");
  const counter = "rivet_rivetkit_actor_connections_total", gauge = "rivet_rivetkit_actor_active_count";
  const scalars = parseExposition(`# TYPE ${counter} counter\n${counter}{actor_name="installation-aaaaaaaa"} 2\n${counter}{actor_name="installation-bbbbbbbb"} 3\n# TYPE ${gauge} gauge\n${gauge}{actor_name="installation-aaaaaaaa"} 2\n${gauge}{actor_name="installation-bbbbbbbb"} 3\n`);
  assert.equal(scalars.values[counter]![0]![1], "5");
  assert.equal(scalars.values[gauge]![0]![1], "3");
  const unknown = parseExposition(`# TYPE ${gauge} gauge\n${gauge}{actor_name="private-key"} 4\n`);
  assert.deepEqual(unknown.values[gauge]![0], [{ actor_name: "other" }, "4"]);
});

void test("brackets snapshots, separates window queue maximum and reports missing, stale and restarted sources", () => {
  const store = new MetricStore();
  try {
    const items = Array.from({ length: 6 }, (_, i) => batch(i + 1, structuredClone(peer.values)));
    for (const item of items) delete item.scrapes[0]!.values.rivet_rivetkit_actor_connections_total;
    items[0]!.delivery.queued = 4;
    for (const item of items) item.delivery.queueHigh = 4;
    for (const item of items) store.ingest(item, item.scrapes[0]!.atMs);
    const read = (from: number, to: number, now = start + 75000) => store.sources(from, to, "runtime", now)[0] as { evidence: { sequenceStart: { atMs: number; queued: number }; sequenceEnd: { atMs: number; queued: number }; received: number } | null; detail: { status: string; queueMax: number; queueHigh: number; families: Record<string, { usable: boolean; reason: string | null }> } };
    const result = read(start + 16000, start + 46000);
    assert.equal(result.evidence!.sequenceStart.atMs, start + 15000);
    assert.equal(result.evidence!.sequenceEnd.atMs, start + 60000);
    assert.equal(result.evidence!.sequenceStart.queued, 0);
    assert.equal(result.detail.queueMax, 0);
    assert.equal(result.detail.queueHigh, 4);
    assert.equal(result.detail.families.openorange_worker_info!.usable, true);
    assert.equal(result.detail.families.rivet_rivetkit_actor_connections_total!.reason, "family-missing");
    assert.equal(read(start + 16000, start + 90000).detail.status, "window-open");
    assert.equal(read(start + 75000, start + 140000, start + 140000).detail.status, "window-open");
    const restarted = batch(1, structuredClone(peer.values));
    restarted.collector.instance = "fedcba9876543210";
    restarted.collector.startedAtMs = start + 60000;
    restarted.delivery.atMs = start + 60000;
    restarted.scrapes[0]!.atMs = start + 60000;
    store.ingest(restarted, start + 80000);
    assert.equal(read(start + 15000, start + 65000, start + 80000).detail.status, "collector-restart");
  } finally { store.close(); }
});

void test("a bracketed window reports stale when its last OK scrape exceeds 45 seconds", () => {
  const store = new MetricStore();
  try {
    const first = batch(1, structuredClone(peer.values));
    store.ingest(first, start);
    for (let n = 2; n <= 6; n++) {
      const failure = batch(n, structuredClone(peer.values));
      failure.scrapes[0]!.outcome = "timeout";
      failure.scrapes[0]!.values = {};
      store.ingest(failure, failure.scrapes[0]!.atMs);
    }
    const entry = store.sources(start + 15000, start + 60000, "runtime", start + 75000)[0] as { evidence: unknown; detail: { status: string; lastOkAtMs: number | null } };
    assert.equal(entry.evidence, null);
    assert.equal(entry.detail.status, "stale");
    assert.equal(entry.detail.lastOkAtMs, start);
  } finally { store.close(); }
});

void test("a missing scrape acknowledgement cannot reconcile with received rows", () => {
  const store = new MetricStore();
  try {
    const first = batch(1, structuredClone(peer.values));
    const second = batch(2, structuredClone(peer.values));
    const third = batch(3, structuredClone(peer.values));
    third.delivery.targets["worker:serve-peer:1"]!.accepted = 1;
    for (const item of [first, second, third]) store.ingest(item, item.scrapes[0]!.atMs);
    const result = store.sources(start, start + 30000, "runtime", start + 30000)[0] as { evidence: { received: number; sequenceStart: { accepted: number }; sequenceEnd: { accepted: number } } };
    assert.equal(result.evidence.received, 2);
    assert.equal(result.evidence.sequenceEnd.accepted - result.evidence.sequenceStart.accepted, 1);
  } finally { store.close(); }
});
