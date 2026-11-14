import { tracing } from "cloudflare:workers";
import diagnostics from "node:diagnostics_channel";
import { OBSERVE_CHANNEL, type InvocationMark, type OperationSummary, type ServiceOperationSummary } from "../producer/channel.ts";
import { reportOperation, reportServiceOperation } from "../producer/report.ts";

const channel = diagnostics.channel(OBSERVE_CHANNEL);

interface ActiveSpan {
  spanContext(): { readonly traceId: string; readonly spanId: string };
}

function activeSpan(): ActiveSpan | undefined {
  const candidate = tracing as { getActiveSpan?: () => ActiveSpan | undefined };
  return typeof candidate.getActiveSpan === "function" ? candidate.getActiveSpan() : undefined;
}

export function markInvocation(): void {
  const span = activeSpan();
  if (span === undefined) return;
  const context = span.spanContext();
  const mark: InvocationMark = { kind: "invocation", traceId: context.traceId, spanId: context.spanId };
  channel.publish(mark);
}

export function markOperation(summary: OperationSummary): void {
  const span = activeSpan();
  if (span === undefined) return;
  reportOperation(summary, span.spanContext());
}

export function markServiceOperation<O extends string = string>(summary: ServiceOperationSummary<NoInfer<O>>): void {
  const span = activeSpan();
  if (span === undefined) return;
  reportServiceOperation<O>(summary, span.spanContext());
}
