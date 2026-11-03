import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillHistory } from "./history-route";

const captureDirectory = new URL("./captures", import.meta.url).pathname;
const captureFile = (name: string, file: string): string => `${captureDirectory}/${name}/${file}`;

interface HostCapture {
  readonly name: string;
  readonly hostId: string;
  readonly capturedAtMs: number;
  readonly system: boolean;
}

interface CaptureMeta {
  readonly hostId?: unknown;
  readonly capturedAtMs?: unknown;
  readonly system?: unknown;
}

function readCapture(name: string, file: string): unknown {
  return JSON.parse(readFileSync(captureFile(name, file), "utf8"));
}

function captureMeta(name: string): CaptureMeta {
  return readCapture(name, "capture.json") as CaptureMeta;
}

function hostCaptures(): HostCapture[] {
  return readdirSync(captureDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const meta = captureMeta(entry.name);
      return typeof meta.hostId === "string"
        ? [{ name: entry.name, hostId: meta.hostId, capturedAtMs: Number(meta.capturedAtMs), system: meta.system === true }]
        : [];
    });
}

function capturedKind(name: string, range: string, kind: string): unknown {
  return readCapture(name, `${kind}-${range}.json`);
}

function fulfillCapture(route: Route, name: string, file: string, history: boolean) {
  return history ? fulfillHistory(route, JSON.parse(readFileSync(captureFile(name, file), "utf8"))) : route.fulfill({ path: captureFile(name, file), contentType: "application/json" });
}

async function freeze(page: Page, capturedAtMs: number): Promise<void> {
  await page.clock.setFixedTime(capturedAtMs);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .topbar { position: static !important; } .section-bar { display: none !important; }";
      document.head.appendChild(style);
    });
  });
}

async function replay(page: Page, capture: HostCapture): Promise<void> {
  await freeze(page, capture.capturedAtMs);
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
      hostId: capture.hostId,
      kind: entry,
      fromMs,
      toMs,
      resolution: "raw",
      stepMs: 15_000,
      ...(entry === "summary" ? { points: [] } : { series: [] })
    });
    if (range === null && url.pathname.endsWith("/history")) {
      if (kinds !== null) return fulfillHistory(route, { hostId: capture.hostId, histories: Object.fromEntries(kinds.map(entry => [entry, emptyHistory(entry)])) });
      return fulfillHistory(route, emptyHistory(kind));
    }
    if (kinds !== null) {
      return fulfillHistory(route, { hostId: capture.hostId, histories: Object.fromEntries(kinds.map(entry => [entry, capturedKind(capture.name, range ?? "1h", entry)])) });
    }
    if (url.pathname.endsWith("/system") && !capture.system) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "no system details for host" } } });
    const file = url.pathname === "/api/v1/hosts" ? "hosts.json" : url.pathname.endsWith("/system") ? "system.json" : `${kind}-${range ?? "1h"}.json`;
    return fulfillCapture(route, capture.name, file, url.pathname.endsWith("/history"));
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
      const histories = Object.fromEntries(kinds.split(",").map(kind => [kind, capturedKind(name, "1h", kind)]));
      return fulfillHistory(route, { projectId: name, histories });
    }
    return fulfillCapture(route, name, `${url.searchParams.get("kind")}-${url.searchParams.get("range")}.json`, true);
  });
}

for (const capture of hostCaptures()) {
  for (const range of ["1h", "24h", "7d"]) {
    test(`${capture.name} host page, ${range}`, { tag: "@mobile" }, async ({ page }) => {
      await replay(page, capture);
      await page.goto("/");
      await page.locator("table").getByRole("link", { name: capture.name }).click();
      await expect(page.getByRole("heading", { name: capture.name })).toBeVisible();
      await page.getByRole("button", { name: range, exact: true }).click();
      await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("heading", { name: "Filesystems" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.mouse.move(0, 0);
      if (!capture.system) {
        await page.getByRole("button", { name: "Host information" }).click();
        await expect(page.getByRole("tooltip", { name: "Host information" })).toContainText("This host has not reported system details.");
        await page.mouse.move(0, 0);
      }
      const regions = [
        ["tiles", page.getByRole("region", { name: "Host summary" })] as const,
        ["charts", page.getByRole("region", { name: "Charts" })] as const
      ];
      for (const [file, region] of regions) {
        await expect(region).toHaveScreenshot(`${capture.name}-${range}-${file}.webp`);
      }
    });
  }
}

test("stuff project page, 1h", { tag: "@mobile" }, async ({ page }) => {
  await replayProject(page, "stuff", Number(captureMeta("stuff").capturedAtMs));
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
