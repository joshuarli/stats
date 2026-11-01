import type { ProjectMetricHistory, ProjectCollectorHistory } from "../../api";
import { pointsIn, type ChartPoint, type TimeWindow } from "../../chart-data";
import { bytes, count, milliseconds, minutes, percent } from "../../format";
import { LIMITS, MIN_SCORED_EVENTS, type Limits } from "../../health";
import { monitorOne } from "../../incidents";
import { addAll, holdLast, ratio, scaled } from "./math";
import { LIST_PRICE_PER_MILLION } from "../../pricing";
import { PROJECT_SETTLE_MS } from "../../../limits";
import { CELL_HUES, lastValue, rangeText, type MonitorCell } from "../host/monitors";

const MINUTE_MS = 60_000;
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "other"] as const;
const ROUTE_PREFIX = "route.";
const R2_OUTCOMES = ["success", "userError", "other"] as const;

export function metricPoints(history: ProjectMetricHistory, metric: string): ChartPoint[] {
  const found = history.series.find(entry => entry.metric === metric);
  if (found === undefined) return [];
  return found.values.map((value, index) => ({ atMs: history.fromMs + index * history.stepMs, value: value ?? undefined }));
}

export function provisionalFromMs(history: ProjectMetricHistory): number {
  const cutoff = history.toMs - history.stepMs - PROJECT_SETTLE_MS;
  return history.fromMs + (Math.floor((cutoff - history.fromMs) / history.stepMs) + 1) * history.stepMs;
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
  readonly routes: ProjectMetricHistory;
  readonly durableObjects: ProjectMetricHistory | undefined;
  readonly r2: ProjectMetricHistory;
  readonly d1: ProjectMetricHistory | undefined;
  readonly d1Statements: ProjectMetricHistory | undefined;
  readonly probes: ProjectMetricHistory | undefined;
  readonly probeNames: readonly string[];
  readonly buckets: readonly string[];
  readonly databases: readonly string[];
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

export interface RouteRow {
  readonly route: string;
  readonly invocations: number;
  readonly cpuMs: number;
  readonly cpuShare: number;
  readonly averageMs: number | undefined;
}

function seriesTotal(history: ProjectMetricHistory, metric: string, view: TimeWindow | null): number {
  return totalIn(metricPoints(history, metric), view);
}

export function routeRows(history: ProjectMetricHistory, view: TimeWindow | null): RouteRow[] {
  const routes = new Set(history.series.map(entry => entry.metric.slice(ROUTE_PREFIX.length, entry.metric.lastIndexOf("."))));
  const totals = [...routes].map(route => ({
    route,
    invocations: seriesTotal(history, `${ROUTE_PREFIX}${route}.invocations`, view),
    cpuMs: seriesTotal(history, `${ROUTE_PREFIX}${route}.cpuMsSum`, view)
  }));
  const allCpu = totals.reduce((sum, entry) => sum + entry.cpuMs, 0);
  return totals
    .map(entry => ({ ...entry, cpuShare: allCpu > 0 ? (entry.cpuMs / allCpu) * 100 : 0, averageMs: entry.invocations > 0 ? entry.cpuMs / entry.invocations : undefined }))
    .sort((left, right) => right.cpuMs - left.cpuMs || left.route.localeCompare(right.route));
}

export interface StatementRow {
  readonly statement: string;
  readonly queries: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly cost: number;
}

export function statementRows(history: ProjectMetricHistory, view: TimeWindow | null): StatementRow[] {
  const statements = new Set(history.series.map(entry => entry.metric.slice("d1q.".length, entry.metric.lastIndexOf("."))));
  return [...statements]
    .map(statement => {
      const rowsRead = seriesTotal(history, `d1q.${statement}.rowsRead`, view);
      const rowsWritten = seriesTotal(history, `d1q.${statement}.rowsWritten`, view);
      return {
        statement,
        queries: seriesTotal(history, `d1q.${statement}.queries`, view),
        rowsRead,
        rowsWritten,
        cost: (rowsWritten * LIST_PRICE_PER_MILLION.d1RowsWritten + rowsRead * LIST_PRICE_PER_MILLION.d1RowsRead) / 1_000_000
      };
    })
    .sort((left, right) => right.cost - left.cost || left.statement.localeCompare(right.statement));
}

export interface CostPart {
  readonly label: string;
  readonly unit: string;
  readonly points: readonly ChartPoint[];
  readonly usage: readonly ChartPoint[];
}

function costPart(label: string, unit: string, usage: readonly ChartPoint[], pricePerMillion: number): CostPart {
  return { label, unit, usage, points: scaled(usage, pricePerMillion / 1_000_000) };
}

export function costParts(data: ProjectData): CostPart[] {
  const parts = [
    costPart("Worker requests", "requests", metricPoints(data.worker, "worker.invocations"), LIST_PRICE_PER_MILLION.workerRequests),
    costPart("Worker CPU", "CPU ms", metricPoints(data.worker, "worker.cpuMsSum"), LIST_PRICE_PER_MILLION.workerCpuMs)
  ];
  if (data.durableObjects !== undefined) {
    parts.push(costPart("Durable Object requests", "requests", metricPoints(data.durableObjects, "do.invocations"), LIST_PRICE_PER_MILLION.durableObjectRequests));
  }
  if (data.d1 !== undefined) {
    parts.push(costPart("D1 rows written", "rows", metricPoints(data.d1, "d1.rowsWritten"), LIST_PRICE_PER_MILLION.d1RowsWritten));
    parts.push(costPart("D1 rows read", "rows", metricPoints(data.d1, "d1.rowsRead"), LIST_PRICE_PER_MILLION.d1RowsRead));
  }
  return parts;
}

export function totalIn(points: readonly ChartPoint[], view: TimeWindow | null): number {
  let total = 0;
  for (const point of pointsIn(points, view)) total += point.value ?? 0;
  return total;
}

export function durableObjectCpuAverage(history: ProjectMetricHistory): ChartPoint[] {
  return ratio(metricPoints(history, "do.cpuMsSum"), metricPoints(history, "do.invocations"), 1, MIN_SCORED_EVENTS);
}

export function durableObjectWallAverage(history: ProjectMetricHistory): ChartPoint[] {
  return ratio(metricPoints(history, "do.wallMsSum"), metricPoints(history, "do.invocations"), 1, MIN_SCORED_EVENTS);
}

export function otherShare(data: ProjectData): ChartPoint[] {
  const total = addAll(R2_OUTCOMES.map(outcome => bucketOutcome(data, outcome)));
  return ratio(bucketOutcome(data, "other"), total, 100, MIN_SCORED_EVENTS);
}

export function probeUp(data: ProjectData): ChartPoint[][] {
  const history = data.probes;
  return history === undefined ? [] : data.probeNames.map(name => metricPoints(history, `probe.${name}.up`));
}

function collectedAgo(value: number | undefined): string {
  return value === undefined ? count(value) : value < 1 ? "just now" : `${minutes(Math.round(value))} ago`;
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
  readonly settledBeforeMs?: number;
  readonly detail?: string;
}

export function buildProjectCells(data: ProjectData, view: TimeWindow | null): MonitorCell[] {
  const stepMs = data.worker.stepMs;
  const workerSettled = provisionalFromMs(data.worker);
  const specs: Spec[] = [
    { id: "requests", label: "Requests", anchor: "requests", limits: undefined, points: metricPoints(data.worker, "worker.invocations"), format: count, settledBeforeMs: workerSettled },
    { id: "server-errors", label: "Worker 5xx", anchor: "status", limits: LIMITS.workerServerErrorPercent, points: serverErrorShare(data), format: percent },
    { id: "cpu-time", label: "CPU time", anchor: "cpu", limits: LIMITS.workerCpuMs, points: cpuAverage(data), format: milliseconds },
    ...(data.buckets.length === 0
      ? []
      : [
          { id: "r2-other", label: "R2 failures", anchor: "r2-operations", limits: LIMITS.r2OtherPercent, points: otherShare(data), format: percent },
          { id: "r2-storage", label: "R2 storage", anchor: "r2-storage", limits: undefined, points: bucketGauge(data, "storageBytes"), format: bytes }
        ]),
    { id: "collector", label: "Collector", anchor: "collector", limits: LIMITS.collectorStaleMinutes, points: data.silence, format: collectedAgo, detail: `longest gap ${minutes(Math.round(Math.max(0, ...data.silence.map(point => point.value ?? 0))))} · stale after ${LIMITS.collectorStaleMinutes.elevated} min` }
  ];
  const ups = probeUp(data);
  if (ups.length > 0) {
    specs.splice(specs.length - 1, 0, { id: "endpoints", label: "Endpoints", anchor: "endpoints", limits: LIMITS.probeUp, points: weakest(ups), parts: ups, format: endpointText, detail: `${ups.length} probed from the edge` });
  }
  return specs.map(spec => {
    const windowed = spec.id === "collector" ? spec.points : pointsIn(spec.points, view);
    const parts = spec.parts === undefined ? [windowed] : spec.parts.map(part => pointsIn(part, view));
    const monitored = monitorOne({ id: spec.id, label: spec.label, anchor: spec.anchor, limits: spec.limits, series: parts, stepMs: spec.id === "collector" ? undefined : stepMs });
    const spark = spec.settledBeforeMs === undefined ? windowed : windowed.filter(point => point.atMs < spec.settledBeforeMs!);
    const arriving = spec.settledBeforeMs !== undefined && windowed.some(point => point.atMs >= spec.settledBeforeMs! && point.value !== undefined);
    return { id: spec.id, label: spec.label, anchor: spec.anchor, monitored, spark, format: spec.format, value: lastValue(spark), detail: spec.detail !== undefined ? spec.detail : arriving ? `${rangeText(spark, spec.format, spec.limits)} · newest still arriving` : rangeText(spark, spec.format, spec.limits), limits: spec.limits, hue: CELL_HUES[spec.id] ?? "neutral" };
  });
}
