import { expect, test, type Page } from "@playwright/test";

const hostId = "h_0123456789abcdef0123456789abcdef";
const now = Date.now();

function summary(range: string, empty = false) {
  const length = empty ? 0 : 12;
  const step = range === "90d" ? 3_600_000 : range === "7d" ? 60_000 : 15_000;
  return {
    hostId, range, kind: "summary", fromMs: now - step * length, toMs: now,
    resolution: range === "90d" ? "1h" : range === "7d" ? "1m" : "raw", stepMs: step,
    points: Array.from({ length }, (_, index) => ({
      atMs: now - (length - index) * step,
      coverageMs: step,
      partial: false,
      cpu: { user: index >= 8 ? 93 : 8 + index, system: 3, idle: 80, iowait: 1, steal: 0 },
      load: { one: 0.4 + index / 100, five: 0.5, fifteen: 0.6 },
      mem: { total: 8_589_934_592, available: 4_294_967_296 - index * 1_000_000, swapUsed: 0, swapInBytesPerSec: 4096 * index, swapOutBytesPerSec: 8192 },
      psi: { cpu: { some10: 1.2, some60: 0.8, some300: 0.4 }, memory: { some10: 0.1, some60: 0.05, some300: 0.02, full10: 0.05, full60: 0.03, full300: 0.01 }, io: { some10: 0.3, some60: 0.2, some300: 0.1 } }
    }))
  };
}

function disks(range: string, empty = false) {
  return { hostId, range, kind: "disks", fromMs: now - 3_600_000, toMs: now, resolution: "raw", stepMs: 15_000, series: empty ? [] : [{ id: "8:0", name: "sda", points: Array.from({ length: 6 }, (_, index) => ({ atMs: now - (6 - index) * 15_000, readBytesPerSec: 1_000_000 + index * 1000, writeBytesPerSec: 500_000, readsPerSec: 20, writesPerSec: 10, busyPct: 4 })) }] };
}

function nets(range: string, empty = false) {
  return { hostId, range, kind: "nets", fromMs: now - 3_600_000, toMs: now, resolution: "raw", stepMs: 15_000, series: empty ? [] : [{ id: "eth0", points: Array.from({ length: 6 }, (_, index) => ({ atMs: now - (6 - index) * 15_000, rxBytesPerSec: 200_000 + index * 1000, txBytesPerSec: 100_000, rxPacketsPerSec: 100, txPacketsPerSec: 80, rxDropsPerSec: 0, txDropsPerSec: 0, rxErrorsPerSec: 0, txErrorsPerSec: 0 })) }] };
}

function filesystems(range: string, empty = false) {
  return { hostId, range, kind: "filesystems", fromMs: now - 3_600_000, toMs: now, resolution: "raw", stepMs: 15_000, series: empty ? [] : [{ id: "/", points: [{ atMs: now - 15_000, total: 100_000_000_000, available: 40_000_000_000 }, { atMs: now, total: 100_000_000_000, available: 39_000_000_000 }] }] };
}

function block(range: string, empty = false) {
  return { hostId, range, kind: "block", fromMs: now - 3_600_000, toMs: now, resolution: "raw", stepMs: 15_000, series: empty ? [] : [{ id: "block", points: [{ atMs: now - 15_000, count: 110, totalUs: 600_000, minUs: 1_500, maxUs: 45_000, p50Us: 5_000, p95Us: 25_000, p99Us: 45_000 }, { atMs: now, count: 90, totalUs: 500_000, minUs: 1_200, maxUs: 40_000, p50Us: 4_000, p95Us: 20_000, p99Us: 40_000 }] }] };
}

async function mock(page: Page, options: { online?: boolean; empty?: boolean; system?: boolean } = {}): Promise<string[]> {
  const requests: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const range = url.searchParams.get("range") ?? "1h";
    const kind = url.searchParams.get("kind") ?? "summary";
    if (url.pathname === "/api/v1/hosts") {
      return route.fulfill({ json: { hosts: [{ hostId, name: "alpha", createdAtMs: now - 100_000, revoked: false, lastReceivedAtMs: options.online === false ? now - 120_000 : now - 5_000, online: options.online !== false }] } });
    }
    if (url.pathname.endsWith("/system")) {
      if (options.system === false) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "no system details for host" } } });
      return route.fulfill({ json: { hostId, reportedAtMs: now - 60_000, system: { agent: "0.1.0", hostname: "alpha-box", os: "Alpine Linux edge", kernel: "7.2.9-2-stable", arch: "x86_64", cpu: { model: "AMD Ryzen 9 9950X 16-Core Processor", threads: 32, cores: 16, sockets: 1, maxMhz: 5756 } } } });
    }
    const empty = options.empty === true;
    if (kind === "disks") return route.fulfill({ json: disks(range, empty) });
    if (kind === "nets") return route.fulfill({ json: nets(range, empty) });
    if (kind === "filesystems") return route.fulfill({ json: filesystems(range, empty) });
    if (kind === "block") return route.fulfill({ json: block(range, empty) });
    const body = summary(range, empty);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from !== null && to !== null) {
      return route.fulfill({ json: { ...body, fromMs: Number(from), toMs: Number(to), points: body.points.slice(0, 4).map((point, index) => ({ ...point, atMs: Number(to) - (4 - index) * 15_000 })) } });
    }
    return route.fulfill({ json: body });
  });
  return requests;
}

test("fleet and host views render charts, ranges, and keyboard controls", async ({ page }, testInfo) => {
  const requests = await mock(page);
  await page.goto("/");
  const fleetTable = page.locator("table");
  await expect(fleetTable.getByRole("link", { name: "alpha" })).toBeVisible();
  await expect(fleetTable).toContainText("online");
  await expect(page.getByRole("img", { name: "alpha CPU trend" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("fleet.png"), fullPage: true });

  await fleetTable.getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "alpha" })).toBeVisible();
  const system = page.getByRole("region", { name: "System" });
  await expect(system).toContainText("AMD Ryzen 9 9950X 16-Core Processor");
  await expect(system).toContainText("16 cores · 32 threads · 1 socket · up to 5.76 GHz");
  await expect(system).toContainText("Alpine Linux edge");
  await expect(system).toContainText("kernel 7.2.9-2-stable · x86_64");
  await expect(system).toContainText("alpha-box");
  await expect(system).toContainText("8 GiB");
  await expect(page.getByLabel("Host metadata")).toHaveCount(0);
  const incidents = page.getByRole("list", { name: "Incidents" });
  await expect(incidents).toContainText("CPU");
  await expect(incidents).toContainText("Critical");
  await expect(incidents).toContainText("ongoing");
  await expect(page.getByRole("button", { name: /^CPU: .*Jump to chart/ })).toContainText("Critical");
  const cpuChart = page.getByRole("img", { name: /CPU;/ });
  await expect(cpuChart).toBeVisible();
  await expect(cpuChart).toHaveAttribute("tabindex", "0");
  await cpuChart.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".chart-tip").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "1h" })).toHaveAttribute("aria-pressed", "true");
  const load = await page.evaluate(() => Math.round(performance.getEntriesByType("navigation")[0]?.duration ?? 0));
  console.log(`dashboard load ${load} ms`);

  for (const range of ["6h", "24h", "7d", "90d"]) {
    await page.getByRole("button", { name: range }).click();
    await expect(page.getByRole("button", { name: range })).toHaveAttribute("aria-pressed", "true");
    expect(requests.some(request => request.includes(`range=${range}`))).toBe(true);
  }
  await page.getByRole("button", { name: "24h" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table", { name: "Disk activity" })).toContainText("sda");
  await expect(page.getByRole("table", { name: "Network activity" })).toContainText("eth0");
  await expect(page.getByRole("table", { name: "Filesystem capacity" })).toContainText("not enough history");
  for (const panel of ["CPU pressure:", "Memory pressure:", "I/O pressure:"]) await expect(page.getByText(panel)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pressure" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Full stalls" })).toHaveCount(0);
  for (const title of ["Incidents", "CPU", "Load", "Memory", "Disk", "Network", "Filesystems"]) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Block latency" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Block latency;/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("host.png"), fullPage: true });
});

test("the CPU and load charts compare against the same window yesterday", async ({ page, isMobile }) => {
  test.skip(isMobile, "the legend rows are checked on desktop");
  const requests = await mock(page);
  await page.goto("/");
  await page.locator("table").getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "CPU" })).toBeVisible();
  await expect(page.getByRole("row", { name: /yesterday/ })).toHaveCount(2);
  const day = 24 * 60 * 60 * 1000;
  await expect.poll(() => requests.some(request => {
    const match = /[?&]from=(\d+)&to=(\d+)&kind=summary/u.exec(request);
    return match !== null && Date.now() - Number(match[2]) > day - 60_000 && Date.now() - Number(match[2]) < day + 60_000;
  })).toBe(true);
});

test("zooming to an incident narrows every chart to it", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.locator("table").getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("list", { name: "Incidents" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Reset/ })).toHaveCount(0);
  await page.getByRole("list", { name: "Incidents" }).getByRole("button", { name: "Zoom" }).first().click();
  await expect(page.getByRole("button", { name: /Reset/ })).toBeVisible();
});

test("missing and stale data never become zero", async ({ page }) => {
  await mock(page, { online: false, empty: true, system: false });
  await page.goto("/");
  await expect(page.locator("table")).toContainText("stale");
  await page.locator("table").getByRole("link", { name: "alpha" }).click();
  await expect(page.getByText("No samples were accepted in this range.")).toBeVisible();
  await expect(page.getByText("This host has not reported system details.")).toBeVisible();
});

test("host summary rebuilds after an empty range becomes populated", async ({ page }) => {
  const options = { empty: true };
  await mock(page, options);
  await page.goto("/");
  await page.locator("table").getByRole("link", { name: "alpha" }).click();
  await expect(page.getByText("No samples were accepted in this range.")).toBeVisible();
  options.empty = false;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("img", { name: /CPU;/ })).toBeVisible();
  await expect(page.getByText("No samples were accepted in this range.")).toHaveCount(0);
});

test("fleet charts keep a stale host that has points", async ({ page }) => {
  await mock(page, { online: false });
  await page.goto("/");
  await expect(page.locator("table")).toContainText("stale");
  await expect(page.locator("table")).toContainText("alpha");
  await expect(page.locator(".chart-empty")).toHaveCount(0);
});

test("search filters the fleet and status facets narrow it", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  const table = page.locator("table");
  await expect(table).toContainText("alpha");

  const search = page.getByRole("searchbox", { name: "Search hosts" });
  await search.fill("no-such-host");
  await expect(page.getByText("No hosts match this view.")).toBeVisible();
  await expect(table).toHaveCount(0);
  await search.fill("alpha");
  await expect(table).toContainText("alpha");

  await page.getByLabel("revoked").check();
  await expect(page.getByText("No hosts match this view.")).toBeVisible();
  await page.getByLabel("revoked").uncheck();
  await expect(table).toContainText("alpha");
});

test("dragging a chart zooms the time window, and escape returns to live", async ({ page, isMobile }) => {
  test.skip(isMobile, "drag selection needs a pointer");
  const requests = await mock(page);
  await page.goto("/");
  await page.locator("table").getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "Block latency" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const plot = page.locator(".chart-plot .u-over").first();
  await expect(plot).toBeVisible();
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  if (box === null) throw new Error("chart plot has no box");
  await expect(page.getByRole("button", { name: /Reset/ })).toHaveCount(0);

  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();

  await expect(page.getByLabel("Visible time window")).toContainText(/\d+s$/);
  await expect(page.getByRole("button", { name: /Reset/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Back to live/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "1h" })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => requests.some(request => /[?&]from=\d+&to=\d+&kind=summary/u.test(request) && !request.includes("range="))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Reset/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "true");
});

test("legend rows isolate and restore series", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.locator("table").getByRole("link", { name: "alpha" }).click();
  const cpuLegend = page.locator(".chart", { has: page.getByRole("img", { name: /CPU;/ }) }).locator(".chart-legend");
  await expect(cpuLegend).toContainText("iowait");
  await cpuLegend.getByRole("button", { name: "Show only user" }).click();
  await expect(cpuLegend.getByRole("button", { name: "Show only user" })).toHaveAttribute("aria-pressed", "true");
  await expect(cpuLegend.getByRole("button", { name: "Show only system" })).toHaveAttribute("aria-pressed", "false");
  await cpuLegend.getByRole("button", { name: "Show only user" }).click();
  await expect(cpuLegend.getByRole("button", { name: "Show only system" })).toHaveAttribute("aria-pressed", "true");
});

test("mobile layout has no horizontal page overflow", async ({ page }, testInfo) => {
  await mock(page);
  await page.goto("/");
  await expect(page.locator("table").getByRole("link", { name: "alpha" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(overflow).toBe(true);
  await page.locator("table").getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "alpha" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
});
