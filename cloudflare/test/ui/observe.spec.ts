import { expect, test, type Page } from "@playwright/test";
import { fulfillHistory } from "./history-route";
import { answer, buildScenario, scenarioComparison, scenarioStore, SCENARIO_ROLLOUTS, SCENARIO_VERSIONS, type Scenario } from "./observe-scenario";

const now = Date.UTC(2026, 10, 4, 2, 0);
const collector = { lastRunAtMs: now - 60_000, lastSuccessAtMs: now - 60_000, lastError: null, stale: false };
const STATS = { id: "stats", name: "stats", worker: "stats", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: ["b25c2595ba784bb1bd51a87a3e87c62b"], d1Databases: [], probes: [], collector };
const STUFF = { id: "stuff", name: "stuff", worker: "stuff", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector };
const MEMORIES = { id: "usr-memories", name: "usr-memories", worker: "usr-memories", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector };
const HISTORY_ROUTE = "GET /api/v1/hosts/:host/history";
let shared: Promise<Scenario> | undefined;

async function setup(page: Page, options: { readonly failing?: boolean; readonly fresh?: boolean; readonly scenario?: Scenario; readonly failWhen?: (method: string, path: string) => boolean; readonly beforePost?: () => Promise<void>; readonly ledgerRoutes?: readonly string[] } = {}): Promise<{ readonly requests: string[]; readonly posts: string[]; readonly services: Set<string> }> {
  const scenario = options.scenario ?? (options.fresh === true ? await buildScenario(now) : await (shared ??= buildScenario(now)));
  const requests: string[] = [];
  const posts: string[] = [];
  const services = new Set<string>();
  await page.clock.setFixedTime(now);
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/hosts") return route.fulfill({ json: { hosts: [] } });
    if (url.pathname === "/api/v1/projects") return route.fulfill({ json: [STATS, STUFF, MEMORIES] });
    if (url.pathname === "/api/v1/projects/stats/deployments") return route.fulfill({ json: scenario.deployments });
    const comparison = /^\/api\/v1\/projects\/stats\/deployments\/([^/]+)\/comparison$/u.exec(url.pathname);
    if (comparison !== null) {
      const window = url.searchParams.get("window") === "6h" ? "6h" : url.searchParams.get("window") === "24h" ? "24h" : "1h";
      const body = scenarioComparison(scenario, comparison[1]!, window);
      return body === null ? route.fulfill({ status: 404, json: { error: { code: "not_found", message: "deployment not found" } } }) : route.fulfill({ json: body });
    }
    const unpolled = /^\/api\/v1\/projects\/(stuff|usr-memories)\/deployments$/u.exec(url.pathname);
    if (unpolled !== null) return route.fulfill({ json: { projectId: unpolled[1], worker: unpolled[1], enabled: false, sync: null, deployments: [], versions: [] } });
    const history = /^\/api\/v1\/projects\/([\w-]+)\/history$/u.exec(url.pathname);
    const kinds = url.searchParams.get("kinds");
    if (history !== null && kinds !== null) {
      const base = { projectId: history[1], range: "24h", fromMs: now - 86_400_000, toMs: now, stepMs: 3_600_000 };
      const body = (kind: string) => kind === "collector" ? { ...base, kind, runs: [] }
        : kind === "worker" ? { ...base, kind, series: [{ metric: "worker.invocations", values: Array.from({ length: 24 }, () => 300) }, { metric: "worker.status.2xx", values: Array.from({ length: 24 }, () => 300) }] }
        : kind === "routes" ? { ...base, kind, series: (options.ledgerRoutes ?? []).flatMap(label => [{ metric: `route.${label}.invocations`, values: Array.from({ length: 24 }, () => 20) }, { metric: `route.${label}.cpuMsSum`, values: Array.from({ length: 24 }, () => 400) }]) }
        : kind === "durable-objects" ? { ...base, kind, series: [{ metric: "do.invocations", values: Array.from({ length: 24 }, () => 600) }, { metric: "do.wallMsSum", values: Array.from({ length: 24 }, () => 30_000) }, { metric: "do.cpuMsSum", values: Array.from({ length: 24 }, () => 9_000) }] }
        : { ...base, kind, series: [] };
      return fulfillHistory(route, { projectId: history[1], histories: Object.fromEntries(kinds.split(",").map(kind => [kind, body(kind)])) });
    }
    return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "unmocked" } } });
  });
  await page.route("**/api/observe/**", async route => {
    const url = new URL(route.request().url());
    const [, service, path] = /^\/api\/observe\/([^/]+)(\/.*)$/u.exec(url.pathname) ?? [];
    if (service === undefined || path === undefined) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "unknown observed service" } } });
    services.add(service);
    requests.push(path + url.search);
    if (options.failing === true || options.failWhen?.(route.request().method(), path + url.search) === true) return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "observe down" } } });
    const method = route.request().method();
    if (method === "POST") posts.push(`${path} ${route.request().postData() ?? ""}`);
    if (method === "POST") await options.beforePost?.();
    const response = await answer(scenario, now, new Request(`https://observe${path}${url.search}`, { method, headers: { "content-type": route.request().headers()["content-type"] ?? "" }, ...(method === "POST" ? { body: route.request().postData() ?? "" } : {}) }));
    return route.fulfill({ status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: await response.text() });
  });
  return { requests, posts, services };
}

const durations = async (page: Page): Promise<number[]> =>
  (await page.locator("#route-explorer .trace-row .trace-span-text").allTextContents()).map(text => text.endsWith(" s") ? Number.parseFloat(text) * 1000 : Number.parseFloat(text));

test("explicit project sections win over retained detail links and remain selected", async ({ page }) => {
  await setup(page);
  const scenario = await (shared ??= buildScenario(now));
  const issue = (await scenarioStore(scenario, now).issues({})).items[0]!;
  const path = `/#/project/stats?range=24h&section=requests&issue=${issue.fingerprint}&deployment=${SCENARIO_ROLLOUTS.v14}`;
  await page.goto(path);
  const sections = page.getByRole("navigation", { name: "Project sections" });
  const requests = sections.getByRole("button", { name: /^Requests/u });
  await expect(requests).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(requests).toHaveAttribute("aria-current", "page");
  await requests.click();
  await expect(requests).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/section=requests/u);
  await sections.getByRole("button", { name: /^Overview/u }).click();
  await expect(page).toHaveURL(/section=overview/u);
  await expect(page).toHaveURL(/issue=/u);
  await expect(page).toHaveURL(/deployment=/u);
  await page.reload();
  await expect(sections.getByRole("button", { name: /^Overview/u })).toHaveAttribute("aria-current", "page");
});

test("project section state follows hash navigation and browser history", async ({ page }) => {
  await setup(page);
  await page.goto("/#/project/stats?section=errors");
  const sections = page.getByRole("navigation", { name: "Project sections" });
  await expect(sections.getByRole("button", { name: /^Errors/u })).toHaveAttribute("aria-current", "page");
  await page.evaluate(() => { window.location.hash = "#/project/stats?section=requests"; });
  await expect(sections.getByRole("button", { name: /^Requests/u })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(sections.getByRole("button", { name: /^Errors/u })).toHaveAttribute("aria-current", "page");
});

test("legacy issue, route and deployment links still choose their sections", async ({ page }) => {
  await setup(page);
  const scenario = await (shared ??= buildScenario(now));
  const issue = (await scenarioStore(scenario, now).issues({})).items[0]!;
  for (const [query, section] of [[`issue=${issue.fingerprint}`, "Errors"], [`route=${encodeURIComponent(HISTORY_ROUTE)}`, "Requests"], [`deployment=${SCENARIO_ROLLOUTS.v14}`, "Deployments"]] as const) {
    await page.goto(`/#/project/stats?${query}`);
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("button", { name: new RegExp(`^${section}`, "u") })).toHaveAttribute("aria-current", "page");
  }
});

test("routes rank by CPU, and choosing one focuses the latency heatmap and keeps it in the URL", { tag: "@mobile" }, async ({ page }) => {
  await setup(page);
  await page.goto("/#/project/stats?range=24h&section=requests");
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

test("sorting routes preserves the selected route and exposes only the active sort", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&section=requests&route=${encodeURIComponent(HISTORY_ROUTE)}`);
  const table = page.locator("#route-explorer .route-table");
  const selected = table.getByRole("button", { name: /hosts\/:host\/history/u });
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  const routeHeader = table.getByRole("columnheader", { name: "Route", exact: true });
  const requestsHeader = table.getByRole("columnheader", { name: "Requests", exact: true });
  await expect(routeHeader).not.toHaveAttribute("aria-sort");
  const sortRoute = routeHeader.getByRole("button");
  await sortRoute.focus();
  await sortRoute.press("Space");
  await expect(routeHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(sortRoute).toBeFocused();
  await expect(requestsHeader).not.toHaveAttribute("aria-sort");
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  const labels = await table.locator("tbody tr:not(:first-child) .route-pick").allTextContents();
  expect(labels.length).toBeGreaterThan(1);
  expect(labels).toEqual([...labels].sort((left, right) => left.localeCompare(right)));
  await sortRoute.press("Enter");
  await expect(routeHeader).toHaveAttribute("aria-sort", "descending");
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  expect(await table.locator("tbody tr:not(:first-child) .route-pick").allTextContents()).toEqual([...labels].reverse());
});

test("a ledger route opens its exact matching requests without prefetching", async ({ page }) => {
  const observe = await setup(page, { ledgerRoutes: [HISTORY_ROUTE] });
  await page.goto("/#/project/stats?range=24h&section=overview");
  const worker = page.locator('[id="ledger-worker"]');
  if (await worker.getAttribute("aria-expanded") !== "true") await worker.click();
  const route = page.locator(`[id="ledger-route:${HISTORY_ROUTE}"]`);
  await expect(route).toBeVisible();
  if (await route.getAttribute("aria-expanded") !== "true") await route.click();
  expect(observe.requests.some(request => request.startsWith("/explore"))).toBe(false);
  await page.locator(".ledger-detail").getByRole("button", { name: "Find matching requests" }).click();
  const requests = page.getByRole("navigation", { name: "Project sections" }).getByRole("button", { name: /^Requests/u });
  await expect(requests).toHaveAttribute("aria-current", "page");
  await expect(requests).toBeFocused();
  await expect(page.locator("#route-explorer .explore-head")).toContainText(`Latency · ${HISTORY_ROUTE}`);
  await expect(page.locator("#route-explorer .route-table").getByRole("button", { name: /hosts\/:host\/history/u })).toHaveAttribute("aria-pressed", "true");
});

test("an unmatched route never displays unrelated requests as its evidence", async ({ page }) => {
  const observe = await setup(page);
  const missing = "GET /no-exact-match";
  await page.goto(`/#/project/stats?section=requests&route=${encodeURIComponent(missing)}`);
  const explorer = page.locator("#route-explorer");
  await expect(explorer).toContainText(`No retained requests match ${missing}`);
  await expect(explorer.locator(".trace-row")).toHaveCount(0);
  expect(observe.requests.some(request => request.startsWith("/traces?"))).toBe(false);
  await explorer.getByRole("button", { name: "Show all requests" }).click();
  await expect(explorer.locator(".trace-row").first()).toBeVisible();
});

test("the p95 view lists the slowest calls first and says where their time went", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&section=requests&route=${encodeURIComponent(HISTORY_ROUTE)}`);
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
  await page.goto(`/#/project/stats?range=24h&section=requests&route=${encodeURIComponent(HISTORY_ROUTE)}`);
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
  await page.goto(`/#/project/stats?range=24h&section=deploys&deployment=${SCENARIO_ROLLOUTS.v14}`);
  const impact = page.locator("#deployments").getByRole("region", { name: "Errors after this deployment" });
  await expect(impact).toContainText("1 new issue group · 1 regression");
  await expect(impact.locator(".impact-rate")).toContainText("→");
  const slowRoute = impact.getByRole("region", { name: "CPU by route" }).getByRole("row").filter({ hasText: "/hosts/:host/history" }).filter({ hasText: "object" });
  await expect(slowRoute.locator(".impact-cpu-worse")).toBeVisible();
  const routes = impact.getByRole("region", { name: "CPU by route" });
  const routeWidth = await slowRoute.locator("td").first().evaluate(element => element.getBoundingClientRect().width);
  expect(routeWidth).toBeGreaterThanOrEqual(140);
  const cells = await slowRoute.locator("td").evaluateAll(elements => elements.map(element => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom })));
  expect(cells[0]!.bottom).toBeLessThanOrEqual(cells[1]!.top);
  const widths = await routes.evaluate(element => ({ visible: element.clientWidth, content: element.scrollWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.visible);
  const issueLink = impact.getByRole("button", { name: /RangeError/u });
  await issueLink.click();
  const dialog = page.getByRole("dialog", { name: "Issue" });
  await expect(dialog).toContainText("RangeError");
  const scrolled = await page.evaluate(() => window.scrollY);
  await expect(dialog.locator(".issue-facts")).toContainText("v1.4.0");
  await expect(page).toHaveURL(/modal=issue%3A[0-9a-f]{64}|modal=issue:[0-9a-f]{64}/u);
  await dialog.getByRole("button", { name: "Open trace" }).first().click();
  const trace = page.getByRole("dialog", { name: "Trace" });
  await expect(trace.getByRole("group", { name: "Trace timeline" })).toBeVisible();
  await trace.getByRole("button", { name: "Issue", exact: true }).click();
  await expect(dialog).toContainText("RangeError");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(issueLink).toBeFocused();
  await expect(page).not.toHaveURL(/modal=/u);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  await expect(impact).toBeInViewport();
});

test("the canary is where the parser bug first appeared", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&section=deploys&deployment=${SCENARIO_ROLLOUTS.canary}`);
  const impact = page.locator("#deployments").getByRole("region", { name: "Errors after this deployment" });
  await expect(impact).toContainText("1 new issue group · no regressions");
  await expect(impact.getByRole("button", { name: /TypeError/u })).toBeVisible();
});

test("deployment evidence fits a 200% zoom equivalent viewport", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&section=deploys&deployment=${SCENARIO_ROLLOUTS.v14}`);
  const impact = page.getByRole("region", { name: "Errors after this deployment" });
  const routes = impact.getByRole("region", { name: "CPU by route" });
  const row = routes.getByRole("row").filter({ hasText: "/hosts/:host/history" }).filter({ hasText: "object" });
  await expect(row.locator(".impact-cpu-worse")).toBeVisible();
  const layout = await row.locator("td").evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  }));
  expect(layout[0]!.bottom <= layout[1]!.top || layout[0]!.right <= layout[1]!.left).toBe(true);
  expect(layout.every(rect => rect.left >= 0 && rect.right <= 640)).toBe(true);
});

test("choosing a deployment in the rail zooms every chart to its rollout and widens the range to reach it", async ({ page }) => {
  await setup(page);
  await page.goto("/#/project/stats?range=24h&section=deploys");
  await expect(page.getByRole("button", { name: "Reset" })).toHaveCount(0);
  await page.getByRole("option", { name: /v1\.3\.0 10%/u }).click();
  await expect(page).toHaveURL(/range=7d/u);
  await expect(page.getByRole("option", { name: /v1\.3\.0 10%/u })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
  await page.locator("#deployments").getByRole("button", { name: "Show full range" }).click();
  await expect(page.getByRole("button", { name: "Reset" })).toHaveCount(0);
  await expect(page.locator("#deployments").getByRole("button", { name: "Zoom charts to this rollout" })).toBeVisible();
});

test("a deployment link opens already zoomed to that rollout", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&section=deploys&deployment=${SCENARIO_ROLLOUTS.v13}`);
  await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
  await expect(page).toHaveURL(/range=7d/u);
});

test("a deploy marker opens that deployment in a modal, and its issues open on top with a way back", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&section=requests&route=${encodeURIComponent(HISTORY_ROUTE)}`);
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
  await page.goto("/#/project/stats?range=24h&section=errors");
  const issues = page.locator("#issues");
  await expect(issues.getByRole("option", { name: /RangeError/u })).toContainText("since v1.4.0");
  await issues.getByLabel("Introduced in").selectOption(SCENARIO_VERSIONS[2].id);
  await expect(issues.locator(".issue-list").getByRole("option")).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`introduced=${SCENARIO_VERSIONS[2].id}`, "u"));
  expect(observe.requests.some(request => request.includes(`introducedIn=${SCENARIO_VERSIONS[2].id}`))).toBe(true);
});

test("an occurrence opens its trace in a modal that survives a reload", async ({ page }) => {
  await setup(page);
  await page.goto("/#/project/stats?range=24h&section=errors");
  await page.locator("#issues").getByRole("option", { name: /deployments\.poll/u }).click();
  await page.locator("#issues").getByRole("button", { name: "Open trace" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Trace" });
  await expect(dialog.locator(".trace-head")).toContainText("scheduled */5 * * * *");
  await expect(dialog.locator(".wf tr.failed")).toHaveCount(1);
  await expect(dialog.locator(".wf-callout")).toContainText("Error");
  await expect(dialog.getByRole("region", { name: "Current selection" })).toContainText("deployments.poll");
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Trace" }).locator(".trace-head")).toContainText("scheduled */5 * * * *");
  await expect(page.locator("#issues .issue-item[aria-selected='true']")).toContainText("deployments.poll");
});

test("resolving an issue posts its new state and moves it to Resolved", async ({ page }) => {
  const observe = await setup(page, { fresh: true });
  await page.goto("/#/project/stats?range=24h&section=errors");
  const issues = page.locator("#issues");
  await issues.getByRole("option", { name: /RangeError/u }).click();
  await issues.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(issues.locator(".issue-list").getByRole("option", { name: /RangeError/u })).toHaveCount(0);
  expect(observe.posts).toHaveLength(1);
  expect(observe.posts[0]).toMatch(/^\/issues\/[0-9a-f]{64}\/state \{"state":"resolved"\}$/u);
  await issues.getByRole("button", { name: "Resolved", exact: true }).click();
  await expect(issues.getByRole("button", { name: "Reopen" })).toBeVisible();
});

test("issue actions report their outcome and preserve focus", async ({ page }) => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const observe = await setup(page, { fresh: true, beforePost: () => wait });
  await page.goto("/#/project/stats?range=24h&section=errors");
  const issues = page.locator("#issues");
  await issues.getByRole("option", { name: /RangeError/u }).click();
  const resolve = issues.getByRole("button", { name: "Resolve", exact: true });
  await resolve.focus();
  await resolve.click();
  await expect(resolve).toBeDisabled();
  await expect(issues.getByRole("status")).toContainText("Resolving issue");
  await expect(issues.getByRole("status")).not.toContainText("Issue resolved");
  expect(observe.posts).toHaveLength(1);
  release?.();
  await expect(issues.getByRole("status")).toContainText("Issue resolved");
  await expect(issues.locator(".issue-list").getByRole("option", { name: /RangeError/u })).toHaveCount(0);
  await expect(issues.locator("[data-action-feedback]")).toBeFocused();
  await issues.getByRole("option", { name: /deployments\.poll/u }).click();
  await expect(issues.locator("[data-action-feedback]")).toBeHidden();
  await issues.getByRole("button", { name: "Resolved", exact: true }).click();
  await issues.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(issues.getByRole("status")).toContainText("Issue reopened");
});

test("a failed resolve says so in the Errors section", async ({ page }) => {
  await setup(page, { fresh: true, failWhen: (method, path) => method === "POST" && path.endsWith("/state") });
  await page.goto("/#/project/stats?range=24h&section=errors");
  const issues = page.locator("#issues");
  await issues.getByRole("option", { name: /RangeError/u }).click();
  const closed = page.waitForEvent("requestfailed", { predicate: request => request.method() === "POST" && request.url().endsWith("/state"), timeout: 5_000 });
  await issues.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(issues).toContainText("Could not mark the issue resolved (503)");
  expect((await closed).failure()).not.toBeNull();
  await expect(issues.getByRole("alert")).toContainText("Could not mark the issue resolved (503)");
  await expect(issues.getByRole("option", { name: /RangeError/u })).toBeVisible();
  await expect(issues.getByRole("button", { name: "Resolve", exact: true })).toBeEnabled();
});

test("issue modal reports a resolution without losing focus", async ({ page }) => {
  const scenario = await buildScenario(now);
  const issue = (await scenarioStore(scenario, now).issues({})).items[0]!;
  await setup(page, { scenario });
  await page.goto(`/#/project/stats?section=errors&modal=issue:${issue.fingerprint}`);
  const dialog = page.getByRole("dialog", { name: "Issue" });
  await dialog.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Issue resolved");
  await expect(dialog.locator("[data-action-feedback]")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
});

test("choosing Resolved never relabels the open issues while its data is missing", async ({ page }) => {
  await setup(page, { failWhen: (_method, path) => path.startsWith("/issues?") && path.includes("state=resolved") });
  await page.goto("/#/project/stats?range=24h&section=errors");
  const issues = page.locator("#issues");
  await expect(issues.getByRole("option", { name: /RangeError/u })).toBeVisible();
  await issues.getByRole("button", { name: "Resolved", exact: true }).click();
  await expect(issues).toContainText("collector is unavailable (503)");
  await expect(issues.locator(".issue-item")).toHaveCount(0);
  await expect(issues).not.toContainText("resolved · last 7 days");
});

test("a failed route exploration is reported in the requests section", async ({ page }) => {
  await setup(page, { failWhen: (_method, path) => path.startsWith("/explore") });
  await page.goto("/#/project/stats?range=24h&section=requests");
  await expect(page.locator("#route-explorer")).toContainText("collector is unavailable (503)");
  await page.locator(".project-nav-item", { hasText: "Errors" }).click();
  await expect(page.locator("#issues .issue-item").first()).toBeVisible();
});

test("the timeline zooms with W, fits the selection with F, and steps with arrow keys", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&section=requests&route=${encodeURIComponent("scheduled */5 * * * *")}`);
  const timeline = page.locator("#route-explorer .tl");
  const span = async () => {
    const text = await timeline.locator(".tl-span").textContent() ?? "";
    return Number.parseFloat(text) * (text.includes(" s ") ? 1000 : 1);
  };
  await timeline.locator(".wf-toggle").first().focus();
  const fitted = await span();
  await page.keyboard.press("w");
  expect(await span()).toBeLessThan(fitted);
  await page.keyboard.press("ArrowDown");
  const stepped = timeline.getByRole("row", { name: /Installation\.knownDeploymentVersions/u });
  await expect(stepped.locator(".wf-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(timeline.getByRole("region", { name: "Current selection" })).toBeVisible();
  await page.keyboard.press("f");
  expect(await span()).toBeLessThan(100);
  await expect(stepped.locator(".wf-fill")).toBeVisible();
});

test("an unavailable collector is reported instead of an empty dataset", async ({ page }) => {
  await setup(page, { failing: true });
  await page.goto("/#/project/stats?range=24h&section=requests");
  await expect(page.locator("#route-explorer")).toContainText("collector is unavailable (503)");
  await expect(page.locator("#route-explorer")).not.toContainText("No requests were observed");
  await page.locator(".project-nav-item", { hasText: "Errors" }).click();
  await expect(page.locator("#issues")).not.toContainText("No open issues");
});

test("the cost ledger splits Durable Object cost by the methods the collector observed", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/stats?range=24h");
  const objects = page.locator('[id="ledger-objects"]');
  await expect(objects).toContainText("≤ $");
  if (await objects.getAttribute("aria-expanded") !== "true") await objects.click();
  const methods = page.locator(".ledger-row.depth-1");
  await expect(methods.first()).toContainText("Installation");
  await expect(methods.last()).toContainText("SQLite rows and storage");
  await expect(methods.last()).toContainText("not collected");
  expect(observe.requests.some(request => request.startsWith("/objects?from="))).toBe(true);
  expect(observe.requests.some(request => request.startsWith("/explore"))).toBe(false);
});

test("the project sidebar shows one section at a time with no inner vertical scroll", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?range=24h&section=requests&route=${encodeURIComponent(HISTORY_ROUTE)}`);
  await expect(page.locator("#route-explorer .trace-row").first()).toBeVisible();
  const scrollers = () => page.locator(".project-layout *").evaluateAll((elements): string[] => elements.filter(element => {
    const style = getComputedStyle(element);
    return ["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
  }).map(element => element.getAttribute("class") ?? element.tagName));
  expect(await scrollers()).toEqual([]);
  await page.locator(".project-nav-item", { hasText: "Signals" }).click();
  await expect(page.locator(".charts").first()).toBeVisible();
  expect(await scrollers()).toEqual([]);
});

test("each observed project reads its own service", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/usr-memories?range=24h&section=requests");
  await expect(page.locator("#route-explorer")).toHaveCount(1);
  await page.locator(".project-nav-item", { hasText: "Errors" }).click();
  await expect(page.locator("#issues")).toHaveCount(1);
  await expect.poll(() => [...observe.services]).toEqual(["usr-memories"]);
});

test("changing the project in the URL moves the observed service with it", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/stats?range=24h&open=errors,requests");
  await expect(page.locator("#issues .issue-item").first()).toBeVisible();
  await expect.poll(() => [...observe.services]).toEqual(["stats"]);
  await page.evaluate(() => { location.hash = "#/project/usr-memories?range=24h&open=errors,requests"; });
  await expect(page.getByRole("heading", { name: "usr-memories" })).toBeVisible();
  await expect.poll(() => observe.services.has("usr-memories")).toBe(true);
  await page.waitForLoadState("networkidle");
  observe.services.clear();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => [...observe.services]).toEqual(["usr-memories"]);
  await page.waitForLoadState("networkidle");
  expect([...observe.services]).toEqual(["usr-memories"]);
});

test("a failed deployments fetch in a project row says so instead of none recorded", async ({ page }) => {
  await setup(page);
  await page.route("**/api/v1/projects/stats/deployments", route => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "deployments down" } } }));
  await page.goto("/#/projects");
  const row = page.locator("tbody", { hasText: "stats" }).first();
  await expect(row).toContainText("deployments unavailable");
  await expect(row).not.toContainText("none recorded");
});

test("other projects split cost by sampled routes and never call the observability API", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/stuff?range=24h");
  await expect(page.getByRole("heading", { name: "stuff" })).toBeVisible();
  await expect(page.locator(".project-section-head", { hasText: /^›Errors/u })).toHaveCount(0);
  await expect(page.locator("#route-explorer, #issues")).toHaveCount(0);
  await expect(page.locator('[id="ledger-worker"]')).toBeVisible();
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
  await page.goto(`/#/project/stats?range=24h&section=requests&route=${encodeURIComponent(HISTORY_ROUTE)}&band=slow`);
  const explorer = page.locator("#route-explorer");
  await expect(explorer.locator(".hot-summary")).toBeVisible();
  await expect(explorer.locator(".wf-fill").first()).toBeVisible();
  await expect(explorer).toHaveScreenshot("stats-route-explorer.webp");

  await page.goto(`/#/project/stats?range=24h&section=deploys&deployment=${SCENARIO_ROLLOUTS.v14}`);
  await page.reload();
  await expect(page.locator("#deployments .impact-summary")).toBeVisible();
  await expect(page.locator("#deployments")).toHaveScreenshot("stats-deployments.webp");

  await page.goto(`/#/project/stats?range=24h&section=errors`);
  await page.reload();
  await expect(page.locator("#issues .issue-facts")).toBeVisible();
  await expect(page.locator("#issues")).toHaveScreenshot("stats-issues.webp");
  await page.locator("#issues").getByRole("button", { name: "Open trace" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Trace" });
  await expect(dialog.locator(".wf-fill").first()).toBeVisible();
  await expect(dialog.locator(".ui-modal-body")).toHaveScreenshot("stats-trace-modal.webp");
});

test("mobile trace keeps invocation facts and stack readable while the timeline scrolls", { tag: "@mobile-only" }, async ({ page }) => {
  await setup(page);
  await page.goto("/#/project/stats?range=24h&section=errors");
  const opener = page.locator("#issues").getByRole("button", { name: "Open trace" }).first();
  await opener.focus();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Trace" });
  const timeline = dialog.getByRole("group", { name: "Trace timeline" });
  const selection = timeline.getByRole("region", { name: "Current selection" });
  await expect(selection.getByRole("region", { name: "Invocation" })).toContainText("CPU time");
  await expect(selection.getByRole("region", { name: "Errors" })).toContainText("src/installation.ts:419:3");
  const fits = async () => {
    const bounds = await Promise.all([timeline.boundingBox(), selection.boundingBox()]);
    expect(bounds[0]).not.toBeNull();
    expect(bounds[1]).not.toBeNull();
    expect(bounds[1]!.x).toBeGreaterThanOrEqual(bounds[0]!.x - 1);
    expect(bounds[1]!.x + bounds[1]!.width).toBeLessThanOrEqual(bounds[0]!.x + bounds[0]!.width + 1);
  };
  await fits();
  const scroll = timeline.locator(".table-scroll");
  await scroll.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await fits();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("frames show their original source, and frames from a version without a map say so", async ({ page }) => {
  await setup(page);
  const scenario = await (shared ??= buildScenario(now));
  const api = scenarioStore(scenario, now);
  const poll = (await api.issues({})).items.find(issue => issue.operation === "deployments.poll")!;
  const old = (await api.occurrences(poll.fingerprint, { limit: 100 })).items.find(item => item.version === SCENARIO_VERSIONS[0].id && item.traceId !== null)!;
  await page.goto(`/#/project/stats?range=24h&section=errors&modal=issue:${poll.fingerprint}`);
  const issue = page.getByRole("dialog", { name: "Issue" });
  await expect(issue.locator(".frames-list li").first()).toContainText("src/deployments/collector.ts:58");
  await expect(issue.locator(".frames-list li").first()).toHaveAttribute("title", /^bundle index\.js:\d+:\d+$/u);
  await page.goto(`/#/project/stats?range=24h&section=errors&modal=trace:${old.traceId}`);
  await page.reload();
  const trace = page.getByRole("dialog", { name: "Trace" });
  await expect(trace.locator(".frames-list li").first()).toContainText("index.js:3121");
  await expect(trace.locator(".frame-unmapped").first()).toBeVisible();
});

test("a closed project page loads the errors, requests, and trace views only when one opens", async ({ page }) => {
  await setup(page);
  const scripts: Promise<string>[] = [];
  page.on("response", response => { if (new URL(response.url()).pathname.endsWith(".js")) scripts.push(response.text()); });
  const viewCodeLoaded = async () => (await Promise.all(scripts)).some(script => script.includes("issue-list") || script.includes("route-explorer"));
  await page.goto("/#/project/stats?range=24h");
  await expect(page.locator("#section-errors")).toContainText("open");
  expect(await viewCodeLoaded()).toBe(false);
  await page.locator("#section-errors .project-nav-item, #section-errors button").first().click();
  await expect(page.locator("#issues").getByRole("option", { name: /RangeError/u })).toBeVisible();
  expect(await viewCodeLoaded()).toBe(true);
});

test("a deep-linked trace stops refreshing once the Requests section is closed", async ({ page }) => {
  const { requests } = await setup(page);
  const traceId = "0123456789abcdef0123456789abcdef";
  const traceReads = () => requests.filter(path => path.startsWith(`/traces/${traceId}`)).length;
  await page.goto(`/#/project/stats?range=24h&trace=${traceId}`);
  await expect(page.locator("#section-requests")).toHaveClass(/\bopen\b/u);
  await expect.poll(traceReads).toBe(1);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(traceReads).toBe(2);
  await page.locator("#section-overview .project-nav-item").click();
  await expect(page.locator("#section-requests")).not.toHaveClass(/\bopen\b/u);
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator("#section-errors")).toContainText("open");
  await page.waitForTimeout(300);
  expect(traceReads()).toBe(2);
});

test("the issue modal reports its own occurrence failure, not the Errors section's", async ({ page }) => {
  const scenario = await (shared ??= buildScenario(now));
  const issues = (await scenarioStore(scenario, now).issues({})).items;
  const section = issues[0]!;
  const modal = issues.find(issue => issue.fingerprint !== section.fingerprint)!;
  await setup(page, { failWhen: (_method, path) => path.startsWith(`/issues/${section.fingerprint}/occurrences`) });
  await page.goto(`/#/project/stats?range=24h&open=errors&issue=${section.fingerprint}&modal=issue:${modal.fingerprint}`);
  const dialog = page.getByRole("dialog", { name: "Issue" });
  await expect(dialog).toContainText(modal.name);
  await expect(dialog.locator("table.occurrence-table tbody tr").first()).toBeVisible();
  await expect(page.locator("#issues .notice-warn")).toBeVisible();
  await expect(dialog.locator(".notice-warn")).toHaveCount(0);
});

test("an application issue grouped by error code opens with its occurrences and no stack", async ({ page }) => {
  const scenario = await buildScenario(now);
  const store = scenarioStore(scenario, now);
  const failure = { schemaVersion: 1, atMs: now - 60_000, operation: "spool.drain", outcome: "error", durationMs: 12, work: {}, release: "r7", service: "stats", error: { code: "spool.lock_timeout" } } as const;
  expect(await store.ingestExternal("stats", [{ ...failure, eventId: "drain-1" }, { ...failure, eventId: "drain-2", atMs: now - 30_000 }])).toEqual({ ok: true, accepted: 2, duplicate: 0 });
  const issue = (await store.issues({})).items.find(item => item.name === "spool.lock_timeout")!;
  await setup(page, { scenario });
  await page.goto(`/#/project/stats?range=24h&open=errors&modal=issue:${issue.fingerprint}`);
  const dialog = page.getByRole("dialog", { name: "Issue" });
  await expect(dialog).toContainText("spool.lock_timeout");
  await expect(dialog).toContainText("Error code reported by the application");
  await expect(dialog.locator(".frames-list li")).toHaveCount(0);
  await expect(dialog.locator("table.occurrence-table tbody tr")).toHaveCount(2);
  await expect(dialog.locator("table.occurrence-table tbody")).toContainText("application");
});
