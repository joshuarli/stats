import { existsSync, readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { fulfillHistory } from "./history-route";

const captureDirectory = new URL("./captures", import.meta.url).pathname;
const captureFile = (name: string, file: string): string => `${captureDirectory}/${name}/${file}`;

interface HostCapture {
  readonly name: string;
  readonly hostId: string;
  readonly capturedAtMs: number;
  readonly system: boolean;
}

interface CaptureMeta {
  readonly hostId?: unknown;
  readonly capturedAtMs?: unknown;
  readonly system?: unknown;
}

function readCapture(name: string, file: string): unknown {
  return JSON.parse(readFileSync(captureFile(name, file), "utf8"));
}

function captureMeta(name: string): CaptureMeta {
  return readCapture(name, "capture.json") as CaptureMeta;
}

function hostCaptures(): HostCapture[] {
  return readdirSync(captureDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const meta = captureMeta(entry.name);
      return typeof meta.hostId === "string"
        ? [{ name: entry.name, hostId: meta.hostId, capturedAtMs: Number(meta.capturedAtMs), system: meta.system === true }]
        : [];
    });
}

function capturedKind(name: string, range: string, kind: string): unknown {
  return readCapture(name, `${kind}-${range}.json`);
}

interface CapturedHistory {
  readonly range?: string;
  readonly fromMs: number;
  readonly stepMs?: number;
  readonly series?: readonly { readonly metric: string; readonly values: readonly (number | null)[] }[];
  readonly runs?: readonly { readonly atMs: number }[];
}

function windowedKind(name: string, kind: string, fromMs: number, toMs: number): unknown {
  for (const range of ["1h", "6h", "24h", "7d", "30d"]) {
    if (!existsSync(captureFile(name, `${kind}-${range}.json`))) continue;
    const captured = readCapture(name, `${kind}-${range}.json`) as CapturedHistory;
    if (captured.fromMs > fromMs) continue;
    const body = Object.fromEntries(Object.entries(captured).filter(([key]) => key !== "range"));
    if (captured.runs !== undefined) return { ...body, fromMs, toMs, runs: captured.runs.filter(run => run.atMs >= fromMs && run.atMs <= toMs) };
    const stepMs = captured.stepMs!;
    const length = captured.series?.[0]?.values.length ?? 0;
    const first = Math.max(0, Math.ceil((fromMs - captured.fromMs) / stepMs));
    const last = Math.min(length - 1, Math.floor((toMs - captured.fromMs) / stepMs));
    return { ...body, fromMs: captured.fromMs + first * stepMs, toMs, series: (captured.series ?? []).map(entry => ({ ...entry, values: entry.values.slice(first, last + 1) })) };
  }
  return capturedKind(name, "1h", kind);
}

function fulfillCapture(route: Route, name: string, file: string, history: boolean) {
  return history ? fulfillHistory(route, JSON.parse(readFileSync(captureFile(name, file), "utf8"))) : route.fulfill({ path: captureFile(name, file), contentType: "application/json" });
}

async function freeze(page: Page, capturedAtMs: number): Promise<void> {
  await page.clock.setFixedTime(capturedAtMs);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .topbar { position: static !important; } .section-bar { display: none !important; } .charts > .widget[id] { scroll-margin-top: 0 !important; }";
      document.head.appendChild(style);
    });
  });
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface Latency { readonly baseMs: number; readonly jitterMs: number }

const NO_LATENCY: Latency = { baseMs: 0, jitterMs: 0 };

function latencyFor(url: string, latency: Latency): number {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) hash = Math.imul(hash ^ url.charCodeAt(index), 16777619) >>> 0;
  return latency.baseMs + (latency.jitterMs === 0 ? 0 : hash % latency.jitterMs);
}

async function replay(page: Page, capture: HostCapture, latency: Latency = NO_LATENCY): Promise<void> {
  await freeze(page, capture.capturedAtMs);
  await page.route("**/api/v1/**", async route => {
    await pause(latencyFor(route.request().url(), latency));
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/projects") return route.fulfill({ json: [] });
    const kind = url.searchParams.get("kind") ?? "summary";
    const kindsParam = url.searchParams.get("kinds");
    const kinds = kindsParam === null ? null : kindsParam.split(",");
    const range = url.searchParams.get("range");
    const fromMs = Number(url.searchParams.get("from"));
    const toMs = Number(url.searchParams.get("to"));
    const emptyHistory = (entry: string) => ({
      hostId: capture.hostId,
      kind: entry,
      fromMs,
      toMs,
      resolution: "raw",
      stepMs: 15_000,
      ...(entry === "summary" ? { points: [] } : { series: [] })
    });
    if (range === null && url.pathname.endsWith("/history")) {
      if (kinds !== null) return fulfillHistory(route, { hostId: capture.hostId, histories: Object.fromEntries(kinds.map(entry => [entry, emptyHistory(entry)])) });
      return fulfillHistory(route, emptyHistory(kind));
    }
    if (kinds !== null) {
      return fulfillHistory(route, { hostId: capture.hostId, histories: Object.fromEntries(kinds.map(entry => [entry, capturedKind(capture.name, range ?? "1h", entry)])) });
    }
    if (url.pathname.endsWith("/system") && !capture.system) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "no system details for host" } } });
    const file = url.pathname === "/api/v1/hosts" ? "hosts.json" : url.pathname.endsWith("/system") ? "system.json" : `${kind}-${range ?? "1h"}.json`;
    return fulfillCapture(route, capture.name, file, url.pathname.endsWith("/history"));
  });
}

async function replayProject(page: Page, name: string, capturedAtMs: number, latency: Latency = NO_LATENCY): Promise<void> {
  await freeze(page, capturedAtMs);
  await page.route("**/api/v1/**", async route => {
    await pause(latencyFor(route.request().url(), latency));
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/hosts") return route.fulfill({ json: { hosts: [] } });
    if (url.pathname === "/api/v1/projects") return route.fulfill({ path: captureFile(name, "projects.json"), contentType: "application/json" });
    const otherProject = /^\/api\/v1\/projects\/([^/]+)\//u.exec(url.pathname);
    if (otherProject !== null && otherProject[1] !== name) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "project is not captured" } } });
    if (url.pathname === `/api/v1/projects/${name}/deployments`) return route.fulfill({ path: captureFile(name, "deployments.json"), contentType: "application/json" });
    const deploymentsPrefix = `/api/v1/projects/${name}/deployments/`;
    if (url.pathname.startsWith(deploymentsPrefix) && url.pathname.endsWith("/comparison")) {
      const deploymentId = url.pathname.slice(deploymentsPrefix.length, url.pathname.length - "/comparison".length);
      const comparison = readCapture(name, `comparison-${url.searchParams.get("window") ?? "1h"}.json`) as object;
      return route.fulfill({ json: { ...comparison, deploymentId } });
    }
    const kinds = url.searchParams.get("kinds");
    if (kinds !== null) {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const body = (kind: string) => from === null || to === null ? capturedKind(name, "1h", kind) : windowedKind(name, kind, Number(from), Number(to));
      return fulfillHistory(route, { projectId: name, histories: Object.fromEntries(kinds.split(",").map(kind => [kind, body(kind)])) });
    }
    return fulfillCapture(route, name, `${url.searchParams.get("kind")}-${url.searchParams.get("range")}.json`, true);
  });
}

for (const capture of hostCaptures()) {
  for (const range of ["1h", "24h", "7d"]) {
    test(`${capture.name} host page, ${range}`, { tag: "@mobile" }, async ({ page }) => {
      await replay(page, capture);
      await page.goto("/");
      await page.locator("table").getByRole("link", { name: capture.name }).click();
      await expect(page.getByRole("heading", { name: capture.name })).toBeVisible();
      await page.getByRole("button", { name: range, exact: true }).click();
      await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("heading", { name: "Filesystems" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.mouse.move(0, 0);
      if (!capture.system) {
        await page.getByRole("button", { name: "About Host information" }).click();
        await expect(page.getByRole("dialog", { name: "Host information" })).toContainText("This host has not reported system details.");
        await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
        await page.mouse.move(0, 0);
      }
      const regions = [
        ["tiles", page.getByRole("region", { name: "Host summary" })] as const,
        ["charts", page.getByRole("region", { name: "Charts" })] as const
      ];
      for (const [file, region] of regions) {
        await expect(region).toHaveScreenshot(`${capture.name}-${range}-${file}.webp`);
      }
    });
  }
}

test("stuff project page, 1h", { tag: "@mobile" }, async ({ page }) => {
  await replayProject(page, "stuff", Number(captureMeta("stuff").capturedAtMs));
  await page.goto("/#/project/stuff?open=signals");
  await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Collector" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Endpoints" })).toBeVisible();
  const ledger = page.getByRole("region", { name: "Cost ledger" });
  await expect(ledger.locator('[id="ledger-worker"]')).toBeVisible();
  await expect(ledger.locator('[id="ledger-r2"]')).toBeVisible();
  await expect(ledger.locator(".ledger-detail")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.mouse.move(0, 0);
  const regions = [
    ["ledger", ledger] as const,
    ["charts", page.getByRole("region", { name: "Charts" })] as const
  ];
  for (const [file, region] of regions) {
    await expect(region).toHaveScreenshot(`stuff-1h-${file}.webp`);
  }
});

for (const range of ["1h", "6h"]) {
  test(`stuff deployments card, ${range}`, { tag: "@mobile" }, async ({ page }) => {
    await replayProject(page, "stuff", Number(captureMeta("stuff").capturedAtMs));
    await page.goto("/#/project/stuff?open=deploys");
    await expect(page.getByRole("heading", { name: "Deployments" })).toBeVisible();
    if (range !== "1h") await page.getByRole("button", { name: range, exact: true }).click();
    const card = page.locator("#deployments");
    await expect(card).toContainText(`${range} each side`);
    await expect(card.getByRole("row", { name: /Worker CPU/u })).toContainText("improved");
    await page.waitForLoadState("networkidle");
    await page.mouse.move(0, 0);
    await expect(card).toHaveScreenshot(`stuff-deployments-${range}.webp`);
  });
}

const LAYOUT_SHIFT_BUDGET = 0.01;
const LAYOUT_LATENCY: Latency = { baseMs: 300, jitterMs: 1500 };

interface LayoutShiftRecord { readonly value: number; readonly sources: string[] }

declare global {
  interface Window {
    layoutShift: { total: number; records: LayoutShiftRecord[] };
  }
}

const apiRequests = new WeakMap<Page, { inFlight: number }>();

async function trackLayoutShift(page: Page): Promise<void> {
  const requests = { inFlight: 0 };
  apiRequests.set(page, requests);
  const isApi = (url: string) => url.includes("/api/v1/");
  page.on("request", request => { if (isApi(request.url())) requests.inFlight += 1; });
  page.on("requestfinished", request => { if (isApi(request.url())) requests.inFlight -= 1; });
  page.on("requestfailed", request => { if (isApi(request.url())) requests.inFlight -= 1; });
  await page.addInitScript(() => {
    const layoutShift: { total: number; records: { value: number; sources: string[] }[] } = { total: 0, records: [] };
    Object.defineProperty(window, "layoutShift", { value: layoutShift });
    const describe = (node: Node | null): string => {
      if (node === null) return "(removed)";
      if (!(node instanceof Element)) return node.nodeName.toLowerCase();
      const classes = typeof node.className === "string" ? node.className.trim().split(/\s+/u).filter(Boolean).map(name => `.${name}`).join("") : "";
      return `${node.nodeName.toLowerCase()}${classes}`;
    };
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as (PerformanceEntry & { readonly value: number; readonly hadRecentInput: boolean; readonly sources: readonly { readonly node: Node | null; readonly previousRect: DOMRectReadOnly; readonly currentRect: DOMRectReadOnly }[] })[]) {
        if (entry.hadRecentInput) continue;
        layoutShift.total += entry.value;
        layoutShift.records.push({
          value: entry.value,
          sources: entry.sources.map(source => `${describe(source.node)} y ${Math.round(source.previousRect.y)}→${Math.round(source.currentRect.y)} h ${Math.round(source.previousRect.height)}→${Math.round(source.currentRect.height)}`)
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

async function settleApiRequests(page: Page): Promise<void> {
  const requests = apiRequests.get(page);
  if (requests === undefined) throw new Error("layout tracking was not installed");
  let quiet = 0;
  while (quiet < 3) {
    await page.waitForTimeout(200);
    quiet = requests.inFlight === 0 ? quiet + 1 : 0;
  }
}

async function expectStableLayout(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await expect(page.locator(".skeleton")).toHaveCount(0);
  await settleApiRequests(page);
  const { total, records } = await page.evaluate(() => window.layoutShift);
  testInfo.annotations.push({ type: "layout-shift", description: `${name} ${testInfo.project.name} ${total.toFixed(4)}` });
  const culprits = records.map(record => `${record.value.toFixed(4)}: ${record.sources.join("; ")}`).join("\n");
  expect(total, `${name} cumulative layout shift\n${culprits}`).toBeLessThanOrEqual(LAYOUT_SHIFT_BUDGET);
}

test("the fleet page keeps its layout while its data arrives", { tag: "@mobile" }, async ({ page }, testInfo) => {
  const host = hostCaptures().find(entry => entry.name === "lisa");
  if (host === undefined) throw new Error("no lisa capture");
  await trackLayoutShift(page);
  await replay(page, host, LAYOUT_LATENCY);
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: host.name })).toBeVisible();
  await expectStableLayout(page, testInfo, "fleet");
});

test("a host page keeps its layout while its data arrives", { tag: "@mobile" }, async ({ page }, testInfo) => {
  const host = hostCaptures().find(entry => entry.name === "lisa");
  if (host === undefined) throw new Error("no lisa capture");
  await trackLayoutShift(page);
  await replay(page, host, LAYOUT_LATENCY);
  await page.goto(`/#/host/${host.hostId}`);
  await expect(page.getByRole("heading", { name: host.name, level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Charts" })).toBeVisible();
  await expectStableLayout(page, testInfo, "host");
});

test("the projects page keeps its layout while its data arrives", { tag: "@mobile" }, async ({ page }, testInfo) => {
  await trackLayoutShift(page);
  await replayProject(page, "stuff", Number(captureMeta("stuff").capturedAtMs), LAYOUT_LATENCY);
  await page.goto("/#/projects");
  await expect(page.getByRole("table", { name: "Projects" })).toBeVisible();
  await expectStableLayout(page, testInfo, "projects");
});

test("the stuff project page keeps its layout while its data arrives", { tag: "@mobile" }, async ({ page }, testInfo) => {
  await trackLayoutShift(page);
  await replayProject(page, "stuff", Number(captureMeta("stuff").capturedAtMs), LAYOUT_LATENCY);
  await page.goto("/#/project/stuff?open=deploys,signals");
  await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
  await expect(page.locator(".ledger-month")).toBeVisible();
  await expect(page.locator("#deployments")).toBeVisible();
  await expect(page.locator(".charts > .widget").first()).toBeVisible();
  await expectStableLayout(page, testInfo, "stuff project");
});

test("the stuff project page keeps its layout at tablet width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await trackLayoutShift(page);
  await replayProject(page, "stuff", Number(captureMeta("stuff").capturedAtMs), LAYOUT_LATENCY);
  await page.goto("/#/project/stuff?open=deploys,signals");
  await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
  await expect(page.locator(".ledger-month")).toBeVisible();
  await expect(page.locator("#deployments")).toBeVisible();
  await expect(page.locator(".charts > .widget").first()).toBeVisible();
  await expectStableLayout(page, testInfo, "stuff project tablet");
});
