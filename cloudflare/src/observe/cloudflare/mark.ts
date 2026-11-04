import { tracing } from "cloudflare:workers";
import diagnostics from "node:diagnostics_channel";
import { OBSERVE_CHANNEL, type InvocationMark } from "../producer/channel.ts";

const channel = diagnostics.channel(OBSERVE_CHANNEL);

export function markInvocation(): void {
  const span = tracing.getActiveSpan();
  if (span === undefined) return;
  const context = span.spanContext();
  const mark: InvocationMark = { kind: "invocation", traceId: context.traceId, spanId: context.spanId };
  channel.publish(mark);
}
