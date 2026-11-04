import { expect, test, type Page } from "@playwright/test";
import { fulfillHistory } from "./history-route";
import { answer, buildScenario, scenarioComparison, scenarioStore, SCENARIO_ROLLOUTS, SCENARIO_VERSIONS, type Scenario } from "./observe-scenario";

const now = Date.UTC(2026, 10, 4, 2, 0);
const collector = { lastRunAtMs: now - 60_000, lastSuccessAtMs: now - 60_000, lastError: null, stale: false };
const STATS = { id: "stats", name: "stats", worker: "stats", buckets: [], durableObjectNamespaces: ["b25c2595ba784bb1bd51a87a3e87c62b"], d1Databases: [], probes: [], collector };
const STUFF = { id: "stuff", name: "stuff", worker: "stuff", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector };
const HISTORY_ROUTE = "GET /api/v1/hosts/:host/history";
let shared: Promise<Scenario> | undefined;

async function setup(page: Page, options: { readonly failing?: boolean; readonly fresh?: boolean } = {}): Promise<{ readonly requests: string[]; readonly posts: string[] }> {
  const scenario = options.fresh === true ? await buildScenario(now) : await (shared ??= buildScenario(now));
  const requests: string[] = [];
  const posts: string[] = [];
  await page.clock.setFixedTime(now);
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/hosts") return route.fulfill({ json: { hosts: [] } });
    if (url.pathname === "/api/v1/projects") return route.fulfill({ json: [STATS, STUFF] });
    if (url.pathname === "/api/v1/projects/stats/deployments") return route.fulfill({ json: scenario.deployments });
    const comparison = /^\/api\/v1\/projects\/stats\/deployments\/([^/]+)\/comparison$/u.exec(url.pathname);
    if (comparison !== null) {
      const window = url.searchParams.get("window") === "6h" ? "6h" : url.searchParams.get("window") === "24h" ? "24h" : "1h";
      const body = scenarioComparison(scenario, comparison[1]!, window);
      return body === null ? route.fulfill({ status: 404, json: { error: { code: "not_found", message: "deployment not found" } } }) : route.fulfill({ json: body });
    }
    if (url.pathname === "/api/v1/projects/stuff/deployments") return route.fulfill({ json: { projectId: "stuff", worker: "stuff", enabled: false, sync: null, deployments: [], versions: [] } });
    const history = /^\/api\/v1\/projects\/(\w+)\/history$/u.exec(url.pathname);
    const kinds = url.searchParams.get("kinds");
    if (history !== null && kinds !== null) {
      const base = { projectId: history[1], range: "24h", fromMs: now - 86_400_000, toMs: now, stepMs: 3_600_000 };
      const body = (kind: string) => kind === "collector" ? { ...base, kind, runs: [] }
        : kind === "worker" ? { ...base, kind, series: [{ metric: "worker.invocations", values: Array.from({ length: 24 }, () => 300) }, { metric: "worker.status.2xx", values: Array.from({ length: 24 }, () => 300) }] }
        : { ...base, kind, series: [] };
      return fulfillHistory(route, { projectId: history[1], histories: Object.fromEntries(kinds.split(",").map(kind => [kind, body(kind)])) });
    }
    return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "unmocked" } } });
  });
  await page.route("**/api/observe/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice("/api/observe".length);
    requests.push(path + url.search);
    if (options.failing === true) return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "observe down" } } });
    const method = route.request().method();
    if (method === "POST") posts.push(`${path} ${route.request().postData() ?? ""}`);
    const response = await answer(scenario, now, new Request(`https://observe${path}${url.search}`, { method, headers: { "content-type": route.request().headers()["content-type"] ?? "" }, ...(method === "POST" ? { body: route.request().postData() ?? "" } : {}) }));
    return route.fulfill({ status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: await response.text() });
  });
  return { requests, posts };
}

const durations = async (page: Page): Promise<number[]> =>
  (await page.locator("#route-explorer .trace-row .trace-span-text").allTextContents()).map(text => text.endsWith(" s") ? Number.parseFloat(text) * 1000 : Number.parseFloat(text));

test("routes rank by CPU, and choosing one focuses the latency heatmap and keeps it in the URL", { tag: "@mobile" }, async ({ page }) => {
  await setup(page);
  await page.goto("/#/project/stats?range=24h");
  const explorer = page.locator("#route-explorer");
  const rows = explorer.locator(".route-table tbody tr");
  await expect(rows.nth(1)).toContainText("/ingest/v1/batches");
  await explorer.getByRole("button", { name: /hosts\/:host\/history/u }).click();
  await expect(page).toHaveURL(/route=GET/u);
  await expect(explorer.locator(".explore-head")).toContainText(`Latency · ${HISTORY_ROUTE}`);
  await expect(explorer.locator(".heatmap-cell").first()).toBeVisible();
  await expect(explorer.locator(".heatmap-marker")).toHaveCount(1);
  await expect(explorer.locator(".heatmap-marker")).toContainText("v1.4.0");
});

test("the p95 view lists the slowest calls first and says where their time went", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&route=${encodeURIComponent(HISTORY_ROUTE)}`);
  const explorer = page.locator("#route-explorer");
  await explorer.getByRole("button", { name: "≥ p95" }).click();
  await expect(page).toHaveURL(/band=slow/u);
  await expect(explorer.locator(".hot-summary")).toContainText("Calls at or above p95");
  await expect(explorer.locator(".hot-summary")).toContainText("in the Durable Object");
  const values = await durations(page);
  expect(values.length).toBeGreaterThan(1);
  expect(values).toEqual([...values].sort((a, b) => b - a));
  await expect(explorer.locator(".trace-head")).toContainText(HISTORY_ROUTE);
});

test("a heatmap cell narrows the calls to its time slice and duration band", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&route=${encodeURIComponent(HISTORY_ROUTE)}`);
  const explorer = page.locator("#route-explorer");
  const cell = explorer.locator(".heatmap-cell").last();
  const label = await cell.getAttribute("aria-label") ?? "";
  const [, low = "0"] = /between (\d+) ms/u.exec(label) ?? [];
  await cell.click();
  await expect(page).toHaveURL(/band=cell/u);
  await expect(cell).toHaveAttribute("aria-pressed", "true");
  const values = await durations(page);
  expect(values.length).toBeGreaterThan(0);
  expect(Math.min(...values)).toBeGreaterThanOrEqual(Number(low));
  await cell.click();
  await expect(page).not.toHaveURL(/band=/u);
});

test("the v1.4.0 deployment shows its new issue group, its regression, and a higher failure rate", { tag: "@mobile" }, async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&deployment=${SCENARIO_ROLLOUTS.v14}`);
  const impact = page.locator("#deployments").getByRole("region", { name: "Errors after this deployment" });
  await expect(impact).toContainText("1 new issue group · 1 regression");
  await expect(impact.locator(".impact-rate")).toContainText("→");
  await impact.getByRole("button", { name: /RangeError/u }).click();
  const dialog = page.getByRole("dialog", { name: "Issue" });
  await expect(dialog).toContainText("RangeError");
  const scrolled = await page.evaluate(() => window.scrollY);
  await expect(dialog.locator(".issue-facts")).toContainText("v1.4.0");
  await expect(page).toHaveURL(/modal=issue%3A[0-9a-f]{64}|modal=issue:[0-9a-f]{64}/u);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/modal=/u);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  await expect(impact).toBeInViewport();
});

test("the canary is where the parser bug first appeared", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&deployment=${SCENARIO_ROLLOUTS.canary}`);
  const impact = page.locator("#deployments").getByRole("region", { name: "Errors after this deployment" });
  await expect(impact).toContainText("1 new issue group · no regressions");
  await expect(impact.getByRole("button", { name: /TypeError/u })).toBeVisible();
});

test("a deploy marker opens that deployment in a modal, and its issues open on top with a way back", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&route=${encodeURIComponent(HISTORY_ROUTE)}`);
  await page.locator("#route-explorer .heatmap-marker").click();
  const deployment = page.getByRole("dialog");
  await expect(deployment).toContainText("1 new issue group · 1 regression");
  await deployment.getByRole("button", { name: /TypeError/u }).click();
  await expect(page.getByRole("dialog", { name: "Issue" })).toContainText("TypeError");
  await page.getByRole("dialog").getByRole("button", { name: /Back|Deployment/u }).first().click();
  await expect(page.getByRole("dialog")).toContainText("Errors after this deployment");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("issues show the version they appeared on and filter by it", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/stats?range=24h");
  const issues = page.locator("#issues");
  await expect(issues.getByRole("option", { name: /RangeError/u })).toContainText("since v1.4.0");
  await issues.getByLabel("Introduced in").selectOption(SCENARIO_VERSIONS[2].id);
  await expect(issues.locator(".issue-list").getByRole("option")).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`introduced=${SCENARIO_VERSIONS[2].id}`, "u"));
  expect(observe.requests.some(request => request.includes(`introducedIn=${SCENARIO_VERSIONS[2].id}`))).toBe(true);
});

test("an occurrence opens its trace in a modal that survives a reload", async ({ page }) => {
  await setup(page);
  await page.goto("/#/project/stats?range=24h");
  await page.locator("#issues").getByRole("option", { name: /deployments\.poll/u }).click();
  await page.locator("#issues").getByRole("button", { name: "Open trace" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Trace" });
  await expect(dialog.locator(".trace-head")).toContainText("scheduled */5 * * * *");
  await expect(dialog.locator(".tl-slice.failed")).toHaveCount(1);
  await expect(dialog.getByRole("region", { name: "Current selection" })).toContainText("deployments.poll");
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Trace" }).locator(".trace-head")).toContainText("scheduled */5 * * * *");
  await expect(page.locator("#issues .issue-item[aria-selected='true']")).toContainText("deployments.poll");
});

test("resolving an issue posts its new state and moves it to Resolved", async ({ page }) => {
  const observe = await setup(page, { fresh: true });
  await page.goto("/#/project/stats?range=24h");
  const issues = page.locator("#issues");
  await issues.getByRole("option", { name: /RangeError/u }).click();
  await issues.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(issues.locator(".issue-list").getByRole("option", { name: /RangeError/u })).toHaveCount(0);
  expect(observe.posts).toHaveLength(1);
  expect(observe.posts[0]).toMatch(/^\/issues\/[0-9a-f]{64}\/state \{"state":"resolved"\}$/u);
  await issues.getByRole("button", { name: "Resolved", exact: true }).click();
  await expect(issues.getByRole("button", { name: "Reopen" })).toBeVisible();
});

test("the timeline zooms with W, fits the selection with F, and steps with arrow keys", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&route=${encodeURIComponent("scheduled */5 * * * *")}`);
  const timeline = page.locator("#route-explorer .tl");
  const span = async () => {
    const text = await timeline.locator(".tl-span").textContent() ?? "";
    return Number.parseFloat(text) * (text.includes(" s ") ? 1000 : 1);
  };
  await timeline.locator(".tl-slice").first().focus();
  const fitted = await span();
  await page.keyboard.press("w");
  expect(await span()).toBeLessThan(fitted);
  await page.keyboard.press("ArrowRight");
  await expect(timeline.getByRole("region", { name: "Current selection" })).toContainText("Installation.knownDeploymentVersions");
  await page.keyboard.press("f");
  expect(await span()).toBeLessThan(100);
  await expect(timeline.locator(".tl-slice.selected .tl-slice-label")).toBeVisible();
});

test("an unavailable collector is reported instead of an empty dataset", async ({ page }) => {
  await setup(page, { failing: true });
  await page.goto("/#/project/stats?range=24h");
  await expect(page.locator("#route-explorer")).toContainText("collector is unavailable (503)");
  await expect(page.locator("#route-explorer")).not.toContainText("No requests were observed");
  await expect(page.locator("#issues")).not.toContainText("No open issues");
});

test("other projects keep the sampled route card and never call the observability API", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/stuff?range=24h");
  await expect(page.getByRole("heading", { name: "stuff" })).toBeVisible();
  await expect(page.locator("#route-explorer, #issues")).toHaveCount(0);
  await expect(page.locator("#routes")).toHaveCount(1);
  expect(observe.requests).toEqual([]);
});

test("the observability cards and trace modal match their goldens", { tag: "@mobile" }, async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .topbar { position: static !important; } .section-bar { display: none !important; }";
      document.head.appendChild(style);
    });
  });
  await page.goto(`/#/project/stats?range=24h&route=${encodeURIComponent(HISTORY_ROUTE)}&band=slow&deployment=${SCENARIO_ROLLOUTS.v14}`);
  const explorer = page.locator("#route-explorer");
  await expect(explorer.locator(".hot-summary")).toBeVisible();
  await expect(explorer.locator(".tl-slice").first()).toBeVisible();
  await expect(page.locator("#deployments .impact-summary")).toBeVisible();
  await expect(page.locator("#issues .issue-facts")).toBeVisible();
  await expect(explorer).toHaveScreenshot("stats-route-explorer.webp");
  await expect(page.locator("#deployments")).toHaveScreenshot("stats-deployments.webp");
  await expect(page.locator("#issues")).toHaveScreenshot("stats-issues.webp");
  await page.locator("#issues").getByRole("button", { name: "Open trace" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Trace" });
  await expect(dialog.locator(".tl-slice").first()).toBeVisible();
  await expect(dialog.locator(".modal-body")).toHaveScreenshot("stats-trace-modal.webp");
});

test("frames show their original source, and frames from a version without a map say so", async ({ page }) => {
  await setup(page);
  const scenario = await (shared ??= buildScenario(now));
  const api = scenarioStore(scenario, now);
  const poll = (await api.issues({})).items.find(issue => issue.operation === "deployments.poll")!;
  const old = (await api.occurrences(poll.fingerprint, { limit: 100 })).items.find(item => item.version === SCENARIO_VERSIONS[0].id && item.traceId !== null)!;
  await page.goto(`/#/project/stats?range=24h&modal=issue:${poll.fingerprint}`);
  const issue = page.getByRole("dialog", { name: "Issue" });
  await expect(issue.locator(".frames-list li").first()).toContainText("src/deployments/collector.ts:58");
  await expect(issue.locator(".frames-list li").first()).toHaveAttribute("title", /^bundle index\.js:\d+:\d+$/u);
  await page.goto(`/#/project/stats?range=24h&modal=trace:${old.traceId}`);
  await page.reload();
  const trace = page.getByRole("dialog", { name: "Trace" });
  await expect(trace.locator(".frames-list li").first()).toContainText("index.js:3121");
  await expect(trace.locator(".frame-unmapped").first()).toBeVisible();
});
