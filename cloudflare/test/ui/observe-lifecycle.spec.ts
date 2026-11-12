import { expect, test, type Page } from "./fixtures";
import { fulfillHistory } from "./history-route";
import { answer, buildScenario, scenarioComparison, scenarioStore, SCENARIO_ROLLOUTS, type Scenario } from "./observe-scenario";

const now = Date.UTC(2026, 10, 4, 2, 0);
const collector = { lastRunAtMs: now - 60_000, lastSuccessAtMs: now - 60_000, lastError: null, stale: false };
const STATS = { id: "stats", name: "stats", worker: "stats", workerBilling: "requests-and-cpu", buckets: [], durableObjectNamespaces: ["b25c2595ba784bb1bd51a87a3e87c62b"], d1Databases: [], probes: [], collector };
const HISTORY_ROUTE = "GET /api/v1/hosts/:host/history";
let shared: Promise<Scenario> | undefined;

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function installBase(
  page: Page,
  onObserve?: (method: string, path: string, scenario: Scenario) => Promise<{ status: number; body: string } | null>,
  fixture?: Scenario
) {
  const scenario = fixture ?? await (shared ??= buildScenario(now));
  const aborted: string[] = [];
  await page.clock.setFixedTime(now);
  page.on("requestfailed", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/observe/")) aborted.push(url.pathname + url.search);
  });
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/hosts") return route.fulfill({ json: { hosts: [] } });
    if (url.pathname === "/api/v1/projects") return route.fulfill({ json: [STATS] });
    if (url.pathname === "/api/v1/projects/stats/deployments") return route.fulfill({ json: scenario.deployments });
    const comparison = /^\/api\/v1\/projects\/stats\/deployments\/([^/]+)\/comparison$/u.exec(url.pathname);
    if (comparison !== null) {
      const window = url.searchParams.get("window") === "6h" ? "6h" : url.searchParams.get("window") === "24h" ? "24h" : "1h";
      const body = scenarioComparison(scenario, comparison[1]!, window);
      return body === null ? route.fulfill({ status: 404, json: { error: { code: "not_found", message: "deployment not found" } } }) : route.fulfill({ json: body });
    }
    const history = /^\/api\/v1\/projects\/([\w-]+)\/history$/u.exec(url.pathname);
    const kinds = url.searchParams.get("kinds");
    if (history !== null && kinds !== null) {
      const base = { projectId: history[1], range: "24h", fromMs: now - 86_400_000, toMs: now, stepMs: 3_600_000 };
      const body = (kind: string) => kind === "collector" ? { ...base, kind, runs: [] }
        : kind === "worker" ? { ...base, kind, series: [{ metric: "worker.invocations", values: Array.from({ length: 24 }, () => 300) }, { metric: "worker.status.2xx", values: Array.from({ length: 24 }, () => 300) }] }
        : kind === "durable-objects" ? { ...base, kind, series: [{ metric: "do.invocations", values: Array.from({ length: 24 }, () => 600) }, { metric: "do.wallMsSum", values: Array.from({ length: 24 }, () => 30_000) }, { metric: "do.cpuMsSum", values: Array.from({ length: 24 }, () => 9_000) }] }
        : { ...base, kind, series: [] };
      return fulfillHistory(route, { projectId: history[1], histories: Object.fromEntries(kinds.split(",").map(kind => [kind, body(kind)])) });
    }
    return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "unmocked" } } });
  });
  await page.route("**/api/observe/**", async route => {
    const url = new URL(route.request().url());
    const [, , path] = /^\/api\/observe\/([^/]+)(\/.*)$/u.exec(url.pathname) ?? [];
    if (path === undefined) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "unknown" } } });
    const method = route.request().method();
    const full = path + url.search;
    if (onObserve !== undefined) {
      const custom = await onObserve(method, full, scenario);
      if (route.request().failure() !== null) return;
      if (custom !== null) return route.fulfill({ status: custom.status, contentType: "application/json", body: custom.body });
    }
    const response = await answer(scenario, now, new Request(`https://observe${full}`, { method, headers: { "content-type": route.request().headers()["content-type"] ?? "" }, ...(method === "POST" ? { body: route.request().postData() ?? "" } : {}) }));
    return route.fulfill({ status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: await response.text() });
  });
  return { scenario, aborted };
}

test("selecting trace B while B is deferred clears trace A's timeline immediately and renders B when it settles", async ({ page }) => {
  const gateB = createGate();
  let traceRequests = 0;

  await installBase(page, async (_method, path) => {
    if (path.startsWith("/traces/")) {
      traceRequests += 1;
      if (traceRequests === 2) await gateB.promise;
    }
    return null;
  });

  await page.goto("/#/project/stats?range=24h&open=requests");
  const explorer = page.locator("#route-explorer");
  const traceRows = explorer.locator(".trace-row");
  await expect(traceRows.first()).toBeVisible();

  const detail = explorer.locator(".trace-detail");
  await expect(detail.locator(".tl")).toBeVisible();
  const traceAText = await detail.locator(".trace-head").textContent();
  expect(traceAText).toBeTruthy();

  await traceRows.nth(1).click();
  await expect(detail.locator(".tl")).toHaveCount(0);
  await expect(detail.locator(".ui-skeleton")).toBeVisible();

  gateB.release();
  await expect(detail.locator(".tl")).toBeVisible();
  await expect(traceRows.nth(1)).toHaveAttribute("aria-selected", "true");
});

test("leaving Requests aborts deferred exploration before it can load traces", async ({ page }) => {
  const gate = createGate();
  let waiting = false;
  const traceLists: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/observe/stats/traces") traceLists.push(request.url());
  });
  const { aborted } = await installBase(page, async (_method, path) => {
    if (path.startsWith("/explore?")) {
      waiting = true;
      await gate.promise;
    }
    return null;
  });
  await page.goto("/#/project/stats?range=24h&section=requests");
  try {
    await expect.poll(() => waiting).toBe(true);
    await page.getByRole("button", { name: /Overview/u }).click();
    await expect.poll(() => aborted.some(path => path.includes("/explore?"))).toBe(true);
    expect(traceLists).toHaveLength(0);
  } finally {
    gate.release();
  }
});

test("selecting a new trace aborts the previous trace request", async ({ page }) => {
  const gate = createGate();
  let firstTrace: string | null = null;
  const { aborted } = await installBase(page, async (_method, path) => {
    if (path.startsWith("/traces/") && firstTrace === null) {
      firstTrace = path;
      await gate.promise;
    }
    return null;
  });
  await page.goto("/#/project/stats?range=24h&open=requests");
  const explorer = page.locator("#route-explorer");
  const traceRows = explorer.locator(".trace-row");
  await expect(traceRows.nth(1)).toBeVisible();
  try {
    await expect.poll(() => firstTrace).not.toBeNull();
    await traceRows.nth(1).click();
    await expect(explorer.locator(".trace-detail .tl")).toBeVisible();
    await expect.poll(() => aborted.some(path => firstTrace !== null && path.endsWith(firstTrace))).toBe(true);
    await expect(traceRows.nth(1)).toHaveAttribute("aria-selected", "true");
  } finally {
    gate.release();
  }
});

test("selecting a new issue aborts the previous occurrence request", async ({ page }) => {
  const gate = createGate();
  let firstOccurrences: string | null = null;
  const { aborted } = await installBase(page, async (_method, path) => {
    if (path.includes("/occurrences") && firstOccurrences === null) {
      firstOccurrences = path;
      await gate.promise;
    }
    return null;
  });
  await page.goto("/#/project/stats?range=24h&section=errors");
  const issues = page.locator("#issues");
  await expect(issues.getByRole("option", { name: /TypeError/u })).toBeVisible();
  try {
    await expect.poll(() => firstOccurrences).not.toBeNull();
    await issues.getByRole("option", { name: /TypeError/u }).click();
    await expect(issues.locator(".issue-detail .frames-head")).toContainText("TypeError");
    await expect.poll(() => aborted.some(path => firstOccurrences !== null && path.endsWith(firstOccurrences))).toBe(true);
  } finally {
    gate.release();
  }
});

test("selecting issue B while B's occurrences are deferred clears issue A's frames and occurrence rows immediately", async ({ page }) => {
  const gateB = createGate();
  let occurrenceCalls = 0;

  await installBase(page, async (_method, path) => {
    if (path.includes("/occurrences")) {
      occurrenceCalls += 1;
      if (occurrenceCalls === 2) await gateB.promise;
    }
    return null;
  });

  await page.goto("/#/project/stats?range=24h&open=errors");
  const issues = page.locator("#issues");
  await expect(issues.locator(".issue-detail .frames")).toBeVisible();
  await expect(issues.locator(".occurrence-table tbody tr").first()).toBeVisible();
  await expect(issues.locator(".issue-detail .frames-head")).toContainText("RangeError");

  await issues.getByRole("option", { name: /TypeError/u }).click();
  await expect(issues.locator(".issue-detail .issue-head")).toContainText("TypeError");
  await expect(issues.locator(".issue-detail .frames")).toHaveCount(0);
  await expect(issues.locator(".occurrence-table tbody tr")).toHaveCount(0);
  await expect(issues.locator(".issue-detail .ui-skeleton")).toBeVisible();

  gateB.release();
  await expect(issues.locator(".issue-detail .frames-head")).toContainText("TypeError");
  await expect(issues.locator(".occurrence-table tbody tr").first()).toBeVisible();
});

test("changing route, band, or window while exploration is deferred clears the previous route exploration and traces", async ({ page }) => {
  const routeGate = createGate();
  const bandGate = createGate();
  const windowGate = createGate();
  let mode: "initial" | "route" | "band" | "window" = "initial";

  await installBase(page, async (_method, path) => {
    if (mode === "route" && path.startsWith("/explore?") && path.includes("route=")) {
      await routeGate.promise;
    } else if (mode === "band" && path.startsWith("/traces?") && path.includes("order=slowest")) {
      await bandGate.promise;
    } else if (mode === "window" && path.startsWith("/explore?")) {
      await windowGate.promise;
    }
    return null;
  });

  await page.goto("/#/project/stats?range=24h&open=requests");
  const explorer = page.locator("#route-explorer");
  await expect(explorer.locator(".explore-head")).toContainText("Latency · all routes");
  await expect(explorer.locator(".trace-row").first()).toBeVisible();

  mode = "route";
  await explorer.getByRole("button", { name: /hosts\/:host\/history/u }).click();
  await expect(page).toHaveURL(/route=GET/u);
  await expect(explorer.locator(".explore-head")).toHaveCount(0);
  await expect(explorer.locator(".trace-row")).toHaveCount(0);
  await expect(explorer.locator(".ui-skeleton")).toBeVisible();

  routeGate.release();
  await expect(explorer.locator(".explore-head")).toContainText(`Latency · ${HISTORY_ROUTE}`);
  await expect(explorer.locator(".trace-row").first()).toBeVisible();

  mode = "band";
  await explorer.getByRole("button", { name: "≥ p95" }).click();
  await expect(page).toHaveURL(/band=slow/u);
  await expect(explorer.locator(".trace-row")).toHaveCount(0);
  await expect(explorer.locator(".ui-skeleton")).toBeVisible();

  bandGate.release();
  await expect(explorer.locator(".hot-summary")).toContainText("Calls at or above p95");
  await expect(explorer.locator(".trace-row").first()).toBeVisible();

  mode = "window";
  await page.getByRole("button", { name: "6h", exact: true }).click();
  await expect(explorer.locator(".trace-row")).toHaveCount(0);
  await expect(explorer.locator(".ui-skeleton")).toBeVisible();

  windowGate.release();
  await expect(explorer.locator(".trace-row").first()).toBeVisible();
});

test("switching issue-state filter from Open to Resolved while Resolved is deferred clears Open issues immediately", async ({ page }) => {
  const resolvedGate = createGate();

  await installBase(page, async (_method, path) => {
    if (path.startsWith("/issues?") && path.includes("state=resolved")) {
      await resolvedGate.promise;
    }
    return null;
  });

  await page.goto("/#/project/stats?range=24h&open=errors");
  const issues = page.locator("#issues");
  await expect(issues.getByRole("option", { name: /RangeError/u })).toBeVisible();

  await issues.getByRole("button", { name: "Resolved", exact: true }).click();
  await expect(page).toHaveURL(/issues=resolved/u);
  await expect(issues.locator(".issue-item")).toHaveCount(0);
  await expect(issues.locator(".ui-skeleton")).toBeVisible();

  resolvedGate.release();
  await expect(issues.locator(".ui-skeleton")).toHaveCount(0);
  await expect(issues).toContainText("No resolved issues with occurrences in the last 7 days.");
});

test("modal stack navigation, back/close, and URL deep links isolate modal state across subjects", async ({ page }) => {
  const issueGate = createGate();
  let blockIssueModal = false;

  await installBase(page, async (_method, path) => {
    if (blockIssueModal && /^\/issues\/[0-9a-f]{64}$/u.test(path)) {
      await issueGate.promise;
    }
    return null;
  });

  await page.goto(`/#/project/stats?range=24h&open=requests&route=${encodeURIComponent(HISTORY_ROUTE)}&modal=deployment:${SCENARIO_ROLLOUTS.v14}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("1 new issue group · 1 regression");

  blockIssueModal = true;
  await dialog.getByRole("button", { name: /RangeError/u }).click();
  await expect(page).toHaveURL(/modal=issue/u);
  await expect(page.getByRole("dialog", { name: "Issue" }).locator(".ui-skeleton")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Issue" })).not.toContainText("1 new issue group");

  issueGate.release();
  await expect(page.getByRole("dialog", { name: "Issue" })).toContainText("RangeError");

  await page.getByRole("dialog").getByRole("button", { name: /Back|Deployment/u }).first().click();
  await expect(page).toHaveURL(new RegExp(`modal=deployment%3A${SCENARIO_ROLLOUTS.v14}|modal=deployment:${SCENARIO_ROLLOUTS.v14}`, "u"));
  await expect(page.getByRole("dialog")).toContainText("1 new issue group · 1 regression");

  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/modal=/u);
});

test("an auth 401 while a second trace loads clears the first trace timeline and surfaces the 401 alert", async ({ page }) => {
  let traceRequests = 0;

  await installBase(page, async (_method, path) => {
    if (path.startsWith("/traces/")) {
      traceRequests += 1;
      if (traceRequests === 2) {
        return { status: 401, body: JSON.stringify({ error: { code: "unauthorized", message: "Access token expired" } }) };
      }
    }
    return null;
  });

  await page.goto("/#/project/stats?range=24h&open=requests");
  const explorer = page.locator("#route-explorer");
  await expect(explorer.locator(".trace-detail .tl")).toBeVisible();

  await explorer.locator(".trace-row").nth(1).click();
  await expect(explorer.locator(".trace-detail .tl")).toHaveCount(0);
  await expect(explorer.locator(".trace-detail [role='alert']")).toContainText("unavailable (401)");
});

test("changing deployment cancels its comparison and never shows it for another release", async ({ page }) => {
  const { scenario } = await installBase(page);
  const gate = createGate();
  let waiting = false;
  const aborted: string[] = [];
  page.on("requestfailed", request => {
    if (request.url().includes("/comparison")) aborted.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/v1/projects/stats/deployments/*/comparison?*", async route => {
    const url = new URL(route.request().url());
    const id = /\/deployments\/([^/]+)\/comparison/u.exec(url.pathname)?.[1];
    if (id === undefined) throw new Error("missing deployment ID");
    if (id === SCENARIO_ROLLOUTS.v13) {
      waiting = true;
      await gate.promise;
      if (route.request().failure() !== null) return;
    }
    const window = url.searchParams.get("window") === "6h" ? "6h" : url.searchParams.get("window") === "24h" ? "24h" : "1h";
    const body = scenarioComparison(scenario, id, window);
    if (body === null) throw new Error("missing comparison fixture");
    await route.fulfill({ json: body });
  });
  await page.goto(`/#/project/stats?range=24h&section=deploys&deployment=${SCENARIO_ROLLOUTS.v14}`);
  const deployment = page.locator("#deployments");
  await expect(deployment.locator(".deployment-periods")).toBeVisible();
  const oldWindows = await deployment.locator(".deployment-periods").textContent();
  try {
    await page.getByRole("option", { name: /^v1\.3\.0\b/u }).click();
    await expect.poll(() => waiting).toBe(true);
    await expect(deployment.locator(".deployment-periods")).toHaveCount(0);
    await expect(deployment.locator(".deployment-panel .ui-skeleton").first()).toBeVisible();
    await page.getByRole("option", { name: /^v1\.4\.0\b/u }).click();
    await expect.poll(() => aborted.some(path => path.includes(SCENARIO_ROLLOUTS.v13))).toBe(true);
    await expect(deployment.locator(".deployment-periods")).toHaveText(oldWindows!);
  } finally {
    gate.release();
  }
});

test("changing deployment cancels the previous rollout impact request", async ({ page }) => {
  const gate = createGate();
  let waiting = false;
  const { aborted } = await installBase(page, async (_method, path) => {
    if (path.startsWith(`/rollouts/${SCENARIO_ROLLOUTS.v14}/impact`)) {
      waiting = true;
      await gate.promise;
    }
    return null;
  });
  await page.goto(`/#/project/stats?range=24h&section=deploys&deployment=${SCENARIO_ROLLOUTS.v14}`);
  try {
    await expect.poll(() => waiting).toBe(true);
    await page.getByRole("option", { name: /^v1\.3\.0\b/u }).click();
    await expect.poll(() => aborted.some(path => path.includes(`/rollouts/${SCENARIO_ROLLOUTS.v14}/impact`))).toBe(true);
    await expect(page.getByRole("region", { name: "Errors after this deployment" })).toBeVisible();
  } finally {
    gate.release();
  }
});


test("resolving an issue cancels its previous modal occurrence request", async ({ page }) => {
  const scenario = await buildScenario(now);
  const issue = (await scenarioStore(scenario, now).issues({})).items[0]!;
  const gate = createGate();
  let waiting = false;
  const { aborted } = await installBase(page, async (_method, path) => {
    if (path.startsWith(`/issues/${issue.fingerprint}/occurrences`) && !waiting) {
      waiting = true;
      await gate.promise;
    }
    return null;
  }, scenario);
  await page.goto(`/#/project/stats?section=deploys&modal=issue:${issue.fingerprint}`);
  const dialog = page.getByRole("dialog", { name: "Issue" });
  try {
    await expect.poll(() => waiting).toBe(true);
    await dialog.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("Issue resolved");
    await expect.poll(() => aborted.some(path => path.includes(`/issues/${issue.fingerprint}/occurrences`))).toBe(true);
    await expect(dialog.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
  } finally {
    gate.release();
  }
});
