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

const projectCollector = { fresh: { lastRunAtMs: now - 60_000, lastSuccessAtMs: now - 60_000, lastError: null, stale: false }, stale: { lastRunAtMs: now - 20 * 60_000, lastSuccessAtMs: now - 20 * 60_000, lastError: null, stale: true } } as const;

const probeTargets = [{ name: "crates", url: "https://crates.example.com/" }, { name: "npm", url: "https://npm.example.com/" }];

function projects(collector: keyof typeof projectCollector, withProbes: boolean) {
  return [{
    id: "stuff", name: "stuff", worker: "stuff", buckets: ["stuff-mycrates", "stuff-mynpm", "stuff-mypypi"], probes: withProbes ? probeTargets : [],
    collector: projectCollector[collector]
  }];
}

const PROJECT_STEP = 300_000;
const PROJECT_POINTS = 12;

function projectHistory(kind: string, range: string, spike: boolean, probeDown: boolean) {
  const fromMs = now - PROJECT_POINTS * PROJECT_STEP;
  const base = { projectId: "stuff", range, fromMs, toMs: now, stepMs: PROJECT_STEP };
  if (kind === "collector") {
    return { ...base, kind, runs: Array.from({ length: PROJECT_POINTS }, (_, index) => ({ atMs: fromMs + index * PROJECT_STEP, ok: true, detail: "ok", rowsRead: 4_000_000, durationMs: 900 })) };
  }
  const column = (value: (index: number) => number | null) => Array.from({ length: PROJECT_POINTS }, (_, index) => value(index));
  const hot = (index: number) => spike && index >= PROJECT_POINTS - 4;
  if (kind === "worker") {
    return {
      ...base, kind,
      series: [
        { metric: "worker.invocations", values: column(() => 1000) },
        { metric: "worker.cpuMsSum", values: column(() => 3000) },
        { metric: "worker.cpuMsMax", values: column(() => 12) },
        { metric: "worker.status.2xx", values: column(index => (hot(index) ? 920 : 1000)) },
        { metric: "worker.status.3xx", values: column(() => 0) },
        { metric: "worker.status.4xx", values: column(() => 0) },
        { metric: "worker.status.5xx", values: column(index => (hot(index) ? 80 : 0)) },
        { metric: "worker.status.other", values: column(() => 0) }
      ]
    };
  }
  if (kind === "probes") {
    return {
      ...base, kind,
      series: probeTargets.flatMap(target => [
        { metric: `probe.${target.name}.up`, values: column(index => (probeDown && target.name === "npm" && index >= PROJECT_POINTS - 3 ? 0 : 1)) },
        { metric: `probe.${target.name}.ms`, values: column(() => 85) }
      ])
    };
  }
  const buckets = ["stuff-mycrates", "stuff-mynpm", "stuff-mypypi"];
  return {
    ...base, kind,
    series: buckets.flatMap(bucket => [
      { metric: `r2.${bucket}.ops.success`, values: column(() => 500) },
      { metric: `r2.${bucket}.ops.userError`, values: column(() => 40) },
      { metric: `r2.${bucket}.ops.other`, values: column(() => 0) },
      { metric: `r2.${bucket}.storageBytes`, values: column(index => (index % 3 === 0 ? 300_000_000 : null)) },
      { metric: `r2.${bucket}.objects`, values: column(index => (index % 3 === 0 ? 1200 : null)) }
    ])
  };
}

async function mock(page: Page, options: { online?: boolean; empty?: boolean; system?: boolean; collector?: keyof typeof projectCollector; spike?: boolean; probes?: boolean; probeDown?: boolean } = {}): Promise<string[]> {
  const requests: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const range = url.searchParams.get("range") ?? "1h";
    const kind = url.searchParams.get("kind") ?? "summary";
    const projectPath = /^\/api\/v1\/projects\/stuff\/history$/u.exec(url.pathname);
    if (projectPath !== null) return route.fulfill({ json: projectHistory(kind, range, options.spike === true, options.probeDown === true) });
    if (url.pathname === "/api/v1/projects") return route.fulfill({ json: projects(options.collector ?? "fresh", options.probes === true) });
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
  const fleetTable = page.getByRole("table", { name: "Fleet hosts" });
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
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
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
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("list", { name: "Incidents" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Reset/ })).toHaveCount(0);
  await page.getByRole("list", { name: "Incidents" }).getByRole("button", { name: "Zoom" }).first().click();
  await expect(page.getByRole("button", { name: /Reset/ })).toBeVisible();
});

test("missing and stale data never become zero", async ({ page }) => {
  await mock(page, { online: false, empty: true, system: false });
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Fleet hosts" })).toContainText("stale");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByText("No samples were accepted in this range.")).toBeVisible();
  await expect(page.getByText("This host has not reported system details.")).toBeVisible();
});

test("host summary rebuilds after an empty range becomes populated", async ({ page }) => {
  const options = { empty: true };
  await mock(page, options);
  await page.goto("/");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByText("No samples were accepted in this range.")).toBeVisible();
  options.empty = false;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("img", { name: /CPU;/ })).toBeVisible();
  await expect(page.getByText("No samples were accepted in this range.")).toHaveCount(0);
});

test("search filters the fleet and the status chips narrow it", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  const table = page.getByRole("table", { name: "Fleet hosts" });
  await expect(table).toContainText("alpha");

  const search = page.getByRole("searchbox", { name: "Search hosts" });
  await search.fill("no-such-host");
  await expect(page.getByText("No hosts match this view.")).toBeVisible();
  await expect(table).toHaveCount(0);
  await search.fill("alpha");
  await expect(table).toContainText("alpha");

  const filters = page.getByRole("group", { name: "Filter by status" });
  const revoked = filters.getByRole("button", { name: /^revoked/u });
  await expect(filters.getByRole("button", { name: /^online/u })).toContainText("1");
  await revoked.click();
  await expect(revoked).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("No hosts match this view.")).toBeVisible();
  await revoked.click();
  await expect(revoked).toHaveAttribute("aria-pressed", "false");
  await expect(table).toContainText("alpha");
  await expect(page.getByText("provisioned")).toHaveCount(0);
  await expect(page.getByRole("complementary")).toHaveCount(0);
});

test("dragging a chart zooms the time window, and escape returns to live", async ({ page, isMobile }) => {
  test.skip(isMobile, "drag selection needs a pointer");
  const requests = await mock(page);
  await page.goto("/");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
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
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
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
  await expect(page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(overflow).toBe(true);
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "alpha" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
});

test("the fleet lists projects and each row opens its page", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  const table = page.getByRole("table", { name: "Projects" });
  await expect(table).toContainText("stuff");
  await expect(table).toContainText("3");
  await expect(table).toContainText("collecting");
  await expect(page.getByRole("table", { name: "Fleet hosts" })).toBeVisible();
  const hostsBox = await page.getByRole("table", { name: "Fleet hosts" }).boundingBox();
  const projectsBox = await table.boundingBox();
  expect(projectsBox!.y).toBeGreaterThan(hostsBox!.y);
  await table.getByRole("link", { name: "stuff" }).click();
  await expect(page).toHaveURL(/#\/project\/stuff$/u);
  await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
});

test("a stale collector shows its state on the fleet and the project page", async ({ page }) => {
  await mock(page, { collector: "stale" });
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Projects" })).toContainText("stale");
  await page.getByRole("table", { name: "Projects" }).getByRole("link", { name: "stuff" }).click();
  await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
  await expect(page.locator(".page-header")).toContainText("stale");
});

test("an unknown project id shows a not-found state", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/other");
  await expect(page.getByText("Project not found")).toBeVisible();
});

test("the project page shows its summary, incidents, and two independent columns", async ({ page }, testInfo) => {
  await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
  const strip = page.getByRole("region", { name: "Project summary" });
  for (const label of ["Requests", "Worker 5xx", "CPU time", "R2 failures", "R2 storage", "Collector"]) {
    await expect(strip.getByRole("button", { name: new RegExp(`^${label}: `, "u") })).toBeVisible();
  }
  await expect(strip.getByRole("button", { name: /^Requests: 1,000/u })).toBeVisible();
  await expect(strip.getByRole("button", { name: /^CPU time: 3 ms/u })).toBeVisible();
  await expect(strip.getByRole("button", { name: /^R2 storage: /u })).toContainText("858.3 MiB");
  for (const title of ["Incidents", "Requests", "Response status", "CPU time", "R2 operations", "R2 storage", "Collector"]) {
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("list", { name: "Incidents" })).toHaveCount(0);
  await expect(page.getByText("Every monitored metric stayed inside its limits.")).toBeVisible();
  await expect(page.getByRole("img", { name: /Worker invocations;/u })).toBeVisible();
  await expect(page.locator(".widget:not(.column .widget)")).toHaveCount(0);
  const left = page.getByRole("region", { name: "Left column" });
  const right = page.getByRole("region", { name: "Right column" });
  await expect(left.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
  await expect(right.getByRole("heading", { name: "R2 operations" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("project.png"), fullPage: true });
});

test("an elevated Worker 5xx share raises an incident that zooms", async ({ page }) => {
  const requests = await mock(page, { spike: true });
  await page.goto("/#/project/stuff");
  const incidents = page.getByRole("list", { name: "Incidents" });
  await expect(incidents).toContainText("Worker 5xx");
  await expect(incidents).toContainText("Critical");
  await expect(incidents).toContainText("ongoing");
  await expect(page.getByRole("button", { name: /^Worker 5xx: .*Jump to chart/u })).toContainText("Critical");
  await incidents.getByRole("button", { name: "Zoom" }).first().click();
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeVisible();
  expect(requests.some(request => request.includes("/projects/stuff/history?range=1h&kind=worker"))).toBe(true);
});

test("a stale collector is flagged on the project page", async ({ page }) => {
  await mock(page, { collector: "stale" });
  await page.goto("/#/project/stuff");
  await expect(page.getByText("The collector has not succeeded recently")).toBeVisible();
  await expect(page.locator(".page-header")).toContainText("stale");
});

test("ranges reload project history", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "24h" }).click();
  await expect.poll(() => requests.some(request => request.includes("/projects/stuff/history?range=24h&kind=r2"))).toBe(true);
});

test("configured probes add an endpoints monitor and chart that say where they measure from", async ({ page }) => {
  const requests = await mock(page, { probes: true });
  await page.goto("/#/project/stuff");
  const strip = page.getByRole("region", { name: "Project summary" });
  await expect(strip.getByRole("button", { name: /^Endpoints: all up/u })).toBeVisible();
  const widget = page.locator("#endpoints");
  await expect(widget.getByRole("heading", { name: "Endpoints" })).toBeVisible();
  await expect(widget).toContainText("from Cloudflare's edge");
  await expect(page.getByRole("img", { name: /Endpoint availability;/u })).toBeVisible();
  await expect(page.getByRole("img", { name: /Endpoint response time;/u })).toBeVisible();
  await expect(page.locator(".widget:not(.column .widget)")).toHaveCount(0);
  expect(requests.some(request => request.includes("kind=probes"))).toBe(true);
});

test("a down endpoint is a critical incident and projects without probes show none", async ({ page }) => {
  await mock(page, { probes: true, probeDown: true });
  await page.goto("/#/project/stuff");
  const incidents = page.getByRole("list", { name: "Incidents" });
  await expect(incidents).toContainText("Endpoints");
  await expect(incidents).toContainText("Critical");
  await expect(page.getByRole("button", { name: /^Endpoints: down/u })).toContainText("Critical");
});

test("a project without probes has no endpoints widget and makes no probe request", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
  await expect(page.locator("#endpoints")).toHaveCount(0);
  expect(requests.some(request => request.includes("kind=probes"))).toBe(false);
});

test("project charts follow a refresh, not just the first load", async ({ page }) => {
  const options = { spike: false };
  await mock(page, options);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("img", { name: "Worker 5xx share; latest 0%" })).toBeVisible();
  options.spike = true;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("img", { name: "Worker 5xx share; latest 8%" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Worker 5xx: 8%/u })).toBeVisible();
});

test("a status pill keeps its place and background when hovered", async ({ page }) => {
  await mock(page, { online: false });
  await page.goto("/");
  const table = page.getByRole("table", { name: "Fleet hosts" });
  const cell = table.locator(".state-cell").first();
  const before = await cell.evaluate(element => { const style = getComputedStyle(element); return [style.backgroundColor, style.paddingTop, style.cursor]; });
  await cell.locator(".badge").hover({ force: true });
  const after = await cell.evaluate(element => { const style = getComputedStyle(element); return [style.backgroundColor, style.paddingTop, style.cursor]; });
  expect(after).toEqual(before);
  expect(before[1]).toBe("0px");
  const pill = await cell.locator(".badge").boundingBox();
  const name = await table.getByRole("link", { name: "alpha" }).boundingBox();
  expect(Math.abs((pill!.y + pill!.height / 2) - (name!.y + name!.height / 2))).toBeLessThan(14);
});

test("each page names itself once and the breadcrumb only appears below the fleet", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fleet", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
  await expect(page.getByText(/^\d+ hosts?$/u)).toHaveCount(0);
  await expect(page.getByText(/^\d+ projects?$/u)).toHaveCount(0);

  await page.getByRole("table", { name: "Projects" }).getByRole("link", { name: "stuff" }).click();
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumb).toHaveText("Fleet");
  await expect(crumb.getByRole("link", { name: "Fleet" })).toBeVisible();

  await page.goto("/");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "alpha", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("combobox", { name: "Switch host" })).toBeVisible();
});

test("a widget title stays on one line however long its subtitle is", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/stuff");
  const title = page.getByRole("heading", { name: "R2 operations" });
  await expect(title).toBeVisible();
  const box = await title.boundingBox();
  expect(box!.height).toBeLessThan(24);
});

