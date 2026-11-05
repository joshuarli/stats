import type { Track } from "../../columns";
import { count } from "../../format";
import { metricTrack, type CollectorHistory, type MetricHistory } from "../../history";
import { MIN_SCORED_EVENTS } from "../../health";
import { addAll, ratio } from "../../math.ts";

export { provisionalFromMs } from "../../project-ledger.ts";

const MINUTE_MS = 60_000;
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "other"] as const;
const R2_OUTCOMES = ["success", "userError", "other"] as const;

export function silenceMinutes(history: CollectorHistory, nowMs: number, lastSuccessAtMs: number | null): Track {
  const times: number[] = [];
  const values: number[] = [];
  let lastSuccess: number | undefined;
  for (const run of history.runs) {
    if (lastSuccess !== undefined) {
      times.push(run.atMs);
      values.push((run.atMs - lastSuccess) / MINUTE_MS);
    }
    if (run.ok) lastSuccess = run.atMs;
  }
  const reference = lastSuccess ?? lastSuccessAtMs ?? undefined;
  if (reference !== undefined) {
    times.push(nowMs);
    values.push(Math.max(0, nowMs - reference) / MINUTE_MS);
  }
  return { times, values };
}

export interface ProjectData {
  readonly worker: MetricHistory;
  readonly routes: MetricHistory;
  readonly durableObjects: MetricHistory | undefined;
  readonly r2: MetricHistory;
  readonly d1: MetricHistory | undefined;
  readonly d1Statements: MetricHistory | undefined;
  readonly probes: MetricHistory | undefined;
  readonly probeNames: readonly string[];
  readonly buckets: readonly string[];
  readonly databases: readonly string[];
  readonly silence: Track;
}

export function r2Metric(bucket: string, suffix: string): string {
  return `r2.${bucket}.${suffix}`;
}

export function bucketOutcome(data: ProjectData, outcome: (typeof R2_OUTCOMES)[number]): Track {
  return addAll(data.buckets.map(bucket => metricTrack(data.r2, r2Metric(bucket, `ops.${outcome}`))));
}

export function serverErrorShare(data: ProjectData): Track {
  return ratio(metricTrack(data.worker, "worker.status.5xx"), metricTrack(data.worker, "worker.invocations"), 100, MIN_SCORED_EVENTS);
}

export function cpuAverage(data: ProjectData): Track {
  return ratio(metricTrack(data.worker, "worker.cpuMsSum"), metricTrack(data.worker, "worker.invocations"), 1, MIN_SCORED_EVENTS);
}

export function durableObjectCpuAverage(history: MetricHistory): Track {
  return ratio(metricTrack(history, "do.cpuMsSum"), metricTrack(history, "do.invocations"), 1, MIN_SCORED_EVENTS);
}

export function durableObjectWallAverage(history: MetricHistory): Track {
  return ratio(metricTrack(history, "do.wallMsSum"), metricTrack(history, "do.invocations"), 1, MIN_SCORED_EVENTS);
}

export function otherShare(data: ProjectData): Track {
  const total = addAll(R2_OUTCOMES.map(outcome => bucketOutcome(data, outcome)));
  return ratio(bucketOutcome(data, "other"), total, 100, MIN_SCORED_EVENTS);
}

export function probeUp(data: ProjectData): Track[] {
  const history = data.probes;
  return history === undefined ? [] : data.probeNames.map(name => metricTrack(history, `probe.${name}.up`));
}

export function endpointText(value: number | undefined): string {
  return value === undefined ? count(value) : value >= 1 ? "all up" : "down";
}

export function hasAnyValue(...series: readonly Track[]): boolean {
  return series.some(track => track.values.some(value => value !== null));
}
