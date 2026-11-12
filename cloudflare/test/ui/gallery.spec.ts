import { expect, test } from "./fixtures";

test.describe("component gallery", () => {
  test("renders all extracted design system primitives on desktop", async ({ page }) => {
    await page.goto("/#/gallery");
    await expect(page.locator(".ui-page-header")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Component Gallery" })).toBeVisible();

    const okBadge = page.locator(".ui-badge-ok").first();
    await expect(okBadge).toBeVisible();
    await expect(okBadge).toHaveText("ok");

    await expect(page.locator(".ui-meter")).toHaveCount(6);
    await expect(page.locator(".ui-notice-info")).toBeVisible();
    await expect(page.locator(".ui-notice-warn")).toBeVisible();
    await expect(page.locator(".ui-notice-bad")).toBeVisible();
    await expect(page.locator(".ui-notice-ok")).toBeVisible();

    await expect(page.locator(".ui-empty-state")).toBeVisible();
    await expect(page.locator(".ui-error-state")).toHaveCount(2);

    await expect(page.locator(".ui-data-table")).toBeVisible();
    await expect(page.locator(".ui-data-table tbody tr")).toHaveCount(3);
  });

  test("supports keyboard and dialog accessibility @mobile", async ({ page }) => {
    await page.goto("/#/gallery");
    await expect(page.locator(".ui-page-header")).toBeVisible();

    const modalButton = page.getByRole("button", { name: "Open Modal" });
    await expect(modalButton).toBeVisible();
    await modalButton.click();

    const dialog = page.locator("dialog.ui-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("open", "");
    await expect(page.getByRole("heading", { name: "Component Library Modal" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("handles interactive segmented controls and pagination", async ({ page }) => {
    await page.goto("/#/gallery");

    const segment24h = page.getByRole("button", { name: "24 Hours" });
    await expect(segment24h).toHaveAttribute("aria-pressed", "false");
    await segment24h.click();
    await expect(segment24h).toHaveAttribute("aria-pressed", "true");

    const nextPage = page.getByRole("button", { name: "Next page" });
    await expect(nextPage).toBeEnabled();
    await nextPage.click();
    await expect(page.locator(".ui-pagination")).toContainText("Page 3 of 8");

    const collapseButton = page.getByRole("button", { name: /Hide Collapsible Panel/u });
    await expect(collapseButton).toBeVisible();
    await collapseButton.click();
    await expect(page.locator(".ui-panel-collapsed")).toBeVisible();

    const expandButton = page.getByRole("button", { name: /Show Collapsible Panel/u });
    await expandButton.click();
    await expect(page.locator(".ui-panel-collapsed")).toHaveCount(0);
  });

  test("a dark operating-system scheme renders the same light gallery", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/#/gallery");
    await expect(page.locator(".ui-page-header")).toBeVisible();
    const gallery = page.locator(".content");
    const light = await gallery.screenshot({ animations: "disabled" });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(250, 250, 249)");
    await expect(page.locator(".ui-panel").first()).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect((await gallery.screenshot({ animations: "disabled" })).equals(light)).toBe(true);
  });
});
