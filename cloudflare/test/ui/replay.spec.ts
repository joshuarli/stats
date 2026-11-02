import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillHistory } from "./history-route";
import stuff from "./captures/stuff/capture.json" with { type: "json" };
import stuffCollector from "./captures/stuff/collector-1h.json" with { type: "json" };
import stuffProbes from "./captures/stuff/probes-1h.json" with { type: "json" };
import stuffR2 from "./captures/stuff/r2-1h.json" with { type: "json" };
import stuffRoutes from "./captures/stuff/routes-1h.json" with { type: "json" };
import stuffWorker from "./captures/stuff/worker-1h.json" with { type: "json" };
import threadripper from "./captures/threadripper/capture.json" with { type: "json" };
import block1h from "./captures/threadripper/block-1h.json" with { type: "json" };
import block24h from "./captures/threadripper/block-24h.json" with { type: "json" };
import block7d from "./captures/threadripper/block-7d.json" with { type: "json" };
import disks1h from "./captures/threadripper/disks-1h.json" with { type: "json" };
import disks24h from "./captures/threadripper/disks-24h.json" with { type: "json" };
import disks7d from "./captures/threadripper/disks-7d.json" with { type: "json" };
import filesystems1h from "./captures/threadripper/filesystems-1h.json" with { type: "json" };
import filesystems24h from "./captures/threadripper/filesystems-24h.json" with { type: "json" };
import filesystems7d from "./captures/threadripper/filesystems-7d.json" with { type: "json" };
import nets1h from "./captures/threadripper/nets-1h.json" with { type: "json" };
import nets24h from "./captures/threadripper/nets-24h.json" with { type: "json" };
import nets7d from "./captures/threadripper/nets-7d.json" with { type: "json" };
import summary1h from "./captures/threadripper/summary-1h.json" with { type: "json" };
import summary24h from "./captures/threadripper/summary-24h.json" with { type: "json" };
import summary7d from "./captures/threadripper/summary-7d.json" with { type: "json" };

const captureFile = (name: string, file: string): string => new URL(`./captures/${name}/${file}`, import.meta.url).pathname;

const capturedHistory = {
  "1h": { summary: summary1h, disks: disks1h, nets: nets1h, filesystems: filesystems1h, block: block1h },
  "24h": { summary: summary24h, disks: disks24h, nets: nets24h, filesystems: filesystems24h, block: block24h },
  "7d": { summary: summary7d, disks: disks7d, nets: nets7d, filesystems: filesystems7d, block: block7d }
} as const;

const capturedProjectHistory = {
  worker: stuffWorker,
  routes: stuffRoutes,
  r2: stuffR2,
  collector: stuffCollector,
  probes: stuffProbes
} as const;

function capturedKind(name: string, range: string, kind: string): unknown {
  if (name !== "threadripper") throw new Error(`no composed history for ${name}`);
  const byRange = capturedHistory[range as keyof typeof capturedHistory];
  if (byRange === undefined) throw new Error(`no composed history for ${range}`);
  const history = byRange[kind as keyof typeof byRange];
  if (history === undefined) throw new Error(`no composed history for ${range} ${kind}`);
  return history;
}

function fulfillCapture(route: Route, name: string, file: string, history: boolean) {
  return history ? fulfillHistory(route, JSON.parse(readFileSync(captureFile(name, file), "utf8"))) : route.fulfill({ path: captureFile(name, file), contentType: "application/json" });
}

async function freeze(page: Page, capturedAtMs: number): Promise<void> {
  await page.clock.setFixedTime(capturedAtMs);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .topbar { position: static !important; }";
      document.head.appendChild(style);
    });
  });
}

async function replay(page: Page, name: string, capturedAtMs: number, hasSystem: boolean): Promise<void> {
  await freeze(page, capturedAtMs);
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/projects") return route.fulfill({ json: [] });
    const kind = url.searchParams.get("kind") ?? "summary";
    const kindsParam = url.searchParams.get("kinds");
    const kinds = kindsParam === null ? null : kindsParam.split(",");
    const range = url.searchParams.get("range");
    const fromMs = Number(url.searchParams.get("from"));
    const toMs = Number(url.searchParams.get("to"));
    const emptyHistory = (entry: string) => ({
      hostId: threadripper.hostId,
      kind: entry,
      fromMs,
      toMs,
      resolution: "raw",
      stepMs: 15_000,
      ...(entry === "summary" ? { points: [] } : { series: [] })
    });
    if (range === null && url.pathname.endsWith("/history")) {
      if (kinds !== null) return fulfillHistory(route, { hostId: threadripper.hostId, histories: Object.fromEntries(kinds.map(entry => [entry, emptyHistory(entry)])) });
      return fulfillHistory(route, emptyHistory(kind));
    }
    if (kinds !== null) {
      return fulfillHistory(route, { hostId: threadripper.hostId, histories: Object.fromEntries(kinds.map(entry => [entry, capturedKind(name, range ?? "1h", entry)])) });
    }
    if (url.pathname.endsWith("/system") && !hasSystem) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "no system details for host" } } });
    const file = url.pathname === "/api/v1/hosts" ? "hosts.json" : url.pathname.endsWith("/system") ? "system.json" : `${kind}-${range ?? "1h"}.json`;
    return fulfillCapture(route, name, file, url.pathname.endsWith("/history"));
  });
}

async function replayProject(page: Page, name: string, capturedAtMs: number): Promise<void> {
  await freeze(page, capturedAtMs);
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/hosts") return route.fulfill({ json: { hosts: [] } });
    if (url.pathname === "/api/v1/projects") return route.fulfill({ path: captureFile(name, "projects.json"), contentType: "application/json" });
    if (url.pathname === `/api/v1/projects/${name}/deployments`) return route.fulfill({ json: { projectId: name, worker: name, enabled: false, sync: null, deployments: [], versions: [] } });
    const kinds = url.searchParams.get("kinds");
    if (kinds !== null) {
      const histories = Object.fromEntries(kinds.split(",").map(kind => {
        const history = capturedProjectHistory[kind as keyof typeof capturedProjectHistory];
        if (history === undefined) throw new Error(`no captured project history for ${kind}`);
        return [kind, history];
      }));
      return fulfillHistory(route, { projectId: "stuff", histories });
    }
    return fulfillCapture(route, name, `${url.searchParams.get("kind")}-${url.searchParams.get("range")}.json`, true);
  });
}

for (const range of ["1h", "24h", "7d"]) {
  test(`threadripper host page, ${range}`, { tag: "@mobile" }, async ({ page }) => {
    await replay(page, "threadripper", threadripper.capturedAtMs, threadripper.system);
    await page.goto("/");
    await page.locator("table").getByRole("link", { name: "threadripper" }).click();
    await expect(page.getByRole("heading", { name: "threadripper" })).toBeVisible();
    await page.getByRole("button", { name: range, exact: true }).click();
    await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Filesystems" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.mouse.move(0, 0);
    if (!threadripper.system) {
      await page.getByRole("button", { name: "Host information" }).click();
      await expect(page.getByRole("tooltip", { name: "Host information" })).toContainText("This host has not reported system details.");
      await page.mouse.move(0, 0);
    }
    const regions = [
      ["tiles", page.getByRole("region", { name: "Host summary" })] as const,
      ["charts", page.getByRole("region", { name: "Charts" })] as const
    ];
    for (const [file, region] of regions) {
      await expect(region).toHaveScreenshot(`threadripper-${range}-${file}.webp`);
    }
  });
}

test("stuff project page, 1h", { tag: "@mobile" }, async ({ page }) => {
  await replayProject(page, "stuff", stuff.capturedAtMs);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("heading", { name: "stuff", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Collector" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Endpoints" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.mouse.move(0, 0);
  const regions = [
    ["tiles", page.getByRole("region", { name: "Project summary" })] as const,
    ["charts", page.getByRole("region", { name: "Charts" })] as const
  ];
  for (const [file, region] of regions) {
    await expect(region).toHaveScreenshot(`stuff-1h-${file}.webp`);
  }
});

