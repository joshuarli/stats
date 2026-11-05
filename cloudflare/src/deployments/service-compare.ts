import { combineRollups, rollupPoints, serviceLevels, type NetPoint, type DiskPoint, type RollupPayload, type Series, type SummaryPoint } from "../aggregate.ts";
import { MINUTE_MS } from "../limits.ts";
import { bucketRows, DEPLOYMENT_BUCKET_MS, gateDeployment, judge, presentMean, type ComparisonWindow, type DeploymentComparison, type MetricComparison, type MetricRow, type WindowBounds } from "./compare.ts";
import type { Deployment } from "./model.ts";

export const SERVICE_SETTLE_MS = 15 * MINUTE_MS;
export const SERVICE_PROBE_NAME = "health";
export const MIN_BUCKET_COVERAGE_MS = 150_000;

export const SERVICE_LEVEL_CAVEAT = "Resource levels only: a service does not report its own work counts, so this cannot show fewer resources for the same work.";

export interface MinuteRollup {
  readonly bucketMs: number;
  readonly payload: RollupPayload;
}

export type SourceName = "hosts" | "cgroup" | "probe";
export const SOURCE_NAMES: readonly SourceName[] = ["hosts", "cgroup", "probe"];

export interface SourceStatus {
  readonly source: SourceName;
  readonly status: "available" | "unavailable";
  readonly detail: string;
}

export interface ServiceComparison extends DeploymentComparison {
  readonly hostIds: readonly string[];
  readonly sources: readonly SourceStatus[];
}

interface LevelMetric {
  readonly metric: string;
  readonly label: string;
  readonly unit: string;
  readonly floor: number;
  readonly source: SourceName;
  readonly replaces?: string;
}

export const SERVICE_LEVEL_METRICS: readonly LevelMetric[] = [
  { metric: "host.cpu", label: "Host CPU used", unit: "%", floor: 2, source: "hosts" },
  { metric: "service.cpu", label: "Service CPU used (cgroup)", unit: "cores", floor: 0.02, source: "cgroup", replaces: "host.cpu" },
  { metric: "host.memory", label: "Host memory used", unit: "%", floor: 2, source: "hosts" },
  { metric: "service.memory", label: "Service memory used (cgroup)", unit: "B", floor: 1_048_576, source: "cgroup", replaces: "host.memory" },
  { metric: "host.pressure.cpu", label: "Host CPU pressure (some, 60 s)", unit: "%", floor: 1, source: "hosts" },
  { metric: "host.pressure.memory", label: "Host memory pressure (some, 60 s)", unit: "%", floor: 1, source: "hosts" },
  { metric: "host.pressure.io", label: "Host I/O pressure (some, 60 s)", unit: "%", floor: 1, source: "hosts" },
  { metric: "host.net", label: "Host network throughput (rx + tx, excluding lo)", unit: "B/s", floor: 1024, source: "hosts" },
  { metric: "host.disk", label: "Host disk throughput (read + write)", unit: "B/s", floor: 1024, source: "hosts" },
  { metric: "service.io", label: "Service I/O throughput (cgroup read + write)", unit: "B/s", floor: 1024, source: "cgroup", replaces: "host.disk" },
  { metric: `probe.${SERVICE_PROBE_NAME}.ms`, label: "Health probe mean response time", unit: "ms", floor: 10, source: "probe" },
  { metric: `probe.${SERVICE_PROBE_NAME}.failure`, label: "Health probe failure share", unit: "%", floor: 1, source: "probe" }
];

export function levelMetricNames(): readonly string[] {
  return SERVICE_LEVEL_METRICS.map(entry => entry.metric);
}

function sum(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

function throughput<P>(series: readonly Series<P>[], pick: (point: P) => number): number | null {
  return sum(series.flatMap(entry => entry.points.slice(0, 1).map(pick)));
}

export function replacementFor(metric: string): string | undefined {
  return SERVICE_LEVEL_METRICS.find(entry => entry.replaces === metric)?.metric;
}

function bucketLevels(payloads: readonly RollupPayload[], bucketMs: number, service: string): Map<string, number> {
  const levels = new Map<string, number>();
  const combined = combineRollups(payloads, bucketMs, DEPLOYMENT_BUCKET_MS);
  if (combined === null || combined.coverageMs < MIN_BUCKET_COVERAGE_MS) return levels;
  const summary = (rollupPoints([combined], "summary") as SummaryPoint[])[0];
  const put = (metric: string, value: number | null | undefined) => {
    if (value !== null && value !== undefined && Number.isFinite(value)) levels.set(metric, value);
  };
  if (summary?.cpu !== undefined) put("host.cpu", summary.cpu.user + summary.cpu.system);
  if (summary?.mem !== undefined && summary.mem.total > 0) put("host.memory", (summary.mem.total - summary.mem.available) / summary.mem.total * 100);
  put("host.pressure.cpu", summary?.psi?.cpu?.some60);
  put("host.pressure.memory", summary?.psi?.memory?.some60);
  put("host.pressure.io", summary?.psi?.io?.some60);
  const nets = (rollupPoints([combined], "nets") as Series<NetPoint>[]).filter(entry => entry.id !== "lo");
  put("host.net", throughput(nets, point => point.rxBytesPerSec + point.txBytesPerSec));
  const disks = rollupPoints([combined], "disks") as Series<DiskPoint>[];
  put("host.disk", throughput(disks, point => point.readBytesPerSec + point.writeBytesPerSec));
  const cgroup = serviceLevels(combined, service, MIN_BUCKET_COVERAGE_MS);
  put("service.cpu", cgroup.cpuCores);
  put("service.memory", cgroup.memoryBytes);
  put("service.io", cgroup.ioBytesPerSec);
  return levels;
}

export function hostLevelRows(service: string, hostIds: readonly string[], rollups: ReadonlyMap<string, readonly MinuteRollup[]>): MetricRow[] {
  const perHost = hostIds.map(hostId => {
    const grouped = new Map<number, RollupPayload[]>();
    for (const rollup of rollups.get(hostId) ?? []) {
      const bucketMs = Math.floor(rollup.bucketMs / DEPLOYMENT_BUCKET_MS) * DEPLOYMENT_BUCKET_MS;
      grouped.set(bucketMs, [...grouped.get(bucketMs) ?? [], rollup.payload]);
    }
    return new Map([...grouped].map(([bucketMs, payloads]) => [bucketMs, bucketLevels(payloads, bucketMs, service)] as const));
  });
  if (perHost.length === 0) return [];
  const rows: MetricRow[] = [];
  for (const bucketMs of new Set(perHost.flatMap(levels => [...levels.keys()]))) {
    for (const entry of SERVICE_LEVEL_METRICS) {
      if (entry.source === "probe") continue;
      const values = perHost.map(levels => levels.get(bucketMs)?.get(entry.metric));
      if (values.every((value): value is number => value !== undefined)) rows.push({ metric: entry.metric, bucket_ms: bucketMs, value: values.reduce((total, value) => total + value, 0) / values.length });
    }
  }
  return rows;
}

export interface ServiceComparisonInput {
  readonly service: string;
  readonly deployment: Deployment;
  readonly deployments: readonly Deployment[];
  readonly hostIds: readonly string[];
  readonly hostRollups: ReadonlyMap<string, readonly MinuteRollup[]>;
  readonly probeRows: readonly MetricRow[];
  readonly hasHealthUrl: boolean;
  readonly window: ComparisonWindow;
  readonly now: number;
  readonly truncated: boolean;
}

function sourceStatuses(input: ServiceComparisonInput, metrics: readonly MetricComparison[]): SourceStatus[] {
  const measured = (source: SourceName) => SERVICE_LEVEL_METRICS.filter(entry => entry.source === source && metrics.some(metric => metric.metric === entry.metric && metric.before !== null && metric.after !== null));
  const hosts = `${input.hostIds.length} ${input.hostIds.length === 1 ? "host" : "hosts"}`;
  const cgroup = measured("cgroup");
  return [
    measured("hosts").length > 0
      ? { source: "hosts", status: "available", detail: hosts }
      : { source: "hosts", status: "unavailable", detail: "No host reported enough rollups in both windows." },
    cgroup.length > 0
      ? { source: "cgroup", status: "available", detail: `${input.service} cgroup on ${hosts}, used for ${cgroup.map(entry => entry.metric).join(", ")}` }
      : { source: "cgroup", status: "unavailable", detail: "No host reported the service's cgroup in both windows; host metrics are used." },
    !input.hasHealthUrl
      ? { source: "probe", status: "unavailable", detail: "The service has no health URL." }
      : measured("probe").length > 0
        ? { source: "probe", status: "available", detail: "health URL" }
        : { source: "probe", status: "unavailable", detail: "No probe results in both windows." }
  ];
}

/** Descriptive comparison of resource levels around a pushed marker, not a causal claim and not work-normalised. A service's cgroup series replaces the matching host series when it has values in both windows. */
export function compareServiceDeployment(input: ServiceComparisonInput): ServiceComparison {
  const gate = gateDeployment({
    deployment: input.deployment, deployments: input.deployments, window: input.window, now: input.now, settleMs: SERVICE_SETTLE_MS,
    lastSuccessAtMs: input.now, truncated: input.truncated, enabled: true, metricsSettled: true
  });
  const buckets = bucketRows([...hostLevelRows(input.service, input.hostIds, input.hostRollups), ...input.probeRows]);
  const mean = (bounds: WindowBounds, metric: string) => presentMean(buckets, bounds, metric);
  const failure = (bounds: WindowBounds) => {
    const up = mean(bounds, `probe.${SERVICE_PROBE_NAME}.up`);
    return up === null ? null : (1 - up) * 100;
  };
  const read = (bounds: WindowBounds, metric: string) => metric === `probe.${SERVICE_PROBE_NAME}.failure` ? failure(bounds) : mean(bounds, metric);
  const raw = SERVICE_LEVEL_METRICS.map(entry => ({ entry, before: read(gate.before, entry.metric), after: read(gate.after, entry.metric) }));
  const usable = new Set(raw.filter(item => item.before !== null && item.after !== null).map(item => item.entry.metric));
  const chosen = raw.filter(({ entry }) => entry.source === "cgroup" ? usable.has(entry.metric) : !usable.has(replacementFor(entry.metric) ?? ""));
  if (usable.size === 0) gate.block("no-data", "No source reported enough data in both windows; missing data is not zero.");
  const blocked = gate.reasons.length > 0;
  const metrics = chosen.map(({ entry, before, after }): MetricComparison => ({ metric: entry.metric, label: entry.label, unit: entry.unit, before, after, ...judge(before, after, entry.floor, blocked) }));
  const cgroupUsed = chosen.some(({ entry }) => entry.source === "cgroup");
  const warnings = [
    ...gate.warnings,
    SERVICE_LEVEL_CAVEAT,
    cgroupUsed
      ? "Host metrics include every process on the host; cgroup metrics cover only the processes in the service's unit. Heuristic signals, not significance tests or proof of causation."
      : "Host rollups include every process on the host, not only this service. Heuristic signals, not significance tests or proof of causation.",
    "Probe times are not user-request latency."
  ];
  return {
    deploymentId: input.deployment.id, window: input.window, before: gate.before, after: gate.after, readyAtMs: gate.readyAtMs,
    beforeInvocations: null, afterInvocations: null, spec: gate.spec, reasons: gate.reasons, reasonCodes: gate.reasonCodes, deferredObjects: false,
    analyticsInvocations: { before: [], after: [] }, warnings, metrics, hostIds: input.hostIds, sources: sourceStatuses(input, metrics)
  };
}
