import { expect, test, type Page } from "@playwright/test";
import { fulfillHistory } from "./history-route";
import { DEPLOYMENT_ID, ISSUE_POLL, ISSUE_REQUEST, mockObserve, NEW_VERSION, observeFixture, STATS_PROJECT, TRACE_INGEST, TRACE_SCHEDULED, UNRECORDED_DEPLOYMENT_ID } from "./observe-fixture";

const now = Date.UTC(2026, 10, 4, 1, 0);
const collector = { lastRunAtMs: now - 60_000, lastSuccessAtMs: now - 60_000, lastError: null, stale: false };
const STUFF = { id: "stuff", name: "stuff", worker: "stuff", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [], collector };

async function setup(page: Page, options: { readonly failing?: boolean } = {}) {
  await page.clock.setFixedTime(now);
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/hosts") return route.fulfill({ json: { hosts: [] } });
    if (url.pathname === "/api/v1/projects") return route.fulfill({ json: [{ ...STATS_PROJECT, collector }, STUFF] });
    const deployments = /^\/api\/v1\/projects\/(\w+)\/deployments$/u.exec(url.pathname);
    if (deployments !== null) {
      if (deployments[1] === "stats") return route.fulfill({ json: observeFixture(now).deployments });
      return route.fulfill({ json: { projectId: deployments[1], worker: deployments[1], enabled: false, sync: null, deployments: [], versions: [] } });
    }
    const history = /^\/api\/v1\/projects\/(\w+)\/history$/u.exec(url.pathname);
    const kinds = url.searchParams.get("kinds");
    if (history !== null && kinds !== null) {
      const base = { projectId: history[1], range: "1h", fromMs: now - 3_600_000, toMs: now, stepMs: 300_000 };
      const body = (kind: string) => kind === "collector" ? { ...base, kind, runs: [] }
        : kind === "worker" ? { ...base, kind, series: [{ metric: "worker.invocations", values: Array.from({ length: 12 }, () => 120) }, { metric: "worker.status.2xx", values: Array.from({ length: 12 }, () => 120) }] }
        : { ...base, kind, series: [] };
      return fulfillHistory(route, { projectId: history[1], histories: Object.fromEntries(kinds.split(",").map(kind => [kind, body(kind)])) });
    }
    return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "unmocked" } } });
  });
  return mockObserve(page, now, options);
}

test("the stats project shows grouped errors and traces from the collector", { tag: "@mobile" }, async ({ page }) => {
  await setup(page);
  await page.goto("/#/project/stats");
  const issues = page.locator("#issues");
  await expect(issues.locator(".issue-list").getByRole("option")).toHaveCount(2);
  await expect(issues.locator(".issue-facts")).toContainText("2,016");
  await expect(issues.locator(".frames-list li.in-app")).toHaveCount(4);
  await expect(issues).toContainText("Message withheld");
  const traces = page.locator("#traces");
  await expect(traces.locator(".trace-list").getByRole("option")).toHaveCount(24);
  await expect(traces.locator(".tl-slice")).toHaveCount(2);
  await expect(traces.getByRole("region", { name: "Current selection" })).toContainText("64 ms");
});

test("an occurrence opens its trace, and both selections survive a reload", async ({ page }) => {
  await setup(page);
  await page.goto("/#/project/stats");
  await page.locator("#issues").getByRole("option", { name: /RangeError/u }).click();
  await expect(page).toHaveURL(new RegExp(`issue=${ISSUE_REQUEST}`, "u"));
  await page.locator("#issues").getByRole("option", { name: /deployments\.poll/u }).click();
  await page.locator("#issues").getByRole("button", { name: "Open trace" }).first().click();
  await expect(page).toHaveURL(new RegExp(`trace=${TRACE_SCHEDULED}`, "u"));
  await expect(page.locator("#traces .trace-head")).toContainText("scheduled */5 * * * *");
  await expect(page.locator("#traces .tl-slice.failed")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#traces .trace-head")).toContainText("scheduled */5 * * * *");
  await expect(page.locator("#issues .issue-item[aria-selected='true']")).toContainText("deployments.poll");
});

test("resolving an issue posts its new state and moves it to Resolved", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/stats");
  await page.locator("#issues").getByRole("option", { name: /RangeError/u }).click();
  await page.locator("#issues").getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.locator("#issues .issue-list").getByRole("option")).toHaveCount(1);
  expect(observe.posts).toEqual([{ path: `/issues/${ISSUE_REQUEST}/state`, body: { state: "resolved" } }]);
  await page.locator("#issues").getByRole("button", { name: "Resolved", exact: true }).click();
  await expect(page.locator("#issues").getByRole("option", { name: /RangeError/u })).toBeVisible();
  await expect(page.locator("#issues").getByRole("button", { name: "Reopen" })).toBeVisible();
});

test("the timeline steps through slices with arrow keys, zooms with W, and fits the selection with F", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?trace=${TRACE_SCHEDULED}`);
  const timeline = page.locator("#traces .tl");
  const selection = timeline.getByRole("region", { name: "Current selection" });
  await expect(selection).toContainText("scheduled */5 * * * *");
  await timeline.locator(".tl-slice").first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(selection).toContainText("Installation.knownDeploymentVersions");
  await expect(timeline.locator(".tl-span")).toHaveText("1.95 s visible");
  await page.keyboard.press("w");
  await expect(timeline.locator(".tl-span")).toHaveText("1.37 s visible");
  await page.keyboard.press("f");
  await expect(timeline.locator(".tl-span")).toHaveText("10.5 ms visible");
  await expect(timeline.locator(".tl-slice.selected .tl-slice-label")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(selection).toContainText("Select a slice");
});

test("trace filters narrow the list and are kept in the URL", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/stats");
  const traces = page.locator("#traces");
  await traces.getByRole("button", { name: "Failed", exact: true }).click();
  await expect(traces.locator(".trace-list").getByRole("option")).toHaveCount(2);
  await expect(page).toHaveURL(/traces=failed/u);
  await traces.getByRole("button", { name: "All", exact: true }).click();
  await traces.getByLabel("Route").selectOption("POST /ingest/v1/batches");
  await expect(page).toHaveURL(/route=POST/u);
  await expect(traces.locator(".trace-list").getByRole("option")).toHaveCount(6);
  expect(observe.requests.some(request => request.startsWith("/traces?") && request.includes("label=POST+%2Fingest%2Fv1%2Fbatches"))).toBe(true);
  await page.reload();
  await expect(traces.getByLabel("Route")).toHaveValue("POST /ingest/v1/batches");
  await expect(page.locator("#traces .trace-head")).toContainText("POST /ingest/v1/batches");
  await expect(page).toHaveURL(new RegExp(`trace=${TRACE_INGEST}|route=`, "u"));
});

test("an unavailable collector is reported instead of an empty dataset", async ({ page }) => {
  await setup(page, { failing: true });
  await page.goto("/#/project/stats");
  await expect(page.locator("#traces")).toContainText("collector is unavailable (503)");
  await expect(page.locator("#traces")).not.toContainText("No invocations");
  await expect(page.locator("#issues")).not.toContainText("No open issues");
});

test("other projects show no observability cards and never call its API", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/stuff");
  await expect(page.getByRole("heading", { name: "stuff" })).toBeVisible();
  await expect(page.locator("#issues, #traces")).toHaveCount(0);
  expect(observe.requests).toEqual([]);
  expect(ISSUE_POLL).toHaveLength(64);
});

test("the selected deployment shows its new issue groups and failure rate, and links to the issue", { tag: "@mobile" }, async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?deployment=${DEPLOYMENT_ID}`);
  const impact = page.locator("#deployments").getByRole("region", { name: "Errors after this deployment" });
  await expect(impact).toContainText("1 new issue group · no regressions");
  await expect(impact).toContainText("Failed requests 0.3% → 1%");
  await expect(impact).toContainText("compared with 2.3 days of earlier data");
  await impact.getByRole("button", { name: /RangeError/u }).click();
  await expect(page).toHaveURL(new RegExp(`issue=${ISSUE_REQUEST}`, "u"));
  await expect(page.locator("#issues .issue-item[aria-selected='true']")).toContainText("RangeError");
});

test("a deployment the collector has not recorded yet says so", async ({ page }) => {
  await setup(page);
  await page.goto(`/#/project/stats?deployment=${UNRECORDED_DEPLOYMENT_ID}`);
  await expect(page.locator("#deployments").getByRole("region", { name: "Errors after this deployment" })).toContainText("has not reached the collector yet");
});

test("issues show the version they were introduced in and filter by it", async ({ page }) => {
  const observe = await setup(page);
  await page.goto("/#/project/stats");
  const issues = page.locator("#issues");
  await expect(issues.getByRole("option", { name: /RangeError/u })).toContainText("since v1.4.0");
  await issues.getByLabel("Introduced in").selectOption(NEW_VERSION);
  await expect(issues.locator(".issue-list").getByRole("option")).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`introduced=${NEW_VERSION}`, "u"));
  expect(observe.requests.some(request => request.includes(`introducedIn=${NEW_VERSION}`))).toBe(true);
  await expect(issues.locator(".issue-facts")).toContainText("v1.4.0");
});
