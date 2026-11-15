import type { RuntimeCapabilities } from "../../../core/capabilities.ts";
import type { ApplicationSummary, ApplicationTotals } from "../../../observe/application/telemetry.ts";
import type { Track } from "../../columns.ts";

export function nativeProjects(capabilities: RuntimeCapabilities): boolean {
  return capabilities.projectSource === "services";
}

export function applicationTrack(data: ApplicationSummary, measure: (bucket: ApplicationTotals & { readonly atMs: number }) => number | null): Track {
  const buckets = new Map(data.buckets.map(bucket => [bucket.atMs, bucket]));
  const times = Array.from({ length: Math.ceil((data.toMs - data.fromMs) / data.stepMs) }, (_, index) => data.fromMs + index * data.stepMs);
  return { times, values: times.map(atMs => { const bucket = buckets.get(atMs); return bucket === undefined ? null : measure(bucket); }) };
}
