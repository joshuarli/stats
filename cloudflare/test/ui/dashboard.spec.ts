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

const PROJECT_BUCKETS = ["stuff-mycrates", "stuff-mynpm", "stuff-mypypi"];

const NAMESPACES = ["b25c2595ba784bb1bd51a87a3e87c62b"];

const DATABASES = ["9870c4da-3758-4f0c-ab6d-2372eb34009b"];

function projects(collector: keyof typeof projectCollector, withProbes: boolean, buckets: readonly string[], durableObjectNamespaces: readonly string[], d1Databases: readonly string[]) {
  return [{
    id: "stuff", name: "stuff", worker: "stuff", buckets, durableObjectNamespaces, d1Databases, probes: withProbes ? probeTargets : [],
    collector: projectCollector[collector]
  }];
}

const PROJECT_STEP = 300_000;
const PROJECT_POINTS = 12;

function projectHistory(kind: string, range: string, spike: boolean, probeDown: boolean, buckets: readonly string[]) {
  const fromMs = now - PROJECT_POINTS * PROJECT_STEP;
  const base = { projectId: "stuff", range, fromMs, toMs: now, stepMs: PROJECT_STEP };
  const scale = range === "24h" ? 2 : 1;
  if (kind === "collector") {
    return { ...base, kind, runs: Array.from({ length: PROJECT_POINTS }, (_, index) => ({ atMs: fromMs + index * PROJECT_STEP, ok: true, detail: "ok", rowsRead: 4_000_000, durationMs: 900 })) };
  }
  const column = (value: (index: number) => number | null) => Array.from({ length: PROJECT_POINTS }, (_, index) => value(index));
  const hot = (index: number) => spike && index >= PROJECT_POINTS - 4;
  if (kind === "worker") {
    return {
      ...base, kind,
      series: [
        { metric: "worker.invocations", values: column(() => 1000 * scale) },
        { metric: "worker.cpuMsSum", values: column(() => 3000 * scale) },
        { metric: "worker.cpuMsMax", values: column(() => 12 * scale) },
        { metric: "worker.status.2xx", values: column(index => (hot(index) ? 920 : 1000) * scale) },
        { metric: "worker.status.3xx", values: column(() => 0) },
        { metric: "worker.status.4xx", values: column(() => 0) },
        { metric: "worker.status.5xx", values: column(index => (hot(index) ? 80 : 0) * scale) },
        { metric: "worker.status.other", values: column(() => 0) }
      ]
    };
  }
  if (kind === "routes") {
    return {
      ...base, kind,
      series: [
        { metric: "route.POST /ingest.invocations", values: column(() => 70 * scale) },
        { metric: "route.POST /ingest.cpuMsSum", values: column(() => 1260 * scale) },
        { metric: "route.GET /api/v1/projects.invocations", values: column(() => 90 * scale) },
        { metric: "route.GET /api/v1/projects.cpuMsSum", values: column(() => 150 * scale) }
      ]
    };
  }
  if (kind === "durable-objects") {
    return {
      ...base, kind,
      series: [
        { metric: "do.invocations", values: column(() => 400 * scale) },
        { metric: "do.errors", values: column(() => 0) },
        { metric: "do.cpuMsSum", values: column(() => 4000 * scale) },
        { metric: "do.cpuMsMax", values: column(() => 38) },
        { metric: "do.wallMsSum", values: column(() => 12_000 * scale) }
      ]
    };
  }
  if (kind === "d1") {
    return {
      ...base, kind,
      series: [
        { metric: "d1.queries", values: column(() => 300) },
        { metric: "d1.rowsRead", values: column(() => 50_000_000) },
        { metric: "d1.rowsWritten", values: column(() => 100_000) }
      ]
    };
  }
  if (kind === "d1-statements") {
    const statement = (name: string, queries: number, rowsRead: number, rowsWritten: number) => [
      { metric: `d1q.${name}.queries`, values: column(() => queries) },
      { metric: `d1q.${name}.rowsRead`, values: column(() => rowsRead) },
      { metric: `d1q.${name}.rowsWritten`, values: column(() => rowsWritten) }
    ];
    return {
      ...base, kind,
      series: [
        ...statement("SELECT * FROM big_read", 100, 50_000_000, 0),
        ...statement("INSERT INTO log VALUES (?)", 100, 0, 10_000),
        ...statement("UPDATE hot SET a = ?", 100, 0, 90_000)
      ]
    };
  }
  if (kind === "probes") {
    return {
      ...base, kind,
      series: probeTargets.flatMap(target => [
        { metric: `probe.${target.name}.up`, values: column(index => (probeDown && target.name === "npm" && index >= PROJECT_POINTS - 3 ? 0 : 1)) },
        { metric: `probe.${target.name}.ms`, values: column(() => 85 * scale) }
      ])
    };
  }
  return {
    ...base, kind,
    series: buckets.flatMap(bucket => [
      { metric: `r2.${bucket}.ops.success`, values: column(() => 500 * scale) },
      { metric: `r2.${bucket}.ops.userError`, values: column(() => 40 * scale) },
      { metric: `r2.${bucket}.ops.other`, values: column(() => 0) },
      { metric: `r2.${bucket}.storageBytes`, values: column(index => (index % 3 === 0 ? 300_000_000 * scale : null)) },
      { metric: `r2.${bucket}.objects`, values: column(index => (index % 3 === 0 ? 1200 * scale : null)) }
    ])
  };
}

async function mock(page: Page, options: { online?: boolean; empty?: boolean; system?: boolean; collector?: keyof typeof projectCollector; spike?: boolean; probes?: boolean; probeDown?: boolean; bucketless?: boolean; durableObjects?: boolean; d1?: boolean } = {}): Promise<string[]> {
  const buckets = options.bucketless === true ? [] : PROJECT_BUCKETS;
  const namespaces = options.durableObjects === true ? NAMESPACES : [];
  const databases = options.d1 === true ? DATABASES : [];
  const requests: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const range = url.searchParams.get("range") ?? "1h";
    const kind = url.searchParams.get("kind") ?? "summary";
    const projectPath = /^\/api\/v1\/projects\/stuff\/history$/u.exec(url.pathname);
    if (projectPath !== null) return route.fulfill({ json: projectHistory(kind, range, options.spike === true, options.probeDown === true, buckets) });
    if (url.pathname === "/api/v1/projects") return route.fulfill({ json: projects(options.collector ?? "fresh", options.probes === true, buckets, namespaces, databases) });
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

test("fleet and host views render charts, ranges, and keyboard controls", { tag: "@mobile" }, async ({ page }, testInfo) => {
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

test("the CPU and load charts compare against the same window yesterday", async ({ page }) => {
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
  const requests = await mock(page);
  await page.goto("/");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("list", { name: "Incidents" })).toBeVisible();
  const window = page.getByLabel("Visible time window");
  await expect(window).toContainText("Past 1 hour");
  await expect(page.getByRole("button", { name: /Reset/ })).toHaveCount(0);
  await page.getByRole("list", { name: "Incidents" }).getByRole("button", { name: "Zoom" }).first().click();
  await expect(window).toContainText(/\d+[smhd]/u);
  await expect(page.getByRole("button", { name: "1h" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /Reset/ })).toBeVisible();
  await expect.poll(() => requests.some(request => /[?&]from=\d+&to=\d+&kind=summary/u.test(request))).toBe(true);
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

test("dragging a chart zooms the time window, and escape returns to live", async ({ page }) => {
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

test("mobile layout has no horizontal page overflow", { tag: "@mobile-only" }, async ({ page }, testInfo) => {
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

test("a stale collector is flagged on the fleet and the project page", async ({ page }) => {
  await mock(page, { collector: "stale" });
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Projects" })).toContainText("stale");
  await page.getByRole("table", { name: "Projects" }).getByRole("link", { name: "stuff" }).click();
  await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
  await expect(page.locator(".page-header")).toContainText("stale");
  await expect(page.getByText("The collector has not succeeded recently")).toBeVisible();
});

test("an unknown project id shows a not-found state", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/other");
  await expect(page.getByText("Project not found")).toBeVisible();
});

test("the project page shows its summary, incidents, and two independent columns", async ({ page }, testInfo) => {
  const requests = await mock(page);
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

  await page.getByRole("button", { name: "24h", exact: true }).click();
  await expect(strip.getByRole("button", { name: /^Requests: 2,000/u })).toBeVisible();
  await expect(page.getByRole("img", { name: "Worker invocations; latest 2,000" })).toBeVisible();
  expect(requests.some(request => request.includes("/projects/stuff/history?range=24h&kind=worker"))).toBe(true);
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

test("a tile past its limit is marked, and tiles with limits show headroom", async ({ page }) => {
  await mock(page, { spike: true });
  await page.goto("/#/project/stuff");
  const strip = page.getByRole("region", { name: "Project summary" });
  await expect(strip.getByRole("button", { name: /^Worker 5xx: 8%/u })).toHaveClass(/is-critical/u);
  await expect(strip.getByRole("button", { name: /^Requests: /u })).not.toHaveClass(/is-/u);
  await expect(strip.getByRole("button", { name: /^CPU time: /u }).locator(".gauge")).toHaveCount(1);
  await expect(strip.getByRole("button", { name: /^Requests: /u }).locator(".gauge")).toHaveCount(0);
});

test("the newest project bucket is marked as still arriving", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/stuff");
  const strip = page.getByRole("region", { name: "Project summary" });
  await expect(strip.getByRole("button", { name: /^Requests: / })).toContainText("newest still arriving");
});

test("widgets collapse, stay collapsed after a reload, and a tile reveals the widget it jumps to", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/stuff");
  const cpu = page.locator("#cpu");
  await expect(cpu.getByRole("img", { name: /^Worker average CPU time;/u })).toBeVisible();
  await cpu.getByRole("button", { name: "Hide CPU time" }).click();
  await expect(cpu.getByRole("img", { name: /^Worker average CPU time;/u })).toHaveCount(0);
  await expect(cpu.getByRole("button", { name: "Show CPU time" })).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
  await expect(page.locator("#cpu").getByRole("img", { name: /^Worker average CPU time;/u })).toHaveCount(0);
  await page.getByRole("region", { name: "Project summary" }).getByRole("button", { name: /^CPU time: / }).click();
  await expect(page.locator("#cpu").getByRole("img", { name: /^Worker average CPU time;/u })).toBeVisible();
});

test("configured probes surface endpoint health and a down endpoint raises an incident", async ({ page }) => {
  const options = { probes: true, probeDown: false };
  const requests = await mock(page, options);
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

  options.probeDown = true;
  await page.getByRole("button", { name: "Refresh" }).click();
  const incidents = page.getByRole("list", { name: "Incidents" });
  await expect(incidents).toContainText("Endpoints");
  await expect(incidents).toContainText("Critical");
  await expect(strip.getByRole("button", { name: /^Endpoints: down/u })).toContainText("Critical");
});

test("CPU by route ranks routes, and Durable Object charts appear only for projects with namespaces", async ({ page }) => {
  const requests = await mock(page, { durableObjects: true });
  await page.goto("/#/project/stuff");
  const routes = page.locator("#routes");
  await expect(routes.getByRole("heading", { name: "CPU by route" })).toBeVisible();
  const rows = routes.getByRole("table", { name: "CPU time by route" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("POST /ingest");
  await expect(rows.first()).toContainText("89.4%");
  await expect(rows.first()).toContainText("18 ms");
  await expect(page.locator("#durable-objects").getByRole("img", { name: /Durable Object average CPU time;/u })).toBeVisible();
  expect(requests.some(request => request.includes("kind=durable-objects"))).toBe(true);
});

test("a project without namespaces has no Durable Object widget and makes no request for one", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.locator("#routes")).toBeVisible();
  await expect(page.locator("#durable-objects")).toHaveCount(0);
  expect(requests.some(request => request.includes("kind=durable-objects"))).toBe(false);
});

test("D1 ranks statements by list cost and the cost estimate adds D1 to the Worker's usage", async ({ page }) => {
  const requests = await mock(page, { d1: true });
  await page.goto("/#/project/stuff");
  const rows = page.locator("#d1").getByRole("table", { name: "D1 cost by statement" }).locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("UPDATE hot SET a = ?");
  await expect(rows.nth(0)).toContainText("$1.08");
  await expect(rows.nth(1)).toContainText("SELECT * FROM big_read");
  await expect(rows.nth(1)).toContainText("$0.60");
  await expect(rows.nth(2)).toContainText("INSERT INTO log VALUES (?)");
  await expect(rows.nth(2)).toContainText("$0.12");
  const cost = page.locator("#cost").getByRole("table", { name: "Estimated cost by component" });
  await expect(cost.getByRole("row", { name: /D1 rows written/u })).toContainText("$1.20");
  await expect(cost.getByRole("row", { name: /D1 rows read/u })).toContainText("$0.60");
  await expect(cost.getByRole("row", { name: /^Total/u })).toContainText("$1.80");
  expect(requests.some(request => request.includes("kind=d1-statements"))).toBe(true);
});

test("a project without databases has no D1 widget, no D1 request, and a cost estimate without D1 rows", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  const cost = page.locator("#cost").getByRole("table", { name: "Estimated cost by component" });
  await expect(cost.getByRole("row", { name: /Worker requests/u })).toBeVisible();
  await expect(cost.getByRole("row", { name: /D1/u })).toHaveCount(0);
  await expect(page.locator("#d1")).toHaveCount(0);
  expect(requests.some(request => request.includes("kind=d1"))).toBe(false);
});

test("a project without probes has no endpoints widget and makes no probe request", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
  await expect(page.locator("#endpoints")).toHaveCount(0);
  expect(requests.some(request => request.includes("kind=probes"))).toBe(false);
});

test("a project without buckets shows no R2 widgets or cells", async ({ page }) => {
  await mock(page, { bucketless: true, probes: true });
  await page.goto("/#/project/stuff");
  const strip = page.getByRole("region", { name: "Project summary" });
  await expect(strip.getByRole("button", { name: /^Requests:/u })).toBeVisible();
  await expect(strip.getByRole("button", { name: /^R2 /u })).toHaveCount(0);
  await expect(page.locator("#r2-operations")).toHaveCount(0);
  await expect(page.locator("#r2-storage")).toHaveCount(0);
  await expect(strip.getByRole("button")).toHaveCount(5);
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
