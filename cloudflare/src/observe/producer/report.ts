import diagnostics from "node:diagnostics_channel";
import { OBSERVE_CHANNEL, type ErrorReport, type Operation, type OperationMessage, type OperationSummary, type ServiceOperationMessage, type ServiceOperationSummary } from "./channel.ts";

const channel = diagnostics.channel(OBSERVE_CHANNEL);

export function reportError<O extends string = Operation>(operation: NoInfer<O>, error: unknown): void {
  channel.publish(errorReport<O>(operation, error));
}

export function reportOperation(summary: OperationSummary, context: { readonly traceId: string; readonly spanId: string }): void {
  const message: OperationMessage = { kind: "operation", traceId: context.traceId, spanId: context.spanId, ...summary };
  channel.publish(message);
}

export function reportServiceOperation<O extends string = string>(summary: ServiceOperationSummary<NoInfer<O>>, context: { readonly traceId: string; readonly spanId: string }): void {
  const message: ServiceOperationMessage<O> = { kind: "operation", traceId: context.traceId, spanId: context.spanId, operation: summary.operation, synthetic: summary.synthetic, rows: summary.rows };
  channel.publish(message);
}

export function errorReport<O extends string = Operation>(operation: NoInfer<O>, error: unknown): ErrorReport<O> {
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
