import { expect, test, type Page } from "@playwright/test";
import threadripper from "./captures/threadripper/capture.json" with { type: "json" };

const captureFile = (name: string, file: string): string => new URL(`./captures/${name}/${file}`, import.meta.url).pathname;

async function replay(page: Page, name: string, capturedAtMs: number): Promise<void> {
  await page.clock.setFixedTime(capturedAtMs);
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get("kind") ?? "summary";
    const range = url.searchParams.get("range") ?? "1h";
    const file = url.pathname === "/api/v1/hosts" ? "hosts.json" : url.pathname.endsWith("/latest") ? "latest.json" : `${kind}-${range}.json`;
    return route.fulfill({ path: captureFile(name, file), contentType: "application/json" });
  });
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .topbar { position: static !important; }" });
}

for (const range of ["1h", "24h", "7d"]) {
  test(`threadripper host page, ${range}`, async ({ page }) => {
    await replay(page, "threadripper", threadripper.capturedAtMs);
    await page.goto("/");
    await page.locator("table").getByRole("link", { name: "threadripper" }).click();
    await expect(page.getByRole("heading", { name: "threadripper" })).toBeVisible();
    await page.getByRole("button", { name: range, exact: true }).click();
    await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Filesystem usage" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    for (const [label, file] of [["Host summary", "tiles"], ["Host charts", "charts"], ["Host activity", "activity"]] as const) {
      await expect(page.getByRole("region", { name: label })).toHaveScreenshot(`threadripper-${range}-${file}.png`);
    }
  });
}
