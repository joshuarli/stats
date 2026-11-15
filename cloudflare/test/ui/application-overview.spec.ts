import { expect, test } from "./fixtures";

const now = Date.UTC(2026, 10, 5, 12);
const base = { events: 10, failed: 0, cancelled: 0, requests: 10, requestDurationMsSum: 100, requestDurationMsMax: 10, status2xx: 10, status3xx: 0, status4xx: 0, status5xx: 0, durationMsSum: 100, durationMsMax: 10, firstAtMs: now - 120000 + 100, lastAtMs: now - 60000 - 100 };

for (const scenario of ["healthy", "failing", "slow", "stale", "deployment", "missing", "historical"] as const) {
  test(`@mobile ${scenario} overview supplies context and a working investigation target`, async ({ page }) => {
    test.setTimeout(10000);
    await page.clock.install({ time: now });
    const deployment = { status: "available", deployment: { id: "00000000-0000-4000-8000-0000000000aa", atMs: now - 90000, source: "marker", message: null, deferred: false, versions: [{ id: "stats-fixture", percentage: 100 }] }, versions: [] };
    await page.route("**/api/v1/hosts", route => route.fulfill({ json: { hosts: [] } }));
    await page.route("**/api/v1/services", route => route.fulfill({ json: { services: [{ name: "stats", hostIds: [], healthUrl: null, unit: null, createdAtMs: now, ...(scenario === "deployment" ? { latestDeployment: deployment } : {}) }] } }));
    await page.route("**/api/v1/capabilities", route => route.fulfill({ json: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true } }));
    await page.route("**/api/v1/services/stats/deployments", route => route.fulfill({ json: { projectId: "stats", enabled: true, deployments: [deployment.deployment], versions: [], markers: [] } }));
    let overviewReads = 0;
    await page.route(/\/api\/observe\/stats\/external\/telemetry(?:\/summary)?\?/u, route => {
      const url = new URL(route.request().url());
      const fromMs = Number(url.searchParams.get("from")), toMs = Number(url.searchParams.get("to"));
      if (url.pathname.endsWith("/summary")) overviewReads++;
      const stale = scenario === "stale" ? 600000 : 0;
      const first = { ...base, atMs: toMs - 120000 - stale, firstAtMs: toMs - 119900 - stale, lastAtMs: toMs - 60100 - stale };
      const fails = scenario === "failing" || scenario === "deployment";
      const second = { ...base, atMs: toMs - 60000 - stale, firstAtMs: toMs - 59900 - stale, lastAtMs: toMs - 1000 - stale, ...(fails ? { failed: 1, status2xx: 9, status5xx: 1 } : {}), ...(scenario === "slow" ? { requestDurationMsSum: 300, requestDurationMsMax: 30, durationMsSum: 300, durationMsMax: 30 } : {}) };
      const totals = { ...base, events: 20, requests: 20, status2xx: fails ? 19 : 20, failed: fails ? 1 : 0, status5xx: fails ? 1 : 0, requestDurationMsSum: first.requestDurationMsSum + second.requestDurationMsSum, durationMsSum: first.durationMsSum + second.durationMsSum, requestDurationMsMax: second.requestDurationMsMax, durationMsMax: second.durationMsMax, firstAtMs: first.firstAtMs, lastAtMs: second.lastAtMs };
      return route.fulfill({ json: { provenance: "application", fromMs, toMs, stepMs: 60000, totals: scenario === "missing" ? null : totals, openIssues: 0, buckets: scenario === "missing" ? [] : [first, second], operations: scenario === "missing" ? [] : [{ ...totals, operation: "http.get.fixture" }], moreOperations: false, recent: scenario === "missing" ? [] : [{ eventId: "fixture-read", service: "stats", receivedAtMs: now, provenance: "application", event: { schemaVersion: 1, eventId: "fixture-read", service: "stats", release: "stats-fixture", atMs: second.lastAtMs, operation: "http.get.fixture", outcome: fails ? "error" : "ok", durationMs: scenario === "slow" ? 30 : 10, work: { http_status: fails ? 500 : 200 } } }], moreRecent: false } });
    });
    await page.goto("/#/project/stats");
    const context = page.getByLabel("Investigation context");
    await expect(context).toBeVisible();
    if (scenario === "historical") {
      const plot = page.locator(".native-overview .u-over").first();
      await plot.scrollIntoViewIfNeeded();
      const box = await plot.boundingBox();
      if (box === null) throw new Error("chart plot has no box");
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up();
      await expect(context).toContainText("Historical window:");
      await expect(context).not.toContainText("Activity may be stale");
    } else await expect(context).toContainText("Current window:");
    if (scenario === "healthy") await expect(page.getByText("No failures reported")).toBeVisible();
    if (scenario === "failing" || scenario === "deployment") {
      await expect(page.getByText("Attention needed")).toBeVisible();
      await expect(context).toContainText("First server errors observed in bucket starting");
      await expect(context).toContainText("bucket width");
      await expect(context).toContainText(new Date(now - 60000).toLocaleString());
    }
    if (scenario === "slow") {
      await expect(context).toContainText("Mean wall time rose to 30 ms across 10 events");
      await expect(context).toContainText("averaged 10 ms across 10 events");
      await expect(context).toContainText(new Date(now - 60000).toLocaleString());
    }
    if (scenario === "stale") await expect(context).toContainText("Activity may be stale");
    if (scenario === "missing") {
      await expect(page.getByText("No activity reported")).toBeVisible();
      await expect(context).toContainText("No event time available");
      await expect(page.getByText("No failures reported")).toHaveCount(0);
    }
    if (scenario === "deployment") {
      await expect(context).toContainText("Latest deployment: stats-fixture");
      await expect(context).toContainText(new Date(now - 90000).toLocaleString());
      await context.getByRole("button", { name: "View deployments →" }).click();
      await expect(page.getByRole("heading", { name: "Deployment", exact: true })).toBeVisible();
      await expect(page.getByText("Deployment history request failed")).toHaveCount(0);
      await expect(page).toHaveURL(/section=deploys/);
    } else {
      if (scenario === "failing" || scenario === "slow") await context.getByRole("button", { name: "Investigate events →" }).first().click();
      else await page.getByRole("button", { name: /(?:HTTP requests|Application events).*In the selected window/ }).click();
      await expect(page.getByRole("heading", { name: "Recent events", exact: true })).toBeVisible();
      if (scenario === "missing") await expect(page.getByText("No recent events in this window")).toBeVisible();
      else await expect(page.getByRole("table", { name: "Recent application events" })).toContainText("http.get.fixture");
      await expect(page).toHaveURL(/section=requests/);
    }
    expect(overviewReads).toBe(scenario === "historical" ? 2 : 1);
  });
}
