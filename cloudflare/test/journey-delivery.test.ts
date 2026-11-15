import { afterEach, expect, it, vi } from "vitest";
import type { ProjectJourney } from "../src/observe/application/journey.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("browser transport bounds concurrency, records loss and survives a failed admission", async () => {
  const pending: { resolve: (response: Response) => void; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => new Promise<Response>(resolve => { pending.push({ resolve, body: JSON.parse(init.body as string) }); }));
  const { deliverProjectJourney, setJourneyDeliveryAvailable } = await import("../src/client/journey-delivery.ts");
  const journey: ProjectJourney = { schemaVersion: 1, source: "range", range: "1h", cache: true, outcome: "ok", startedAtMs: Date.now(), durationMs: 10, trace: { traceId: "1".repeat(32), spanId: "2".repeat(16) }, work: { render_us: 10_000 } };
  deliverProjectJourney(journey);
  expect(pending).toHaveLength(0);
  setJourneyDeliveryAvailable(true);
  for (let i = 0; i < 10; i++) deliverProjectJourney(journey);
  expect(pending).toHaveLength(2);
  pending[0]!.resolve(new Response(null, { status: 503 }));
  pending[1]!.resolve(new Response(null, { status: 202 }));
  await new Promise<void>(resolve => { setImmediate(resolve); });
  deliverProjectJourney(journey);
  expect(pending).toHaveLength(3);
  expect(pending[2]!.body["dropped"]).toBe(10);
  expect(pending[2]!.body["asset"]).toBe("journey-delivery.ts");
  pending[2]!.resolve(new Response(null, { status: 202 }));
});
