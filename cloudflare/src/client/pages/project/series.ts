import { windowIndexes, windowTracks, type TimeWindow } from "../../chart-data";
import type { Cells, Track } from "../../columns";
import { bytes, count, milliseconds, minutes, percent } from "../../format";
import { metricTrack, type CollectorHistory, type MetricHistory } from "../../history";
import { LIMITS, MIN_SCORED_EVENTS, type Limits } from "../../health";
import { monitorState } from "../../monitoring";
import { addAll, holdLast, ratio, scaled } from "./math";
import { LIST_PRICE_PER_MILLION } from "../../pricing";
import { PROJECT_SETTLE_MS } from "../../../limits";
import { lastValue } from "../../metrics";
import { rangeText, type MonitorCell } from "../host/monitors";

const MINUTE_MS = 60_000;
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "other"] as const;
const ROUTE_PREFIX = "route.";
const R2_OUTCOMES = ["success", "userError", "other"] as const;

export function provisionalFromMs(history: MetricHistory): number {
  const cutoff = history.toMs - history.stepMs - PROJECT_SETTLE_MS;
  return history.fromMs + (Math.floor((cutoff - history.fromMs) / history.stepMs) + 1) * history.stepMs;
}

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

function bucketGauge(data: ProjectData, suffix: "storageBytes" | "objects"): Track {
  return addAll(data.buckets.map(bucket => holdLast(metricTrack(data.r2, r2Metric(bucket, suffix)))));
}

export function serverErrorShare(data: ProjectData): Track {
  return ratio(metricTrack(data.worker, "worker.status.5xx"), metricTrack(data.worker, "worker.invocations"), 100, MIN_SCORED_EVENTS);
}

export function cpuAverage(data: ProjectData): Track {
  return ratio(metricTrack(data.worker, "worker.cpuMsSum"), metricTrack(data.worker, "worker.invocations"), 1, MIN_SCORED_EVENTS);
}

export interface RouteRow {
  readonly route: string;
  readonly invocations: number;
  readonly cpuMs: number;
  readonly cpuShare: number;
  readonly averageMs: number | undefined;
}

function seriesTotal(history: MetricHistory, metric: string, view: TimeWindow | null): number {
  return totalIn(metricTrack(history, metric), view);
}

export function routeRows(history: MetricHistory, view: TimeWindow | null): RouteRow[] {
  const routes = new Set(history.table.names().map(metric => metric.slice(ROUTE_PREFIX.length, metric.lastIndexOf("."))));
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

export function statementRows(history: MetricHistory, view: TimeWindow | null): StatementRow[] {
  const statements = new Set(history.table.names().map(metric => metric.slice("d1q.".length, metric.lastIndexOf("."))));
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
  readonly points: Track;
  readonly usage: Track;
}

function costPart(label: string, unit: string, usage: Track, pricePerMillion: number): CostPart {
  return { label, unit, usage, points: scaled(usage, pricePerMillion / 1_000_000) };
}

export function costParts(data: ProjectData): CostPart[] {
  const parts = [
    costPart("Worker requests", "requests", metricTrack(data.worker, "worker.invocations"), LIST_PRICE_PER_MILLION.workerRequests),
    costPart("Worker CPU", "CPU ms", metricTrack(data.worker, "worker.cpuMsSum"), LIST_PRICE_PER_MILLION.workerCpuMs)
  ];
  if (data.durableObjects !== undefined) {
    parts.push(costPart("Durable Object requests", "requests", metricTrack(data.durableObjects, "do.invocations"), LIST_PRICE_PER_MILLION.durableObjectRequests));
  }
  if (data.d1 !== undefined) {
    parts.push(costPart("D1 rows written", "rows", metricTrack(data.d1, "d1.rowsWritten"), LIST_PRICE_PER_MILLION.d1RowsWritten));
    parts.push(costPart("D1 rows read", "rows", metricTrack(data.d1, "d1.rowsRead"), LIST_PRICE_PER_MILLION.d1RowsRead));
  }
  return parts;
}

export function totalIn(track: Track, view: TimeWindow | null): number {
  const [first, last] = windowIndexes(track.times, view);
  let total = 0;
  for (let index = first; index <= last; index += 1) total += track.values[index] ?? 0;
  return total;
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

function collectedAgo(value: number | undefined): string {
  return value === undefined ? count(value) : value < 1 ? "just now" : `${minutes(Math.round(value))} ago`;
}

export function endpointText(value: number | undefined): string {
  return value === undefined ? count(value) : value >= 1 ? "all up" : "down";
}

function weakest(series: readonly Track[]): Track {
  const first = series[0];
  if (first === undefined) return { times: [], values: [] };
  const values = first.times.map((_, index) => {
    let lowest: number | null = null;
    for (const track of series) {
      const value = track.values[index];
      if (value !== undefined && value !== null && (lowest === null || value < lowest)) lowest = value;
    }
    return lowest;
  });
  return { times: first.times, values };
}

export function hasAnyValue(...series: readonly Track[]): boolean {
  return series.some(track => track.values.some(value => value !== null));
}

interface Spec {
  readonly id: string;
  readonly parts?: readonly Track[];
  readonly label: string;
  readonly anchor: string;
  readonly limits: Limits | undefined;
  readonly points: Track;
  readonly format: (value: number | undefined) => string;
  readonly settledBeforeMs?: number;
  readonly detail?: string;
}

function settledPrefix(track: Track, settledBeforeMs: number): Cells {
  const unsettled = track.times.findIndex(time => time >= settledBeforeMs);
  return unsettled === -1 ? track.values : track.values.slice(0, unsettled);
}

export function buildProjectCells(data: ProjectData, view: TimeWindow | null): MonitorCell[] {
  const stepMs = data.worker.stepMs;
  const workerSettled = provisionalFromMs(data.worker);
  const specs: Spec[] = [
    { id: "requests", label: "Requests", anchor: "requests", limits: undefined, points: metricTrack(data.worker, "worker.invocations"), format: count, settledBeforeMs: workerSettled },
    { id: "server-errors", label: "Worker 5xx", anchor: "status", limits: LIMITS.workerServerErrorPercent, points: serverErrorShare(data), format: percent },
    { id: "cpu-time", label: "CPU time", anchor: "worker-cpu", limits: LIMITS.workerCpuMs, points: cpuAverage(data), format: milliseconds },
    ...(data.buckets.length === 0
      ? []
      : [
          { id: "r2-other", label: "R2 failures", anchor: "r2-operations", limits: LIMITS.r2OtherPercent, points: otherShare(data), format: percent },
          { id: "r2-storage", label: "R2 storage", anchor: "r2-storage", limits: undefined, points: bucketGauge(data, "storageBytes"), format: bytes }
        ]),
    { id: "collector", label: "Collector", anchor: "collector", limits: LIMITS.collectorStaleMinutes, points: data.silence, format: collectedAgo, detail: `longest gap ${minutes(Math.round(Math.max(0, ...data.silence.values.map(value => value ?? 0))))}` }
  ];
  const ups = probeUp(data);
  if (ups.length > 0) {
    specs.splice(specs.length - 1, 0, { id: "endpoints", label: "Endpoints", anchor: "endpoints", limits: LIMITS.probeUp, points: weakest(ups), parts: ups, format: endpointText, detail: `${ups.length} probed from the edge` });
  }
  return specs.map(spec => {
    const [windowed] = spec.id === "collector" ? [spec.points] : windowTracks([spec.points], view);
    const parts = spec.parts === undefined ? [windowed!] : spec.id === "collector" ? [...spec.parts] : windowTracks(spec.parts, view);
    const monitored = monitorState({ limits: spec.limits, series: parts, stepMs: spec.id === "collector" ? undefined : stepMs });
    const spark = spec.settledBeforeMs === undefined ? windowed!.values : settledPrefix(windowed!, spec.settledBeforeMs);
    const arriving = spec.settledBeforeMs !== undefined && windowed!.times.some((time, index) => time >= spec.settledBeforeMs! && windowed!.values[index] !== null);
    return { id: spec.id, label: spec.label, anchor: spec.anchor, state: monitored, spark, format: spec.format, value: lastValue(spark), detail: spec.detail !== undefined ? spec.detail : arriving ? `${rangeText(spark, spec.format)} · newest still arriving` : rangeText(spark, spec.format), limits: spec.limits };
  });
}
