import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { encodeFrame, type SourceBatch } from "../../src/ingest/encode.ts";
import { INGEST_MEDIA_TYPE, INGEST_PATH } from "../../src/ingest/http.ts";

const NODE_ORIGIN = "http://127.0.0.1:4175";
const NODE_LOGIN = "playwright@example.com";

const SOURCE = JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/v2/sources/linux-normal.json"), "utf8")) as SourceBatch;

function freshBatch(hostId: string): Uint8Array<ArrayBuffer> {
  const lastAtMs = Math.max(...SOURCE.samples.map(sample => Number(sample["atMs"])));
  const shift = Date.now() - 1000 - lastAtMs;
  return encodeFrame({ ...SOURCE, hostId, samples: SOURCE.samples.map(sample => ({ ...sample, atMs: String(Number(sample["atMs"]) + shift) })) });
}

test.use({ baseURL: NODE_ORIGIN, extraHTTPHeaders: { "Tailscale-User-Login": NODE_LOGIN } });

test("the Node target renders a host the real server stored, with projects absent rather than zero", async ({ page, request }) => {
  const name = `node-${Date.now().toString(36)}`;
  const created = await request.post("/api/v1/admin/hosts", { data: { name } });
  expect(created.status()).toBe(201);
  const host = await created.json() as { hostId: string; token: string };
  const ingested = await fetch(`${NODE_ORIGIN}${INGEST_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: freshBatch(host.hostId) });
  expect(ingested.status).toBe(200);

  await page.goto("/");
  const fleetTable = page.getByRole("table", { name: "Fleet hosts" });
  const row = fleetTable.getByRole("row", { name: new RegExp(name, "u") });
  await expect(row.getByRole("link", { name })).toBeVisible();
  await expect(row.locator(".status-dot")).toHaveAttribute("title", "online");
  await expect(row).toContainText("used of");

  await row.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.goto("/#/projects");
  await expect(page.getByText("No projects are configured.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Projects" })).toHaveCount(0);
  await page.goto("/#/project/stuff");
  await expect(page.getByText("Project not found")).toBeVisible();
});

test("the Node target refuses the dashboard without an allowed Tailscale login", async ({ browser }) => {
  for (const headers of [{}, { "Tailscale-User-Login": "intruder@example.com" }]) {
    const context = await browser.newContext({ extraHTTPHeaders: headers });
    const response = await context.request.get(`${NODE_ORIGIN}/`);
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    await context.close();
  }
});
