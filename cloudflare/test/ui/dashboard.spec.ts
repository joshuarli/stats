import { expect, test, type Page } from "@playwright/test";
import { fulfillHistory } from "./history-route";

const hostId = "h_0123456789abcdef0123456789abcdef";
const now = Date.now();

function summary(range: string, empty = false, accelerator = false) {
  const length = empty ? 0 : 12;
  const step = range === "30d" ? 3_600_000 : range === "7d" ? 60_000 : 15_000;
  return {
    hostId, range, kind: "summary", fromMs: now - step * length, toMs: now,
    resolution: range === "30d" ? "1h" : range === "7d" ? "1m" : "raw", stepMs: step,
    points: Array.from({ length }, (_, index) => ({
      atMs: now - (length - index) * step,
      coverageMs: step,
      partial: false,
      uptimeMs: 3_600_000 + index * step,
      cpu: { user: index >= 8 ? 93 : 8 + index, system: 3, idle: 80, iowait: 1, steal: 0 },
      load: { one: 0.4 + index / 100, five: 0.5, fifteen: 0.6 },
      mem: { total: 8_589_934_592, available: 4_294_967_296 - index * 1_000_000, swapUsed: 0, swapInBytesPerSec: 4096 * index, swapOutBytesPerSec: 8192 },
      psi: { cpu: { some10: 1.2, some60: 0.8, some300: 0.4 }, memory: { some10: 0.1, some60: 0.05, some300: 0.02, full10: 0.05, full60: 0.03, full300: 0.01 }, io: { some10: 0.3, some60: 0.2, some300: 0.1 } },
      ...(accelerator ? { gpu: { busyPct: 20 + index }, power: { gpuWatts: 0.6 + index / 10, ...(index % 4 === 0 ? { systemWatts: 14.8 } : {}) } } : {})
    }))
  };
}

function disks(range: string, empty = false) {
  return { hostId, range, kind: "disks", fromMs: now - 3_600_000, toMs: now, resolution: "raw", stepMs: 15_000, series: empty ? [] : [{ id: "8:0", name: "sda", points: Array.from({ length: 6 }, (_, index) => ({ atMs: now - (6 - index) * 15_000, readBytesPerSec: 1_000_000 + index * 1000, writeBytesPerSec: 500_000, readsPerSec: 20, writesPerSec: 10, busyPct: 4 })) }] };
}

function nets(range: string, empty = false) {
  return { hostId, range, kind: "nets", fromMs: now - 3_600_000, toMs: now, resolution: "raw", stepMs: 15_000, series: empty ? [] : [{ id: "eth0", points: Array.from({ length: 6 }, (_, index) => ({ atMs: now - (6 - index) * 15_000, rxBytesPerSec: 200_000 + index * 1000, txBytesPerSec: 100_000, rxPacketsPerSec: 100, txPacketsPerSec: 80, rxDropsPerSec: 0, txDropsPerSec: 0, rxErrorsPerSec: 0, txErrorsPerSec: 0 })) }] };
}

function manyNets(range: string) {
  const ids = ["eth0", ...Array.from({ length: 12 }, (_, index) => `veth${index.toString(16).padStart(7, "0")}`), "veth-drops"];
  return { hostId, range, kind: "nets", fromMs: now - 3_600_000, toMs: now, resolution: "raw", stepMs: 15_000, series: ids.map((id, device) => ({ id, points: Array.from({ length: 6 }, (_, index) => ({ atMs: now - (6 - index) * 15_000, rxBytesPerSec: device === 0 ? 2_000_000 : device === ids.length - 1 ? 0 : 1_000 * (ids.length - device), txBytesPerSec: 100, rxPacketsPerSec: 100, txPacketsPerSec: 80, rxDropsPerSec: device === ids.length - 1 ? 1 : 0, txDropsPerSec: 0, rxErrorsPerSec: 0, txErrorsPerSec: 0 })) })) };
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
        { metric: "d1.rowsWritten", values: column(() => 100_000) },
        { metric: `d1.${DATABASES[0]}.storageBytes`, values: column(index => (index % 3 === 0 ? 245_923_840 : null)) }
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

const DEPLOYMENT_ID = "0b7f4c3e-1d2a-4b5c-8d9e-0f1a2b3c4d5e";
const DEPLOYED_VERSION = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const EARLIER_DEPLOYMENT_ID = "1c8a5d4f-2e3b-4c6d-9e0f-1a2b3c4d5e6f";
const EARLIER_VERSION = "8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d";
const DEPLOYED_AT = Math.floor((now - 2 * 86_400_000) / 300_000) * 300_000 + 60_000;

function deploymentHistory() {
  return {
    projectId: "stuff", worker: "stuff", enabled: true,
    sync: { lastAttemptAtMs: now - 60_000, lastSuccessAtMs: now - 60_000, error: null, truncated: false },
    deployments: [
      { id: DEPLOYMENT_ID, atMs: DEPLOYED_AT, source: "wrangler", message: "ship cache", versions: [{ id: DEPLOYED_VERSION, percentage: 100 }], deferred: false },
      { id: EARLIER_DEPLOYMENT_ID, atMs: DEPLOYED_AT - 86_400_000, source: "wrangler", message: null, versions: [{ id: EARLIER_VERSION, percentage: 100 }], deferred: false }
    ],
    versions: [{ id: DEPLOYED_VERSION, tag: "v42", message: null }, { id: EARLIER_VERSION, tag: "v41", message: null }]
  };
}

function deploymentComparison(window: "1h" | "6h" | "24h") {
  const duration = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 }[window];
  const end = Math.floor(DEPLOYED_AT / 300_000) * 300_000;
  const start = end + 600_000;
  return {
    deploymentId: DEPLOYMENT_ID, window,
    before: { fromMs: end - duration, toMs: end }, after: { fromMs: start, toMs: start + duration },
    readyAtMs: start + duration + 2_700_000, beforeInvocations: 12_000, afterInvocations: 11_800,
    reasons: window === "24h" ? ["Another deployment overlaps the comparison windows."] : [],
    warnings: ["Heuristic signals, not significance tests or proof of causation."],
    metrics: [{ metric: "worker.cpu", label: "Worker CPU / invocation", unit: "ms", before: 2, after: 1.5, delta: -0.5, deltaPercent: -25, verdict: window === "24h" ? "confounded" : "improved" }]
  };
}

async function mock(page: Page, options: { online?: boolean; empty?: boolean; system?: boolean; collector?: keyof typeof projectCollector; spike?: boolean; probes?: boolean; probeDown?: boolean; bucketless?: boolean; durableObjects?: boolean; d1?: boolean; accelerator?: boolean; manyNets?: boolean; staleGap?: boolean } = {}): Promise<string[]> {
  const buckets = options.bucketless === true ? [] : PROJECT_BUCKETS;
  const namespaces = options.durableObjects === true ? NAMESPACES : [];
  const databases = options.d1 === true ? DATABASES : [];
  const requests: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const range = url.searchParams.get("range") ?? "1h";
    const kind = url.searchParams.get("kind") ?? "summary";
    const kinds = url.searchParams.get("kinds");
    const projectPath = /^\/api\/v1\/projects\/stuff\/history$/u.exec(url.pathname);
    if (projectPath !== null) {
      const body = (entry: string) => projectHistory(entry, range, options.spike === true, options.probeDown === true, buckets);
      if (kinds !== null) return fulfillHistory(route, { projectId: "stuff", histories: Object.fromEntries(kinds.split(",").map(entry => [entry, body(entry)])) });
      return fulfillHistory(route, body(kind));
    }
    if (url.pathname === "/api/v1/projects/stuff/deployments") return route.fulfill({ json: deploymentHistory() });
    if (url.pathname === `/api/v1/projects/stuff/deployments/${DEPLOYMENT_ID}/comparison`) return route.fulfill({ json: deploymentComparison(({ "6h": "6h", "24h": "24h" } as const)[url.searchParams.get("window") ?? ""] ?? "1h") });
    if (url.pathname === "/api/v1/projects") return route.fulfill({ json: projects(options.collector ?? "fresh", options.probes === true, buckets, namespaces, databases) });
    if (url.pathname === "/api/v1/hosts") {
      return route.fulfill({ json: { hosts: [{ hostId, name: "alpha", createdAtMs: now - 100_000, revoked: false, lastReceivedAtMs: options.online === false ? now - 120_000 : now - 5_000, online: options.online !== false }] } });
    }
    if (url.pathname.endsWith("/system")) {
      if (options.system === false) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "no system details for host" } } });
      return route.fulfill({ json: { hostId, reportedAtMs: now - 60_000, system: { agent: "0.1.0", hostname: "alpha-box", os: "Alpine Linux edge", kernel: "7.2.9-2-stable", arch: "x86_64", cpu: { model: "AMD Ryzen 9 9950X 16-Core Processor", threads: 32, cores: 16, sockets: 1, maxMhz: 5756 } } } });
    }
    const empty = options.empty === true;
    const historyBody = (kind: string): unknown => {
      if (kind === "disks") return disks(range, empty);
      if (kind === "nets") return options.manyNets === true ? manyNets(range) : nets(range, empty);
      if (kind === "filesystems") return filesystems(range, empty);
      if (kind === "block") return block(range, empty);
      const body = summary(range, empty, options.accelerator === true);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (from !== null && to !== null) {
        return { ...body, fromMs: Number(from), toMs: Number(to), points: body.points.slice(0, 4).map((point, index) => ({ ...point, atMs: Number(to) - (4 - index) * 15_000 })) };
      }
      if (options.staleGap === true && !empty) {
        return { ...body, fromMs: now - 3_600_000, toMs: now, points: body.points.map((point, index) => ({ ...point, atMs: now - 3_600_000 + (index + 1) * 15_000 })) };
      }
      return body;
    };
    if (kinds !== null) {
      return fulfillHistory(route, { hostId, histories: Object.fromEntries(kinds.split(",").map(kind => [kind, historyBody(kind)])) });
    }
    return fulfillHistory(route, historyBody(kind));
  });
  return requests;
}

test("fleet and host views render charts, ranges, and keyboard controls", { tag: "@mobile" }, async ({ page }, testInfo) => {
  const requests = await mock(page);
  await page.goto("/");
  const fleetTable = page.getByRole("table", { name: "Fleet hosts" });
  await expect(fleetTable.getByRole("link", { name: "alpha" })).toBeVisible();
  await expect(fleetTable.locator(".status-dot").first()).toHaveAttribute("title", "online");
  await expect(fleetTable).toContainText("AMD Ryzen 9 9950X 16-Core Processor");
  await expect(fleetTable).toContainText("16 cores · 32 threads");
  await expect(fleetTable).toContainText("Alpine Linux edge");
  await expect(fleetTable).toContainText("Load 1m / 5m / 15m");
  await expect(fleetTable).toContainText("Disk space");
  await expect(fleetTable).not.toContainText("PSI some10");
  await expect(page.getByRole("img", { name: "alpha CPU trend" })).toBeVisible();
  await expect(page.getByRole("img", { name: "alpha memory trend" })).toBeVisible();
  await expect(page.getByRole("img", { name: "alpha load trend" })).toBeVisible();
  await expect(page.getByRole("img", { name: "alpha disk space trend" })).toBeVisible();
  await expect(page.getByRole("img", { name: "alpha disk throughput trend" })).toBeVisible();
  await expect(page.getByRole("img", { name: "alpha network throughput trend" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("fleet.png"), fullPage: true });

  await fleetTable.getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "alpha" })).toBeVisible();
  await page.getByRole("button", { name: "Host information" }).hover();
  const system = page.getByRole("tooltip", { name: "Host information" });
  await expect(system).toContainText("AMD Ryzen 9 9950X 16-Core Processor");
  await expect(system).toContainText("16 cores · 32 threads · 1 socket · up to 5.76 GHz");
  await expect(system).toContainText("Alpine Linux edge");
  await expect(system).toContainText("kernel 7.2.9-2-stable · x86_64");
  await expect(system).toContainText("alpha-box");
  await expect(system).toContainText("8 GiB");
  await expect(system).toContainText("Uptime");
  await page.mouse.move(0, 0);
  await expect(page.getByLabel("Host metadata")).toHaveCount(0);
  const cpuCell = page.getByRole("button", { name: /^CPU: .*Jump to chart/ });
  await expect(cpuCell).toHaveClass(/is-critical/);
  await expect(cpuCell.locator(".health-word")).toHaveCount(0);
  const cpuChart = page.getByRole("img", { name: /CPU;/ });
  await expect(cpuChart).toBeVisible();
  await expect(cpuChart).toHaveAttribute("tabindex", "0");
  await cpuChart.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".chart-tip").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "1h" })).toHaveAttribute("aria-pressed", "true");
  const load = await page.evaluate(() => Math.round(performance.getEntriesByType("navigation")[0]?.duration ?? 0));
  console.log(`dashboard load ${load} ms`);

  for (const range of ["6h", "24h", "7d", "30d"]) {
    await page.getByRole("button", { name: range }).click();
    await expect(page.getByRole("button", { name: range })).toHaveAttribute("aria-pressed", "true");
    expect(requests.some(request => request.includes(`range=${range}`))).toBe(true);
  }
  await page.getByRole("button", { name: "24h" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table", { name: "Disk activity" })).toContainText("sda");
  await expect(page.getByRole("table", { name: "Network activity" })).toContainText("eth0");
  await expect(page.getByRole("table", { name: "Filesystem capacity" })).toContainText("Mount");
  for (const panel of ["CPU pressure", "Memory pressure", "I/O pressure"]) await expect(page.getByText(panel)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pressure" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Full stalls" })).toHaveCount(0);
  for (const title of ["CPU", "Load", "Memory", "Disk", "Network", "Filesystems"]) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Block latency" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Block latency;/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Power" })).toHaveCount(0);
  await expect(page.getByText("GPU busy")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("host.png"), fullPage: true });
});

test("the network table collapses churn behind a show-all control", async ({ page }) => {
  await mock(page, { manyNets: true });
  await page.goto("/");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  const table = page.getByRole("table", { name: "Network activity" });
  await expect(table).toContainText("eth0");
  await expect(table).toContainText("veth-drops");
  await expect(table.locator("tbody tr")).toHaveCount(8);
  const more = page.getByRole("button", { name: "Show all 14 interfaces" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(table.locator("tbody tr")).toHaveCount(14);
  const fewer = page.getByRole("button", { name: "Show fewer interfaces" });
  await expect(fewer).toHaveAttribute("aria-expanded", "true");
  await fewer.click();
  await expect(table.locator("tbody tr")).toHaveCount(8);
});

test("a host that reports gpu and power shows GPU busy beside CPU and a Power widget", async ({ page }) => {
  await mock(page, { accelerator: true });
  await page.goto("/");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "Power" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Power;/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /GPU busy;/ })).toBeVisible();
  await expect(page.locator("#cpu").getByText("GPU busy").first()).toBeVisible();
});

test("the host page reads every history kind in one request", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "CPU" })).toBeVisible();
  const hostHistory = () => requests.filter(request => request.startsWith(`/api/v1/hosts/${hostId}/history`));
  await expect.poll(() => requests.some(request => request.includes("range=1h&kinds=summary,disks,nets,filesystems"))).toBe(true);
  await expect.poll(() => hostHistory().some(request => request.includes("range=1h&kinds=summary,disks,nets,filesystems,block"))).toBe(true);
  expect(hostHistory().filter(request => request.includes("range=1h&kind="))).toHaveLength(0);
});

test("a bad period is marked on the strip and explained on chart hover", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("button", { name: /^CPU: .*Jump to chart/u })).toHaveClass(/is-critical/);
  const plot = page.locator(".chart", { has: page.getByRole("img", { name: /^CPU;/ }) }).locator(".u-over");
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  if (box === null) throw new Error("chart plot has no box");
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
  const episode = page.locator(".chart-tip-episode");
  await expect(episode).toBeVisible();
  await expect(episode).toContainText("Critical");
  await expect(episode).toContainText("ongoing");
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
  await expect(page.locator(".chart-tip-episode")).toHaveCount(0);
});

test("an offline host leaves its mini graphs short of the right edge", async ({ page }) => {
  await mock(page, { online: false, staleGap: true });
  await page.goto("/");
  const spark = page.getByRole("img", { name: "alpha CPU trend" });
  const line = spark.locator(".spark-line");
  await expect(line).toBeVisible();
  const xs = [...((await line.getAttribute("d")) ?? "").matchAll(/[ML]([\d.]+),/gu)].map(match => Number(match[1]));
  expect(xs.length).toBeGreaterThan(0);
  expect(Math.max(...xs)).toBeLessThan(40);
  const gaps = await spark.locator(".spark-gap").evaluateAll(nodes => nodes.map(node => Number(node.getAttribute("width"))));
  expect(Math.max(...gaps)).toBeGreaterThan(100);
});

test("missing and stale data never become zero", async ({ page }) => {
  await mock(page, { online: false, empty: true, system: false });
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Fleet hosts" }).locator(".status-dot").first()).toHaveAttribute("title", "stale");
  await page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" }).click();
  await expect(page.getByText("No samples were accepted in this range.")).toBeVisible();
  await page.getByRole("button", { name: "Host information" }).click();
  await expect(page.getByRole("tooltip", { name: "Host information" })).toContainText("This host has not reported system details.");
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
  await expect.poll(() => requests.some(request => /[?&]from=\d+&to=\d+&kinds=summary,/u.test(request) && !request.includes("range="))).toBe(true);

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
  const userRow = cpuLegend.getByRole("row", { name: /Show only user/u });
  await userRow.locator("td").nth(1).click();
  await expect(cpuLegend.getByRole("button", { name: "Show only user" })).toHaveAttribute("aria-pressed", "true");
  await expect(cpuLegend.getByRole("button", { name: "Show only system" })).toHaveAttribute("aria-pressed", "false");
  await userRow.locator("td").nth(3).click();
  await expect(cpuLegend.getByRole("button", { name: "Show only system" })).toHaveAttribute("aria-pressed", "true");
});

test("the fleet fits desktop viewports without horizontal scrolling", async ({ page }) => {
  await mock(page);
  for (const width of [1280, 1024, 900]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("table", { name: "Fleet hosts" }).getByRole("link", { name: "alpha" })).toBeVisible();
    const region = page.getByRole("region", { name: "Fleet hosts table" });
    expect(await region.evaluate(element => element.scrollWidth - element.clientWidth), `${width}px`).toBeLessThanOrEqual(1);
  }
});

test("mobile pages confine dense data to local scroll areas", { tag: "@mobile-only" }, async ({ page }, testInfo) => {
  await mock(page);
  const pageOverflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const hosts = page.getByRole("table", { name: "Fleet hosts" });
    await expect(hosts.getByRole("link", { name: "alpha" })).toBeVisible();
    const fleetScroll = page.getByRole("region", { name: "Fleet hosts table" });
    expect(await fleetScroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await hosts.locator("th").first().evaluate(element => getComputedStyle(element).position)).toBe("sticky");
    await expect.poll(pageOverflow).toBeLessThanOrEqual(1);

    await page.goto(`/#/host/${hostId}`);
    await expect(page.getByRole("heading", { name: "alpha", level: 1 })).toBeVisible();
    await expect(page.getByRole("img", { name: /CPU;/u })).toBeVisible();
    await expect(page.getByRole("group", { name: "Time range" })).toBeVisible();
    await expect.poll(pageOverflow).toBeLessThanOrEqual(1);
    if (width === 320) {
      const legend = page.getByRole("region", { name: "CPU series statistics" });
      expect(await legend.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    }

    await page.goto("/#/project/stuff");
    await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
    await expect(page.getByRole("img", { name: /Worker invocations;/u })).toBeVisible();
    await expect.poll(pageOverflow).toBeLessThanOrEqual(1);
  }
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

test("the project page compares a deployment's before and after windows", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("img", { name: /Worker invocations;/u })).toBeVisible();
  const deployment = page.getByRole("listbox", { name: "Deployment", exact: true });
  await expect(deployment.getByRole("option", { name: /v42/u })).toHaveAttribute("aria-selected", "true");
  const table = page.getByRole("region", { name: "Deployment metric comparison" });
  await expect(table.getByRole("row", { name: /Worker CPU/u })).toContainText("improved");
  await page.getByRole("button", { name: "24h", exact: true }).click();
  await expect(page.getByText("Another deployment overlaps the comparison windows.")).toBeVisible();
  await expect(table.getByRole("row", { name: /Worker CPU/u })).toContainText("confounded");
});

test("the deployment comparison window follows the time range", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  const row = page.getByRole("region", { name: "Deployment metric comparison" }).getByRole("row", { name: /Worker CPU/u });
  await expect(row).toContainText("improved");
  await expect(page.locator("#deployments")).toContainText("1h each side");
  await page.getByRole("button", { name: "6h", exact: true }).click();
  await expect(page.locator("#deployments")).toContainText("6h each side");
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await expect(page.locator("#deployments")).toContainText("24h each side");
  expect(requests.some(request => request.includes("/comparison?window=6h"))).toBe(true);
  expect(requests.some(request => request.includes("/comparison?window=24h"))).toBe(true);
});

test("the range and the selected deployment live in the URL", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/stuff?range=24h");
  await expect(page.getByRole("button", { name: "24h", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#deployments")).toContainText("24h each side");
  await page.getByRole("button", { name: "6h", exact: true }).click();
  await expect(page).toHaveURL(/#\/project\/stuff\?range=6h$/u);
  await page.getByRole("button", { name: "1h", exact: true }).click();
  await expect(page).toHaveURL(/#\/project\/stuff$/u);

  await page.goto(`/#/project/stuff?deployment=${EARLIER_DEPLOYMENT_ID}`);
  await page.reload();
  const options = page.getByRole("listbox", { name: "Deployment" });
  await expect(options.getByRole("option", { name: /v41/u })).toHaveAttribute("aria-selected", "true");
  await options.getByRole("option", { name: /v42/u }).click();
  await expect(page).toHaveURL(new RegExp(`deployment=${DEPLOYMENT_ID}$`, "u"));
});

test("arrow keys move through the deployment list", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/stuff");
  const options = page.getByRole("listbox", { name: "Deployment" });
  const latest = options.getByRole("option", { name: /v42/u });
  const earlier = options.getByRole("option", { name: /v41/u });
  await expect(latest).toHaveAttribute("aria-selected", "true");
  await latest.focus();
  await page.keyboard.press("ArrowDown");
  await expect(earlier).toHaveAttribute("aria-selected", "true");
  await expect(earlier).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(earlier).toBeFocused();
  await page.keyboard.press("Home");
  await expect(latest).toBeFocused();
  await expect(latest).toHaveAttribute("aria-selected", "true");
});

test("the section bar marks the card you are reading", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("img", { name: /Worker invocations;/u })).toBeVisible();
  const bar = page.getByRole("navigation", { name: "Sections" });
  await page.mouse.wheel(0, 400);
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Cost" }).click();
  await expect(bar.getByRole("button", { name: "Cost" })).toHaveAttribute("aria-current", "location");
  await expect(bar.locator('[aria-current="location"]')).toHaveCount(1);
});

test("clicking a deploy marker on a chart selects that deployment", async ({ page }) => {
  await mock(page);
  const recent = deploymentHistory();
  recent.deployments[0]!.atMs = now - 15 * 60_000;
  recent.deployments[1]!.atMs = now - 45 * 60_000;
  await page.route("**/api/v1/projects/stuff/deployments", route => route.fulfill({ json: recent }));
  await page.goto("/#/project/stuff");
  const options = page.getByRole("listbox", { name: "Deployment" });
  await expect(options.getByRole("option", { name: /v42/u })).toHaveAttribute("aria-selected", "true");
  const plot = page.locator(".chart", { has: page.getByRole("img", { name: /Worker invocations;/u }) }).locator(".u-over");
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  if (box === null) throw new Error("chart plot has no box");
  const pointerAt: number[] = [];
  for (let x = 2; x < box.width; x += 2) {
    await page.mouse.move(box.x + x, box.y + box.height / 2);
    if (await plot.evaluate(element => (element as HTMLElement).style.cursor === "pointer")) pointerAt.push(x);
  }
  expect(pointerAt.length).toBeGreaterThan(0);
  await page.mouse.click(box.x + pointerAt[0]! + 1, box.y + box.height / 2);
  await expect(options.getByRole("option", { name: /v41/u })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`deployment=${EARLIER_DEPLOYMENT_ID}$`, "u"));
});

test("a project without deployment tracking says so", async ({ page }) => {
  await mock(page);
  await page.route("**/api/v1/projects/stuff/deployments", route => route.fulfill({ json: { projectId: "stuff", worker: "stuff", enabled: false, sync: null, deployments: [], versions: [] } }));
  await page.goto("/#/project/stuff");
  await expect(page.locator("#deployments")).toContainText("Deployment tracking is disabled");
});

test("the deployment table stays in place while the next comparison loads", async ({ page }) => {
  await mock(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/comparison\?window=24h/u, async route => {
    await gate;
    await route.fallback();
  });
  await page.goto("/#/project/stuff");
  const row = page.getByRole("region", { name: "Deployment metric comparison" }).getByRole("row", { name: /Worker CPU/u });
  await expect(row).toContainText("improved");
  const detail = page.locator(".deployment-detail");
  await page.getByRole("button", { name: "24h", exact: true }).click();
  await expect(detail).toHaveAttribute("aria-busy", "true");
  await expect(row).toContainText("improved");
  release();
  await expect(row).toContainText("confounded");
  await expect(detail).toHaveAttribute("aria-busy", "false");
});

test("a section bar appears below the summary and jumps to a card without hiding it", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("img", { name: /Worker invocations;/u })).toBeVisible();
  const bar = page.getByRole("navigation", { name: "Sections" });
  await expect(bar).toBeHidden();
  await page.mouse.wheel(0, 400);
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Deployments" }).click();
  const card = page.locator("#deployments");
  const barBottom = async () => (await bar.boundingBox())!.y + (await bar.boundingBox())!.height;
  await expect.poll(async () => (await card.boundingBox())!.y >= (await barBottom()) - 1).toBe(true);
  await expect(card.getByRole("heading", { name: "Deployments" })).toBeInViewport();
});

test("an unknown project id shows a not-found state", async ({ page }) => {
  await mock(page);
  await page.goto("/#/project/other");
  await expect(page.getByText("Project not found")).toBeVisible();
});

test("the project page refreshes on the collector cadence, not every live tick", async ({ page }) => {
  await page.clock.install();
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
  await expect(page.getByRole("img", { name: /Worker invocations;/u })).toBeVisible();
  const projectHistory = () => requests.filter(request => request.startsWith("/api/v1/projects/stuff/history")).length;
  const initial = projectHistory();
  expect(initial).toBe(1);

  await page.clock.runFor(30_000);
  await page.waitForTimeout(100);
  expect(projectHistory()).toBe(initial);

  await page.clock.runFor(5 * 60_000);
  await expect.poll(() => projectHistory()).toBeGreaterThan(initial);

  const beforeManual = projectHistory();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => projectHistory()).toBeGreaterThan(beforeManual);
});

test("the project page shows its summary and balanced columns of chart cards", async ({ page }, testInfo) => {
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
  for (const title of ["Requests", "Response status", "CPU time", "R2 operations", "R2 storage", "Collector"]) {
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("img", { name: /Worker invocations;/u })).toBeVisible();
  await expect(page.locator(".widget:not(.charts .widget)")).toHaveCount(0);
  const cards = page.locator(".charts > .widget:not(.wide)");
  await expect(cards.first().getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
  await expect(cards.nth(1).getByRole("heading", { name: "Estimated cost" })).toBeVisible();
  const rects = await cards.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { left: Math.round(box.left), top: Math.round(box.top), bottom: Math.round(box.bottom) };
  }));
  const columns = new Map<number, { top: number; bottom: number }[]>();
  for (const { left, top, bottom } of rects) columns.set(left, [...(columns.get(left) ?? []), { top, bottom }]);
  expect(columns.size).toBe(3);
  for (const stack of columns.values()) {
    for (let index = 1; index < stack.length; index += 1) expect(stack[index]!.top).toBeGreaterThanOrEqual(stack[index - 1]!.bottom);
  }
  const ends = [...columns.values()].map(stack => Math.max(...stack.map(card => card.bottom)));
  const tallest = Math.max(...rects.map(card => card.bottom - card.top));
  expect(Math.max(...ends) - Math.min(...ends)).toBeLessThanOrEqual(tallest);
  await page.screenshot({ path: testInfo.outputPath("project.png"), fullPage: true });

  await page.getByRole("button", { name: "24h", exact: true }).click();
  await expect(strip.getByRole("button", { name: /^Requests: 2,000/u })).toBeVisible();
  await expect(page.getByRole("img", { name: "Worker invocations; latest 2,000" })).toBeVisible();
  expect(requests.some(request => request.includes("/projects/stuff/history?range=24h&kinds=") && request.includes("worker"))).toBe(true);
});

test("an elevated Worker 5xx share raises an incident that is marked and explained on hover", async ({ page }) => {
  const requests = await mock(page, { spike: true });
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("button", { name: /^Worker 5xx: .*Jump to chart/u })).toHaveClass(/is-critical/);
  const plot = page.locator(".chart", { has: page.getByRole("img", { name: /Worker 5xx share;/u }) }).locator(".u-over");
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  if (box === null) throw new Error("chart plot has no box");
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  await expect(page.locator(".chart-tip-episode")).toContainText("Critical");
  expect(requests.some(request => request.includes("/projects/stuff/history?range=1h&kinds=") && request.includes("worker"))).toBe(true);
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
  const cpu = page.locator("#worker-cpu");
  await expect(cpu.getByRole("img", { name: /^Worker average CPU time;/u })).toBeVisible();
  await cpu.getByRole("button", { name: "Hide CPU time" }).click();
  await expect(cpu.getByRole("img", { name: /^Worker average CPU time;/u })).toHaveCount(0);
  await expect(cpu.getByRole("button", { name: "Show CPU time" })).toHaveAttribute("aria-expanded", "false");
  await expect(cpu.getByRole("button", { name: "Expand CPU time" })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
  await expect(page.locator("#worker-cpu").getByRole("img", { name: /^Worker average CPU time;/u })).toHaveCount(0);
  await page.getByRole("region", { name: "Project summary" }).getByRole("button", { name: /^CPU time: / }).click();
  await expect(page.locator("#worker-cpu").getByRole("img", { name: /^Worker average CPU time;/u })).toBeVisible();
});

test("configured probes surface endpoint health and a down endpoint raises an incident", async ({ page }) => {
  const options = { probes: true, probeDown: false };
  const requests = await mock(page, options);
  await page.goto("/#/project/stuff");
  const strip = page.getByRole("region", { name: "Project summary" });
  await expect(strip.getByRole("button", { name: /^Endpoints: all up/u })).toBeVisible();
  const widget = page.locator("#endpoints");
  await expect(widget.getByRole("heading", { name: "Endpoints" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Endpoint availability;/u })).toBeVisible();
  await expect(page.getByRole("img", { name: /Endpoint response time;/u })).toBeVisible();
  await expect(page.locator(".widget:not(.charts .widget)")).toHaveCount(0);
  expect(requests.some(request => request.includes("kinds=") && request.includes("probes"))).toBe(true);

  options.probeDown = true;
  await page.getByRole("button", { name: "Refresh" }).click();
  const down = strip.getByRole("button", { name: /^Endpoints: down/u });
  await expect(down).toHaveClass(/is-critical/);
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
  expect(requests.some(request => request.includes("kinds=") && request.includes("durable-objects"))).toBe(true);
});

test("a project without namespaces has no Durable Object widget and makes no request for one", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.locator("#routes")).toBeVisible();
  await expect(page.locator("#durable-objects")).toHaveCount(0);
  expect(requests.some(request => request.startsWith("/api/v1/projects/stuff/history") && request.includes("durable-objects"))).toBe(false);
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
  await expect(page.locator("#d1").getByRole("img", { name: /D1 database size;/u })).toBeVisible();
  expect(requests.some(request => request.includes("kinds=") && request.includes("d1-statements"))).toBe(true);
});

test("a project without databases has no D1 widget, no D1 request, and a cost estimate without D1 rows", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  const cost = page.locator("#cost").getByRole("table", { name: "Estimated cost by component" });
  await expect(cost.getByRole("row", { name: /Worker requests/u })).toBeVisible();
  await expect(cost.getByRole("row", { name: /D1/u })).toHaveCount(0);
  await expect(page.locator("#d1")).toHaveCount(0);
  expect(requests.some(request => request.startsWith("/api/v1/projects/stuff/history") && request.includes("d1"))).toBe(false);
});

test("a project without probes has no endpoints widget and makes no probe request", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
  await expect(page.locator("#endpoints")).toHaveCount(0);
  expect(requests.some(request => request.startsWith("/api/v1/projects/stuff/history") && request.includes("probes"))).toBe(false);
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
  await mock(page);
  await page.goto("/");
  const table = page.getByRole("table", { name: "Projects" });
  const cell = table.locator(".state-cell").first();
  const before = await cell.evaluate(element => { const style = getComputedStyle(element); return [style.backgroundColor, style.paddingTop, style.cursor]; });
  await cell.locator(".badge").hover({ force: true });
  const after = await cell.evaluate(element => { const style = getComputedStyle(element); return [style.backgroundColor, style.paddingTop, style.cursor]; });
  expect(after).toEqual(before);
  expect(before[1]).toBe("0px");
  const pill = await cell.locator(".badge").boundingBox();
  const name = await table.getByRole("link", { name: "stuff" }).boundingBox();
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

const FULL_PAGES: ReadonlyArray<{ readonly name: string; readonly path: string; readonly options: Parameters<typeof mock>[1] }> = [
  { name: "host", path: `/#/host/${hostId}`, options: { accelerator: true } },
  { name: "project", path: "/#/project/stuff", options: { probes: true, durableObjects: true, d1: true } }
];

async function openPage(page: Page, path: string, options: Parameters<typeof mock>[1]): Promise<void> {
  await mock(page, options);
  await page.goto(path);
  await expect(page.locator(".charts > .widget").first()).toBeVisible();
  await expect(page.locator(".chart-empty, .skeleton")).toHaveCount(0);
}

for (const { name, path, options } of FULL_PAGES) {
  test(`the ${name} page keeps every widget's collapse control on the same right inset`, async ({ page }) => {
    await openPage(page, path, options);
    const insets = await page.locator(".widget").evaluateAll(widgets => widgets.map(widget => {
      const button = widget.querySelector(".collapse")?.getBoundingClientRect();
      return button === undefined ? null : Math.round((widget.getBoundingClientRect().right - button.right) * 10) / 10;
    }));
    expect(new Set(insets.filter(inset => inset !== null)).size).toBe(1);
  });

  test(`the ${name} page does not scroll sideways at any supported width`, async ({ page }) => {
    await mock(page, options);
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await expect(page.locator(".charts > .widget").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}px`).toBeLessThanOrEqual(1);
    }
  });

  test(`collapsing a widget on the ${name} page moves none of its header controls and centers its title`, async ({ page }) => {
    await openPage(page, path, options);
    const headerBoxes = () => page.locator(".widget[id]").evaluateAll(widgets => widgets.map(widget => {
      const box = (selector: string) => {
        const rect = widget.querySelector(selector)?.getBoundingClientRect();
        return rect === undefined ? null : { x: rect.x - widget.getBoundingClientRect().x, y: rect.y - widget.getBoundingClientRect().y, height: rect.height };
      };
      return { id: widget.id, title: box("h2"), expand: box(".expand"), collapse: box(".collapse") };
    }));
    const before = await headerBoxes();
    const ids = before.map(entry => entry.id);
    for (const id of ids) await page.locator(`#${id} .collapse`).click();
    const after = await headerBoxes();
    expect(after).toEqual(before);
    const margins = await page.locator(".widget.collapsed").evaluateAll(widgets => widgets.map(widget => {
      const widgetRect = widget.getBoundingClientRect();
      const title = widget.querySelector("h2")?.getBoundingClientRect();
      return title === undefined ? null : Math.abs((title.top - widgetRect.top) - (widgetRect.bottom - title.bottom));
    }));
    expect(margins.length).toBe(ids.length);
    for (const margin of margins) expect(margin).toBeLessThanOrEqual(1);
  });
}

test("no element id repeats on a page and no widget id repeats across pages, because collapse state is stored by id", async ({ page }) => {
  const widgetIds: string[] = [];
  for (const { path, options } of FULL_PAGES) {
    await page.goto("about:blank");
    await openPage(page, path, options);
    const ids = await page.locator("[id]").evaluateAll(elements => elements.map(element => element.id));
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    widgetIds.push(...await page.locator(".widget[id]").evaluateAll(widgets => widgets.map(widget => widget.id)));
    await page.unrouteAll({ behavior: "wait" });
  }
  expect(widgetIds.filter((id, index) => widgetIds.indexOf(id) !== index)).toEqual([]);
});
