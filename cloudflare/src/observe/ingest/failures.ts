import { GROUPING_VERSION, sha256Hex } from "../core/grouping.ts";
import type { ApplicationFailure, ExternalEvent, ReceivedEvent } from "./model.ts";

async function failureOf(service: string, event: ExternalEvent): Promise<ApplicationFailure | null> {
  if (event.error === undefined) return null;
  const [fingerprint, key] = await Promise.all([
    sha256Hex([GROUPING_VERSION, "application", service, event.operation, event.error.code].join("\u0000")),
    sha256Hex([GROUPING_VERSION, "application-occurrence", service, event.eventId, String(event.atMs)].join("\u0000"))
  ]);
  return { fingerprint, invocationKey: key.slice(0, 32), code: event.error.code };
}

export async function receiveEvents(service: string, events: readonly ExternalEvent[]): Promise<readonly ReceivedEvent[]> {
  return Promise.all(events.map(async event => ({ event, failure: await failureOf(service, event) })));
}
