import { COUNT_BUCKET_MS, HEALTH_BUCKET_MS, RETENTION_MS } from "../../src/observe/core/limits.ts";
import type { EventRows, MeasuredFigures } from "../../src/observe/core/budget.ts";
import { ALL_SHAPES, delta, objectEntry, pickShape, random, seededWorkload, traceFor, workerEntry, type Fate, type Meter, type Rig, type Shape, type SimEntry } from "./workload.ts";

export interface PhaseReport {
  readonly events: number;
  readonly ingest: Meter;
  readonly retention: Meter;
  readonly flushes: number;
}

export interface FlushReport extends PhaseReport {
  readonly keysPerFlush: number;
  readonly countRows: number;
  readonly countBuckets: number;
  readonly hoursSpanned: number;
}

export interface SteadyReport extends PhaseReport {
  readonly requests: number;
  readonly keptEvents: number;
  readonly failedEvents: number;
  readonly durationMs: number;
}

export interface Measurement {
  readonly kept: PhaseReport;
  readonly failed: PhaseReport;
  readonly rejected: PhaseReport;
  readonly flushing: FlushReport;
  readonly maintenance: Meter;
  readonly steady: SteadyReport;
  readonly figures: Pick<MeasuredFigures, "kept" | "failed" | "rejected" | "flush" | "maintenanceRowsPerHour" | "maintenanceRequestsPerHour">;
}

const CLEANUP_AFTER_MS = RETENTION_MS + 2 * HEALTH_BUCKET_MS;
const TABLES = ["observe_invocations", "observe_counts", "observe_outcomes", "observe_occurrences", "observe_health_events", "observe_issues"];

async function size(rig: Rig, table: string, where = "1 = 1"): Promise<number> {
  return (await rig.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`))[0]!.n;
}

async function cleanUntilEmpty(rig: Rig, from: number): Promise<number> {
  let at = from + CLEANUP_AFTER_MS;
  for (let attempt = 0; attempt < 30; attempt++) {
    await rig.alarm(at);
    at += HEALTH_BUCKET_MS;
    const left = (await Promise.all([...TABLES.map(table => size(rig, table)), size(rig, "observe_write_cost", "phase = 'ingest'")])).reduce((sum, n) => sum + n, 0);
    if (left === 0) return at;
  }
  throw new Error("cleanup did not empty the store");
}

async function phase(rig: Rig, entries: readonly SimEntry[], settle = 0): Promise<{ report: PhaseReport; clock: number; countRows: number; countBuckets: number; hoursSpanned: number; keptTotal: number }> {
  const begun = await rig.meter();
  const flushesBefore = (await rig.health()).sampling?.flushes ?? 0;
  await rig.tail(entries, settle);
  const ended = await rig.meter();
  const ending = (await rig.health()).sampling;
  const flushes = (ending?.flushes ?? 0) - flushesBefore;
  const countRows = await size(rig, "observe_count_entries");
  const countBuckets = await size(rig, "observe_counts");
  const hoursSpanned = (await rig.query<{ n: number }>("SELECT COUNT(DISTINCT bucket_at) AS n FROM observe_write_cost WHERE phase = 'ingest'"))[0]!.n;
  const cleaning = await rig.meter();
  const clock = await cleanUntilEmpty(rig, ended.nowMs);
  const cleaned = await rig.meter();
  return { report: { events: entries.length, ingest: delta(ended, begun), retention: delta(cleaned, cleaning), flushes }, clock, countRows, countBuckets, hoursSpanned, keptTotal: ending?.kept ?? 0 };
}

function forced(count: number, startMs: number, spacingMs: number, keepPerMillion: number, fate: Fate, failure?: "uncaught" | "double-operation", seed = 7): SimEntry[] {
  const rng = random(seed);
  const result: SimEntry[] = [];
  for (let n = 0; n < count; n++) {
    const shape = pickShape(rng);
    const invocation = { atMs: startMs + n * spacingMs, traceId: traceFor(rng, keepPerMillion, fate), shape, ...(failure === undefined ? {} : { failure }) };
    result.push(workerEntry(rng, invocation));
    if (failure === undefined && shape.rpc !== null) result.push(objectEntry(rng, invocation));
  }
  return result.sort((a, b) => a.nowMs - b.nowMs);
}

function flushing(intervals: number, startMs: number, intervalMs: number, keepPerMillion: number, shapes: readonly Shape[]): SimEntry[] {
  const rng = random(11);
  const result: SimEntry[] = [];
  for (let interval = 0; interval < intervals; interval++) {
    shapes.forEach((shape, n) => {
      const invocation = { atMs: startMs + interval * (intervalMs + 1_000) + n * 100, traceId: traceFor(rng, keepPerMillion, "dropped"), shape };
      result.push(workerEntry(rng, invocation));
      if (shape.rpc !== null) result.push(objectEntry(rng, invocation));
    });
  }
  return result.sort((a, b) => a.nowMs - b.nowMs);
}

function eventRows(report: PhaseReport): EventRows {
  return { ingestRows: report.ingest.rowsWritten / report.events, retentionRows: (report.retention.rowsWritten - (report.retention.byTable["observe_counts"] ?? 0)) / report.events };
}

export interface MeasureOptions {
  readonly keepPerMillion: number;
  readonly flushIntervalMs: number;
  readonly steadyKeepPerMillion: number;
  readonly steadyFailurePerMillion: number;
  readonly steadyDurationMs: number;
  readonly requestsPerSecond: number;
}

export async function measure(rig: Rig, options: MeasureOptions): Promise<Measurement> {
  const { keepPerMillion } = options;
  let clock = (await rig.meter()).nowMs + COUNT_BUCKET_MS;
  const next = (at: number) => { clock = at + 2 * COUNT_BUCKET_MS; };

  const keptEntries = forced(300, clock, 6_000, keepPerMillion, "kept");
  const kept = await phase(rig, keptEntries);
  next(kept.clock);
  const failed = await phase(rig, forced(100, clock, 6_000, keepPerMillion, "natural", "uncaught", 8));
  next(failed.clock);
  const rejected = await phase(rig, forced(100, clock, 6_000, keepPerMillion, "natural", "double-operation", 9));
  next(rejected.clock);

  const idleBefore = await rig.meter();
  await rig.tail(forced(3, clock, 6_000, keepPerMillion, "kept", undefined, 12));
  const idleStart = await rig.meter();
  await rig.alarm(idleStart.nowMs + HEALTH_BUCKET_MS / 2);
  const maintenance = delta(await rig.meter(), idleStart);
  void idleBefore;
  next(await cleanUntilEmpty(rig, idleStart.nowMs));

  const intervals = 20;
  const flush = await phase(rig, flushing(intervals, clock, options.flushIntervalMs, keepPerMillion, ALL_SHAPES), 30_000);
  next(flush.clock);

  const rng = random(21);
  const probability = options.steadyKeepPerMillion / 1_000_000;
  const workload = seededWorkload({
    seed: 5, startMs: clock, durationMs: options.steadyDurationMs, requestsPerSecond: options.requestsPerSecond, keepPerMillion,
    fate: () => rng() < probability ? "kept" : "dropped", failurePerMillion: options.steadyFailurePerMillion
  });
  const steady = await phase(rig, workload.entries, 30_000);

  const flushReport: FlushReport = { ...flush.report, keysPerFlush: flush.countRows / flush.countBuckets, countRows: flush.countRows, countBuckets: flush.countBuckets, hoursSpanned: flush.hoursSpanned };
  const otherRetention = flush.report.retention.rowsWritten - (flush.report.retention.byTable["observe_counts"] ?? 0);

  return {
    kept: kept.report, failed: failed.report, rejected: rejected.report, flushing: flushReport, maintenance,
    steady: { ...steady.report, requests: workload.requests, keptEvents: steady.keptTotal - workload.failed, failedEvents: workload.failed, durationMs: options.steadyDurationMs },
    figures: {
      kept: eventRows(kept.report), failed: eventRows(failed.report), rejected: eventRows(rejected.report),
      flush: { rowsPerFlush: flush.report.ingest.rowsWritten / flush.report.flushes, retentionRowsPerBucket: (flush.report.retention.byTable["observe_counts"] ?? 0) / flush.countBuckets, retentionRowsPerHour: otherRetention / flush.hoursSpanned },
      maintenanceRowsPerHour: maintenance.rowsWritten + maintenance.setAlarms,
      maintenanceRequestsPerHour: 2
    }
  };
}
