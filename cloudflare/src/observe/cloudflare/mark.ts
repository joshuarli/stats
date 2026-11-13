import { tracing } from "cloudflare:workers";
import diagnostics from "node:diagnostics_channel";
import { OBSERVE_CHANNEL, type InvocationMark, type OperationSummary, type ServiceOperationSummary } from "../producer/channel.ts";
import { reportOperation, reportServiceOperation } from "../producer/report.ts";

const channel = diagnostics.channel(OBSERVE_CHANNEL);

export function markInvocation(): void {
  const span = tracing.getActiveSpan();
  if (span === undefined) return;
  const context = span.spanContext();
  const mark: InvocationMark = { kind: "invocation", traceId: context.traceId, spanId: context.spanId };
  channel.publish(mark);
}

export function markOperation(summary: OperationSummary): void {
  const span = tracing.getActiveSpan();
  if (span === undefined) return;
  reportOperation(summary, span.spanContext());
}

export function markServiceOperation<O extends string = string>(summary: ServiceOperationSummary<NoInfer<O>>): void {
  const span = tracing.getActiveSpan();
  if (span === undefined) return;
  reportServiceOperation<O>(summary, span.spanContext());
}
