import type { Route } from "@playwright/test";
import { expect, test } from "./fixtures";

const now = Date.UTC(2026, 10, 5, 12);
const summary = { provenance: "application", fromMs: now - 3600000, toMs: now, stepMs: 60000, totals: null, openIssues: 0, buckets: [], operations: [], moreOperations: false };
const platform = { fromMs: now - 3600000, toMs: now, operations: [], delivery: null, truncated: false, capabilities: { actorRequests: true, sqlite: true, outboundRpc: false, runtimeMetrics: false } };

for (const section of ["overview", "platform"] as const) {
  test(`@mobile live ticks do not restart a slow ${section} range read`, async ({ page }) => {
    await page.clock.install({ time: now });
    await page.route("**/api/v1/hosts", route => route.fulfill({ json: { hosts: [] } }));
    await page.route("**/api/v1/services", route => route.fulfill({ json: { services: [{ name: "stats", hostIds: [], healthUrl: null, unit: null, createdAtMs: now }] } }));
    await page.route("**/api/v1/capabilities", route => route.fulfill({ json: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true } }));
    let pending = false;
    const held: Route[] = [];
    let requests = 0;
    await page.route(section === "overview" ? "**/api/observe/stats/external/telemetry/summary?*" : "**/api/observe/stats-platform/platform?*", async route => {
      requests++;
      if (pending) { held.push(route); return; }
      await route.fulfill({ json: section === "overview" ? summary : platform });
    });
    await page.goto(`/#/project/stats?section=${section}`);
    await expect(page.getByRole("heading", { name: section === "overview" ? "Application overview" : "Observed platform operations", exact: true })).toBeVisible();
    expect(requests).toBe(1);
    pending = true;
    await page.getByRole("button", { name: "6h", exact: true }).click();
    await expect.poll(() => held.length).toBe(1);
    await page.clock.fastForward(20000);
    await expect.poll(() => requests).toBe(2);
    await held[0]!.fulfill({ json: section === "overview" ? summary : platform });
    await expect(page.getByRole("heading", { name: section === "overview" ? "Application overview" : "Observed platform operations", exact: true })).toBeVisible();
    expect(requests).toBe(2);
    pending = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => requests).toBe(3);
  });
}

test("@mobile recent summary ranges reuse their completed windows until refresh", async ({ page }) => {
  await page.clock.install({ time: now });
  await page.route("**/api/v1/hosts", route => route.fulfill({ json: { hosts: [] } }));
  await page.route("**/api/v1/services", route => route.fulfill({ json: { services: [{ name: "stats", hostIds: [], healthUrl: null, unit: null, createdAtMs: now }] } }));
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true } }));
  let requests = 0, hold = false;
  await page.route("**/api/observe/stats/external/telemetry/summary?*", async route => {
    requests++;
    if (hold) return;
    const url = new URL(route.request().url()), fromMs = Number(url.searchParams.get("from")), toMs = Number(url.searchParams.get("to"));
    const n = Math.round((toMs - fromMs) / 3600000);
    const totals = { events: n, failed: 0, cancelled: 0, requests: n, requestDurationMsSum: n, requestDurationMsMax: 1, status2xx: n, status3xx: 0, status4xx: 0, status5xx: 0, durationMsSum: n, durationMsMax: 1, firstAtMs: fromMs + 1000, lastAtMs: fromMs + 1000 };
    await route.fulfill({ json: { ...summary, fromMs, toMs, stepMs: Math.max(1000, Math.ceil((toMs - fromMs) / 120000) * 1000), totals, buckets: [{ ...totals, atMs: fromMs }], operations: [{ ...totals, operation: "http.get.fixture" }] } });
  });
  await page.goto("/#/project/stats");
  await expect(page.getByRole("button", { name: "1 HTTP requests", exact: true })).toBeVisible();
  for (const [label, hours] of [["6h", 6], ["24h", 24], ["7d", 168], ["30d", 168]] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByRole("button", { name: `${hours} HTTP requests`, exact: true })).toBeVisible();
  }
  expect(requests).toBe(5);
  hold = true;
  for (let round = 0; round < 5; round++) {
    for (const [label, hours] of [["1h", 1], ["6h", 6], ["24h", 24], ["7d", 168], ["30d", 168]] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByRole("button", { name: `${hours} HTTP requests`, exact: true })).toBeVisible();
    }
  }
  await page.clock.fastForward(20000);
  expect(requests).toBe(5);
  hold = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => requests).toBe(6);
  await page.getByRole("button", { name: "6h", exact: true }).click();
  await expect(page.getByRole("button", { name: "6 HTTP requests", exact: true })).toBeVisible();
  expect(requests).toBe(7);
});
