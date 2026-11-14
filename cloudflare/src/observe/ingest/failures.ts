import { DEFAULT_MESSAGE_POLICY, prepareError } from "../core/model.ts";
import { GROUPING_VERSION, sha256Hex } from "../core/grouping.ts";
import type { ApplicationFailure, ExternalEvent, ReceivedEvent } from "./model.ts";

async function failureOf(service: string, event: ExternalEvent): Promise<ApplicationFailure | null> {
  if (event.error === undefined) return null;
  const [fingerprint, key] = await Promise.all([
    sha256Hex([GROUPING_VERSION, "application", service, event.operation, event.error.code].join("\u0000")),
    sha256Hex([GROUPING_VERSION, "application-occurrence", service, event.eventId, String(event.atMs)].join("\u0000"))
  ]);
  const diagnostics = event.diagnostics;
  if (diagnostics === undefined) return { fingerprint, invocationKey: key.slice(0, 32), code: event.error.code };
  const prepared = await prepareError({ source: "caught", operation: event.operation, name: diagnostics.name, message: diagnostics.message, stack: diagnostics.frames.join("\n") }, 0, DEFAULT_MESSAGE_POLICY);
  return { fingerprint: prepared.fingerprint, invocationKey: key.slice(0, 32), code: event.error.code, prepared };
}

export async function receiveEvents(service: string, events: readonly ExternalEvent[]): Promise<readonly ReceivedEvent[]> {
  return Promise.all(events.map(async event => ({ event, failure: await failureOf(service, event) })));
}
