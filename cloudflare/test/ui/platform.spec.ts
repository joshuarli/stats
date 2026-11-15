import { expect, test, type Page } from "./fixtures";

const now = Date.UTC(2026, 10, 5, 12);
const service = (name: string) => ({ name, hostIds: [], healthUrl: null, unit: null, createdAtMs: now });
const summary = { provenance: "application", fromMs: now - 3600000, toMs: now, stepMs: 60000, totals: null, openIssues: 0, buckets: [], operations: [], moreOperations: false };
const operation = (operation: string, count: number, failed: number) => ({ operation, release: "stats-1_oo-1_rk-3", count, failed, meanUs: 60, maxUs: 90, p50UpperUs: 50, p95UpperUs: 100, histogram: [{ upperUs: 50, count: count - 1 }, { upperUs: 100, count: 1 }] });
const telemetry = { fromMs: now - 3600000, toMs: now, operations: [operation("platform.installation.invoke", 3, 1), operation("platform.installation.sqlite.query", 4, 2)], delivery: { atMs: now - 30000, release: "bridge-1", samplePpm: 100000, received: 100, admitted: 70, filtered: 20, invalid: 10, dropped: 2, queued: 3, sent: 65, exporterLoss: "unknown" }, truncated: false, capabilities: { actorRequests: true, sqlite: true, outboundRpc: false, runtimeMetrics: false } };
async function setup(page: Page) {
  await page.clock.install({ time: now });
  await page.route("**/api/v1/hosts", route => route.fulfill({ json: { hosts: [] } }));
  await page.route("**/api/v1/services", route => route.fulfill({ json: { services: [service("stats"), service("web")] } }));
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: { projectSource: "services", analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true } }));
  await page.route("**/api/observe/*/external/telemetry/summary?*", route => route.fulfill({ json: summary }));
}

test("@mobile platform shows sampled operations and real histogram, only fetching when open", async ({ page }) => {
  await setup(page);
  let requests = 0;
  await page.route("**/api/observe/stats-platform/platform?*", route => { requests++; return route.fulfill({ json: telemetry }); });
  await page.goto("/#/project/stats");
  await expect(page.getByRole("button", { name: /Platform/ })).toBeVisible();
  expect(requests).toBe(0);
  await page.getByRole("button", { name: /Platform/ }).click();
  await expect(page.getByText("Actor invocation: installation.invoke")).toBeVisible();
  await expect(page.getByText("Nested SQLite: installation.sqlite.query")).toBeVisible();
  const rows = page.getByRole("table", { name: "Observed platform operations" }).locator("tbody tr");
  await expect(rows.nth(0)).toContainText("3"); await expect(rows.nth(0)).toContainText("1");
  await expect(rows.nth(1)).toContainText("4"); await expect(rows.nth(1)).toContainText("2");
  await expect(rows.nth(0)).toContainText("≤ 50 µs"); await expect(rows.nth(0)).toContainText("≤ 100 µs");
  await expect(rows.nth(0)).toContainText("stats-1_oo-1_rk-3");
  await page.getByText("Nested SQLite: installation.sqlite.query").click();
  await expect(page.locator(".platform-bin").nth(0)).toContainText("≤ 50 µs");
  await expect(page.locator(".platform-bin").nth(0)).toContainText("3");
  await expect(page.locator(".platform-bin").nth(1)).toContainText("> 50 to ≤ 100 µs");
  await expect(page.getByText(/configured root sampling 100,000 ppm/)).toBeVisible();
  await expect(page.getByText(/exporter loss unknown/).first()).toBeVisible();
  await expect(page.getByText(/Separate outbound RPC and runtime gauges/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: /Overview/ }).click();
  const closed = requests; await page.waitForTimeout(100); expect(requests).toBe(closed);
  await page.goto("/#/project/web");
  await expect(page.getByRole("button", { name: /Platform/ })).toHaveCount(0);
  expect(requests).toBe(closed);
});

test("@mobile platform distinguishes disabled, empty and stale reports", async ({ page }) => {
  await setup(page);
  let mode = "disabled";
  await page.route("**/api/observe/stats-platform/platform?*", route => mode === "disabled" ? route.fulfill({ status: 404 }) : route.fulfill({ json: { ...telemetry, operations: [], delivery: mode === "empty" ? null : { ...telemetry.delivery, atMs: now - 120000 } } }));
  await page.goto("/#/project/stats?section=platform");
  await expect(page.getByText("The optional bridge is disabled or unconfigured.")).toBeVisible();
  mode = "empty"; await page.reload();
  await expect(page.getByText("No observed platform operations")).toBeVisible();
  await expect(page.getByText("Delivery report unavailable or stale.")).toBeVisible();
  mode = "stale"; await page.reload();
  await expect(page.getByText("Delivery report unavailable or stale.")).toBeVisible();
});
