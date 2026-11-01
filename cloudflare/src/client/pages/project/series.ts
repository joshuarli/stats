import type { ProjectMetricHistory, ProjectCollectorHistory } from "../../api";
import { pointsIn, type ChartPoint, type TimeWindow } from "../../chart-data";
import { bytes, count, isFiniteNumber, percent } from "../../format";
import { LIMITS, type Limits } from "../../health";
import { monitorOne } from "../../incidents";
import { lastValue, rangeText, type MonitorCell } from "../host/monitors";

const MINUTE_MS = 60_000;
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "other"] as const;
export const R2_OUTCOMES = ["success", "userError", "other"] as const;

export function milliseconds(value: number | undefined): string {
  return isFiniteNumber(value) ? `${count(value)} ms` : count(value);
}

export function minutes(value: number | undefined): string {
  return isFiniteNumber(value) ? `${count(value)} min` : count(value);
}

export function metricPoints(history: ProjectMetricHistory, metric: string): ChartPoint[] {
  const found = history.series.find(entry => entry.metric === metric);
  if (found === undefined) return [];
  return found.values.map((value, index) => ({ atMs: history.fromMs + index * history.stepMs, value: value ?? undefined }));
}

export function addAll(parts: readonly (readonly ChartPoint[])[]): ChartPoint[] {
  const first = parts[0];
  if (first === undefined) return [];
  return first.map((point, index) => {
    let total = 0;
    for (const part of parts) {
      const value = part[index]?.value;
      if (value === undefined) return { atMs: point.atMs, value: undefined };
      total += value;
    }
    return { atMs: point.atMs, value: total };
  });
}

export function holdLast(points: readonly ChartPoint[]): ChartPoint[] {
  let held: number | undefined;
  return points.map(point => {
    held = point.value ?? held;
    return { atMs: point.atMs, value: held };
  });
}

export function ratio(part: readonly ChartPoint[], whole: readonly ChartPoint[], scale: number): ChartPoint[] {
  return whole.map((point, index) => {
    const numerator = part[index]?.value;
    const denominator = point.value;
    return { atMs: point.atMs, value: numerator === undefined || denominator === undefined || denominator <= 0 ? undefined : (numerator / denominator) * scale };
  });
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
  readonly buckets: readonly string[];
  readonly silence: readonly ChartPoint[];
}

export function r2Metric(bucket: string, suffix: string): string {
  return `r2.${bucket}.${suffix}`;
}

export function bucketOutcome(data: ProjectData, outcome: (typeof R2_OUTCOMES)[number]): ChartPoint[] {
  return addAll(data.buckets.map(bucket => metricPoints(data.r2, r2Metric(bucket, `ops.${outcome}`))));
}

export function bucketGauge(data: ProjectData, suffix: "storageBytes" | "objects"): ChartPoint[] {
  return addAll(data.buckets.map(bucket => holdLast(metricPoints(data.r2, r2Metric(bucket, suffix)))));
}

export function serverErrorShare(data: ProjectData): ChartPoint[] {
  return ratio(metricPoints(data.worker, "worker.status.5xx"), metricPoints(data.worker, "worker.invocations"), 100);
}

export function cpuAverage(data: ProjectData): ChartPoint[] {
  return ratio(metricPoints(data.worker, "worker.cpuMsSum"), metricPoints(data.worker, "worker.invocations"), 1);
}

export function otherShare(data: ProjectData): ChartPoint[] {
  const total = addAll(R2_OUTCOMES.map(outcome => bucketOutcome(data, outcome)));
  return ratio(bucketOutcome(data, "other"), total, 100);
}

export function hasAnyValue(...series: readonly (readonly ChartPoint[])[]): boolean {
  return series.some(points => points.some(point => point.value !== undefined));
}

interface Spec {
  readonly id: string;
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
    { id: "r2-other", label: "R2 failures", anchor: "r2-operations", limits: LIMITS.r2OtherPercent, points: otherShare(data), format: percent },
    { id: "r2-storage", label: "R2 storage", anchor: "r2-storage", limits: undefined, points: bucketGauge(data, "storageBytes"), format: bytes },
    { id: "collector", label: "Collector", anchor: "collector", limits: LIMITS.collectorStaleMinutes, points: data.silence, format: minutes }
  ];
  return specs.map(spec => {
    const windowed = spec.id === "collector" ? spec.points : pointsIn(spec.points, view);
    const monitored = monitorOne({ id: spec.id, label: spec.label, anchor: spec.anchor, limits: spec.limits, series: [windowed], stepMs: spec.id === "collector" ? undefined : stepMs });
    return { id: spec.id, label: spec.label, anchor: spec.anchor, monitored, spark: windowed, format: spec.format, value: lastValue(windowed), detail: rangeText(windowed, spec.format) };
  });
}
