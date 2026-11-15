import type { Route } from "@playwright/test";
import type { ProjectJourney } from "../../src/client/project-journey";
import { expect, test } from "./fixtures";

declare global {
  interface Window { captureProjectJourney: (journey: ProjectJourney) => Promise<void> }
}

test("@mobile project journeys measure real chart completion, cache reuse, errors and cancellation", async ({ page }) => {
  const journeys: ProjectJourney[] = [];
  await page.exposeFunction("captureProjectJourney", (journey: ProjectJourney) => { journeys.push(journey); });
  await page.addInitScript(() => window.addEventListener("stats:project-journey", event => { void window.captureProjectJourney((event as CustomEvent<ProjectJourney>).detail); }));
  await page.route("**/api/v1/hosts", route => route.fulfill({ json: { hosts: [] } }));
  await page.route("**/api/v1/services", route => route.fulfill({ json: { services: [{ name: "stats", hostIds: [], healthUrl: null, unit: null, createdAtMs: Date.now() }] } }));
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true } }));
  let held: Route | undefined;
  let hold = false, fail = false, reads = 0;
  const parents: string[] = [];
  await page.route("**/api/observe/stats/external/telemetry/summary?*", async route => {
    reads++;
    parents.push(route.request().headers()["traceparent"] ?? "");
    if (hold) { held = route; return; }
    if (fail) { await route.fulfill({ status: 503, json: { error: { message: "unavailable" } } }); return; }
    const url = new URL(route.request().url()), fromMs = Number(url.searchParams.get("from")), toMs = Number(url.searchParams.get("to"));
    const n = Math.round((toMs - fromMs) / 3600000);
    const totals = { events: n, failed: 0, cancelled: 0, requests: n, requestDurationMsSum: n, requestDurationMsMax: 1, status2xx: n, status3xx: 0, status4xx: 0, status5xx: 0, durationMsSum: n, durationMsMax: 1, firstAtMs: fromMs + 1000, lastAtMs: fromMs + 1000 };
    await route.fulfill({ headers: { "Server-Timing": "app-store;dur=5.000, app-query;dur=2.000, app-total;dur=8.000, secret;dur=99" }, json: { provenance: "application", fromMs, toMs, stepMs: Math.max(1000, Math.ceil((toMs - fromMs) / 120000) * 1000), totals, openIssues: 0, buckets: [{ ...totals, atMs: fromMs }], operations: [], moreOperations: false } });
  });
  await page.goto("/#/project/stats");
  await expect.poll(() => journeys.filter(entry => entry.outcome === "ok").length).toBe(1);
  await expect(page.locator(".native-overview canvas")).toHaveCount(3);
  const first = journeys[0]!;
  expect(first.source).toBe("navigation");
  expect(first.cache).toBe(false);
  expect(first.work["query_us"]).toBe(2000);
  expect(first.work["store_us"]).toBe(5000);
  expect(first.work["total_us"]).toBe(8000);
  expect(first.work["render_us"]).toBeGreaterThan(0);
  expect(first.work["health_us"]).toBeGreaterThan(0);
  expect(parents[0]).toBe(`00-${first.trace.traceId}-${first.trace.spanId}-00`);
  expect(JSON.stringify(journeys)).not.toMatch(/secret|api\/observe|stats\.17166969/u);

  await page.getByRole("button", { name: "6h", exact: true }).click();
  await expect.poll(() => journeys.filter(entry => entry.range === "6h" && entry.outcome === "ok").length).toBe(1);
  const before = reads;
  await page.getByRole("button", { name: "1h", exact: true }).click();
  await expect.poll(() => journeys.filter(entry => entry.cache).length).toBe(1);
  expect(reads).toBe(before);
  expect(journeys.at(-1)!.work["fetch_us"]).toBeUndefined();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => journeys.at(-1)?.source).toBe("refresh");

  hold = true;
  await page.getByRole("button", { name: "24h", exact: true }).click();
  await expect.poll(() => held !== undefined).toBe(true);
  hold = false;
  await page.getByRole("button", { name: "6h", exact: true }).click();
  await expect.poll(() => journeys.filter(entry => entry.range === "24h" && entry.outcome === "cancelled").length).toBe(1);
  await held!.fulfill({ status: 503 });
  await expect.poll(() => journeys.filter(entry => entry.range === "6h" && entry.outcome === "ok").length).toBe(2);
  expect(journeys.filter(entry => entry.range === "24h" && entry.outcome === "ok")).toHaveLength(0);

  fail = true;
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await expect.poll(() => journeys.at(-1)?.outcome).toBe("error");
});

test("@mobile navigating from the project list excludes time spent on the list", async ({ page }) => {
  await page.clock.install();
  const journeys: ProjectJourney[] = [];
  await page.exposeFunction("captureProjectJourney", (journey: ProjectJourney) => { journeys.push(journey); });
  await page.addInitScript(() => window.addEventListener("stats:project-journey", event => { void window.captureProjectJourney((event as CustomEvent<ProjectJourney>).detail); }));
  await page.route("**/api/v1/hosts", route => route.fulfill({ json: { hosts: [] } }));
  await page.route("**/api/v1/services", route => route.fulfill({ json: { services: [{ name: "stats", hostIds: [], healthUrl: null, unit: null, createdAtMs: Date.now() }] } }));
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true } }));
  await page.route("**/api/observe/stats/external/telemetry/summary?*", route => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: { provenance: "application", fromMs: Number(url.searchParams.get("from")), toMs: Number(url.searchParams.get("to")), stepMs: 30000, totals: null, openIssues: 0, buckets: [], operations: [], moreOperations: false } });
  });
  await page.goto("/#/projects");
  await expect(page.getByRole("link", { name: "stats", exact: true })).toBeVisible();
  await page.clock.fastForward(30000);
  expect(journeys).toHaveLength(0);
  await page.getByRole("link", { name: "stats", exact: true }).click();
  await expect.poll(() => journeys.length).toBe(1);
  expect(journeys[0]!.source).toBe("navigation");
  expect(journeys[0]!.durationMs).toBeLessThan(5000);
});
