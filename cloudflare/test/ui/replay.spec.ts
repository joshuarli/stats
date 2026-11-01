import { expect, test, type Page } from "@playwright/test";
import threadripper from "./captures/threadripper/capture.json" with { type: "json" };

const captureFile = (name: string, file: string): string => new URL(`./captures/${name}/${file}`, import.meta.url).pathname;

async function replay(page: Page, name: string, capturedAtMs: number, hasSystem: boolean): Promise<void> {
  await page.clock.setFixedTime(capturedAtMs);
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get("kind") ?? "summary";
    const range = url.searchParams.get("range") ?? "1h";
    if (url.pathname.endsWith("/system") && !hasSystem) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "no system details for host" } } });
    const file = url.pathname === "/api/v1/hosts" ? "hosts.json" : url.pathname.endsWith("/system") ? "system.json" : `${kind}-${range}.json`;
    return route.fulfill({ path: captureFile(name, file), contentType: "application/json" });
  });
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .topbar { position: static !important; }" });
}

for (const range of ["1h", "24h", "7d"]) {
  test(`threadripper host page, ${range}`, async ({ page }) => {
    await replay(page, "threadripper", threadripper.capturedAtMs, threadripper.system);
    await page.goto("/");
    await page.locator("table").getByRole("link", { name: "threadripper" }).click();
    await expect(page.getByRole("heading", { name: "threadripper" })).toBeVisible();
    await page.getByRole("button", { name: range, exact: true }).click();
    await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Filesystem usage" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    if (!threadripper.system) await expect(page.getByText("This host has not reported system details.")).toBeVisible();
    const regions = [...(threadripper.system ? [["System", "system"] as const] : []), ["Host summary", "tiles"] as const, ["Host charts", "charts"] as const, ["Host activity", "activity"] as const];
    for (const [label, file] of regions) {
      await expect(page.getByRole("region", { name: label })).toHaveScreenshot(`threadripper-${range}-${file}.png`);
    }
  });
}
