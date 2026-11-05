import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openHistory } from "../src/binary/history";
import { getProjectHistories } from "../src/client/api";
import { decodeProjectHistories } from "../src/client/history";
import { assembleProjectLedger, historyKinds, projectHistoryPath, settledWindow } from "../src/client/project-ledger";
import { ledgerOf, loadCostInputs, resolveLive } from "../src/cli/cost-load";
import { decodeProjects } from "../src/cli/decode";
import { createHttpClient } from "../src/cli/http";
import type { CommandContext } from "../src/cli/registry";
import { encodeSnapshot, parseSnapshot, serializeSnapshot } from "../src/cli/snapshot-format";
import { previousWindowOf } from "../src/cost/ledger";
import { HOUR_MS } from "../src/limits";
import type { Installation } from "../src/cloudflare/installation";
import type { CollectorRun } from "../src/projects/store";
import { accessToken } from "./access-token";

const NOW = 1_793_510_415_000;
const BUCKET = 300_000;
const NEWEST = Math.floor(NOW / BUCKET) * BUCKET;
const ORIGIN = "https://example.com";

function installation() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

function seededRun(): CollectorRun {
  const points: { metric: string; bucketMs: number; value: number }[] = [];
  for (let step = 0; step <= 48; step += 1) {
    const bucketMs = NEWEST - step * BUCKET;
    points.push(
      { metric: "worker.invocations", bucketMs, value: 1000 + (step % 7) },
      { metric: "worker.cpuMsSum", bucketMs, value: 9000 + step },
      { metric: "worker.status.2xx", bucketMs, value: 990 },
      { metric: "worker.status.5xx", bucketMs, value: 4 },
      { metric: "route.GET /busy.invocations", bucketMs, value: 600 },
      { metric: "route.GET /busy.cpuMsSum", bucketMs, value: 6000 },
      { metric: "route.GET /idle.invocations", bucketMs, value: 40 },
      { metric: "route.GET /idle.cpuMsSum", bucketMs, value: 100 },
      { metric: "r2.stuff-mycrates.storageBytes", bucketMs, value: 5_000_000_000 }
    );
  }
  return { ok: true, atMs: NOW - 60_000, detail: "ok", rowsRead: 1, durationMs: 1, upstreamQueries: 1, collected: [{ project: "stuff", points }], storeOwners: [] };
}

async function token(): Promise<string> {
  return accessToken();
}

async function through(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Cf-Access-Jwt-Assertion", await token());
  return SELF.fetch(new URL(input instanceof Request ? input.url : input, ORIGIN), { method: init?.method ?? "GET", headers, redirect: init?.redirect ?? "follow", signal: init?.signal ?? null });
}

function context(): CommandContext {
  const controller = new AbortController();
  return {
    origin: ORIGIN,
    signal: controller.signal,
    now: () => NOW,
    http: createHttpClient({ origin: ORIGIN, signal: controller.signal, fetch: through, credential: async () => ({ header: "Cf-Access-Jwt-Assertion", value: await token() }) }),
    option: () => undefined,
    flag: () => false
  };
}

beforeEach(async () => {
  await runInDurableObject(installation(), async (instance: Installation, state) => {
    for (const table of ["project_samples", "project_hours", "collector_runs"]) state.storage.sql.exec(`DELETE FROM ${table}`);
    await instance.recordCollectorRun(seededRun());
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("statsctl cost against the Worker", () => {
  it("builds the same report from real binary frames as the dashboard adapter", async () => {
    const run = context();
    const listed = await run.http.getJson("/api/v1/projects", decodeProjects);
    if (listed.kind !== "ok") throw new Error("projects were not returned");
    const project = listed.value.find(candidate => candidate.id === "stuff")!;
    const windows = await resolveLive(run, project.id, { kind: "settled", range: "1h" });
    const inputs = await loadCostInputs(run, project, windows, NOW, 2);
    const cli = ledgerOf(inputs).report;

    vi.stubGlobal("fetch", through);
    const signal = new AbortController().signal;
    const kinds = historyKinds(project);
    const page = await getProjectHistories(project.id, { range: "1h" }, kinds, signal);
    const settled = settledWindow(page.worker, HOUR_MS, null);
    const dashboard = assembleProjectLedger({
      nowMs: NOW,
      project,
      windows: { current: settled, previous: previousWindowOf(settled) },
      current: await getProjectHistories(project.id, settled, kinds, signal),
      baseline: await getProjectHistories(project.id, previousWindowOf(settled), kinds, signal),
      objectMethods: undefined,
      planMonth: undefined
    }).report;

    expect(cli.windows.current).toEqual(settled);
    expect(cli.windows.current.toMs).toBeLessThanOrEqual(NOW - 45 * 60_000);
    expect(JSON.stringify(cli)).toBe(JSON.stringify(dashboard));
    expect(cli.total.monthly.now).toBeGreaterThan(0);
    expect(cli.comparison.baseline).toBe("present");
    expect(cli.lines.find(line => line.id === "worker")?.children.map(child => child.label)).toContain("GET /busy");
    expect(inputs.requests.project).toBe(2);
  });

  it("decodes the frames the CLI saved exactly as the live path did", async () => {
    const run = context();
    const listed = await run.http.getJson("/api/v1/projects", decodeProjects);
    if (listed.kind !== "ok") throw new Error("projects were not returned");
    const project = listed.value.find(candidate => candidate.id === "stuff")!;
    const windows = await resolveLive(run, project.id, { kind: "settled", range: "1h" });
    const inputs = await loadCostInputs(run, project, windows, NOW, 2);
    const replayed = parseSnapshot(serializeSnapshot(encodeSnapshot(inputs, "unknown")));
    expect(JSON.stringify(ledgerOf(replayed).report)).toBe(JSON.stringify(ledgerOf(inputs).report));
    const response = await through(projectHistoryPath(project.id, windows.current, historyKinds(project)), undefined);
    expect(response.headers.get("content-type")).toBe("application/vnd.stats.history.v1");
    const direct = decodeProjectHistories(openHistory(await response.arrayBuffer()).root);
    expect(direct.worker.fromMs).toBeLessThanOrEqual(windows.current.fromMs);
  });
});
