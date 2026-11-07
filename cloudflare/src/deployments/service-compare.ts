import { combineRollups, rollupPoints, serviceLevels, type NetPoint, type DiskPoint, type RollupPayload, type Series, type SummaryPoint } from "../aggregate.ts";
import { MINUTE_MS } from "../limits.ts";
import type { ExternalEventRecord } from "../observe/ingest/model.ts";
import { bucketRows, DEPLOYMENT_BUCKET_MS, gateDeployment, judge, presentMean, type Buckets, type ComparisonWindow, type DeploymentComparison, type MetricComparison, type MetricReasonCode, type MetricRow, type WindowBounds } from "./compare.ts";
import type { Deployment } from "./model.ts";

export const SERVICE_SETTLE_MS = 15 * MINUTE_MS;
export const SERVICE_PROBE_NAME = "health";
export const MIN_BUCKET_COVERAGE_MS = 150_000;
export const SUCCESSFUL_OUTCOME = "ok";

export const SERVICE_COMPARISON_CAVEAT = "Resource levels and per-work ratios are descriptive, not causal. A per-work ratio is shown only when the resource is attributable and the work counter is complete; otherwise it is unavailable. Service CPU and I/O per work unit divide by observed work: producer drops, rejected batches and sequence gaps are not recorded, so completion is unproven.";

export type WorkMetricKind = "application.duration" | "application.failure" | "application.durationPerWork" | "application.cpuPerWork" | "application.ioPerWork";

export interface WorkMetricDefinition {
  readonly metric: WorkMetricKind;
  readonly label: string;
  readonly unit: string;
  readonly floor: number;
  readonly needsWork: boolean;
}

export const SERVICE_WORK_METRICS: readonly WorkMetricDefinition[] = [
  { metric: "application.duration", label: "Application duration per successful event", unit: "ms", floor: 1, needsWork: false },
  { metric: "application.failure", label: "Application failure share", unit: "%", floor: 1, needsWork: false },
  { metric: "application.durationPerWork", label: "Application duration per work unit", unit: "ms", floor: 0.01, needsWork: true },
  { metric: "application.cpuPerWork", label: "Service CPU per work unit", unit: "CPU-s", floor: 0.0001, needsWork: true },
  { metric: "application.ioPerWork", label: "Service I/O per work unit", unit: "B", floor: 1, needsWork: true }
];

export function applicationMetricName(metric: WorkMetricKind, operation: string, work?: string): string {
  if (metric === "application.duration") return `application.${operation}.duration`;
  if (metric === "application.failure") return `application.${operation}.failure`;
  if (work === undefined) throw new Error("a per-work metric needs a work key");
  const suffix = metric === "application.durationPerWork" ? "duration" : metric === "application.cpuPerWork" ? "cpu" : "io";
  return `application.${operation}.${work}.${suffix}`;
}

export interface WorkBucket {
  readonly atMs: number;
  readonly successes: number;
  readonly failures: number;
}

export interface WorkMeasurement {
  readonly key: string;
  readonly total: number;
  readonly complete: boolean;
  readonly durationPerUnitMs: number | null;
  readonly cpuPerUnit: number | null;
  readonly ioPerUnit: number | null;
  readonly reason: string | null;
}

export interface WorkSide {
  readonly successes: number;
  readonly failures: number;
  readonly failureRate: number | null;
  readonly meanDurationMs: number | null;
  readonly throughputPerMinute: number | null;
  readonly work: readonly WorkMeasurement[];
  readonly buckets: readonly WorkBucket[];
}

export interface WorkSummary {
  readonly operation: string;
  readonly before: WorkSide;
  readonly after: WorkSide;
}

export interface MinuteRollup {
  readonly bucketMs: number;
  readonly payload: RollupPayload;
}

export type SourceName = "hosts" | "cgroup" | "probe" | "application";
export const SOURCE_NAMES: readonly SourceName[] = ["hosts", "cgroup", "probe", "application"];

export interface SourceStatus {
  readonly source: SourceName;
  readonly status: "available" | "unavailable";
  readonly detail: string;
}

export type ApplicationSuppressionCode = Extract<MetricReasonCode, "application-truncated" | "application-unavailable">;

export interface ApplicationSuppression {
  readonly code: ApplicationSuppressionCode;
  readonly detail: string;
}

export const UNRECORDED_COVERAGE_EVIDENCE = ["producer-drops", "rejected-batches", "sequence-gaps"] as const;
export type UnrecordedCoverageEvidence = typeof UNRECORDED_COVERAGE_EVIDENCE[number];

export interface WindowCoverage {
  readonly buckets: number;
  readonly bucketsWithEvents: number;
  readonly emptyBucketsWhileUp: number;
  readonly completeness: "unproven" | "gaps-observed";
  readonly unrecorded: readonly UnrecordedCoverageEvidence[];
}

export interface ApplicationCoverage {
  readonly before: WindowCoverage;
  readonly after: WindowCoverage;
}

export interface ServiceComparison extends DeploymentComparison {
  readonly hostIds: readonly string[];
  readonly sources: readonly SourceStatus[];
  readonly work: readonly WorkSummary[];
  readonly applicationSuppression: ApplicationSuppression | null;
  readonly applicationCoverage: ApplicationCoverage | null;
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

export function hostLevelRows(service: string, hostIds: readonly string[], rollupsOf: (hostId: string) => readonly MinuteRollup[]): MetricRow[] {
  const perHost = hostIds.map(hostId => {
    const grouped = new Map<number, RollupPayload[]>();
    for (const rollup of rollupsOf(hostId)) {
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
  readonly hostRollups: (hostId: string) => readonly MinuteRollup[];
  readonly probeRows: readonly MetricRow[];
  readonly hasHealthUrl: boolean;
  readonly window: ComparisonWindow;
  readonly now: number;
  readonly truncated: boolean;
  readonly applicationEvents?: readonly ExternalEventRecord[];
  readonly applicationTruncated?: boolean;
  readonly applicationProblem?: string | null;
}

interface WorkBucketAccumulator {
  atMs: number;
  successes: number;
  failures: number;
}

interface WorkAccumulator {
  successes: number;
  failures: number;
  durationMs: number;
  work: Map<string, { present: number; total: number }>;
  buckets: Map<number, WorkBucketAccumulator>;
}

function summarizeWorkSide(events: readonly ExternalEventRecord[], bounds: WindowBounds, cpuCores: number | null, ioBytesPerSec: number | null, coverage: WindowCoverage): Map<string, WorkSide> {
  const byOperation = new Map<string, WorkAccumulator>();
  for (const record of events) {
    const event = record.event;
    if (event.atMs < bounds.fromMs || event.atMs >= bounds.toMs) continue;
    const operation: WorkAccumulator = byOperation.get(event.operation) ?? {
      successes: 0, failures: 0, durationMs: 0, work: new Map<string, { present: number; total: number }>(), buckets: new Map<number, WorkBucketAccumulator>()
    };
    const success = event.outcome === SUCCESSFUL_OUTCOME;
    const bucketAt = Math.floor(event.atMs / DEPLOYMENT_BUCKET_MS) * DEPLOYMENT_BUCKET_MS;
    const bucket: WorkBucketAccumulator = operation.buckets.get(bucketAt) ?? { atMs: bucketAt, successes: 0, failures: 0 };
    if (success) {
      operation.successes += 1;
      operation.durationMs += event.durationMs;
      bucket.successes += 1;
      for (const [key, value] of Object.entries(event.work)) {
        const count: { present: number; total: number } = operation.work.get(key) ?? { present: 0, total: 0 };
        count.present += 1;
        count.total += value;
        operation.work.set(key, count);
      }
    } else {
      operation.failures += 1;
      bucket.failures += 1;
    }
    operation.buckets.set(bucketAt, bucket);
    byOperation.set(event.operation, operation);
  }
  const successfulOperations = [...byOperation].filter(([, value]) => value.successes > 0);
  const seconds = (bounds.toMs - bounds.fromMs) / 1000;
  const minimumMinutes = (bounds.toMs - bounds.fromMs) / 60_000;
  return new Map([...byOperation].map(([operation, value]) => {
    const keys = [...value.work].map(([key, count]) => {
      const complete = value.successes > 0 && count.present === value.successes && count.total > 0;
      const reasons: string[] = [];
      if (value.successes === 0) reasons.push("no successful events");
      else if (count.present !== value.successes) reasons.push(`the work counter is incomplete: ${count.present} of ${value.successes} successful events reported ${key}`);
      else if (count.total === 0) reasons.push(`no ${key} work units were reported`);
      if (successfulOperations.length !== 1) reasons.push(`the service cgroup covers ${successfulOperations.length} operations`);
      const gapped = coverage.completeness === "gaps-observed";
      if (gapped) reasons.push(`${coverage.emptyBucketsWhileUp} of ${coverage.buckets} five-minute buckets had no application events while the service was up`);
      if (cpuCores === null) reasons.push("the service cgroup reported no CPU level in this window");
      if (ioBytesPerSec === null) reasons.push("the service cgroup reported no I/O level in this window");
      const perUnit = complete ? value.durationMs / count.total : null;
      return {
        key, total: count.total, complete,
        durationPerUnitMs: perUnit,
        cpuPerUnit: complete && !gapped && successfulOperations.length === 1 && cpuCores !== null ? cpuCores * seconds / count.total : null,
        ioPerUnit: complete && !gapped && successfulOperations.length === 1 && ioBytesPerSec !== null ? ioBytesPerSec * seconds / count.total : null,
        reason: reasons.length === 0 ? null : reasons.join("; ")
      };
    });
    const total = value.successes + value.failures;
    return [operation, {
      successes: value.successes,
      failures: value.failures,
      failureRate: total === 0 ? null : value.failures / total * 100,
      meanDurationMs: value.successes === 0 ? null : value.durationMs / value.successes,
      throughputPerMinute: minimumMinutes === 0 ? null : total / minimumMinutes,
      work: keys.sort((left, right) => left.key.localeCompare(right.key)),
      buckets: [...value.buckets.values()].sort((left, right) => left.atMs - right.atMs)
    }];
  }));
}

function serviceUp(buckets: Buckets, atMs: number): boolean {
  const bucket = buckets.get(atMs);
  return (bucket?.get(`probe.${SERVICE_PROBE_NAME}.up`) ?? 0) > 0 || bucket?.has("service.cpu") === true;
}

function windowCoverage(events: readonly ExternalEventRecord[], bounds: WindowBounds, buckets: Buckets): WindowCoverage {
  const withEvents = new Set<number>();
  for (const record of events) {
    if (record.event.atMs >= bounds.fromMs && record.event.atMs < bounds.toMs) withEvents.add(Math.floor(record.event.atMs / DEPLOYMENT_BUCKET_MS) * DEPLOYMENT_BUCKET_MS);
  }
  let total = 0, empty = 0;
  for (let at = bounds.fromMs; at < bounds.toMs; at += DEPLOYMENT_BUCKET_MS) {
    total += 1;
    if (!withEvents.has(at) && serviceUp(buckets, at)) empty += 1;
  }
  return { buckets: total, bucketsWithEvents: withEvents.size, emptyBucketsWhileUp: empty, completeness: empty > 0 ? "gaps-observed" : "unproven", unrecorded: UNRECORDED_COVERAGE_EVIDENCE };
}

function comparisonReason(before: WorkMeasurement | undefined, after: WorkMeasurement | undefined): string | undefined {
  const sides = [before?.reason === null ? undefined : before?.reason, after?.reason === null ? undefined : after?.reason].filter((reason): reason is string => reason !== undefined);
  if (sides.length === 0) return undefined;
  return [...new Set(sides)].join("; ");
}

function workMetric(metric: string, label: string, unit: string, before: number | null, after: number | null, floor: number, blocked: boolean): MetricComparison {
  return { metric, label, unit, before, after, ...judge(before, after, floor, blocked) };
}

function workMetrics(work: readonly WorkSummary[], blocked: boolean, coverage: ApplicationCoverage, unavailableReason?: string): MetricComparison[] {
  const metrics: MetricComparison[] = [];
  const gapped = coverage.before.completeness === "gaps-observed" || coverage.after.completeness === "gaps-observed";
  const add = (metric: string, label: string, unit: string, before: number | null, after: number | null, floor: number, reason?: string, perObservedWork = false) => {
    const unavailable = unavailableReason === undefined ? undefined : `comparison windows are not comparable: ${unavailableReason}`;
    const compared = workMetric(metric, label, unit, unavailable === undefined ? before : null, unavailable === undefined ? after : null, floor, blocked);
    const detail = unavailable ?? reason;
    metrics.push({
      ...compared,
      ...(detail === undefined ? {} : { reason: detail }),
      ...(perObservedWork ? { basis: "observed-work" as const } : {}),
      ...(perObservedWork && gapped && unavailable === undefined ? { reasonCode: "application-gap" as const } : {})
    });
  };
  for (const summary of work) {
    const operation = summary.operation;
    add(applicationMetricName("application.duration", operation), `${operation} duration per successful event`, "ms", summary.before.meanDurationMs, summary.after.meanDurationMs, 1);
    add(applicationMetricName("application.failure", operation), `${operation} failure share`, "%", summary.before.failureRate, summary.after.failureRate, 1);
    const keys = [...new Set([...summary.before.work, ...summary.after.work].map(item => item.key))].sort();
    for (const key of keys) {
      const before = summary.before.work.find(item => item.key === key);
      const after = summary.after.work.find(item => item.key === key);
      const reason = comparisonReason(before, after);
      add(applicationMetricName("application.durationPerWork", operation, key), `${operation} duration per ${key}`, `ms/${key}`, before?.durationPerUnitMs ?? null, after?.durationPerUnitMs ?? null, 0.01, reason);
      add(applicationMetricName("application.cpuPerWork", operation, key), `${operation} service CPU per observed ${key}`, `CPU-s/${key}`, before?.cpuPerUnit ?? null, after?.cpuPerUnit ?? null, 0.0001, reason, true);
      add(applicationMetricName("application.ioPerWork", operation, key), `${operation} service I/O per observed ${key}`, `B/${key}`, before?.ioPerUnit ?? null, after?.ioPerUnit ?? null, 1, reason, true);
    }
  }
  return metrics;
}

function sourceStatuses(input: ServiceComparisonInput, suppression: ApplicationSuppression | null, metrics: readonly MetricComparison[], work: readonly WorkSummary[], coverage: ApplicationCoverage | null): SourceStatus[] {
  const measured = (source: SourceName) => SERVICE_LEVEL_METRICS.filter(entry => entry.source === source && metrics.some(metric => metric.metric === entry.metric && metric.before !== null && metric.after !== null));
  const hosts = `${input.hostIds.length} ${input.hostIds.length === 1 ? "host" : "hosts"}`;
  const cgroup = measured("cgroup");
  const successes = work.reduce((total, summary) => total + summary.before.successes + summary.after.successes, 0);
  const applicationMeasured = metrics.some(metric => metric.metric.startsWith("application.") && metric.before !== null && metric.after !== null);
  const gaps = coverage !== null && (coverage.before.completeness === "gaps-observed" || coverage.after.completeness === "gaps-observed");
  const application = suppression !== null
    ? { source: "application" as const, status: "unavailable" as const, detail: suppression.detail }
    : work.length === 0
      ? { source: "application" as const, status: "unavailable" as const, detail: "No application events were reported in either window." }
      : !applicationMeasured
        ? { source: "application" as const, status: "unavailable" as const, detail: "Per-work ratios are unavailable because the comparison windows are not comparable." }
        : { source: "application" as const, status: "available" as const, detail: `${successes} successful events across ${work.length} ${work.length === 1 ? "operation" : "operations"}; per observed work, ${gaps ? "gaps seen" : "drops and gaps not recorded"}` };
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
        : { source: "probe", status: "unavailable", detail: "No probe results in both windows." },
    application
  ];
}

function applicationSuppression(input: ServiceComparisonInput): ApplicationSuppression | null {
  if (input.applicationProblem !== null && input.applicationProblem !== undefined) return { code: "application-unavailable", detail: `Application telemetry unavailable: ${input.applicationProblem}` };
  if (input.applicationTruncated === true) return { code: "application-truncated", detail: "Application telemetry was truncated for this window; partial events are withheld." };
  return null;
}

const EMPTY_WORK_SIDE: WorkSide = { successes: 0, failures: 0, failureRate: null, meanDurationMs: null, throughputPerMinute: null, work: [], buckets: [] };

/** Descriptive comparison of resource levels and per-work application ratios around a pushed marker, not a causal claim. A service's cgroup series supersedes the matching host series when it has values in both windows; the host rows stay in the response, marked supersededBy and listed after the rest. A cgroup resource is divided by work only when one operation owns the service's successful events in that window. */
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
  const supersededBy = (metric: string) => {
    const replacement = replacementFor(metric);
    return replacement !== undefined && usable.has(replacement) ? replacement : undefined;
  };
  const shown = raw.filter(({ entry }) => entry.source !== "cgroup" || usable.has(entry.metric));
  const chosen = [...shown.filter(({ entry }) => supersededBy(entry.metric) === undefined), ...shown.filter(({ entry }) => supersededBy(entry.metric) !== undefined)];
  const suppression = applicationSuppression(input);
  const events = suppression === null ? input.applicationEvents ?? [] : [];
  const coverage: ApplicationCoverage = { before: windowCoverage(events, gate.before, buckets), after: windowCoverage(events, gate.after, buckets) };
  const beforeWork = summarizeWorkSide(events, gate.before, read(gate.before, "service.cpu"), read(gate.before, "service.io"), coverage.before);
  const afterWork = summarizeWorkSide(events, gate.after, read(gate.after, "service.cpu"), read(gate.after, "service.io"), coverage.after);
  const operations = [...new Set([...beforeWork.keys(), ...afterWork.keys()])].sort();
  const work = operations.map((operation): WorkSummary => ({ operation, before: beforeWork.get(operation) ?? EMPTY_WORK_SIDE, after: afterWork.get(operation) ?? EMPTY_WORK_SIDE }));
  const workHasData = work.some(summary => summary.before.meanDurationMs !== null && summary.after.meanDurationMs !== null);
  if (usable.size === 0 && !workHasData) gate.block("no-data", "No source reported enough data in both windows; missing data is not zero.");
  const blocked = gate.reasons.length > 0;
  const levelMetrics = chosen.map(({ entry, before, after }): MetricComparison => {
    const replacement = supersededBy(entry.metric);
    return { metric: entry.metric, label: entry.label, unit: entry.unit, before, after, ...judge(before, after, entry.floor, blocked), ...(replacement === undefined ? {} : { supersededBy: replacement }) };
  });
  const metrics = [...levelMetrics, ...workMetrics(work, blocked, coverage, gate.reasons.length === 0 ? undefined : gate.reasons.join("; "))];
  const cgroupUsed = shown.some(({ entry }) => entry.source === "cgroup");
  const warnings = [
    ...gate.warnings,
    SERVICE_COMPARISON_CAVEAT,
    cgroupUsed
      ? "Host metrics include every process on the host; cgroup metrics cover only the processes in the service's unit. Heuristic signals, not significance tests or proof of causation."
      : "Host rollups include every process on the host, not only this service. Heuristic signals, not significance tests or proof of causation.",
    "Application latency is measured by the application; a successful event has outcome \"ok\". Application work counts are the application's own measurements, and a missing key makes that ratio unavailable. Service CPU and I/O per work unit are per observed work: producer drops, rejected batches and sequence gaps are not recorded, and a five-minute bucket with no events while the service was up withholds them.",
    "Probe times are not user-request latency."
  ];
  return {
    deploymentId: input.deployment.id, window: input.window, before: gate.before, after: gate.after, readyAtMs: gate.readyAtMs,
    beforeInvocations: null, afterInvocations: null, spec: gate.spec, reasons: gate.reasons, reasonCodes: gate.reasonCodes, deferredObjects: false,
    analyticsInvocations: { before: [], after: [] }, warnings, metrics, hostIds: input.hostIds, sources: sourceStatuses(input, suppression, metrics, work, suppression === null ? coverage : null), work,
    applicationSuppression: suppression, applicationCoverage: suppression === null ? coverage : null
  };
}
