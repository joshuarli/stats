import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { accessToken } from "./access-token";
import type { Installation } from "../src/cloudflare/installation";
import type { DeploymentHistory } from "../src/deployments/model";
import type { DeploymentComparison } from "../src/deployments/compare";
import { collectDeployments } from "../src/cloudflare/deployments/collector";

const NOW = 1_793_510_415_000;
const ID = "00000000-0000-4000-8000-000000000002";
const VERSION = "00000000-0000-4000-8000-000000000102";
const stub = () => env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
const path = "/api/v1/projects/stuff/deployments";
async function get(suffix = "", method = "GET"): Promise<Response> {
  return SELF.fetch(`https://example.com${path}${suffix}`, { method, headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
}

beforeEach(async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    for (const table of ["project_deployments", "project_deployment_versions", "project_deployment_sync", "project_deployment_coverage"]) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
});

describe("deployment API", () => {
  it("requires Access on history and comparisons", async () => {
    for (const suffix of ["", `/${ID}/comparison?window=1h`]) expect((await SELF.fetch(`https://example.com${path}${suffix}`)).status).toBe(401);
  });
  it("is disabled without secrets and never returns credentials", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const history = await response.json() as DeploymentHistory;
    expect(history).toMatchObject({ projectId: "stuff", worker: "stuff", enabled: false, sync: null, deployments: [], versions: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects writes, unknown projects, extra and duplicate parameters", async () => {
    expect((await get("", "POST")).status).toBe(405);
    expect((await get("?range=1h")).status).toBe(400);
    expect((await get(`/${ID}/comparison?window=1h&window=24h`)).status).toBe(400);
    expect((await get(`/${ID}/comparison?window=7d`)).status).toBe(400);
    expect((await get(`/${ID}/comparison?window=toString`)).status).toBe(400);
    expect((await SELF.fetch("https://example.com/api/v1/projects/missing/deployments", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } })).status).toBe(404);
  });
  it("records through the binding, lists events and withholds unproven comparisons", async () => {
    await runInDurableObject(stub(), async (instance: Installation) => {
      await instance.recordDeploymentPoll({ project: "stuff", worker: "stuff", atMs: NOW, error: null, truncated: false, versions: [], deployments: [{ id: ID, atMs: NOW - 3 * 3_600_000, source: "api", message: null, deferred: false, versions: [{ id: VERSION, percentage: 100 }] }] });
    });
    const history = await (await get()).json() as DeploymentHistory;
    expect(history.deployments).toHaveLength(1);
    const response = await get(`/${ID}/comparison?window=1h`);
    expect(response.status).toBe(200);
    expect((await get(`/${ID}/comparison?window=6h`)).status).toBe(200);
    const comparison = await response.json() as DeploymentComparison;
    expect(comparison.deploymentId).toBe(ID);
    expect(comparison.reasons.some(reason => reason.includes("No proof"))).toBe(true);
    expect(comparison.metrics.every(metric => metric.verdict !== "improved" && metric.verdict !== "regressed")).toBe(true);
    expect((await get("/00000000-0000-4000-8000-000000000099/comparison")).status).toBe(404);
  });
  it("polls with request options the Workers runtime accepts", async () => {
    const created_on = new Date(NOW - 3_600_000).toISOString();
    await collectDeployments({
      projects: [{ id: "stuff", worker: "stuff" }], account: "0123456789abcdef0123456789abcdef", token: "test-token", now: NOW, store: stub(),
      fetch: async (url, init) => {
        const request = new Request(url, init);
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return Response.json({ success: true, result: { deployments: [{ id: ID, created_on, source: "api", strategy: "percentage", versions: [{ version_id: VERSION, percentage: 100 }] }] }, result_info: { total_pages: 1 } });
      },
    });
    const history = await (await get()).json() as DeploymentHistory;
    expect(history.sync).toMatchObject({ error: null, lastSuccessAtMs: NOW });
    expect(history.deployments.map(deployment => deployment.id)).toEqual([ID]);
  });
});

it("overview lists select the same retained deployment as history", async () => {
  const headers = { "Cf-Access-Jwt-Assertion": await accessToken() };
  const list = async () => await (await SELF.fetch("https://example.com/api/v1/projects", { headers })).json() as { id: string; latestDeployment: { status: string; deployment?: unknown; versions?: unknown[] } }[];
  const project = async () => (await list()).find(item => item.id === "stuff")!.latestDeployment;
  expect(await project()).toEqual({ status: "none" });
  const first = { id: ID, atMs: NOW - 1000, source: "api", message: "release", deferred: false, versions: [{ id: VERSION, percentage: 25 }, { id: "00000000-0000-4000-8000-000000000103", percentage: 75 }] };
  const second = { ...first, id: "00000000-0000-4000-8000-000000000003" };
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec("INSERT INTO project_deployments VALUES (?, ?, ?, ?, ?)", "stuff", "stuff", first.id, first.atMs, JSON.stringify(first));
    state.storage.sql.exec("INSERT INTO project_deployment_versions VALUES (?, ?, ?, ?, ?)", "stuff", "stuff", VERSION, NOW, JSON.stringify({ id: VERSION, tag: "release", message: null }));
  });
  expect((await project()).deployment).toEqual((await (await get()).json() as DeploymentHistory).deployments[0]);
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec("INSERT INTO project_deployments VALUES (?, ?, ?, ?, ?)", "stuff", "stuff", second.id, second.atMs, JSON.stringify(second));
  });
  const summary = await project();
  expect(summary.deployment).toEqual((await (await get()).json() as DeploymentHistory).deployments[0]);
  expect(summary.versions).toEqual([{ id: VERSION, tag: "release", message: null }]);
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec("UPDATE project_deployments SET at_ms = ?", NOW - 31 * 86_400_000);
  });
  expect(await project()).toEqual({ status: "none" });
});
