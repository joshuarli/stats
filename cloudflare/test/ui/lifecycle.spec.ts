import { expect, test, type Page, type Route } from "@playwright/test";
import { HISTORY_CONTENT_TYPE } from "../../src/binary/history";
import { fulfillHistory } from "./history-route";
import { answer, buildScenario, scenarioComparison } from "./observe-scenario";

const HOST_A = "h_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOST_B = "h_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOST_C = "h_cccccccccccccccccccccccccccccccc";
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

interface DeferredGate {
  readonly wait: Promise<void>;
  readonly release: () => void;
}

function createGate(): DeferredGate {
  let release = () => {};
  const wait = new Promise<void>(resolve => {
    release = resolve;
  });
  return { wait, release };
}

function hostBundle(hostId: string, range: string, cpuUser: number) {
  const step = range === "30d" ? 3_600_000 : range === "7d" ? 60_000 : 15_000;
  const resolution = range === "30d" ? "1h" : range === "7d" ? "1m" : "raw";
  const length = 8;
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
        points: Array.from({ length }, (_, index) => ({
          atMs: fromMs + (index + 1) * step,
          coverageMs: step,
          partial: false,
          uptimeMs: 3_600_000 + index * step,
          cpu: { user: cpuUser, system: 2, idle: 100 - cpuUser - 2, iowait: 0, steal: 0 },
          load: { one: cpuUser / 10, five: 0.5, fifteen: 0.4 },
          mem: { total: 8_589_934_592, available: 4_294_967_296, swapUsed: 0, swapInBytesPerSec: 0, swapOutBytesPerSec: 0 }
        }))
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
            readBytesPerSec: cpuUser * 100_000,
            writeBytesPerSec: 50_000,
            readsPerSec: 10,
            writesPerSec: 5,
            busyPct: cpuUser / 2
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
            rxBytesPerSec: cpuUser * 10_000,
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
          points: [
            { atMs: NOW - step, total: 100_000_000_000, available: 50_000_000_000 },
            { atMs: NOW, total: 100_000_000_000, available: 50_000_000_000 }
          ]
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

function fleetBundle(hostId: string, range: string, cpuUser: number) {
  const full = hostBundle(hostId, range, cpuUser);
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

function projectBundle(projectId: string, invocationsPerBucket: number) {
  const stepMs = 300_000;
  const points = 12;
  const fromMs = NOW - points * stepMs;
  const toMs = NOW;
  const col = (val: number) => Array.from({ length: points }, () => val);
  return {
    projectId,
    histories: {
      worker: {
        projectId,
        kind: "worker",
        fromMs,
        toMs,
        stepMs,
        series: [
          { metric: "worker.invocations", values: col(invocationsPerBucket) },
          { metric: "worker.cpuMsSum", values: col(invocationsPerBucket * 3) },
          { metric: "worker.cpuMsMax", values: col(12) },
          { metric: "worker.status.2xx", values: col(invocationsPerBucket) },
          { metric: "worker.status.3xx", values: col(0) },
          { metric: "worker.status.4xx", values: col(0) },
          { metric: "worker.status.5xx", values: col(0) },
          { metric: "worker.status.other", values: col(0) }
        ]
      },
      routes: {
        projectId,
        kind: "routes",
        fromMs,
        toMs,
        stepMs,
        series: [
          { metric: "route.GET /api.invocations", values: col(invocationsPerBucket) },
          { metric: "route.GET /api.cpuMsSum", values: col(invocationsPerBucket * 2) }
        ]
      },
      r2: {
        projectId,
        kind: "r2",
        fromMs,
        toMs,
        stepMs,
        series: []
      },
      collector: {
        projectId,
        kind: "collector",
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

const THREE_HOSTS = [
  { hostId: HOST_A, name: "alpha-node", createdAtMs: NOW - 86_400_000, revoked: false, lastReceivedAtMs: NOW - 5_000, online: true },
  { hostId: HOST_B, name: "bravo-node", createdAtMs: NOW - 86_400_000, revoked: false, lastReceivedAtMs: NOW - 5_000, online: true },
  { hostId: HOST_C, name: "charlie-node", createdAtMs: NOW - 86_400_000, revoked: false, lastReceivedAtMs: NOW - 5_000, online: true }
];

async function installBaseRoutes(page: Page) {
  await page.clock.install({ time: NOW });
  await page.route("**/api/v1/hosts", route => route.fulfill({ json: { hosts: THREE_HOSTS } }));
  await page.route("**/api/v1/hosts/*/system", route => {
    const id = /\/hosts\/([^/]+)\/system/u.exec(route.request().url())?.[1] ?? HOST_A;
    const label = id === HOST_A ? "alpha" : id === HOST_B ? "bravo" : "charlie";
    return route.fulfill({
      json: {
        reportedAtMs: NOW,
        system: { agent: "0.4.0", hostname: `${label}.internal`, os: "Debian 13", kernel: "6.12.0", arch: "x86_64", cpu: { model: "EPYC", threads: 16 } }
      }
    });
  });
  await page.route("**/api/v1/services", route => route.fulfill({ json: { services: [] } }));
}

test("host A to B navigation aborts A's deferred history and renders only B", async ({ page }) => {
  await installBaseRoutes(page);
  const gateA = createGate();
  const aborted: string[] = [];
  page.on("requestfailed", req => {
    if (req.url().includes("/history")) aborted.push(new URL(req.url()).pathname);
  });

  await page.route("**/api/v1/hosts/*/history*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes(HOST_A)) {
      await gateA.wait;
      try {
        await fulfillHistory(route, hostBundle(HOST_A, "1h", 20));
      } catch {}
      return;
    }
    await fulfillHistory(route, hostBundle(HOST_B, "1h", 75));
  });

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.getByRole("heading", { name: "alpha-node", level: 1 })).toBeVisible();
  await expect(page.locator(".ui-skeleton").first()).toBeVisible();

  await page.evaluate(id => { window.location.hash = `#/host/${id}`; }, HOST_B);
  await expect(page.getByRole("heading", { name: "bravo-node", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Charts" })).toBeVisible();
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("77%");

  await expect.poll(() => aborted.some(path => path.includes(HOST_A))).toBe(true);
  gateA.release();
  await expect(page.getByRole("heading", { name: "bravo-node", level: 1 })).toBeVisible();
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("77%");
});

test("project A to B navigation at the same range never shows A's data under B", async ({ page }) => {
  await installBaseRoutes(page);
  const gateB = createGate();
  const aborted: string[] = [];
  page.on("requestfailed", req => {
    if (req.url().includes("/projects/")) aborted.push(new URL(req.url()).pathname);
  });

  await page.route("**/api/v1/projects", route => route.fulfill({
    json: [
      { id: "alpha", name: "alpha", worker: "alpha", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector: { lastRunAtMs: NOW - 60_000, lastSuccessAtMs: NOW - 60_000, lastError: null, stale: false } },
      { id: "bravo", name: "bravo", worker: "bravo", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector: { lastRunAtMs: NOW - 60_000, lastSuccessAtMs: NOW - 60_000, lastError: null, stale: false } }
    ]
  }));
  await page.route("**/api/v1/projects/*/deployments", route => {
    const projectId = /\/projects\/([^/]+)\/deployments/u.exec(route.request().url())?.[1] ?? "alpha";
    return route.fulfill({ json: { projectId, worker: projectId, enabled: true, sync: null, deployments: [], versions: [] } });
  });
  await page.route("**/api/v1/projects/*/history*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/projects/bravo/")) {
      await gateB.wait;
      await fulfillHistory(route, projectBundle("bravo", 5_000));
      return;
    }
    await fulfillHistory(route, projectBundle("alpha", 1_000));
  });

  await page.goto("/#/project/alpha");
  await expect(page.getByRole("heading", { name: "alpha", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Cost ledger" })).toContainText("288,000 req");

  await page.evaluate(() => { window.location.hash = "#/project/bravo"; });
  await expect(page.getByRole("heading", { name: "bravo", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Cost ledger" })).toHaveCount(0);
  await expect(page.locator(".skeleton-ledger")).toBeVisible();

  gateB.release();
  await expect(page.getByRole("region", { name: "Cost ledger" })).toContainText("1,440,000 req");
});

test("host A to B where B fails never shows A's data under B", async ({ page }) => {
  await installBaseRoutes(page);
  await page.route("**/api/v1/hosts/*/history*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes(HOST_B)) {
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "failed" } } });
      return;
    }
    await fulfillHistory(route, hostBundle(HOST_A, "1h", 25));
  });

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.getByRole("heading", { name: "alpha-node", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Charts" })).toBeVisible();
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("27%");

  await page.evaluate(id => { window.location.hash = `#/host/${id}`; }, HOST_B);
  await expect(page.getByRole("heading", { name: "bravo-node", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Charts" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("The telemetry service returned 500.");
});

test("rapid A to B to C to A navigation aborts intermediate loads and settles on A", async ({ page }) => {
  await installBaseRoutes(page);
  const gateB = createGate();
  const gateC = createGate();
  const aborted: string[] = [];
  page.on("requestfailed", req => {
    if (req.url().includes("/history")) aborted.push(new URL(req.url()).pathname);
  });

  await page.route("**/api/v1/hosts/*/history*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes(HOST_B)) {
      await gateB.wait;
      try { await fulfillHistory(route, hostBundle(HOST_B, "1h", 60)); } catch {}
      return;
    }
    if (url.pathname.includes(HOST_C)) {
      await gateC.wait;
      try { await fulfillHistory(route, hostBundle(HOST_C, "1h", 80)); } catch {}
      return;
    }
    await fulfillHistory(route, hostBundle(HOST_A, "1h", 18));
  });

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.getByRole("heading", { name: "alpha-node", level: 1 })).toBeVisible();
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("20%");

  await page.evaluate(id => { window.location.hash = `#/host/${id}`; }, HOST_B);
  await expect.poll(() => page.url()).toContain(HOST_B);
  await page.evaluate(id => { window.location.hash = `#/host/${id}`; }, HOST_C);
  await expect.poll(() => page.url()).toContain(HOST_C);
  await page.evaluate(id => { window.location.hash = `#/host/${id}`; }, HOST_A);

  await expect(page.getByRole("heading", { name: "alpha-node", level: 1 })).toBeVisible();
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("20%");
  await expect.poll(() => aborted.some(path => path.includes(HOST_B))).toBe(true);
  await expect.poll(() => aborted.some(path => path.includes(HOST_C))).toBe(true);

  gateB.release();
  gateC.release();
  await expect(page.getByRole("heading", { name: "alpha-node", level: 1 })).toBeVisible();
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("20%");
});

test("a range change whose history fails never keeps the previous range's charts", async ({ page }) => {
  await installBaseRoutes(page);
  await page.route("**/api/v1/hosts/*/history*", async route => {
    const range = new URL(route.request().url()).searchParams.get("range") ?? "1h";
    if (range === "7d") {
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "failed" } } });
      return;
    }
    await fulfillHistory(route, hostBundle(HOST_A, "1h", 25));
  });

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("27%");

  await page.getByRole("button", { name: "7d", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The telemetry service returned 500.");
  await expect(page.getByRole("region", { name: "Charts" })).toHaveCount(0);
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toHaveCount(0);
});

test("range change while a history downloads aborts the earlier range across resolutions", async ({ page }) => {
  await installBaseRoutes(page);
  const gate7d = createGate();
  const abortedRanges: string[] = [];
  page.on("requestfailed", req => {
    const range = new URL(req.url()).searchParams.get("range");
    if (range !== null) abortedRanges.push(range);
  });

  await page.route("**/api/v1/hosts/*/history*", async route => {
    const range = new URL(route.request().url()).searchParams.get("range") ?? "1h";
    if (range === "7d") {
      await gate7d.wait;
      try { await fulfillHistory(route, hostBundle(HOST_A, "7d", 40)); } catch {}
      return;
    }
    if (range === "30d") {
      await fulfillHistory(route, hostBundle(HOST_A, "30d", 85));
      return;
    }
    await fulfillHistory(route, hostBundle(HOST_A, "1h", 15));
  });

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("17%");

  await page.getByRole("button", { name: "7d", exact: true }).click();
  await page.getByRole("button", { name: "30d", exact: true }).click();

  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("87%");
  await expect(page.getByRole("button", { name: "30d", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status", { name: "Visible time window" })).toContainText("Past 30 days");
  await expect.poll(() => abortedRanges).toContain("7d");
  gate7d.release();
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("87%");
});

test("live, paused, and zoomed states respect the 15-second poll boundary and document.hidden", async ({ page }) => {
  await installBaseRoutes(page);
  const perHostCalls = new Map<string, number>();
  await page.route("**/api/v1/hosts/*/history*", async route => {
    const id = /\/hosts\/([^/]+)\/history/u.exec(route.request().url())?.[1] ?? HOST_A;
    const next = (perHostCalls.get(id) ?? 0) + 1;
    perHostCalls.set(id, next);
    const kinds = new URL(route.request().url()).searchParams.get("kinds") ?? "";
    if (kinds.includes("block")) {
      await fulfillHistory(route, hostBundle(id, "1h", 20 + next));
    } else {
      await fulfillHistory(route, fleetBundle(id, "1h", 20 + next));
    }
  });

  await page.goto("/#/");
  await expect(page.getByRole("table", { name: "Fleet hosts" })).toBeVisible();
  expect(perHostCalls.get(HOST_A)).toBe(1);
  expect(perHostCalls.get(HOST_B)).toBe(1);
  expect(perHostCalls.get(HOST_C)).toBe(1);

  await page.clock.runFor(15_000);
  await expect.poll(() => perHostCalls.get(HOST_A)).toBe(2);
  expect(perHostCalls.get(HOST_B)).toBe(2);
  expect(perHostCalls.get(HOST_C)).toBe(2);

  let historyCalls = 0;
  await page.route("**/api/v1/hosts/*/history*", async route => {
    historyCalls += 1;
    await fulfillHistory(route, hostBundle(HOST_A, "1h", 20 + historyCalls));
  });

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.getByRole("region", { name: "Charts" })).toBeVisible();
  expect(historyCalls).toBe(1);

  await page.clock.runFor(15_000);
  await expect.poll(() => historyCalls).toBe(2);

  await page.getByRole("button", { name: /^Live/u }).click();
  await expect(page.getByRole("button", { name: /^Live/u })).toHaveAttribute("aria-pressed", "false");
  await page.clock.runFor(15_000);
  expect(historyCalls).toBe(2);

  await page.getByRole("button", { name: /^Live/u }).click();
  await expect(page.getByRole("button", { name: /^Live/u })).toHaveAttribute("aria-pressed", "true");

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  });
  await page.clock.runFor(15_000);
  expect(historyCalls).toBe(2);

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });
  await page.clock.runFor(15_000);
  await expect.poll(() => historyCalls).toBe(3);

  const plot = page.locator(".chart-plot .u-over").first();
  const box = await plot.boundingBox();
  if (box === null) throw new Error("missing plot box");
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: /^Reset/u })).toBeVisible();
  const afterZoomCalls = historyCalls;

  await page.clock.runFor(15_000);
  expect(historyCalls).toBe(afterZoomCalls);
});

test("manual refresh during an automatic tick and overlapping 304 revalidation settle cleanly", async ({ page }) => {
  await installBaseRoutes(page);
  const gateRefresh = createGate();
  let callCount = 0;
  let sawIfNoneMatch = false;
  const etag = 'W/"host-a-1h-v1"';

  await page.route("**/api/v1/hosts/*/history*", async (route: Route) => {
    callCount += 1;
    if (route.request().headers()["if-none-match"] === etag) {
      sawIfNoneMatch = true;
      if (callCount === 2) await gateRefresh.wait;
      await route.fulfill({ status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
      return;
    }
    await fulfillHistory(route, hostBundle(HOST_A, "1h", 33));
  });

  await page.addInitScript((tag: string) => {
    const origFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await origFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/history") && response.status === 200) {
        const headers = new Headers(response.headers);
        headers.set("ETag", tag);
        return new Response(await response.arrayBuffer(), { status: 200, headers });
      }
      return response;
    };
  }, etag);

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("35%");
  expect(callCount).toBe(1);

  await page.clock.runFor(15_000);
  await expect.poll(() => callCount).toBe(2);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  gateRefresh.release();

  await expect.poll(() => sawIfNoneMatch).toBe(true);
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("35%");
  await expect(page.locator(".notice-warn")).toHaveCount(0);
});

test("malformed history frame and auth 401 during refresh surface explicit errors", async ({ page }) => {
  await installBaseRoutes(page);
  let mode: "ok" | "401" | "malformed" = "ok";

  await page.route("**/api/v1/hosts/*/history*", async route => {
    if (mode === "401") {
      await route.fulfill({ status: 401, json: { error: { code: "unauthorized", message: "unauthorized" } } });
      return;
    }
    if (mode === "malformed") {
      await route.fulfill({ status: 200, contentType: HISTORY_CONTENT_TYPE, body: "bad" });
      return;
    }
    await fulfillHistory(route, hostBundle(HOST_A, "1h", 22));
  });

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("24%");

  mode = "401";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".notice-warn")).toContainText("Sign in through Cloudflare Access.");
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("24%");
  await expect(page.getByRole("region", { name: "Charts" })).toBeVisible();

  mode = "malformed";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".notice-warn")).toContainText("The response did not match the telemetry contract.");
  await expect(page.locator(".strip-cell", { hasText: "CPU" })).toContainText("24%");
  await expect(page.getByRole("region", { name: "Charts" })).toBeVisible();
});

test("disposal during an active chart load aborts the load and leaves no uplot roots", async ({ page }) => {
  await installBaseRoutes(page);
  const gate = createGate();
  let aborted = false;
  page.on("requestfailed", req => {
    if (req.url().includes("/history")) aborted = true;
  });

  await page.route("**/api/v1/hosts/*/history*", async route => {
    await gate.wait;
    try { await fulfillHistory(route, hostBundle(HOST_A, "1h", 30)); } catch {}
  });

  await page.goto(`/#/host/${HOST_A}`);
  await expect(page.getByRole("heading", { name: "alpha-node", level: 1 })).toBeVisible();

  await page.evaluate(() => { window.location.hash = "#/services"; });
  await expect(page.getByText("No services are configured.")).toBeVisible();
  await expect.poll(() => aborted).toBe(true);

  gate.release();
  const uplotCount = await page.evaluate(() => document.querySelectorAll(".uplot").length);
  expect(uplotCount).toBe(0);
});

test("fleet requests /system only on mount and manual refresh, and filtering or sorting issues no host requests", async ({ page }) => {
  await installBaseRoutes(page);
  let systemCalls = 0;
  let historyCalls = 0;

  await page.route("**/api/v1/hosts/*/system", route => {
    systemCalls += 1;
    const id = /\/hosts\/([^/]+)\/system/u.exec(route.request().url())?.[1] ?? HOST_A;
    const label = id === HOST_A ? "alpha" : id === HOST_B ? "bravo" : "charlie";
    return route.fulfill({
      json: {
        reportedAtMs: NOW,
        system: { agent: "0.4.0", hostname: `${label}.internal`, os: "Debian 13", kernel: "6.12.0", arch: "x86_64", cpu: { model: "EPYC", threads: 16 } }
      }
    });
  });

  await page.route("**/api/v1/hosts/*/history*", async route => {
    historyCalls += 1;
    const id = /\/hosts\/([^/]+)\/history/u.exec(route.request().url())?.[1] ?? HOST_A;
    const cpu = id === HOST_A ? 40 : id === HOST_B ? 20 : 60;
    await fulfillHistory(route, fleetBundle(id, "1h", cpu));
  });

  await page.goto("/#/");
  await expect(page.getByRole("table", { name: "Fleet hosts" })).toContainText("charlie-node");
  expect(systemCalls).toBe(3);
  expect(historyCalls).toBe(3);

  await page.getByRole("searchbox", { name: "Search hosts" }).fill("bravo");
  await expect(page.getByRole("table", { name: "Fleet hosts" }).locator("tbody tr")).toHaveCount(1);
  expect(systemCalls).toBe(3);
  expect(historyCalls).toBe(3);

  await page.getByRole("searchbox", { name: "Search hosts" }).fill("");
  await expect(page.getByRole("table", { name: "Fleet hosts" }).locator("tbody tr")).toHaveCount(3);
  expect(systemCalls).toBe(3);
  expect(historyCalls).toBe(3);

  await page.getByRole("columnheader", { name: "Host" }).getByRole("button").click();
  expect(systemCalls).toBe(3);
  expect(historyCalls).toBe(3);

  await page.clock.runFor(15_000);
  await expect.poll(() => historyCalls).toBe(6);
  expect(systemCalls).toBe(3);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => historyCalls).toBe(9);
  await expect.poll(() => systemCalls).toBe(6);
});

test("fleet scheduler keeps concurrency at most 4, starts the 5th host before slow earlier hosts finish, and requests only visible page hosts", async ({ page }) => {
  await page.clock.install({ time: NOW });
  const twelveHosts = Array.from({ length: 12 }, (_, index) => {
    const hex = index.toString(16).padStart(2, "0");
    return {
      hostId: `h_${hex.repeat(16)}`,
      name: `node-${String(index + 1).padStart(2, "0")}`,
      createdAtMs: NOW - 86_400_000,
      revoked: false,
      lastReceivedAtMs: NOW - 5_000,
      online: true
    };
  });
  const slowGate = createGate();
  const seenHosts = new Set<string>();
  let inFlightHistories = 0;
  let maxInFlightHistories = 0;
  let fifthStartedWhileSlowPending = false;
  let slowPending = true;

  await page.route("**/api/v1/hosts", route => route.fulfill({ json: { hosts: twelveHosts } }));
  await page.route("**/api/v1/services", route => route.fulfill({ json: { services: [] } }));
  await page.route("**/api/v1/hosts/*/system", route => route.fulfill({
    json: { reportedAtMs: NOW, system: { agent: "0.4.0", hostname: "node", os: "Debian 13", kernel: "6.12.0", arch: "x86_64", cpu: { model: "EPYC", threads: 16 } } }
  }));

  await page.route("**/api/v1/hosts/*/history*", async route => {
    const id = /\/hosts\/([^/]+)\/history/u.exec(route.request().url())?.[1] ?? twelveHosts[0]!.hostId;
    seenHosts.add(id);
    inFlightHistories += 1;
    if (inFlightHistories > maxInFlightHistories) maxInFlightHistories = inFlightHistories;
    if (id === twelveHosts[4]!.hostId && slowPending) fifthStartedWhileSlowPending = true;
    if (id === twelveHosts[0]!.hostId || id === twelveHosts[1]!.hostId || id === twelveHosts[2]!.hostId) {
      await slowGate.wait;
    }
    inFlightHistories -= 1;
    await fulfillHistory(route, fleetBundle(id, "1h", 25));
  });

  await page.goto("/#/");
  await expect.poll(() => fifthStartedWhileSlowPending).toBe(true);
  slowPending = false;
  slowGate.release();

  await expect(page.getByRole("table", { name: "Fleet hosts" }).locator("tbody tr")).toHaveCount(10);
  expect(maxInFlightHistories).toBeLessThanOrEqual(4);
  expect(seenHosts.size).toBe(10);
  expect(seenHosts.has(twelveHosts[10]!.hostId)).toBe(false);
  expect(seenHosts.has(twelveHosts[11]!.hostId)).toBe(false);
});

test("projects overview requests no from=0 or eager range history, reuses ledger histories for trends, and falls back to range history on ledger failure", async ({ page }) => {
  await installBaseRoutes(page);
  const historyUrls: string[] = [];

  await page.route("**/api/v1/projects", route => route.fulfill({
    json: [
      { id: "alpha", name: "alpha", worker: "alpha", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector: { lastRunAtMs: NOW - 60_000, lastSuccessAtMs: NOW - 60_000, lastError: null, stale: false } },
      { id: "broken", name: "broken", worker: "broken", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector: { lastRunAtMs: NOW - 60_000, lastSuccessAtMs: NOW - 60_000, lastError: null, stale: false } }
    ]
  }));
  await page.route("**/api/v1/projects/*/deployments", route => {
    const projectId = /\/projects\/([^/]+)\/deployments/u.exec(route.request().url())?.[1] ?? "alpha";
    return route.fulfill({ json: { projectId, worker: projectId, enabled: true, sync: null, deployments: [], versions: [] } });
  });
  await page.route("**/api/v1/projects/*/history*", async route => {
    const url = new URL(route.request().url());
    historyUrls.push(`${url.pathname}${url.search}`);
    if (url.pathname.includes("/projects/broken/") && url.searchParams.has("from")) {
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "ledger failed" } } });
      return;
    }
    const projectId = url.pathname.includes("/projects/broken/") ? "broken" : "alpha";
    await fulfillHistory(route, projectBundle(projectId, 500));
  });

  await page.goto("/#/projects");
  await expect(page.getByRole("table", { name: "Projects" })).toContainText("alpha");
  await expect(page.getByRole("table", { name: "Projects" })).toContainText("unavailable");

  expect(historyUrls.some(url => url.includes("from=0"))).toBe(false);
  expect(historyUrls.some(url => url.includes("range="))).toBe(false);

  const countBeforeAlphaExpand = historyUrls.length;
  await page.getByRole("button", { name: "Show alpha trends" }).click();
  await expect(page.locator(".projects-trends").first()).toBeVisible();
  expect(historyUrls.length).toBe(countBeforeAlphaExpand);

  await page.getByRole("button", { name: "Show broken trends" }).click();
  await expect.poll(() => historyUrls.some(url => url.includes("/projects/broken/history?range=1h"))).toBe(true);
  await expect(page.locator(".projects-trends")).toHaveCount(2);
});

test("a paused projects overview requests no ledger history as the wall clock rolls past a bucket", async ({ page }) => {
  await installBaseRoutes(page);
  const historyUrls: string[] = [];
  await page.route("**/api/v1/projects", route => route.fulfill({
    json: [{ id: "alpha", name: "alpha", worker: "alpha", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector: { lastRunAtMs: NOW - 60_000, lastSuccessAtMs: NOW - 60_000, lastError: null, stale: false } }]
  }));
  await page.route("**/api/v1/projects/*/deployments", route => route.fulfill({ json: { projectId: "alpha", worker: "alpha", enabled: true, sync: null, deployments: [], versions: [] } }));
  await page.route("**/api/v1/projects/*/history*", async route => {
    const url = new URL(route.request().url());
    historyUrls.push(`${url.pathname}${url.search}`);
    await fulfillHistory(route, projectBundle("alpha", 500));
  });

  await page.goto("/#/projects");
  await expect(page.getByRole("table", { name: "Projects" })).toContainText("/mo");
  await page.getByRole("button", { name: /^Live/u }).click();
  await expect(page.getByRole("button", { name: /^Live/u })).toHaveAttribute("aria-pressed", "false");
  const settled = historyUrls.length;
  await page.clock.runFor(10 * 60_000);
  await expect(page.getByRole("table", { name: "Projects" })).toContainText("/mo");
  expect(historyUrls.slice(settled)).toEqual([]);
});

test("closed project page defers comparison and occurrences until their sections open", async ({ page }) => {
  await installBaseRoutes(page);
  const scenario = await buildScenario(NOW);
  let comparisonCalls = 0;
  let occurrenceCalls = 0;
  let healthCalls = 0;
  let issuesCalls = 0;

  await page.route("**/api/v1/projects", route => route.fulfill({
    json: [
      { id: "stats", name: "stats", worker: "stats", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: ["b25c2595ba784bb1bd51a87a3e87c62b"], d1Databases: [], probes: [], collector: { lastRunAtMs: NOW - 60_000, lastSuccessAtMs: NOW - 60_000, lastError: null, stale: false } }
    ]
  }));
  await page.route("**/api/v1/projects/stats/deployments", route => route.fulfill({ json: scenario.deployments }));
  await page.route("**/api/v1/projects/stats/deployments/*/comparison*", route => {
    comparisonCalls += 1;
    const match = /\/deployments\/([^/]+)\/comparison/u.exec(route.request().url());
    const body = scenarioComparison(scenario, match?.[1] ?? "", "1h");
    return route.fulfill({ json: body ?? {} });
  });
  await page.route("**/api/v1/projects/stats/history*", route => fulfillHistory(route, projectBundle("stats", 1_000)));
  await page.route("**/api/observe/stats/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice("/api/observe/stats".length);
    if (path === "/health") healthCalls += 1;
    if (path === "/issues") issuesCalls += 1;
    if (path.endsWith("/occurrences")) occurrenceCalls += 1;
    const response = await answer(scenario, NOW, new Request(`https://observe${path}${url.search}`, { method: route.request().method() }));
    return route.fulfill({ status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: await response.text() });
  });

  await page.goto("/#/project/stats");
  await expect(page.getByRole("heading", { name: "stats", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Cost ledger" })).toBeVisible();
  await expect.poll(() => healthCalls).toBe(1);
  await expect.poll(() => issuesCalls).toBe(1);
  expect(comparisonCalls).toBe(0);
  expect(occurrenceCalls).toBe(0);

  await page.getByRole("button", { name: /Deployments/u }).click();
  await expect.poll(() => comparisonCalls).toBe(1);
  expect(occurrenceCalls).toBe(0);

  await page.getByRole("button", { name: /Errors/u }).click();
  await expect.poll(() => occurrenceCalls).toBe(1);
});
