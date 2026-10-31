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
      cpu: { user: 8 + index, system: 3, idle: 80, iowait: 1, steal: 0 },
      load: { one: 0.4 + index / 100, five: 0.5, fifteen: 0.6 },
      mem: { total: 8_589_934_592, available: 4_294_967_296 - index * 1_000_000, swapUsed: 0 },
      psi: { cpu: { some10: 1.2, some60: 0.8, some300: 0.4 }, memory: { some10: 0.1, some60: 0.05, some300: 0.02 }, io: { some10: 0.3, some60: 0.2, some300: 0.1 } }
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

async function mock(page: Page, options: { online?: boolean; empty?: boolean; latest?: boolean } = {}): Promise<string[]> {
  const requests: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const range = url.searchParams.get("range") ?? "1h";
    const kind = url.searchParams.get("kind") ?? "summary";
    if (url.pathname === "/api/v1/hosts") {
      return route.fulfill({ json: { hosts: [{ hostId, name: "alpha", createdAtMs: now - 100_000, revoked: false, lastReceivedAtMs: options.online === false ? now - 120_000 : now - 5_000, online: options.online !== false }] } });
    }
    if (url.pathname.endsWith("/latest")) {
      if (options.latest === false) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "no samples" } } });
      return route.fulfill({ json: { hostId, receivedAtMs: options.online === false ? now - 120_000 : now - 5_000, sample: { seq: "900015", atMs: String(now - 5_000), monoMs: "900015000", uptimeMs: "900000000", cpuCount: 8, cpu: { user: "1", system: "1", idle: "1", iowait: "0", steal: "0", total: "4" } } } });
    }
    const empty = options.empty === true;
    if (kind === "disks") return route.fulfill({ json: disks(range, empty) });
    if (kind === "nets") return route.fulfill({ json: nets(range, empty) });
    if (kind === "filesystems") return route.fulfill({ json: filesystems(range, empty) });
    if (kind === "block") return route.fulfill({ json: block(range, empty) });
    return route.fulfill({ json: summary(range, empty) });
  });
  return requests;
}

test("fleet and host views render charts, ranges, and keyboard controls", async ({ page }, testInfo) => {
  const requests = await mock(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "alpha" })).toBeVisible();
  await expect(page.locator("table")).toContainText("online");
  await expect(page.locator("svg").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("fleet.png"), fullPage: true });

  await page.getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "alpha" })).toBeVisible();
  const cpuChart = page.getByRole("img", { name: /CPU;/ });
  await expect(cpuChart).toBeVisible();
  await expect(cpuChart).toHaveAttribute("tabindex", "0");
  await cpuChart.focus();
  await page.keyboard.press("ArrowLeft");
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
  await expect(page.locator("table").filter({ hasText: "sda" })).toContainText("sda");
  await expect(page.locator("table").filter({ hasText: "eth0" })).toContainText("eth0");
  await expect(page.getByRole("heading", { name: "Block latency" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Block latency;/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("host.png"), fullPage: true });
});

test("missing and stale data never become zero", async ({ page }) => {
  await mock(page, { online: false, empty: true, latest: false });
  await page.goto("/");
  await expect(page.locator("table")).toContainText("stale");
  await page.getByRole("link", { name: "alpha" }).click();
  await expect(page.getByText("No samples were accepted in this range.")).toBeVisible();
  await expect(page.getByText(/No samples were accepted/u)).toBeVisible();
});

test("mobile layout has no horizontal page overflow", async ({ page }, testInfo) => {
  await mock(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "alpha" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(overflow).toBe(true);
  await page.getByRole("link", { name: "alpha" }).click();
  await expect(page.getByRole("heading", { name: "alpha" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
});
