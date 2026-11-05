import { tracing } from "cloudflare:workers";
import diagnostics from "node:diagnostics_channel";
import { OBSERVE_CHANNEL, type InvocationMark, type OperationSummary } from "../producer/channel.ts";
import { reportOperation } from "../producer/report.ts";

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
