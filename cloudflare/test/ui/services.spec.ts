import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { comparisonBounds, DEPLOYMENT_BUCKET_MS } from "../../src/deployments/compare.ts";
import { INGEST_MEDIA_TYPE } from "../../src/ingest/http.ts";
import { BUILT_ASSETS, openAssets } from "../../src/node/assets.ts";
import { openNodeInstallation, type NodeInstallation } from "../../src/node/installation.ts";
import { createStatsServer, observeHandler } from "../../src/node/server.ts";
import type { ProbeFetch } from "../../src/projects/probes.ts";
import { HostSeries, SAMPLE_STEP_MS, SAMPLES_PER_BUCKET, type HostLevels } from "../support/service-data.ts";
import type { ExternalEvent } from "../../src/observe/ingest/model.ts";
import type { ServiceComparison } from "../../src/deployments/service-compare.ts";

const ORIGIN = "http://127.0.0.1:4176";
const LOGIN = "services@example.com";
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const FIRST_AT = NOW - 4 * HOUR;
const SECOND_AT = NOW - 2 * HOUR;
const WEB_CGROUP = { name: "web", cpuCores: 0.2, memoryBytes: 268_435_456, ioBytesPerSec: 100_000 };
const BEFORE: HostLevels = { cpuPercent: 20, memoryUsedPercent: 40, netBytesPerSec: 1_000_000, diskBytesPerSec: 500_000, cpuPressure: 1, service: WEB_CGROUP };
const AFTER: HostLevels = { ...BEFORE, cpuPercent: 50, netBytesPerSec: 2_000_000, service: { ...WEB_CGROUP, cpuCores: 0.5 } };
const JSON_HEADERS = { "Content-Type": "application/json" };

test.use({ extraHTTPHeaders: { "Tailscale-User-Login": LOGIN }, timezoneId: "UTC", locale: "en-US", bypassCSP: true });

let nowMs = NOW;
let installation: NodeInstallation;
let server: Server;
let scratch: string;

async function post(path: string, body: unknown, headers: Record<string, string> = JSON_HEADERS): Promise<Response> {
  return installation.core.fetch(new Request(`https://installation${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function createHost(name: string): Promise<{ hostId: string; token: string }> {
  const response = await post("/admin/hosts", { name });
  expect(response.status).toBe(201);
  return await response.json() as { hostId: string; token: string };
}

async function createService(body: Record<string, unknown>): Promise<string> {
  const response = await post("/admin/services", body);
  expect(response.status).toBe(201);
  return (await response.json() as { deployToken: string }).deployToken;
}

async function mark(service: string, token: string, version: string, hostIds: string[], atMs: number): Promise<string> {
  nowMs = atMs;
  const response = await post(`/services/${service}/deployments`, { markerId: `v-${version}`, version, message: `release ${version}`, hostIds }, { ...JSON_HEADERS, Authorization: `Bearer ${token}` });
  expect(response.status).toBe(201);
  return (await response.json() as { deployment: { id: string } }).deployment.id;
}

async function ingest(host: { hostId: string; token: string }, series: HostSeries, window: { fromMs: number; toMs: number }, levels: HostLevels): Promise<void> {
  for (let bucketMs = window.fromMs; bucketMs < window.toMs; bucketMs += DEPLOYMENT_BUCKET_MS) {
    nowMs = bucketMs + SAMPLES_PER_BUCKET * SAMPLE_STEP_MS;
    const response = await installation.core.fetch(new Request("https://installation/ingest", { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: series.bucketFrame(bucketMs, levels) }));
    expect(response.status).toBe(200);
  }
}

function activity(window: { readonly fromMs: number; readonly toMs: number }, durationMs: number, prefix: string): ExternalEvent[] {
  const events: ExternalEvent[] = [];
  for (let atMs = window.fromMs + 60_000; atMs < window.toMs; atMs += 60_000) {
    const eventId = `${prefix}-${atMs}`;
    events.push({ schemaVersion: 1, eventId, atMs, operation: "note.save", outcome: "ok", durationMs, work: { saves: 1 }, release: "1.1.0", service: "web" });
  }
  return events;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../../.work/tmp", import.meta.url));
  mkdirSync(root, { recursive: true });
  scratch = mkdtempSync(join(root, "playwright-services-"));
  const probes: ProbeFetch = async () => ({ status: 200, body: null });
  installation = openNodeInstallation({ path: join(scratch, "stats.sqlite"), projects: "[]", clock: { now: () => nowMs }, probeFetch: probes });

  const host = await createHost("web-1");
  const token = await createService({ name: "web", hostIds: [host.hostId], healthUrl: "https://web.example.com/health", unit: "web.service" });
  await mark("web", token, "1.0.0", [host.hostId], FIRST_AT);
  await mark("web", token, "1.1.0", [host.hostId], SECOND_AT);
  const { before, after } = comparisonBounds(SECOND_AT, "1h");
  const series = new HostSeries(host.hostId);
  await ingest(host, series, before, BEFORE);
  await ingest(host, series, after, AFTER);
  let latencyMs = 0;
  let currentNow = 0;
  const timed: ProbeFetch = async () => {
    nowMs = currentNow + latencyMs;
    return { status: 200, body: null };
  };
  for (const [window, latency] of [[before, 40], [after, 55]] as const) {
    latencyMs = latency;
    for (let bucketMs = window.fromMs; bucketMs < window.toMs; bucketMs += DEPLOYMENT_BUCKET_MS) {
      currentNow = bucketMs + 1000;
      nowMs = currentNow;
      await installation.core.collectServiceProbes(timed);
    }
  }

  const batchHost = await createHost("batch-1");
  const batchToken = await createService({ name: "batch", hostIds: [batchHost.hostId] });
  await mark("batch", batchToken, "2.0.0", [batchHost.hostId], FIRST_AT);
  await mark("batch", batchToken, "2.1.0", [batchHost.hostId], SECOND_AT);
  await installation.observe.ingestExternal("web", [...activity(before, 40, "before"), ...activity(after, 55, "after")]);
  nowMs = NOW;

  server = createStatsServer({ installation: request => installation.core.fetch(request), observe: observeHandler(installation), assets: await openAssets(BUILT_ASSETS), allowedLogins: new Set([LOGIN]), transport: "tcp" });
  await new Promise<void>(resolve => server.listen(4176, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  installation.close();
  rmSync(scratch, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .topbar { position: static !important; }";
      document.head.appendChild(style);
    });
  });
});

test("the Services page lists each service with its hosts, probe, and last deploy", async ({ page }) => {
  await page.goto(`${ORIGIN}/#/services`);
  const table = page.getByRole("table", { name: "Services" });
  await expect(table.getByRole("link", { name: "web", exact: true })).toBeVisible();
  const web = table.getByRole("row", { name: /^web\b/u });
  await expect(web).toContainText("https://web.example.com/health");
  await expect(web).toContainText("1.1.0");
  const batch = table.getByRole("row", { name: /^batch\b/u });
  await expect(batch).toContainText("unavailable, no health URL");
  await expect(batch).toContainText("2.1.0");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("main.content")).toHaveScreenshot("services-list.webp");
});

test("the Services list does not load the project search stylesheet", async ({ page }) => {
  const styles: Promise<string>[] = [];
  page.on("response", response => {
    if (new URL(response.url()).pathname.endsWith(".css")) styles.push(response.text());
  });
  await page.goto(`${ORIGIN}/#/services`);
  await expect(page.getByRole("table", { name: "Services" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect((await Promise.all(styles)).join("\n")).not.toContain(".projects-scroll-hint");
});

test("a service page compares its cgroup in place of host levels, labels the source, and keeps host-only metrics", async ({ page }) => {
  await page.goto(`${ORIGIN}/#/service/web`);
  const comparison = page.getByRole("region", { name: "Deployment metric comparison" });
  const cpu = comparison.getByRole("row", { name: /Service CPU used \(cgroup\)/u });
  await expect(cpu).toContainText("0.2");
  await expect(cpu).toContainText("0.5 cores");
  await expect(cpu).toContainText("regressed");
  await expect(comparison.getByRole("row", { name: /Host CPU used/u })).toHaveCount(0);
  await expect(comparison.getByRole("row", { name: /Service memory used \(cgroup\)/u })).toContainText("unchanged");
  await expect(comparison.getByRole("row", { name: /Host network throughput/u })).toContainText("regressed");
  await expect(page.getByText("Service cgroup: Ready", { exact: true })).toBeVisible();
  await expect(comparison.getByRole("row", { name: /Health probe mean response time/u })).toContainText("40");
  await expect(comparison.getByRole("row", { name: /Host memory pressure/u })).toContainText("unavailable");
  await expect(page.getByText("Application: Ready", { exact: true })).toBeVisible();
  const operations = page.getByRole("table", { name: "Application operations" });
  await expect(operations.getByRole("row", { name: /note\.save/u })).toContainText("40");
  await expect(operations.getByRole("row", { name: /note\.save/u })).toContainText("55");
  await expect(page.getByText("0 open issues").first()).toBeVisible();
  await expect(page.getByText("per-work ratios are descriptive", { exact: false }).first()).toBeAttached();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("main.content")).toHaveScreenshot("service-web.webp");
});

test("a service with no host data and no health URL shows every source unavailable", async ({ page }) => {
  await page.goto(`${ORIGIN}/#/service/batch`);
  const comparison = page.getByRole("region", { name: "Deployment metric comparison" });
  await expect(comparison.getByRole("row", { name: /Host CPU used/u })).toContainText("unavailable");
  await expect(page.locator("#deployments").getByRole("status")).toContainText("No overall verdict");
  await expect(page.locator("#deployments").getByRole("status")).not.toContainText("ready when the after window settles");
  await expect(page.getByText("Health probe: Not set", { exact: true })).toBeVisible();
  await expect(page.getByText("Service cgroup: Unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/0 open issues|issues unavailable/u).first()).toBeVisible();
  await expect(page.locator("main.content")).toHaveScreenshot("service-batch.webp");
});

test("service comparison explains its source coverage without hover", async ({ page }) => {
  await page.goto(`${ORIGIN}/#/service/web`);
  const coverage = page.locator("#deployments").getByText("Data coverage", { exact: true });
  await coverage.click();
  const details = coverage.locator("..");
  await expect(details).toContainText("successful events across 1 operation");
  await expect(details).toContainText("drops and gaps not recorded");
  await expect(details).toContainText("1 host");
});

test("application work does not promise that an overlapping comparison will settle", async ({ page }) => {
  await page.route("**/api/v1/services/web/deployments/*/comparison?*", async route => {
    const response = await route.fetch();
    const comparison = await response.json() as ServiceComparison;
    await route.fulfill({ response, json: { ...comparison, reasons: ["Another deployment overlaps the comparison windows."], reasonCodes: ["overlap"] } });
  });
  await page.goto(`${ORIGIN}/#/service/web`);
  const work = page.locator("#service-work");
  await expect(work.getByText("The comparison has limitations; see the deployment comparison above for details.")).toBeVisible();
  await expect(work).not.toContainText("ready at the end of the window");
  const comparison = page.locator("#deployments");
  await comparison.getByText("Why", { exact: true }).click();
  await expect(comparison).toContainText("Another deployment overlaps the comparison windows.");
});

test("application work distinguishes unavailable rates from zero", async ({ page }) => {
  await page.route("**/api/v1/services/web/deployments/*/comparison?*", async route => {
    const response = await route.fetch();
    const comparison = await response.json() as ServiceComparison;
    const work = comparison.work[0]!;
    await route.fulfill({ response, json: { ...comparison, work: [{ ...work, after: { ...work.after, successes: 0, failures: 0, failureRate: null, meanDurationMs: null, throughputPerMinute: 0 } }] } });
  });
  await page.goto(`${ORIGIN}/#/service/web`);
  const row = page.getByRole("table", { name: "Application operations" }).getByRole("row", { name: /note\.save/u });
  await expect(row.locator("td").nth(1)).toHaveText("0% → unavailable");
  await expect(row.locator("td").nth(2)).toHaveText("40 ms → unavailable");
  await expect(page.locator(".service-facts")).toContainText("0 events/min after, unavailable failure rate, unavailable mean latency");
});

test("long work details do not squeeze operation names", async ({ page }) => {
  await page.route("**/api/v1/services/web/deployments/*/comparison?*", async route => {
    const response = await route.fetch();
    const comparison = await response.json() as ServiceComparison;
    const work = comparison.work[0]!;
    const key = "processed_objects_long_counter";
    const measurement = { ...work.before.work[0]!, key, durationPerUnitMs: 1.234, cpuPerUnit: 0.001234, ioPerUnit: 1234 };
    await route.fulfill({ response, json: { ...comparison, work: [{ ...work, operation: "payments.process_settlement", before: { ...work.before, work: [measurement] }, after: { ...work.after, work: [measurement] } }] } });
  });
  await page.goto(`${ORIGIN}/#/service/web`);
  const row = page.getByRole("row", { name: /payments\.process_settlement/u });
  const identity = row.getByRole("rowheader");
  await expect(identity).toBeVisible();
  await expect(row).toContainText("processed_objects_long_counter");
  const layout = await identity.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return { width: element.getBoundingClientRect().width, lines: range.getClientRects().length }; });
  expect(layout.width).toBeGreaterThan(140);
  expect(layout.lines).toBe(1);
});

test("an unavailable service issue response releases its unread body", async ({ page }) => {
  await page.route("**/api/observe/web/issues?*", route => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "collector unavailable" } } }));
  const closed = page.waitForEvent("requestfailed", { predicate: request => request.url().includes("/api/observe/web/issues?"), timeout: 5_000 });
  await page.goto(`${ORIGIN}/#/service/web`);
  await expect(page.getByText("Issues: unavailable")).toBeVisible();
  expect((await closed).failure()).not.toBeNull();
});

test("an unknown service is a not-found state, not an empty page", async ({ page }) => {
  await page.goto(`${ORIGIN}/#/service/absent`);
  await expect(page.getByText("Service not found")).toBeVisible();
});

test("refreshing the services list aborts the older deployment request", async ({ page }) => {
  let release = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  let cancelled = false;
  page.on("requestfailed", request => {
    if (request.url().endsWith("/services/web/deployments")) cancelled = true;
  });
  await page.route("**/api/v1/services/web/deployments", async route => {
    requests += 1;
    if (requests === 1) {
      await wait;
      if (route.request().failure() !== null) return;
    }
    await route.continue();
  });
  await page.goto(`${ORIGIN}/#/services`);
  try {
    await expect.poll(() => requests).toBe(1);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => cancelled).toBe(true);
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("table", { name: "Services" }).getByRole("row", { name: /^web\b/u })).toContainText("1.1.0");
  } finally {
    release();
  }
});

test("refreshing a service aborts the older issue request", async ({ page }) => {
  let release = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  let cancelled = false;
  page.on("requestfailed", request => {
    if (request.url().includes("/api/observe/web/issues?")) cancelled = true;
  });
  await page.route("**/api/observe/web/issues?*", async route => {
    requests += 1;
    if (requests === 1) {
      await wait;
      if (route.request().failure() !== null) return;
    }
    await route.fulfill({ json: { items: [], next: null } });
  });
  await page.goto(`${ORIGIN}/#/service/web`);
  try {
    await expect.poll(() => requests).toBe(1);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => cancelled).toBe(true);
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("0 open issues").first()).toBeVisible();
  } finally {
    release();
  }
});

test("service work identifies the previous window while a comparison updates", async ({ page }) => {
  let release = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  let waiting = false;
  await page.route("**/api/v1/services/web/deployments/*/comparison?*", async route => {
    if (new URL(route.request().url()).searchParams.get("window") === "24h") {
      waiting = true;
      await wait;
      if (route.request().failure() !== null) return;
    }
    await route.continue();
  });
  await page.goto(`${ORIGIN}/#/service/web`);
  await expect(page.getByRole("table", { name: "Application operations" })).toBeVisible();
  try {
    await page.getByRole("button", { name: "24h", exact: true }).click();
    await expect.poll(() => waiting).toBe(true);
    await expect(page.locator(".service-facts")).toContainText("previous comparison window");
    await expect(page.locator("#service-work").getByRole("status")).toHaveText("Updating comparison; application work uses the previous window.");
  } finally {
    release();
  }
  await expect(page.locator("#service-work").getByRole("status")).toHaveCount(0);
  await expect(page.locator(".service-facts")).not.toContainText("previous comparison window");
});
