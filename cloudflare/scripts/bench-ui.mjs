#!/usr/bin/env node
/**
 * Dashboard load benchmark against the local preview (`make preview`).
 * Reports medians for first paint, largest paint, content-ready, heap, DOM size,
 * listeners, and transferred bytes under an emulated link. This is a local
 * fixture measurement, not a production latency or billing measurement.
 */
import { chromium } from "@playwright/test";

const USAGE = "usage: node scripts/bench-ui.mjs [--base URL] [--runs N] [--latency MS] [--down KBPS] [--cpu RATE]";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} needs a value\n${USAGE}`);
  return value;
}
if (args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const base = option("--base", process.env.BASE ?? "http://127.0.0.1:4174");
const runs = Number(option("--runs", "5"));
const latency = Number(option("--latency", "150"));
const downKbps = Number(option("--down", "1600"));
const cpuRate = Number(option("--cpu", "1"));
if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer\n${USAGE}`);

async function json(path) {
  let response;
  try {
    response = await fetch(base + path);
  } catch (cause) {
    throw new Error(`cannot reach ${base}${path}; start the preview with "make preview"\n${cause.message}`);
  }
  if (!response.ok) throw new Error(`${base}${path} returned ${response.status}`);
  return response.json();
}

const hosts = (await json("/api/v1/hosts")).hosts ?? [];
const projects = await json("/api/v1/projects");
const pages = [
  { name: "fleet", url: `${base}/#/`, ready: 'table[aria-label="Fleet hosts"] tbody tr' },
  ...(hosts[0] === undefined ? [] : [{ name: "host", url: `${base}/#/host/${hosts[0].hostId}`, ready: ".chart-plot" }]),
  ...(projects[0] === undefined ? [] : [{ name: "project", url: `${base}/#/project/${projects[0].id}`, ready: ".chart-plot" }])
];

const init = () => {
  window.__bench = { lcp: 0, longTasks: [] };
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) window.__bench.lcp = entry.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) window.__bench.longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
};

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const browser = await chromium.launch();
const results = [];
for (const target of pages) {
  const cold = [];
  for (let run = 0; run < runs; run += 1) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.addInitScript(init);
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
    const sample = async () => {
      await page.goto(target.url, { waitUntil: "load" });
      await page.waitForSelector(target.ready, { timeout: 30_000 });
      const readyMs = await page.evaluate(() => performance.now());
      await page.waitForTimeout(250);
      const timing = await page.evaluate(ready => {
        const nav = performance.getEntriesByType("navigation")[0];
        const paints = Object.fromEntries(performance.getEntriesByType("paint").map(entry => [entry.name, entry.startTime]));
        const resources = performance.getEntriesByType("resource");
        const api = resources.filter(entry => entry.name.includes("/api/"));
        const scripts = resources.filter(entry => entry.name.endsWith(".js"));
        return {
          fcpMs: paints["first-contentful-paint"] ?? 0,
          lcpMs: window.__bench.lcp,
          readyMs: ready,
          ttfbMs: nav.responseStart,
          jsKb: scripts.reduce((total, entry) => total + entry.encodedBodySize, 0) / 1024,
          apiKb: api.reduce((total, entry) => total + entry.encodedBodySize, 0) / 1024,
          requests: resources.length,
          maxLongTaskMs: Math.max(0, ...window.__bench.longTasks),
          totalLongTaskMs: window.__bench.longTasks.reduce((total, value) => total + value, 0)
        };
      }, readyMs);
      const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(entry => [entry.name, entry.value]));
      return { ...timing, heapKb: metrics.JSHeapUsedSize / 1024, nodes: metrics.Nodes, listeners: metrics.JSEventListeners };
    };
    cold.push(await sample());
    await context.close();
  }
  const summarize = samples => Object.fromEntries(Object.entries(samples[0]).map(([key]) => [key, Math.round(median(samples.map(sample => sample[key])))]));
  results.push({ page: target.name, runs, cold: summarize(cold) });
}

console.log(JSON.stringify({ base, latency, downKbps, cpuRate, results }, null, 1));
await browser.close();
