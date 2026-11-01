import type { ProjectMetricHistory, ProjectCollectorHistory } from "../../api";
import { pointsIn, type ChartPoint, type TimeWindow } from "../../chart-data";
import { bytes, count, milliseconds, minutes, percent } from "../../format";
import { LIMITS, MIN_SCORED_EVENTS, type Limits } from "../../health";
import { monitorOne } from "../../incidents";
import { addAll, holdLast, ratio } from "./math";
import { lastValue, rangeText, type MonitorCell } from "../host/monitors";

const MINUTE_MS = 60_000;
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "other"] as const;
const R2_OUTCOMES = ["success", "userError", "other"] as const;

export function metricPoints(history: ProjectMetricHistory, metric: string): ChartPoint[] {
  const found = history.series.find(entry => entry.metric === metric);
  if (found === undefined) return [];
  return found.values.map((value, index) => ({ atMs: history.fromMs + index * history.stepMs, value: value ?? undefined }));
}

export function silenceMinutes(history: ProjectCollectorHistory, nowMs: number, lastSuccessAtMs: number | null): ChartPoint[] {
  const points: ChartPoint[] = [];
  let lastSuccess: number | undefined;
  for (const run of history.runs) {
    if (lastSuccess !== undefined) points.push({ atMs: run.atMs, value: (run.atMs - lastSuccess) / MINUTE_MS });
    if (run.ok) lastSuccess = run.atMs;
  }
  const reference = lastSuccess ?? lastSuccessAtMs ?? undefined;
  if (reference !== undefined) points.push({ atMs: nowMs, value: Math.max(0, nowMs - reference) / MINUTE_MS });
  return points;
}

export interface ProjectData {
  readonly worker: ProjectMetricHistory;
  readonly r2: ProjectMetricHistory;
  readonly probes: ProjectMetricHistory | undefined;
  readonly probeNames: readonly string[];
  readonly buckets: readonly string[];
  readonly silence: readonly ChartPoint[];
}

export function r2Metric(bucket: string, suffix: string): string {
  return `r2.${bucket}.${suffix}`;
}

export function bucketOutcome(data: ProjectData, outcome: (typeof R2_OUTCOMES)[number]): ChartPoint[] {
  return addAll(data.buckets.map(bucket => metricPoints(data.r2, r2Metric(bucket, `ops.${outcome}`))));
}

function bucketGauge(data: ProjectData, suffix: "storageBytes" | "objects"): ChartPoint[] {
  return addAll(data.buckets.map(bucket => holdLast(metricPoints(data.r2, r2Metric(bucket, suffix)))));
}

export function serverErrorShare(data: ProjectData): ChartPoint[] {
  return ratio(metricPoints(data.worker, "worker.status.5xx"), metricPoints(data.worker, "worker.invocations"), 100, MIN_SCORED_EVENTS);
}

export function cpuAverage(data: ProjectData): ChartPoint[] {
  return ratio(metricPoints(data.worker, "worker.cpuMsSum"), metricPoints(data.worker, "worker.invocations"), 1, MIN_SCORED_EVENTS);
}

export function otherShare(data: ProjectData): ChartPoint[] {
  const total = addAll(R2_OUTCOMES.map(outcome => bucketOutcome(data, outcome)));
  return ratio(bucketOutcome(data, "other"), total, 100, MIN_SCORED_EVENTS);
}

export function probeUp(data: ProjectData): ChartPoint[][] {
  const history = data.probes;
  return history === undefined ? [] : data.probeNames.map(name => metricPoints(history, `probe.${name}.up`));
}

export function endpointText(value: number | undefined): string {
  return value === undefined ? count(value) : value >= 1 ? "all up" : "down";
}

function weakest(series: readonly (readonly ChartPoint[])[]): ChartPoint[] {
  const first = series[0];
  if (first === undefined) return [];
  return first.map((point, index) => {
    const values = series.flatMap(column => (column[index]?.value === undefined ? [] : [column[index]!.value!]));
    return { atMs: point.atMs, value: values.length === 0 ? undefined : Math.min(...values) };
  });
}

export function hasAnyValue(...series: readonly (readonly ChartPoint[])[]): boolean {
  return series.some(points => points.some(point => point.value !== undefined));
}

interface Spec {
  readonly id: string;
  readonly parts?: readonly (readonly ChartPoint[])[];
  readonly label: string;
  readonly anchor: string;
  readonly limits: Limits | undefined;
  readonly points: readonly ChartPoint[];
  readonly format: (value: number | undefined) => string;
}

export function buildProjectCells(data: ProjectData, view: TimeWindow | null): MonitorCell[] {
  const stepMs = data.worker.stepMs;
  const specs: Spec[] = [
    { id: "requests", label: "Requests", anchor: "requests", limits: undefined, points: metricPoints(data.worker, "worker.invocations"), format: count },
    { id: "server-errors", label: "Worker 5xx", anchor: "status", limits: LIMITS.workerServerErrorPercent, points: serverErrorShare(data), format: percent },
    { id: "cpu-time", label: "CPU time", anchor: "cpu", limits: LIMITS.workerCpuMs, points: cpuAverage(data), format: milliseconds },
    ...(data.buckets.length === 0
      ? []
      : [
          { id: "r2-other", label: "R2 failures", anchor: "r2-operations", limits: LIMITS.r2OtherPercent, points: otherShare(data), format: percent },
          { id: "r2-storage", label: "R2 storage", anchor: "r2-storage", limits: undefined, points: bucketGauge(data, "storageBytes"), format: bytes }
        ]),
    { id: "collector", label: "Collector", anchor: "collector", limits: LIMITS.collectorStaleMinutes, points: data.silence, format: minutes }
  ];
  const ups = probeUp(data);
  if (ups.length > 0) {
    specs.splice(specs.length - 1, 0, { id: "endpoints", label: "Endpoints", anchor: "endpoints", limits: LIMITS.probeUp, points: weakest(ups), parts: ups, format: endpointText });
  }
  return specs.map(spec => {
    const windowed = spec.id === "collector" ? spec.points : pointsIn(spec.points, view);
    const parts = spec.parts === undefined ? [windowed] : spec.parts.map(part => pointsIn(part, view));
    const monitored = monitorOne({ id: spec.id, label: spec.label, anchor: spec.anchor, limits: spec.limits, series: parts, stepMs: spec.id === "collector" ? undefined : stepMs });
    return { id: spec.id, label: spec.label, anchor: spec.anchor, monitored, spark: windowed, format: spec.format, value: lastValue(windowed), detail: rangeText(windowed, spec.format) };
  });
}
