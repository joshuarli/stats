#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const USAGE = "usage: node scripts/bench-ui.mjs [--base URL] [--runs N] [--latency MS] [--down KBPS] [--cpu RATE] [--retention N] [--json] [--out PATH]";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value\n${USAGE}`);
  return value;
}
if (args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const initialCwd = process.env.INIT_CWD ?? process.cwd();
const base = option("--base", process.env.BASE ?? `http://127.0.0.1:${process.env.PREVIEW_PORT ?? 4174}`);
const runs = Number(option("--runs", "5"));
const latency = Number(option("--latency", "150"));
const downKbps = Number(option("--down", "1600"));
const cpuRate = Number(option("--cpu", "1"));
const retentionSteps = Number(option("--retention", "0"));
const outArg = option("--out", null);
const outPath = outArg === null ? null : resolve(initialCwd, outArg);

if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer\n${USAGE}`);
if (!Number.isInteger(retentionSteps) || retentionSteps < 0) throw new Error(`--retention must be a non-negative integer\n${USAGE}`);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const previewScript = resolve(scriptDir, "preview.mjs");

async function isPreviewReady(url) {
  try {
    const response = await fetch(`${url}/api/v1/hosts`);
    if (!response.ok) return false;
    const body = await response.json();
    const count = body.hosts?.length ?? 0;
    if ((process.env.PREVIEW_SCALE ?? "default") === "large") return count >= 24;
    return count > 0 && count < 24;
  } catch {
    return false;
  }
}

let activeBase = base;
async function ensurePreview(url) {
  if (await isPreviewReady(url)) return null;
  const parsed = new URL(url);
  const targetPort = option("--base", null) !== null || process.env.BASE !== undefined
    ? (parsed.port || "4174")
    : String(4174 + Math.floor(Math.random() * 500) + 1);
  activeBase = `http://${parsed.hostname}:${targetPort}`;
  const child = spawn(process.execPath, [previewScript], {
    env: { ...process.env, PREVIEW_PORT: targetPort },
    stdio: "ignore"
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isPreviewReady(activeBase)) return child;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  child.kill();
  throw new Error(`preview did not become ready at ${activeBase}`);
}

const spawnedPreview = await ensurePreview(base);
const cleanupPreview = () => {
  if (spawnedPreview !== null) {
    try {
      spawnedPreview.kill();
    } catch {}
  }
};
process.on("exit", cleanupPreview);

async function fetchJson(path) {
  const response = await fetch(activeBase + path);
  if (!response.ok) throw new Error(`${activeBase}${path} returned ${response.status}`);
  return response.json();
}

async function fetchOptionalJson(path, fallback) {
  try {
    const response = await fetch(activeBase + path);
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

const hosts = (await fetchJson("/api/v1/hosts")).hosts ?? [];
const projects = await fetchJson("/api/v1/projects");
const rawServices = await fetchOptionalJson("/api/v1/services", { services: [] });
const services = Array.isArray(rawServices) ? rawServices : (rawServices.services ?? []);

const primaryHost = hosts[0];
const statsProject = projects.find(project => project.id === "stats") ?? projects[0];
const fallbackServices = services.length > 0 ? services : (primaryHost === undefined ? [] : [{
  name: "web",
  hostIds: [primaryHost.hostId],
  healthUrl: "https://web.ts.net/health",
  unit: "web.service",
  createdAtMs: primaryHost.createdAtMs
}]);
const primaryServiceName = fallbackServices[0]?.name ?? "web";

function classifyPath(pathWithSearch) {
  const pathname = pathWithSearch.split("?")[0] ?? pathWithSearch;
  if (pathname.startsWith("/api/observe/")) return "observe";
  if (/^\/api\/v1\/(?:hosts|projects)\/[^/]+\/history$/u.test(pathname)) return "history";
  if (pathname.startsWith("/api/")) return "json";
  return "asset";
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function spread(values) {
  if (values.length === 0) return { min: 0, median: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1)
  };
}

async function attachPreviewFallbacks(page) {
  const etags = new Map();
  await page.route(/\/api\/v1\//u, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const key = url.pathname + url.search;
    if (url.pathname === "/api/v1/services") {
      const upstream = await route.fetch();
      if (upstream.status() === 404) {
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
          body: JSON.stringify({ services: fallbackServices })
        });
        return;
      }
      await route.fulfill({ response: upstream });
      return;
    }
    const serviceDeploys = /^\/api\/v1\/services\/([^/]+)\/deployments$/u.exec(url.pathname);
    if (serviceDeploys !== null) {
      const upstream = await route.fetch();
      if (upstream.status() === 404) {
        const svcName = decodeURIComponent(serviceDeploys[1]);
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
          body: JSON.stringify({
            projectId: svcName,
            worker: svcName,
            enabled: true,
            sync: null,
            versions: [],
            deployments: [],
            markers: []
          })
        });
        return;
      }
      await route.fulfill({ response: upstream });
      return;
    }
    if (/^\/api\/v1\/(?:hosts|projects)\/[^/]+\/history$/u.test(url.pathname)) {
      const ifNoneMatch = request.headers()["if-none-match"];
      const upstream = await route.fetch();
      if (upstream.status() === 304) {
        await route.fulfill({ response: upstream });
        return;
      }
      if (upstream.status() === 200) {
        const body = await upstream.body();
        const existingEtag = upstream.headers()["etag"];
        const etag = existingEtag ?? `W/"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
        etags.set(key, etag);
        if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
          await route.fulfill({
            status: 304,
            headers: { ETag: etag, "Cache-Control": "no-store", Vary: "Accept-Encoding" }
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: {
            "Content-Type": upstream.headers()["content-type"] ?? "application/vnd.stats.history.v1",
            ETag: etag,
            "Cache-Control": "no-store",
            Vary: "Accept-Encoding"
          },
          body
        });
        return;
      }
    }
    await route.continue();
  });
}

function createNetworkTracker(page) {
  let active = 0;
  let records = [];
  const pending = new Map();

  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== new URL(activeBase).origin) return;
    active += 1;
    pending.set(request, { path: url.pathname + url.search, method: request.method() });
  });

  const finish = async (request, failed) => {
    const info = pending.get(request);
    if (!info) return;
    pending.delete(request);
    let status = failed ? 0 : 200;
    let bytes = 0;
    try {
      const response = await request.response();
      if (response) {
        status = response.status();
        if (status !== 304 && !failed) {
          const body = await response.body();
          bytes = body.byteLength;
        }
      }
    } catch {}
    records.push({
      path: info.path,
      kind: classifyPath(info.path),
      status,
      bytes
    });
    active = Math.max(0, active - 1);
  };

  page.on("requestfinished", request => { void finish(request, false); });
  page.on("requestfailed", request => { void finish(request, true); });

  return {
    reset() {
      records = [];
    },
    snapshot() {
      return [...records];
    },
    async waitForQuiet(quietMs = 180, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      let quietSince = active === 0 ? Date.now() : null;
      while (Date.now() < deadline) {
        if (active === 0) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= quietMs) return;
        } else {
          quietSince = null;
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
    }
  };
}

async function waitForSelector(page, selector) {
  await page.waitForFunction(sel => document.querySelector(sel) !== null, selector, { timeout: 30_000 });
}

async function readCdpState(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await new Promise(resolveWait => setTimeout(resolveWait, 25));
  await cdp.send("HeapProfiler.collectGarbage");
  const [{ metrics }, heap] = await Promise.all([
    cdp.send("Performance.getMetrics"),
    cdp.send("Runtime.getHeapUsage")
  ]);
  const map = Object.fromEntries(metrics.map(entry => [entry.name, entry.value]));
  return {
    heapUsedBytes: heap.usedSize,
    heapBackingBytes: heap.backingStorageSize ?? 0,
    nodes: map.Nodes ?? 0,
    listeners: map.JSEventListeners ?? 0,
    taskDurationSec: map.TaskDuration ?? 0,
    scriptDurationSec: map.ScriptDuration ?? 0
  };
}

function summarizeNetwork(records) {
  const byClass = { asset: 0, json: 0, history: 0, observe: 0 };
  let jsBytes = 0;
  let cssBytes = 0;
  let apiBytes = 0;
  let historyBytes = 0;
  let observeBytes = 0;
  let jsonBytes = 0;
  for (const record of records) {
    byClass[record.kind] = (byClass[record.kind] ?? 0) + 1;
    if (record.kind === "asset") {
      const pathname = record.path.split("?")[0] ?? "";
      if (pathname.endsWith(".js")) jsBytes += record.bytes;
      else if (pathname.endsWith(".css")) cssBytes += record.bytes;
    } else {
      apiBytes += record.bytes;
      if (record.kind === "history") historyBytes += record.bytes;
      else if (record.kind === "observe") observeBytes += record.bytes;
      else jsonBytes += record.bytes;
    }
  }
  const requestList = records.map(record => record.path);
  const apiRequestList = records.filter(record => record.kind !== "asset").map(record => record.path);
  return {
    requests: records.length,
    apiRequests: apiRequestList.length,
    byClass,
    jsBytes,
    jsKb: +(jsBytes / 1024).toFixed(1),
    cssBytes,
    cssKb: +(cssBytes / 1024).toFixed(1),
    apiBytes,
    apiKb: +(apiBytes / 1024).toFixed(1),
    historyBytes,
    observeBytes,
    jsonBytes,
    requestList,
    apiRequestList
  };
}

function summarizeSamples(samples) {
  const numericKeys = [
    "fcpMs", "lcpMs", "readyMs", "ttfbMs",
    "jsBytes", "jsKb", "cssBytes", "cssKb", "apiBytes", "apiKb", "historyBytes", "observeBytes", "jsonBytes",
    "requests", "apiRequests",
    "heapKb", "heapUsedKb", "heapBackingKb", "nodes", "listeners",
    "taskMs", "scriptMs", "maxLongTaskMs", "totalLongTaskMs"
  ].filter(key => key in (samples[0] ?? {}));
  const summary = {};
  for (const key of numericKeys) {
    const med = median(samples.map(sample => sample[key]));
    summary[key] = key.endsWith("Kb") || key.endsWith("Ms") ? +med.toFixed(1) : Math.round(med);
  }
  const medianIdx = Math.floor(samples.length / 2);
  const sortedByReady = [...samples].sort((left, right) => left.readyMs - right.readyMs);
  const representative = sortedByReady[medianIdx] ?? samples[0];
  summary.byClass = {
    asset: Math.round(median(samples.map(sample => sample.byClass.asset))),
    json: Math.round(median(samples.map(sample => sample.byClass.json))),
    history: Math.round(median(samples.map(sample => sample.byClass.history))),
    observe: Math.round(median(samples.map(sample => sample.byClass.observe)))
  };
  summary.spreadReadyMs = spread(samples.map(sample => Math.round(sample.readyMs)));
  summary.requestList = representative?.requestList ?? [];
  summary.apiRequestList = representative?.apiRequestList ?? [];
  return summary;
}

const routeTargets = [
  {
    name: "fleet",
    hash: "#/",
    url: `${activeBase}/#/`,
    pivotHash: "#/services",
     pivotReady: "main.content .widget, main.content .empty-state, main.content .error-state",
    ready: 'table[aria-label="Fleet hosts"] tbody tr'
  },
  ...(primaryHost === undefined ? [] : [{
    name: "host",
    hash: `#/host/${primaryHost.hostId}`,
    url: `${activeBase}/#/host/${primaryHost.hostId}`,
    pivotHash: "#/",
    pivotReady: 'table[aria-label="Fleet hosts"] tbody tr',
    ready: ".chart-plot .uplot"
  }]),
  {
    name: "projects",
    hash: "#/projects",
    url: `${activeBase}/#/projects`,
    pivotHash: "#/",
    pivotReady: 'table[aria-label="Fleet hosts"] tbody tr',
    ready: 'table[aria-label="Projects"] tbody tr'
  },
  ...(statsProject === undefined ? [] : [{
    name: "project",
    hash: `#/project/${statsProject.id}`,
    url: `${activeBase}/#/project/${statsProject.id}`,
    pivotHash: "#/projects",
    pivotReady: 'table[aria-label="Projects"] tbody tr',
    ready: '[aria-label="Cost ledger"]'
  }]),
  {
    name: "services",
    hash: "#/services",
    url: `${activeBase}/#/services`,
    pivotHash: "#/",
    pivotReady: 'table[aria-label="Fleet hosts"] tbody tr',
    ready: 'table[aria-label="Services"] tbody tr, main.content .empty-state, main.content .error-state'
  },
  {
    name: "service",
    hash: `#/service/${primaryServiceName}`,
    url: `${activeBase}/#/service/${primaryServiceName}`,
    pivotHash: "#/services",
    pivotReady: 'table[aria-label="Services"] tbody tr, main.content .empty-state, main.content .error-state',
    ready: "#service-work, main.content .empty-state, main.content .error-state"
  },
  ...(statsProject === undefined ? [] : [{
    name: "project-errors",
    hash: `#/project/${statsProject.id}?section=errors`,
    url: `${activeBase}/#/project/${statsProject.id}?section=errors`,
    pivotHash: "#/projects",
    pivotReady: 'table[aria-label="Projects"] tbody tr',
    ready: "#issues .issue-list, #issues .observe-empty"
  }, {
    name: "project-requests",
    hash: `#/project/${statsProject.id}?section=requests`,
    url: `${activeBase}/#/project/${statsProject.id}?section=requests`,
    pivotHash: "#/projects",
    pivotReady: 'table[aria-label="Projects"] tbody tr',
    ready: "#route-explorer .route-table, #route-explorer .observe-empty"
  }])
];

const initScript = () => {
  window.__bench = { lcp: 0, longTasks: [] };
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) window.__bench.lcp = entry.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) window.__bench.longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
};

const browser = await chromium.launch();

async function runRetentionTrace(steps) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await attachPreviewFallbacks(page);
  const tracker = createNetworkTracker(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  await page.goto(`${activeBase}/#/`, { waitUntil: "load" });
  await waitForSelector(page, 'table[aria-label="Fleet hosts"] tbody tr');
  await tracker.waitForQuiet();

  const checkpoints = [];
  const recordCheckpoint = async step => {
    const state = await readCdpState(cdp);
    const domInfo = await page.evaluate(() => ({
      uplotRoots: document.querySelectorAll(".uplot").length
    }));
    checkpoints.push({
      step,
      heapUsedKb: +(state.heapUsedBytes / 1024).toFixed(1),
      heapBackingKb: +(state.heapBackingBytes / 1024).toFixed(1),
      nodes: state.nodes,
      listeners: state.listeners,
      uplotRoots: domInfo.uplotRoots
    });
  };

  await recordCheckpoint(0);
  const rangeCycle = ["1h", "6h", "24h", "7d", "30d"];
  let fleetPagesVisited = new Set([1]);

  for (let step = 1; step <= steps; step += 1) {
    const mode = step % 5;
    if (mode === 1 || mode === 2) {
      const host = hosts[(step + Math.floor(step / 2)) % hosts.length];
      const range = rangeCycle[step % rangeCycle.length];
      await page.evaluate(targetHash => { window.location.hash = targetHash; }, `#/host/${host.hostId}`);
      await waitForSelector(page, ".chart-plot .uplot");
      await page.getByRole("button", { name: range, exact: true }).click();
    } else if (mode === 3) {
      const project = projects[step % projects.length];
      const range = rangeCycle[step % 3];
      await page.evaluate(targetHash => { window.location.hash = targetHash; }, `#/project/${project.id}`);
      await waitForSelector(page, '[aria-label="Cost ledger"], main.content .empty-state');
      await page.getByRole("button", { name: range, exact: true }).click();
    } else if (mode === 4) {
      await page.evaluate(() => { window.location.hash = "#/projects"; });
      await waitForSelector(page, 'table[aria-label="Projects"] tbody tr');
    } else {
      await page.evaluate(() => { window.location.hash = "#/"; });
      await waitForSelector(page, 'table[aria-label="Fleet hosts"] tbody tr');
      const totalPages = Math.max(1, Math.ceil(hosts.length / 10));
      if (totalPages > 1) {
        const targetPage = ((Math.floor(step / 5) - 1) % totalPages) + 1;
        const pageText = await page.getByText(/^Page \d+ of \d+$/u).textContent();
        const current = /^Page (\d+) of (\d+)$/u.exec(pageText?.trim() ?? "");
        if (current === null || Number(current[2]) !== totalPages) throw new Error(`Unexpected fleet pagination: ${pageText}`);
        let currentPage = Number(current[1]);
        while (currentPage !== targetPage) {
          const direction = currentPage < targetPage ? 1 : -1;
          await page.getByRole("button", { name: direction === 1 ? "Next page" : "Previous page" }).click();
          currentPage += direction;
          await page.getByText(`Page ${currentPage} of ${totalPages}`, { exact: true }).waitFor();
          await tracker.waitForQuiet(60, 5_000);
        }
        fleetPagesVisited.add(currentPage);
      }
    }
    await tracker.waitForQuiet(60, 5_000);
    if (step % 25 === 0 || step === steps) {
      await recordCheckpoint(step);
    }
  }

  await page.evaluate(() => { window.location.hash = "#/"; });
  await waitForSelector(page, 'table[aria-label="Fleet hosts"] tbody tr');
  await tracker.waitForQuiet(100, 5_000);
  const finalOnFleet = await readCdpState(cdp);
  const uplotRootsOnFleet = await page.evaluate(() => document.querySelectorAll(".uplot").length);

  await context.close();
  const first = checkpoints[0];
  const last = checkpoints.at(-1);
  return {
    steps,
    fixture: {
      hosts: hosts.length,
      projects: projects.length,
      services: fallbackServices.length,
      fleetPages: Math.max(1, Math.ceil(hosts.length / 10)),
      fleetPagesExercised: fleetPagesVisited.size
    },
    checkpoints,
    finalOnFleet: {
      heapUsedKb: +(finalOnFleet.heapUsedBytes / 1024).toFixed(1),
      heapBackingKb: +(finalOnFleet.heapBackingBytes / 1024).toFixed(1),
      nodes: finalOnFleet.nodes,
      listeners: finalOnFleet.listeners,
      uplotRootsOnFleet
    },
    peakHeapUsedKb: Math.max(...checkpoints.map(point => point.heapUsedKb)),
    peakHeapBackingKb: Math.max(...checkpoints.map(point => point.heapBackingKb)),
    deltaHeapUsedKb: +((last?.heapUsedKb ?? 0) - (first?.heapUsedKb ?? 0)).toFixed(1),
    deltaHeapBackingKb: +((last?.heapBackingKb ?? 0) - (first?.heapBackingKb ?? 0)).toFixed(1)
  };
}

async function measureFleetMetricSort() {
  if (hosts.length <= 10) return null;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await attachPreviewFallbacks(page);
  const tracker = createNetworkTracker(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(`${activeBase}/#/`, { waitUntil: "load" });
  await waitForSelector(page, 'table[aria-label="Fleet hosts"] tbody tr');
  await tracker.waitForQuiet();
  const before = await readCdpState(cdp);
  const start = performance.now();
  await page.getByRole("columnheader", { name: "CPU" }).getByRole("button").click();
  await tracker.waitForQuiet();
  const historyRecords = tracker.snapshot().filter(entry => entry.kind === "history");
  const loaded = new Set(historyRecords.filter(entry => entry.status === 200 || entry.status === 304).map(entry => /^\/api\/v1\/hosts\/([^/]+)\/history/u.exec(entry.path)?.[1]).filter(Boolean));
  if (hosts.some(host => !loaded.has(host.hostId))) throw new Error(`fleet CPU sort loaded ${loaded.size} of ${hosts.length} hosts`);
  const values = [];
  const ids = [];
  for (let currentPage = 0; currentPage < Math.ceil(hosts.length / 10); currentPage += 1) {
    const rows = await page.locator('table[aria-label="Fleet hosts"] tbody tr').evaluateAll(elements => elements.map(row => ({
      href: row.querySelector('a[href^="#/host/"]')?.getAttribute("href") ?? "",
      cpu: row.querySelectorAll("td")[1]?.querySelector(".metric-value-small")?.textContent?.trim() ?? ""
    })));
    for (const row of rows) {
      const value = Number.parseFloat(row.cpu);
      values.push(Number.isFinite(value) ? value : null);
      ids.push(row.href);
    }
    if (currentPage + 1 < Math.ceil(hosts.length / 10)) {
      const previous = rows[0]?.href;
      await page.getByRole("button", { name: "Next page" }).click();
      await page.waitForFunction(href => document.querySelector('table[aria-label="Fleet hosts"] tbody tr a[href^="#/host/"]')?.getAttribute("href") !== href, previous);
      await tracker.waitForQuiet();
    }
  }
  if (ids.length !== hosts.length || new Set(ids).size !== hosts.length) throw new Error("fleet CPU sort omitted or duplicated hosts");
  let last = -Infinity;
  let missing = false;
  for (const value of values) {
    if (value === null) { missing = true; continue; }
    if (missing || value < last) throw new Error("fleet CPU values are not globally ordered");
    last = value;
  }
  const after = await readCdpState(cdp);
  const result = { hosts: hosts.length, historyHosts: loaded.size, historyRequests: historyRecords.length, requests: summarizeNetwork(tracker.snapshot()), sortedCpuValues: values, wallMs: +(performance.now() - start).toFixed(1), taskMs: +((after.taskDurationSec - before.taskDurationSec) * 1000).toFixed(1), scriptMs: +((after.scriptDurationSec - before.scriptDurationSec) * 1000).toFixed(1) };
  await context.close();
  return result;
}

async function measurePreviewNodeTimings() {
  const probes = [
    ["hosts", "/api/v1/hosts"],
    ...(primaryHost === undefined ? [] : [["hostHistory1h", `/api/v1/hosts/${primaryHost.hostId}/history?range=1h&kinds=summary,disks,nets,filesystems,block`]]),
    ...(statsProject === undefined ? [] : [["projectHistory1h", `/api/v1/projects/${statsProject.id}/history?range=1h&kinds=worker,routes,r2,collector,durable-objects`]]),
    ["observeHealth", "/api/observe/stats/health"]
  ];
  const timings = {};
  for (const [label, path] of probes) {
    for (let warmup = 0; warmup < 3; warmup += 1) {
      const response = await fetch(activeBase + path);
      await response.arrayBuffer();
    }
    const samplesMs = [];
    let bytes = 0;
    for (let iter = 0; iter < 15; iter += 1) {
      const start = process.hrtime.bigint();
      const response = await fetch(activeBase + path);
      const buf = await response.arrayBuffer();
      bytes = buf.byteLength;
      samplesMs.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const stats = spread(samplesMs);
    timings[label] = {
      path,
      bytes,
      medianMs: +stats.median.toFixed(2),
      minMs: +stats.min.toFixed(2),
      maxMs: +stats.max.toFixed(2)
    };
  }
  return timings;
}

async function measureConditionalHistoryAndCharts() {
  if (primaryHost === undefined || statsProject === undefined) return { conditionalHistory: null, charts: null };
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await attachPreviewFallbacks(page);
  const tracker = createNetworkTracker(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  const hostRanges = {};
  for (const range of ["1h", "24h", "7d"]) {
    tracker.reset();
    if (range === "1h") {
      await page.goto(`${activeBase}/#/host/${primaryHost.hostId}?range=1h`, { waitUntil: "load" });
      await waitForSelector(page, ".chart-plot .uplot");
    } else {
      await page.getByRole("button", { name: range, exact: true }).click();
    }
    await tracker.waitForQuiet();
    const initialHistory = tracker.snapshot().find(entry => entry.kind === "history" && entry.path.includes(`range=${range}`));
    tracker.reset();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await tracker.waitForQuiet();
    const revalidated = tracker.snapshot().find(entry => entry.kind === "history" && entry.path.includes(`range=${range}`));
    hostRanges[range] = {
      initialStatus: initialHistory?.status ?? 0,
      frameBytes: initialHistory?.bytes ?? 0,
      revalidateStatus: revalidated?.status ?? 0,
      revalidateBytes: revalidated?.bytes ?? 0
    };
  }

  await page.getByRole("button", { name: "1h", exact: true }).click();
  await tracker.waitForQuiet();
  const projectRanges = {};
  for (const range of ["1h", "24h", "7d"]) {
    tracker.reset();
    if (range === "1h") {
      await page.evaluate(projectId => { window.location.hash = `#/project/${projectId}?range=1h`; }, statsProject.id);
      await waitForSelector(page, '[aria-label="Cost ledger"]');
    } else {
      await page.getByRole("button", { name: range, exact: true }).click();
    }
    await tracker.waitForQuiet();
    const initialHistory = tracker.snapshot().find(entry => entry.kind === "history" && entry.path.includes(`range=${range}`));
    tracker.reset();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await tracker.waitForQuiet();
    const revalidated = tracker.snapshot().find(entry => entry.kind === "history" && entry.path.includes(`range=${range}`));
    projectRanges[range] = {
      initialStatus: initialHistory?.status ?? 0,
      frameBytes: initialHistory?.bytes ?? 0,
      revalidateStatus: revalidated?.status ?? 0,
      revalidateBytes: revalidated?.bytes ?? 0
    };
  }

  await page.getByRole("button", { name: "1h", exact: true }).click();
  await tracker.waitForQuiet();
  const chartStart = performance.now();
  await page.evaluate(() => { window.location.hash = "#/"; });
  await waitForSelector(page, 'table[aria-label="Fleet hosts"] tbody tr');
  await tracker.waitForQuiet();
  const hostNavStart = performance.now();
  await page.evaluate(hostId => { window.location.hash = `#/host/${hostId}?range=1h`; }, primaryHost.hostId);
  await waitForSelector(page, ".chart-plot .uplot");
  const chartReadyMs = +(performance.now() - hostNavStart).toFixed(1);
  void chartStart;
  await tracker.waitForQuiet();

  const beforeRange = await readCdpState(cdp);
  const rangeWallStart = performance.now();
  for (const nextRange of ["24h", "7d", "1h"]) {
    await page.getByRole("button", { name: nextRange, exact: true }).click();
    await tracker.waitForQuiet(100, 5_000);
  }
  const rangeWallMs = +(performance.now() - rangeWallStart).toFixed(1);
  const afterRange = await readCdpState(cdp);

  const beforeCycles = await readCdpState(cdp);
  for (let cycle = 0; cycle < 10; cycle += 1) {
    await page.evaluate(() => { window.location.hash = "#/"; });
    await waitForSelector(page, 'table[aria-label="Fleet hosts"] tbody tr');
    await page.evaluate(hostId => { window.location.hash = `#/host/${hostId}?range=1h`; }, primaryHost.hostId);
    await waitForSelector(page, ".chart-plot .uplot");
  }
  await tracker.waitForQuiet(100, 5_000);
  const afterCycles = await readCdpState(cdp);
  const activePlotsOnHost = await page.evaluate(() => document.querySelectorAll(".uplot").length);

  await page.evaluate(() => { window.location.hash = "#/"; });
  await waitForSelector(page, 'table[aria-label="Fleet hosts"] tbody tr');
  await tracker.waitForQuiet(100, 5_000);
  const afterLeave = await readCdpState(cdp);
  const uplotRootsAfterLeave = await page.evaluate(() => document.querySelectorAll(".uplot").length);

  await context.close();
  return {
    conditionalHistory: {
      host: hostRanges,
      project: projectRanges
    },
    charts: {
      chartReadyMs,
      activePlotsOnHost,
      rangeChange: {
        wallMs: rangeWallMs,
        taskMs: +((afterRange.taskDurationSec - beforeRange.taskDurationSec) * 1000).toFixed(1),
        scriptMs: +((afterRange.scriptDurationSec - beforeRange.scriptDurationSec) * 1000).toFixed(1)
      },
      mountDestroy10Cycles: {
        beforeHeapUsedKb: +(beforeCycles.heapUsedBytes / 1024).toFixed(1),
        afterHeapUsedKb: +(afterCycles.heapUsedBytes / 1024).toFixed(1),
        heapDeltaKb: +((afterCycles.heapUsedBytes - beforeCycles.heapUsedBytes) / 1024).toFixed(1),
        beforeBackingKb: +(beforeCycles.heapBackingBytes / 1024).toFixed(1),
        afterBackingKb: +(afterCycles.heapBackingBytes / 1024).toFixed(1),
        backingDeltaKb: +((afterCycles.heapBackingBytes - beforeCycles.heapBackingBytes) / 1024).toFixed(1),
        nodesDelta: afterCycles.nodes - beforeCycles.nodes,
        listenersDelta: afterCycles.listeners - beforeCycles.listeners,
        uplotRootsAfterLeave,
        afterLeaveHeapUsedKb: +(afterLeave.heapUsedBytes / 1024).toFixed(1)
      }
    }
  };
}

const results = [];
for (const target of routeTargets) {
  process.stderr.write(`Measuring ${target.name}\n`);
  const coldSamples = [];
  const warmSamples = [];
  for (let run = 0; run < runs; run += 1) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await attachPreviewFallbacks(page);
    await page.addInitScript(initScript);
    const tracker = createNetworkTracker(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency,
      downloadThroughput: (downKbps * 1000) / 8,
      uploadThroughput: (downKbps * 500) / 8,
      connectionType: "cellular4g"
    });
    if (cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });

    const beforeCold = await readCdpState(cdp);
    tracker.reset();
    await page.goto(target.url, { waitUntil: "load" });
    await waitForSelector(page, target.ready);
    const readyMs = await page.evaluate(() => performance.now());
    await tracker.waitForQuiet();
    const paintTiming = await page.evaluate(ready => {
      const nav = performance.getEntriesByType("navigation")[0];
      const paints = Object.fromEntries(performance.getEntriesByType("paint").map(entry => [entry.name, entry.startTime]));
      return {
        fcpMs: paints["first-contentful-paint"] ?? 0,
        lcpMs: window.__bench.lcp,
        readyMs: ready,
        ttfbMs: nav?.responseStart ?? 0,
        maxLongTaskMs: Math.max(0, ...window.__bench.longTasks),
        totalLongTaskMs: window.__bench.longTasks.reduce((total, value) => total + value, 0)
      };
    }, readyMs);
    const afterCold = await readCdpState(cdp);
    const coldNet = summarizeNetwork(tracker.snapshot());
    coldSamples.push({
      ...paintTiming,
      ...coldNet,
      heapKb: afterCold.heapUsedBytes / 1024,
      heapUsedKb: afterCold.heapUsedBytes / 1024,
      heapBackingKb: afterCold.heapBackingBytes / 1024,
      nodes: afterCold.nodes,
      listeners: afterCold.listeners,
      taskMs: (afterCold.taskDurationSec - beforeCold.taskDurationSec) * 1000,
      scriptMs: (afterCold.scriptDurationSec - beforeCold.scriptDurationSec) * 1000
    });

    await page.evaluate(hash => { window.location.hash = hash; }, target.pivotHash);
    await waitForSelector(page, target.pivotReady);
    await tracker.waitForQuiet();

    const beforeWarm = await readCdpState(cdp);
    tracker.reset();
    const warmStart = await page.evaluate(hash => {
      const start = performance.now();
      window.location.hash = hash;
      return start;
    }, target.hash);
    await waitForSelector(page, target.ready);
    const warmReadyMs = await page.evaluate(start => performance.now() - start, warmStart);
    await tracker.waitForQuiet();
    const afterWarm = await readCdpState(cdp);
    const warmNet = summarizeNetwork(tracker.snapshot());
    warmSamples.push({
      readyMs: warmReadyMs,
      ...warmNet,
      heapKb: afterWarm.heapUsedBytes / 1024,
      heapUsedKb: afterWarm.heapUsedBytes / 1024,
      heapBackingKb: afterWarm.heapBackingBytes / 1024,
      nodes: afterWarm.nodes,
      listeners: afterWarm.listeners,
      taskMs: (afterWarm.taskDurationSec - beforeWarm.taskDurationSec) * 1000,
      scriptMs: (afterWarm.scriptDurationSec - beforeWarm.scriptDurationSec) * 1000
    });

    await context.close();
  }
  results.push({
    page: target.name,
    url: target.url,
    runs,
    cold: summarizeSamples(coldSamples),
    warm: summarizeSamples(warmSamples)
  });
}

const { conditionalHistory, charts } = await measureConditionalHistoryAndCharts();
const fleetMetricSort = await measureFleetMetricSort();
const previewNodeTimings = await measurePreviewNodeTimings();
const retention = retentionSteps > 0 ? await runRetentionTrace(retentionSteps) : null;

await browser.close();
cleanupPreview();

const output = {
  generatedAt: new Date().toISOString(),
  base: activeBase,
  scale: process.env.PREVIEW_SCALE ?? "default",
  fixture: {
    hosts: hosts.length,
    projects: projects.length,
    services: services.length,
    fleetPages: Math.max(1, Math.ceil(hosts.length / 10))
  },
  latency,
  downKbps,
  cpuRate,
  caveat: "Assets are served uncompressed by the local preview, so jsKb/cssKb are raw transfer sizes; compare compressed bundle sizes with bench-bundle.mjs.",
  results,
  conditionalHistory,
  charts,
  fleetMetricSort,
  previewNodeTimings,
  ...(retention === null ? {} : { retention })
};

if (outPath !== null) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
}

console.log(JSON.stringify(output, null, 2));
