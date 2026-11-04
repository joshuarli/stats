export const OBSERVE_CHANNEL = "stats.observe";
export const OBSERVED_PROJECT = "stats";

export const OPERATIONS = [
  "installation.request",
  "projects.config",
  "collector.record",
  "deployments.collect",
  "deployments.poll",
  "deployments.record",
  "deployments.version",
  "deployments.coverage",
  "deployments.retention",
  "deployments.api",
  "deployments.forward"
] as const;

export type Operation = typeof OPERATIONS[number];

export interface InvocationMark {
  readonly kind: "invocation";
  readonly traceId: string;
  readonly spanId: string;
}

export interface ErrorReport {
  readonly kind: "error";
  readonly operation: Operation;
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

export type ChannelMessage = InvocationMark | ErrorReport;
