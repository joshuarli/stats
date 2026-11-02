import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { accessToken } from "./access-token";
import type { Installation } from "../src/deployments/installation";
import type { DeploymentHistory } from "../src/deployments/model";
import type { DeploymentComparison } from "../src/deployments/compare";

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
    const comparison = await response.json() as DeploymentComparison;
    expect(comparison.deploymentId).toBe(ID);
    expect(comparison.reasons.some(reason => reason.includes("No proof"))).toBe(true);
    expect(comparison.metrics.every(metric => metric.verdict !== "improved" && metric.verdict !== "regressed")).toBe(true);
    expect((await get("/00000000-0000-4000-8000-000000000099/comparison")).status).toBe(404);
  });
  it("keeps inherited host and project APIs working", async () => {
    for (const resource of ["hosts", "projects"]) expect((await SELF.fetch(`https://example.com/api/v1/${resource}`, { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } })).status).toBe(200);
  });
});
