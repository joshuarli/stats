import type { RuntimeCapabilities } from "../../../core/capabilities.ts";
import type { ApplicationTelemetry, ApplicationTotals } from "../../../observe/application/telemetry.ts";
import type { Track } from "../../columns.ts";

export function nativeProjects(capabilities: RuntimeCapabilities): boolean {
  return capabilities.applicationEvents && !capabilities.analyticsCollection && !capabilities.cloudflareDeployments && !capabilities.tailEvents;
}

export function applicationTrack(data: ApplicationTelemetry, measure: (bucket: ApplicationTotals) => number | null): Track {
  const buckets = new Map(data.buckets.map(bucket => [bucket.atMs, bucket]));
  const times = Array.from({ length: Math.ceil((data.toMs - data.fromMs) / data.stepMs) }, (_, index) => data.fromMs + index * data.stepMs);
  return { times, values: times.map(atMs => { const bucket = buckets.get(atMs); return bucket === undefined ? null : measure(bucket); }) };
}
