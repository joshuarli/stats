import { expect, test, type Page } from "./fixtures";
import { fulfillHistory } from "./history-route";

const HOST_A = "h_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

function buildHostBundle(hostId: string, range: string, cpuBase: number, includePsi = true) {
  const step = range === "30d" ? 3_600_000 : range === "7d" ? 60_000 : 15_000;
  const resolution = range === "30d" ? "1h" : range === "7d" ? "1m" : "raw";
  const length = 12;
  const fromMs = NOW - step * length;
  return {
    hostId,
    histories: {
      summary: {
        hostId,
        kind: "summary",
        fromMs,
        toMs: NOW,
        resolution,
        stepMs: step,
        points: Array.from({ length }, (_, index) => {
          const user = cpuBase + index;
          return {
            atMs: fromMs + (index + 1) * step,
            coverageMs: step,
            partial: false,
            cpuCount: 16,
            uptimeMs: 3_600_000 + index * step,
            cpu: { user, system: 2, idle: 100 - user - 2, iowait: 0, steal: 0 },
            load: { one: user / 10, five: 0.5, fifteen: 0.4 },
            mem: { total: 8_589_934_592, available: 4_294_967_296, swapUsed: 134_217_728, swapInBytesPerSec: 0, swapOutBytesPerSec: 0 },
            ...(includePsi
              ? {
                  psi: {
                    cpu: { some10: 1.2, some60: 1.0, some300: 0.8 },
                    memory: { some10: 0.5, some60: 0.4, some300: 0.3, full10: 0.1, full60: 0.1, full300: 0.1 },
                    io: { some10: 0.8, some60: 0.6, some300: 0.5, full10: 0.2, full60: 0.1, full300: 0.1 }
                  }
                }
              : {})
          };
        })
      },
      disks: {
        hostId,
        kind: "disks",
        fromMs,
        toMs: NOW,
        resolution,
        stepMs: step,
        series: [{
          id: "8:0",
          name: "nvme0n1",
          points: Array.from({ length }, (_, index) => ({
            atMs: fromMs + (index + 1) * step,
            readBytesPerSec: (cpuBase + index) * 100_000,
            writeBytesPerSec: 50_000,
            readsPerSec: 10 + index,
            writesPerSec: 5,
            busyPct: (cpuBase + index) / 2
          }))
        }]
      },
      nets: {
        hostId,
        kind: "nets",
        fromMs,
        toMs: NOW,
        resolution,
        stepMs: step,
        series: [{
          id: "eth0",
          points: Array.from({ length }, (_, index) => ({
            atMs: fromMs + (index + 1) * step,
            rxBytesPerSec: (cpuBase + index) * 10_000,
            txBytesPerSec: 20_000,
            rxPacketsPerSec: 50,
            txPacketsPerSec: 40,
            rxDropsPerSec: 0,
            txDropsPerSec: 0,
            rxErrorsPerSec: 0,
            txErrorsPerSec: 0
          }))
        }]
      },
      filesystems: {
        hostId,
        kind: "filesystems",
        fromMs,
        toMs: NOW,
        resolution,
        stepMs: step,
        series: [{
          id: "/",
          points: Array.from({ length }, (_, index) => ({
            atMs: fromMs + (index + 1) * step,
            total: 100_000_000_000,
            available: 50_000_000_000
          }))
        }]
      },
      block: {
        hostId,
        kind: "block",
        fromMs,
        toMs: NOW,
        resolution,
        stepMs: step,
        series: []
      }
    }
  };
}

function buildFleetBundle(hostId: string, range: string, cpuBase: number) {
  const full = buildHostBundle(hostId, range, cpuBase, true);
  return {
    hostId,
    histories: {
      summary: full.histories.summary,
      disks: full.histories.disks,
      nets: full.histories.nets,
      filesystems: full.histories.filesystems
    }
  };
}

function buildProjectBundle(projectId: string) {
  const stepMs = 300_000;
  const points = 12;
  const fromMs = NOW - points * stepMs;
  const toMs = NOW;
  return {
    projectId,
    histories: {
      worker: {
        projectId,
        kind: "worker",
        range: "1h",
        fromMs,
        toMs,
        stepMs,
        series: [
          { metric: "worker.invocations", values: Array.from({ length: points }, (_, idx) => 100 + idx * 10) },
          { metric: "worker.cpuMsSum", values: Array.from({ length: points }, () => 300) },
          { metric: "worker.cpuMsMax", values: Array.from({ length: points }, () => 12) },
          { metric: "worker.status.2xx", values: Array.from({ length: points }, (_, idx) => 100 + idx * 10) },
          { metric: "worker.status.3xx", values: Array.from({ length: points }, () => 0) },
          { metric: "worker.status.4xx", values: Array.from({ length: points }, () => 0) },
          { metric: "worker.status.5xx", values: Array.from({ length: points }, () => 0) },
          { metric: "worker.status.other", values: Array.from({ length: points }, () => 0) }
        ]
      },
      routes: { projectId, kind: "routes", range: "1h", fromMs, toMs, stepMs, series: [] },
      r2: { projectId, kind: "r2", range: "1h", fromMs, toMs, stepMs, series: [] },
      collector: {
        projectId,
        kind: "collector",
        range: "1h",
        fromMs,
        toMs,
        stepMs,
        runs: Array.from({ length: points }, (_, index) => ({
          atMs: fromMs + index * stepMs,
          ok: true,
          detail: "ok",
          rowsRead: 1000,
          durationMs: 200
        }))
      }
    }
  };
}

async function installChartRoutes(page: Page) {
  await page.clock.install({ time: NOW });
  await page.route("**/api/v1/hosts", route => route.fulfill({
    json: {
      hosts: [{ hostId: HOST_A, name: "alpha-node", createdAtMs: NOW - 86_400_000, revoked: false, lastReceivedAtMs: NOW - 5_000, online: true }]
    }
  }));
  await page.route("**/api/v1/hosts/*/system", route => route.fulfill({
    json: {
      reportedAtMs: NOW,
      system: { agent: "0.4.0", hostname: "alpha.internal", os: "Debian 13", kernel: "6.12.0", arch: "x86_64", cpu: { model: "EPYC", threads: 16 } }
    }
  }));
  await page.route("**/api/v1/services", route => route.fulfill({ json: { services: [] } }));
}

test("charts update in place via setData on telemetry ticks and range switches, and rebuild only when construction props change", async ({ page }) => {
  await installChartRoutes(page);
  let tickCount = 0;

  await page.route("**/api/v1/hosts/*/history*", async route => {
    const url = new URL(route.request().url());
    const range = url.searchParams.get("range") ?? "1h";
    const kinds = url.searchParams.get("kinds") ?? "";
    if (!kinds.includes("block")) {
      await fulfillHistory(route, buildFleetBundle(HOST_A, range, 20));
      return;
    }
    tickCount += 1;
    const includePsi = range !== "30d";
    const base = range === "24h" ? 30 : tickCount === 1 ? 20 : 50;
    await fulfillHistory(route, buildHostBundle(HOST_A, range, base, includePsi));
  });

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.getByRole("region", { name: "Charts" })).toBeVisible();
  await expect(page.locator("#cpu .chart-plot").first()).toHaveAttribute("aria-label", "CPU; latest 33%");
  await expect(page.locator("#cpu .chart-plot")).toHaveCount(2);

  await page.evaluate(() => {
    const cpuPlot = document.querySelector("#cpu .chart-plot .uplot") as (HTMLElement & { __marker?: string }) | null;
    const loadPlot = document.querySelector("#load .chart-plot .uplot") as (HTMLElement & { __marker?: string }) | null;
    if (cpuPlot) cpuPlot.__marker = "cpu-v1";
    if (loadPlot) loadPlot.__marker = "load-v1";
  });

  await page.clock.runFor(15_000);
  await expect(page.locator("#cpu .chart-plot").first()).toHaveAttribute("aria-label", "CPU; latest 63%");

  const markersAfterTick = await page.evaluate(() => ({
    cpu: (document.querySelector("#cpu .chart-plot .uplot") as (HTMLElement & { __marker?: string }) | null)?.__marker ?? null,
    load: (document.querySelector("#load .chart-plot .uplot") as (HTMLElement & { __marker?: string }) | null)?.__marker ?? null
  }));
  expect(markersAfterTick).toEqual({ cpu: "cpu-v1", load: "load-v1" });

  await page.getByRole("button", { name: "24h", exact: true }).click();
  await expect(page.locator("#cpu .chart-plot").first()).toHaveAttribute("aria-label", "CPU; latest 43%");
  const markersAfter24h = await page.evaluate(() => ({
    cpu: (document.querySelector("#cpu .chart-plot .uplot") as (HTMLElement & { __marker?: string }) | null)?.__marker ?? null,
    load: (document.querySelector("#load .chart-plot .uplot") as (HTMLElement & { __marker?: string }) | null)?.__marker ?? null
  }));
  expect(markersAfter24h).toEqual({ cpu: "cpu-v1", load: "load-v1" });

  await page.getByRole("button", { name: "30d", exact: true }).click();
  await expect(page.locator("#cpu .chart-plot")).toHaveCount(1);
  const markersAfter30d = await page.evaluate(() => ({
    cpu: (document.querySelector("#cpu .chart-plot .uplot") as (HTMLElement & { __marker?: string }) | null)?.__marker ?? null,
    load: (document.querySelector("#load .chart-plot .uplot") as (HTMLElement & { __marker?: string }) | null)?.__marker ?? null
  }));
  expect(markersAfter30d).toEqual({ cpu: null, load: "load-v1" });
});

test("charts support resize, cross-chart cursor sync, tooltips, keyboard navigation, series toggling, and zoom/pan", async ({ page }) => {
  await installChartRoutes(page);
  await page.route("**/api/v1/hosts/*/history*", async route => {
    await fulfillHistory(route, buildHostBundle(HOST_A, "1h", 20, true));
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.getByRole("region", { name: "Charts" })).toBeVisible();

  const initialWidth = await page.evaluate(() => document.querySelector<HTMLCanvasElement>("#cpu .chart-plot canvas")?.width ?? 0);
  expect(initialWidth).toBeGreaterThan(0);

  await page.setViewportSize({ width: 1440, height: 800 });
  await expect.poll(async () => page.evaluate(() => document.querySelector<HTMLCanvasElement>("#cpu .chart-plot canvas")?.width ?? 0)).toBeGreaterThan(initialWidth);

  const cpuOver = page.locator("#cpu .chart-plot .u-over").first();
  const box = await cpuOver.boundingBox();
  if (box === null) throw new Error("missing cpu plot bounding box");
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);

  await expect(page.locator("#cpu .chart-tip").first()).toBeVisible();
  await expect(page.locator("#cpu .chart-legend thead").first()).toContainText("At cursor");
  await expect(page.locator("#load .chart-legend thead")).toContainText("At cursor");

  const cpuPlot = page.locator("#cpu .chart-plot").first();
  await page.mouse.move(0, 0);
  await cpuPlot.focus();
  await expect(page.locator("#cpu .chart-legend tbody tr").first().locator(".legend-now")).toContainText("33%");

  await page.keyboard.press("Home");
  await expect(page.locator("#cpu .chart-legend tbody tr").first().locator(".legend-now")).toContainText("22%");

  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#cpu .chart-legend tbody tr").first().locator(".legend-now")).toContainText("23%");

  await page.keyboard.press("End");
  await expect(page.locator("#cpu .chart-legend tbody tr").first().locator(".legend-now")).toContainText("33%");

  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#cpu .chart-legend tbody tr").first().locator(".legend-now")).toContainText("32%");

  const totalKey = page.locator("#cpu .chart-legend").getByRole("button", { name: "Show only total" });
  const userRow = page.locator("#cpu .chart-legend tbody tr").nth(1);
  await totalKey.click();
  await expect(totalKey).toHaveAttribute("aria-pressed", "true");
  await expect(userRow.locator(".legend-key")).toHaveAttribute("aria-pressed", "false");

  await totalKey.click();
  await expect(userRow.locator(".legend-key")).toHaveAttribute("aria-pressed", "true");

  const ramKey = page.locator("#memory .chart-inline-legend").getByRole("button", { name: /RAM used/u });
  const swapKey = page.locator("#memory .chart-inline-legend").getByRole("button", { name: /swap used/u });
  await ramKey.click({ modifiers: ["Shift"] });
  await expect(ramKey).toHaveAttribute("aria-pressed", "false");
  await expect(swapKey).toHaveAttribute("aria-pressed", "true");
  await ramKey.click({ modifiers: ["Shift"] });
  await expect(ramKey).toHaveAttribute("aria-pressed", "true");

  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: /^Reset/u })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Reset/u })).toHaveCount(0);
});

test("project charts shade unsettled provisional buckets and mark them in the tooltip", async ({ page }) => {
  await installChartRoutes(page);
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: { analyticsCollection: true, cloudflareDeployments: true, tailEvents: true, applicationEvents: true } }));
  await page.route("**/api/v1/projects", route => route.fulfill({
    json: [
      { id: "stats", name: "stats", worker: "stats", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector: { lastRunAtMs: NOW - 60_000, lastSuccessAtMs: NOW - 60_000, lastError: null, stale: false } }
    ]
  }));
  await page.route("**/api/v1/projects/stats/deployments", route => route.fulfill({
    json: { projectId: "stats", worker: "stats", enabled: false, sync: null, deployments: [], versions: [] }
  }));
  await page.route("**/api/v1/projects/stats/history*", route => fulfillHistory(route, buildProjectBundle("stats")));
  await page.route("**/api/observe/**", route => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "down" } } }));

  await page.goto("/#/project/stats?open=signals");
  await expect(page.locator("#requests .chart-plot .uplot")).toBeVisible();

  const over = page.locator("#requests .chart-plot .u-over");
  await over.scrollIntoViewIfNeeded();
  const box = await over.boundingBox();
  if (box === null) throw new Error("missing project chart bounding box");
  await page.mouse.move(box.x + box.width - 6, box.y + box.height * 0.5);
  await expect(page.locator("#requests .chart-tip")).toContainText("still arriving");
});

test("ten host mount/destroy cycles stay within memory, node, listener, observer, and sync bounds", async ({ context, page }) => {
  await page.addInitScript(() => {
    const win = window as Window & { __roActive?: Set<ResizeObserver> };
    win.__roActive = new Set<ResizeObserver>();
    const OrigRO = window.ResizeObserver;
    window.ResizeObserver = class extends OrigRO {
      override observe(target: Element, options?: ResizeObserverOptions) {
        if (target.classList.contains("chart-plot")) win.__roActive!.add(this);
        return super.observe(target, options);
      }
      override disconnect() {
        win.__roActive!.delete(this);
        return super.disconnect();
      }
    };
  });

  await installChartRoutes(page);
  await page.route("**/api/v1/hosts/*/history*", async route => {
    const kinds = new URL(route.request().url()).searchParams.get("kinds") ?? "";
    if (kinds.includes("block")) {
      await fulfillHistory(route, buildHostBundle(HOST_A, "1h", 25, true));
    } else {
      await fulfillHistory(route, buildFleetBundle(HOST_A, "1h", 25));
    }
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");

  const readCdp = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    await cdp.send("HeapProfiler.collectGarbage");
    const [{ metrics }, heap] = await Promise.all([
      cdp.send("Performance.getMetrics"),
      cdp.send("Runtime.getHeapUsage")
    ]);
    const map = Object.fromEntries(metrics.map((entry: { name: string; value: number }) => [entry.name, entry.value]));
    return {
      heapUsedBytes: heap.usedSize as number,
      heapBackingBytes: (heap.backingStorageSize ?? 0) as number,
      nodes: (map.Nodes ?? 0) as number,
      listeners: (map.JSEventListeners ?? 0) as number
    };
  };

  await page.goto("/#/");
  await page.waitForFunction(() => document.querySelector('table[aria-label="Fleet hosts"] tbody tr') !== null);
  await page.evaluate(id => { window.location.hash = `#/host/${id}`; }, HOST_A);
  await page.waitForFunction(() => document.querySelector(".chart-plot .uplot") !== null);
  await page.evaluate(() => { window.location.hash = "#/"; });
  await page.waitForFunction(() => document.querySelector('table[aria-label="Fleet hosts"] tbody tr') !== null);
  await page.evaluate(id => { window.location.hash = `#/host/${id}`; }, HOST_A);
  await page.waitForFunction(() => document.querySelector(".chart-plot .uplot") !== null);

  const before = await readCdp();

  for (let cycle = 0; cycle < 10; cycle += 1) {
    await page.evaluate(() => { window.location.hash = "#/"; });
    await page.waitForFunction(() => document.querySelector('table[aria-label="Fleet hosts"] tbody tr') !== null);
    await page.evaluate(id => { window.location.hash = `#/host/${id}`; }, HOST_A);
    await page.waitForFunction(() => document.querySelector(".chart-plot .uplot") !== null);
  }

  const after = await readCdp();
  expect(after.heapUsedBytes - before.heapUsedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(after.heapBackingBytes - before.heapBackingBytes).toBeLessThanOrEqual(1 * 1024 * 1024);
  expect(Math.abs(after.nodes - before.nodes)).toBeLessThanOrEqual(50);
  expect(Math.abs(after.listeners - before.listeners)).toBeLessThanOrEqual(10);

  await page.evaluate(() => { window.location.hash = "#/"; });
  await page.waitForFunction(() => document.querySelector('table[aria-label="Fleet hosts"] tbody tr') !== null);
  await readCdp();

  const afterLeave = await page.evaluate(() => {
    const win = window as Window & { __roActive?: Set<ResizeObserver> };
    return {
      uplotRoots: document.querySelectorAll(".uplot").length,
      activeResizeObservers: win.__roActive?.size ?? 0
    };
  });
  expect(afterLeave).toEqual({ uplotRoots: 0, activeResizeObservers: 0 });
});
