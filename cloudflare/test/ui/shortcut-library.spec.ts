import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

test("library menu and select typeahead do not trigger dashboard shortcuts", async ({ page }) => {
  const scratchRoot = resolve(root, "../.work/tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const output = mkdtempSync(join(scratchRoot, "shortcut-controls-"));
  try {
    await build({ configFile: false, root, logLevel: "silent", build: { outDir: output, emptyOutDir: true, lib: { entry: resolve(root, "test/ui/shortcut-controls.mjs"), name: "ShortcutControls", formats: ["iife"], fileName: () => "controls.js" } } });
    await page.route("**/api/v1/hosts", route => route.fulfill({ json: { hosts: [] } }));
    await page.goto("/#/");
    const search = page.getByRole("searchbox", { name: "Search hosts" });
    await expect(search).toBeVisible();
    await page.addStyleTag({ path: require.resolve("@laputa-systems/ui-dashboard/styles/layout.css") });
    await page.addStyleTag({ path: require.resolve("@laputa-systems/ui-dashboard/styles/forms.css") });
    await page.addScriptTag({ path: join(output, "controls.js") });
    const live = page.getByRole("button", { name: /^Live/u });
    await expect(live).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Probe actions" }).click();
    const menu = page.getByRole("menu", { name: "Probe actions" });
    await expect(menu).toBeVisible();
    for (const key of ["l", "z", "[", "]", "/"]) await page.keyboard.press(key);
    await expect(live).toHaveAttribute("aria-pressed", "true");
    await expect(menu).toBeVisible();
    await expect(search).not.toBeFocused();
    await page.keyboard.press("Escape");
    const select = page.getByRole("combobox", { name: "Browse Probe scope" });
    await select.click();
    await expect(select).toHaveAttribute("aria-expanded", "true");
    for (const key of ["l", "z", "[", "]", "/"]) await page.keyboard.press(key);
    await expect(live).toHaveAttribute("aria-pressed", "true");
    await expect(select).toHaveAttribute("aria-expanded", "true");
    await expect(search).not.toBeFocused();
    await page.keyboard.press("Escape");
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("l");
    await expect(live).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
