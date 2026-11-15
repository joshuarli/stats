import { UI_JOURNEY_PATH, type ProjectJourney } from "../observe/application/journey.ts";

let available = false, inFlight = 0, dropped = 0;
const asset = new URL(import.meta.url).pathname.split("/").at(-1)!;

export function setJourneyDeliveryAvailable(value: boolean): void {
  available = value;
}

/** Best-effort transport has two slots, no queue or retries; admission is not a durable ingest acknowledgment. */
export function deliverProjectJourney(journey: ProjectJourney): void {
  if (!available || inFlight >= 2) { dropped = Math.min(1e12, dropped + 1); return; }
  inFlight++;
  void fetch(UI_JOURNEY_PATH, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...journey, asset, dropped }), signal: AbortSignal.timeout(3000)
  }).then(async response => {
    await response.body?.cancel();
    if (response.status !== 202) dropped = Math.min(1e12, dropped + 1);
  }).catch(() => { dropped = Math.min(1e12, dropped + 1); }).finally(() => { inFlight--; });
}
