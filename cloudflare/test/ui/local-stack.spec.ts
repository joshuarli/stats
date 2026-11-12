import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import { accessToken } from "../access-token.ts";
import { dollarsPrecise } from "../../src/client/format.ts";
import { BUCKET_MS } from "../../src/projects/queries.ts";
import { scenario, type Mode } from "../../local/scenario.ts";
import { addHost, ingestFixture } from "../../local/seed.ts";
import { ACCESS_HEADER, cliEnv, productionProjects, startStack, type Stack } from "../../local/stack.ts";
import { CLOUDFLARE_ROOT } from "../../local/topology.ts";
import { ensureBuilds } from "../../scripts/ensure-build.ts";

const ANCHORED: Partial<Record<"logs.workersLogs", Mode>> = { "logs.workersLogs": { kind: "late", omitNewestSlots: 12 } };

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "UTC", locale: "en-US" });

let stack: Stack;
const TICK = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;

async function collect(atMs: number, modes: Parameters<typeof scenario>[2]): Promise<string> {
  return stack.collect(scenario(productionProjects(stack.stats), atMs, modes));
}

async function open(page: Page, path: string): Promise<void> {
  await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: await accessToken() });
  await page.goto("about:blank");
  await page.goto(`${stack.origin}${path}`);
}

async function cliTotal(project: string): Promise<number> {
  const child = spawn(process.execPath, ["--experimental-strip-types", join(CLOUDFLARE_ROOT, "src/cli/statsctl.ts"), "cost", "--project", project, "--window", "1h", "--json"], { env: { ...process.env, ...cliEnv(stack.origin) }, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const status = await new Promise<number | null>(resolve => child.on("close", resolve));
  expect(status).toBe(0);
  const envelope = JSON.parse(stdout) as { payload: { projects: { id: string; report: { total: { monthly: { now: number } } } }[] } };
  return envelope.payload.projects.find(entry => entry.id === project)!.report.total.monthly.now;
}

test.beforeAll(async () => {
  const artifacts = await ensureBuilds(["stats", "observe"]);
  stack = await startStack({ nowMs: null, statsOutput: join(artifacts.find(artifact => artifact.target === "stats")!.output, "v0/workers/default"), observeOutput: join(artifacts.find(artifact => artifact.target === "observe")!.output, "v0/workers/default") });
  const host = await addHost(stack);
  expect(await ingestFixture(stack, host, Date.now() - 60_000)).toBe(200);
  expect(await collect(TICK - 2 * BUCKET_MS, ANCHORED)).toBe("ok");
});

test.afterAll(async () => {
  await stack.dispose();
});

test("the project page's estimated cost equals statsctl cost from the same stack", async ({ page }) => {
  const expected = dollarsPrecise(await cliTotal("stuff"));
  await open(page, "/#/project/stuff");
  await expect(page.locator(".ledger-amount")).toHaveText(`${expected}/mo`);
});

test("a failing collection shows the failed collector, and a later good run clears it", async ({ page }) => {
  expect(await collect(TICK - BUCKET_MS, { ...ANCHORED, "states.r2CombinedStorage": { kind: "fail" } })).toBe("exception");
  await open(page, "/#/project/stuff?open=signals");
  await expect(page.locator(".ui-page-header .ui-badge").first()).toContainText("failing");
  await expect(page.locator("#collector .collector-error")).toHaveText("Last run failed: collector_failed:r2Storage");
  expect(await collect(TICK, ANCHORED)).toBe("ok");
  await open(page, "/#/project/stuff?open=signals");
  await expect(page.locator(".ui-page-header .ui-badge").first()).toContainText("collecting");
  await expect(page.locator("#collector .collector-error")).toHaveCount(0);
});

test("the stats observe cards render traces from the attached collector", async ({ page }) => {
  expect((await stack.fetch("/api/v1/projects")).status).toBe(200);
  await expect.poll(async () => (await stack.observe("stats", "/traces?limit=100") as { items: { label: string }[] }).items.some(item => item.label === "GET /api/v1/projects")).toBe(true);
  await open(page, "/#/project/stats?range=1h&section=requests");
  const explorer = page.locator("#route-explorer");
  await expect(explorer.locator(".route-table tbody tr").first()).toBeVisible();
  await expect(explorer.getByRole("button", { name: /\/api\/v1\/projects/u }).first()).toBeVisible();
  await expect(page.locator("#section-errors")).toBeVisible();
});

test("the Worker serves the lazy Errors view and its feedback stylesheet", async ({ page }) => {
  const assets: { readonly path: string; readonly status: number; readonly type: string }[] = [];
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.includes("/assets/ObserveSection-")) assets.push({ path, status: response.status(), type: response.headers()["content-type"] ?? "" });
  });
  await open(page, "/#/project/stats?section=errors");
  await expect(page.locator("#issues")).toBeVisible();
  await expect.poll(() => assets.length).toBeGreaterThanOrEqual(2);
  expect(assets.some(asset => asset.path.endsWith(".js") && asset.status === 200 && asset.type.includes("javascript"))).toBe(true);
  expect(assets.some(asset => asset.path.endsWith(".css") && asset.status === 200 && asset.type.includes("text/css"))).toBe(true);
});
