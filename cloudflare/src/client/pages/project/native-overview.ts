import type { ApplicationSummary, ApplicationTotals } from "../../../observe/application/telemetry.ts";
import { applicationTrack } from "./native-series.ts";

export function operationLabel(operation: string): string {
  const match = /^http\.([a-z]+)\.(.+)$/u.exec(operation);
  if (match !== null) return `${match[1]!.toUpperCase()} ${match[2]!.replaceAll("-", " ")}`;
  return operation.replaceAll(".", " ").replaceAll("_", " ");
}

export function applicationOverview(data: ApplicationSummary) {
  const totals = data.totals;
  const http = (totals?.requests ?? 0) > 0;
  const events = totals?.events ?? 0;
  const failed = (totals?.failed ?? 0) - (totals?.cancelled ?? 0);
  if (failed < 0) throw new RangeError("cancellations exceed unsuccessful events");
  const count = http ? totals!.requests : events;
  const duration = (bucket: ApplicationTotals) => http ? bucket.requestDurationMsSum : bucket.durationMsSum;
  const measured = (bucket: ApplicationTotals) => http ? bucket.requests : bucket.events;
  const traffic = applicationTrack(data, bucket => measured(bucket) * 60_000 / Math.min(data.stepMs, data.toMs - bucket.atMs));
  const failures = applicationTrack(data, bucket => http ? bucket.requests === 0 ? null : bucket.status5xx : bucket.failed - bucket.cancelled);
  const mean = applicationTrack(data, bucket => measured(bucket) === 0 ? null : duration(bucket) / measured(bucket));
  const maximum = applicationTrack(data, bucket => measured(bucket) === 0 ? null : http ? bucket.requestDurationMsMax : bucket.durationMsMax);
  const ranked = data.operations.filter(operation => http ? operation.requests > 0 : operation.events > 0).map(operation => ({
    operation: operation.operation,
    label: operationLabel(operation.operation),
    count: measured(operation),
    wallMs: duration(operation),
    meanMs: duration(operation) / measured(operation),
    failures: http ? operation.status5xx : operation.failed - operation.cancelled
  })).sort((left, right) => right.wallMs - left.wallMs || left.operation.localeCompare(right.operation));
  const peak = ranked[0]?.wallMs ?? 0;
  return {
    http, events, failed, count,
    failures: http ? totals?.status5xx ?? 0 : failed,
    errorPercent: http && totals !== null ? totals.status5xx / totals.requests * 100 : null,
    meanMs: totals === null || count === 0 ? null : duration(totals) / count,
    maxMs: totals === null || count === 0 ? null : http ? totals.requestDurationMsMax : totals.durationMsMax,
    traffic, failureTrack: failures, mean, maximum,
    needsAttention: data.openIssues > 0 || failed > 0 || (totals?.status5xx ?? 0) > 0,
    operations: ranked.slice(0, 5).map(operation => ({ ...operation, widthPercent: peak === 0 ? 0 : operation.wallMs / peak * 100 })),
    omittedOperations: Math.max(0, ranked.length - 5),
    truncatedOperations: data.moreOperations
  };
}
