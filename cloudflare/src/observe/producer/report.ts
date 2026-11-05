import diagnostics from "node:diagnostics_channel";
import { OBSERVE_CHANNEL, type ErrorReport, type Operation, type OperationMessage, type OperationSummary } from "./channel.ts";

const channel = diagnostics.channel(OBSERVE_CHANNEL);

export function reportError(operation: Operation, error: unknown): void {
  channel.publish(errorReport(operation, error));
}

export function reportOperation(summary: OperationSummary, context: { readonly traceId: string; readonly spanId: string }): void {
  const message: OperationMessage = { kind: "operation", traceId: context.traceId, spanId: context.spanId, ...summary };
  channel.publish(message);
}

export function errorReport(operation: Operation, error: unknown): ErrorReport {
  if (!(error instanceof Error)) return { kind: "error", operation, name: typeof error, message: "", stack: null };
  return { kind: "error", operation, name: readText(error, "name") ?? "Error", message: readText(error, "message") ?? "", stack: readText(error, "stack") };
}

function readText(error: Error, field: "name" | "message" | "stack"): string | null {
  try {
    const value: unknown = error[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
