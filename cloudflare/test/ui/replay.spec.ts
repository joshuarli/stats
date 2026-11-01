import { expect, test, type Page } from "@playwright/test";
import stuff from "./captures/stuff/capture.json" with { type: "json" };
import threadripper from "./captures/threadripper/capture.json" with { type: "json" };

const captureFile = (name: string, file: string): string => new URL(`./captures/${name}/${file}`, import.meta.url).pathname;

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
    const range = url.searchParams.get("range");
    if (range === null && url.pathname.endsWith("/history")) {
      const empty = kind === "summary" ? { points: [] } : { series: [] };
      return route.fulfill({ json: { hostId: threadripper.hostId, kind, fromMs: Number(url.searchParams.get("from")), toMs: Number(url.searchParams.get("to")), resolution: "raw", stepMs: 15_000, ...empty } });
    }
    if (url.pathname.endsWith("/system") && !hasSystem) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "no system details for host" } } });
    const file = url.pathname === "/api/v1/hosts" ? "hosts.json" : url.pathname.endsWith("/system") ? "system.json" : `${kind}-${range ?? "1h"}.json`;
    return route.fulfill({ path: captureFile(name, file), contentType: "application/json" });
  });
}

async function replayProject(page: Page, name: string, capturedAtMs: number): Promise<void> {
  await freeze(page, capturedAtMs);
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/hosts") return route.fulfill({ json: { hosts: [] } });
    const file = url.pathname === "/api/v1/projects" ? "projects.json" : `${url.searchParams.get("kind")}-${url.searchParams.get("range")}.json`;
    return route.fulfill({ path: captureFile(name, file), contentType: "application/json" });
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
    if (!threadripper.system) await expect(page.getByText("This host has not reported system details.")).toBeVisible();
    const regions = [
      ...(threadripper.system ? [["system", page.getByRole("region", { name: "System" })] as const] : []),
      ["tiles", page.getByRole("region", { name: "Host summary" })] as const,
      ["incidents", page.locator("#incidents")] as const,
      ["left", page.getByRole("region", { name: "Left column" })] as const,
      ["right", page.getByRole("region", { name: "Right column" })] as const
    ];
    for (const [file, region] of regions) {
      await expect(region).toHaveScreenshot(`threadripper-${range}-${file}.png`);
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
    ["incidents", page.locator("#incidents")] as const,
    ["left", page.getByRole("region", { name: "Left column" })] as const,
    ["right", page.getByRole("region", { name: "Right column" })] as const
  ];
  for (const [file, region] of regions) {
    await expect(region).toHaveScreenshot(`stuff-1h-${file}.png`);
  }
});

