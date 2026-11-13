import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessToken } from "./access-token";
import { CloudflareSql } from "../src/cloudflare/sql";
import { authenticateDeployToken, authenticateIngestToken } from "../src/core/installation/services";
import type { DeploymentHistory } from "../src/deployments/model";

const NOW = 1_793_510_415_000;
const ORIGIN = "https://example.com";
const stub = () => env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));

afterEach(() => {
  vi.restoreAllMocks();
});

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", await accessToken());
  return SELF.fetch(`${ORIGIN}/api/v1${path}`, { ...init, headers });
}

async function createHost(name: string): Promise<string> {
  const response = await admin("/admin/hosts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  expect(response.status).toBe(201);
  return (await response.json() as { hostId: string }).hostId;
}

async function createService(body: unknown): Promise<Response> {
  return admin("/admin/services", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function mark(name: string, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/ingest/services/${name}/deployments`, {
    method: "POST",
    headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function markerRows(name: string): Promise<number> {
  return runInDurableObject(stub(), async (_instance, state) => state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM service_deployments WHERE service = ?", name).one().count);
}

async function provisioned(name: string, hostNames: readonly string[] = ["web-1", "web-2"]): Promise<{ hostIds: string[]; deployToken: string; ingestToken: string }> {
  const hostIds: string[] = [];
  for (const host of hostNames) hostIds.push(await createHost(`${name}-${host}`));
  const response = await createService({ name, hostIds });
  expect(response.status).toBe(201);
  const created = await response.json() as { deployToken: string; ingestToken: string };
  return { hostIds, deployToken: created.deployToken, ingestToken: created.ingestToken };
}

describe("services", () => {
  it("refuses to purge a host a service lists with 409, and purges it once no service lists it", async () => {
    const lone = await createHost("lonely");
    expect((await admin(`/admin/hosts/${lone}/purge`, { method: "DELETE" })).status).toBe(204);
    const { hostIds } = await provisioned("purge-guard", ["a"]);
    const refused = await admin(`/admin/hosts/${hostIds[0]}/purge`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("conflict");
    const stillListed = await admin("/hosts");
    expect((await stillListed.json() as { hosts: { hostId: string }[] }).hosts.some(host => host.hostId === hostIds[0])).toBe(true);
  });

  it("creates a service and returns its two credentials only in the creation response", async () => {
    const log = vi.spyOn(console, "error");
    const info = vi.spyOn(console, "log");
    const hostIds = [await createHost("api-b"), await createHost("api-a")];
    const response = await createService({ name: "api", hostIds, healthUrl: "https://api.example.com/health", unit: "api@1.service" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const created = await response.json() as Record<string, unknown>;
    expect(created).toEqual({
      name: "api", hostIds: [...hostIds].sort(), healthUrl: "https://api.example.com/health", unit: "api@1.service", createdAtMs: NOW,
      deployToken: expect.stringMatching(/^nft_[A-Za-z0-9_-]{43}$/u),
      ingestToken: expect.stringMatching(/^nft_[A-Za-z0-9_-]{43}$/u)
    });
    const deployToken = created["deployToken"] as string;
    const ingestToken = created["ingestToken"] as string;
    expect(deployToken).not.toBe(ingestToken);

    const listed = await admin("/services");
    expect(listed.status).toBe(200);
    const listText = await listed.text();
    expect((JSON.parse(listText) as { services: Record<string, unknown>[] }).services.filter(service => service["name"] === "api")).toEqual([{ name: "api", hostIds: [...hostIds].sort(), healthUrl: "https://api.example.com/health", unit: "api@1.service", createdAtMs: NOW, latestDeployment: { status: "none" } }]);
    const one = await admin("/services/api");
    expect(one.status).toBe(200);
    const oneText = await one.text();
    expect(JSON.parse(oneText)).toEqual({ name: "api", hostIds: [...hostIds].sort(), healthUrl: "https://api.example.com/health", unit: "api@1.service", createdAtMs: NOW });

    const marked = await mark("api", deployToken, { markerId: "run-1", version: "abc123", hostIds: [hostIds[0]] });
    const markedText = await marked.text();
    const history = await admin("/services/api/deployments");
    const historyText = await history.text();
    for (const text of [listText, oneText, markedText, historyText]) {
      expect(text).not.toContain(deployToken);
      expect(text).not.toContain(ingestToken);
    }
    const verifiers = await runInDurableObject(stub(), async (_instance, state) => state.storage.sql.exec<{ token_hash: string; ingest_token_hash: string }>("SELECT token_hash, ingest_token_hash FROM services WHERE name = 'api'").one());
    expect(verifiers.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(verifiers.ingest_token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(verifiers.token_hash).not.toBe(verifiers.ingest_token_hash);
    for (const token of [deployToken, ingestToken]) {
      expect(verifiers.token_hash).not.toContain(token);
      expect(verifiers.ingest_token_hash).not.toContain(token);
    }
    for (const call of [...log.mock.calls, ...info.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(deployToken);
      expect(JSON.stringify(call)).not.toContain(ingestToken);
    }
  });

  it("accepts each service credential only on its own capability", async () => {
    const { hostIds, deployToken, ingestToken } = await provisioned("split", ["a"]);
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = new CloudflareSql(state.storage);
      expect(await authenticateDeployToken(sql, "split", deployToken)).toBe(true);
      expect(await authenticateDeployToken(sql, "split", ingestToken)).toBe(false);
      expect(await authenticateIngestToken(sql, "split", ingestToken)).toBe(true);
      expect(await authenticateIngestToken(sql, "split", deployToken)).toBe(false);
      expect(await authenticateDeployToken(sql, "split", null)).toBe(false);
      expect(await authenticateIngestToken(sql, "split", null)).toBe(false);
      expect(await authenticateDeployToken(sql, "absent", deployToken)).toBe(false);
      expect(await authenticateIngestToken(sql, "absent", ingestToken)).toBe(false);
    });
    expect((await mark("split", ingestToken, { markerId: "m1", version: "1", hostIds: [hostIds[0]] })).status).toBe(401);
  });

  it("rotates the deploy and ingest credentials independently and refuses each old verifier", async () => {
    const { hostIds, deployToken, ingestToken } = await provisioned("rotating", ["a"]);
    const marker = { markerId: "release-1", version: "1.0.0", hostIds: [hostIds[0]] };
    expect((await mark("rotating", deployToken, marker)).status).toBe(201);

    const rotated = await admin("/admin/services/rotating/rotate", { method: "POST" });
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    const deploy = await rotated.json() as { name: string; deployToken: string };
    expect(deploy.name).toBe("rotating");
    expect(deploy.deployToken).toMatch(/^nft_[A-Za-z0-9_-]{43}$/u);
    expect(deploy.deployToken).not.toBe(deployToken);
    expect(JSON.stringify(deploy)).not.toContain(ingestToken);

    expect((await mark("rotating", deployToken, { ...marker, markerId: "old" })).status).toBe(401);
    expect((await mark("rotating", deploy.deployToken, { ...marker, markerId: "new" })).status).toBe(201);

    const ingestRotated = await admin("/admin/services/rotating/token/rotate", { method: "POST" });
    expect(ingestRotated.status).toBe(200);
    const ingest = await ingestRotated.json() as { name: string; ingestToken: string };
    expect(ingest.name).toBe("rotating");
    expect(ingest.ingestToken).toMatch(/^nft_[A-Za-z0-9_-]{43}$/u);
    expect(ingest.ingestToken).not.toBe(ingestToken);
    expect(JSON.stringify(ingest)).not.toContain(deploy.deployToken);

    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = new CloudflareSql(state.storage);
      expect(await authenticateDeployToken(sql, "rotating", deployToken)).toBe(false);
      expect(await authenticateIngestToken(sql, "rotating", ingestToken)).toBe(false);
      expect(await authenticateDeployToken(sql, "rotating", deploy.deployToken)).toBe(true);
      expect(await authenticateIngestToken(sql, "rotating", ingest.ingestToken)).toBe(true);
    });

    expect((await admin("/admin/services/missing/rotate", { method: "POST" })).status).toBe(404);
    expect((await admin("/admin/services/missing/token/rotate", { method: "POST" })).status).toBe(404);
  });

  it("deletes a service with its markers and refuses its credentials afterwards", async () => {
    const { hostIds, deployToken, ingestToken } = await provisioned("gone", ["a"]);
    expect((await mark("gone", deployToken, { markerId: "m1", version: "1", hostIds: [hostIds[0]] })).status).toBe(201);
    expect(await markerRows("gone")).toBe(1);

    expect((await admin("/admin/services/gone", { method: "DELETE" })).status).toBe(204);
    expect(await markerRows("gone")).toBe(0);
    expect((await mark("gone", deployToken, { markerId: "m2", version: "1", hostIds: [hostIds[0]] })).status).toBe(401);
    expect((await admin("/services/gone")).status).toBe(404);
    expect((await admin("/admin/services/gone", { method: "DELETE" })).status).toBe(404);
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = new CloudflareSql(state.storage);
      expect(await authenticateDeployToken(sql, "gone", deployToken)).toBe(false);
      expect(await authenticateIngestToken(sql, "gone", ingestToken)).toBe(false);
    });
  });

  it("requires Access on every service route except the marker post", async () => {
    for (const [path, method] of [
      ["/admin/services", "POST"], ["/admin/services/api/rotate", "POST"], ["/admin/services/api/token/rotate", "POST"], ["/admin/services/api", "DELETE"],
      ["/services", "GET"], ["/services/api", "GET"], ["/services/api/deployments", "GET"]
    ] as const) {
      const response = await SELF.fetch(`${ORIGIN}/api/v1${path}`, { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("rejects invalid service definitions, duplicate names, and unusable hosts without storing anything", async () => {
    const live = await createHost("valid-live");
    const revoked = await createHost("valid-revoked");
    expect((await admin(`/admin/hosts/${revoked}`, { method: "DELETE" })).status).toBe(204);
    const cases: readonly [unknown, number][] = [
      [{ name: "Bad", hostIds: [live] }, 400],
      [{ name: "-bad", hostIds: [live] }, 400],
      [{ name: "a".repeat(33), hostIds: [live] }, 400],
      [{ name: "valid", hostIds: [] }, 400],
      [{ name: "valid", hostIds: [live, live] }, 400],
      [{ name: "valid", hostIds: ["h_00000000000000000000000000000000"] }, 400],
      [{ name: "valid", hostIds: [revoked] }, 400],
      [{ name: "valid", hostIds: [live], healthUrl: "http://example.com/health" }, 400],
      [{ name: "valid", hostIds: [live], healthUrl: "https://user:pass@example.com/" }, 400],
      [{ name: "valid", hostIds: [live], healthUrl: "ftp://example.com/" }, 400],
      [{ name: "valid", hostIds: [live], unit: "../etc" }, 400],
      [{ name: "valid", hostIds: [live], unit: "a/b" }, 400],
      [{ name: "valid", hostIds: [live], unit: "a".repeat(129) }, 400],
      [{ name: "valid", hostIds: [live], extra: true }, 400],
      [[], 400]
    ];
    for (const [body, status] of cases) expect((await createService(body)).status, JSON.stringify(body)).toBe(status);
    expect((await admin("/admin/services", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
    expect((await admin("/admin/services", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await admin("/services/valid")).status).toBe(404);

    expect((await createService({ name: "valid", hostIds: [live], healthUrl: "http://web.tail1234.ts.net:8080/health" })).status).toBe(201);
    const duplicate = await createService({ name: "valid", hostIds: [live] });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: { code: "conflict", message: "a service with this name exists" } });
    expect((await admin("/services/missing")).status).toBe(404);
    expect((await admin("/services/missing/deployments")).status).toBe(404);
  });

  it("records a marker as a deployment and answers a repeat with the stored marker", async () => {
    const { hostIds, deployToken } = await provisioned("web");
    const body = { markerId: "ci-42", version: "v1.2.3+abc", message: "ship\nit", hostIds: [hostIds[1], hostIds[0]] };
    const first = await mark("web", deployToken, body);
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const marker = await first.json() as { service: string; markerId: string; hostIds: string[]; deployment: { id: string } };
    expect(marker).toEqual({
      service: "web", markerId: "ci-42", hostIds: [...hostIds].sort(),
      deployment: { id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u), atMs: NOW, source: "marker", message: "ship it", versions: [{ id: "v1.2.3+abc", percentage: 100 }], deferred: false }
    });

    const repeat = await mark("web", deployToken, { ...body, hostIds });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(marker);
    expect(await markerRows("web")).toBe(1);

    for (const changed of [{ ...body, version: "v1.2.4" }, { ...body, message: "other" }, { ...body, hostIds: [hostIds[0]] }]) {
      const conflict = await mark("web", deployToken, changed);
      expect(conflict.status, JSON.stringify(changed)).toBe(409);
      expect((await conflict.json() as { error: { code: string } }).error.code).toBe("conflict");
    }
    expect(await markerRows("web")).toBe(1);

    expect((await mark("web", deployToken, { markerId: "ci-43", version: "v1.2.4", hostIds: [hostIds[0]] })).status).toBe(201);
    const history = await admin("/services/web/deployments");
    expect(history.status).toBe(200);
    const read = await history.json() as DeploymentHistory & { markers: unknown };
    expect(read).toMatchObject({ projectId: "web", worker: "web", enabled: true, sync: null, versions: [] });
    expect(read.deployments.map(deployment => deployment.versions[0]!.id)).toEqual(["v1.2.4", "v1.2.3+abc"]);
    expect(read.deployments[1]).toEqual(marker.deployment);
    expect(read.markers).toEqual([
      { deploymentId: read.deployments[0]!.id, markerId: "ci-43", hostIds: [hostIds[0]] },
      { deploymentId: marker.deployment.id, markerId: "ci-42", hostIds: [...hostIds].sort() }
    ]);
    expect((await admin("/services/web/deployments?window=1h")).status).toBe(400);
  });

  it("rejects a wrong token, an unknown service, unknown or foreign hosts, and malformed markers before writing", async () => {
    const { hostIds, deployToken, ingestToken } = await provisioned("shop");
    const foreign = await createHost("shop-foreign");
    const other = await provisioned("blog", ["one"]);
    const valid = { markerId: "m1", version: "1", hostIds: [hostIds[0]] };
    const log = vi.spyOn(console, "error");
    const cases: readonly [string, string | null, unknown, number, Record<string, string>?][] = [
      ["shop", null, valid, 401],
      ["shop", "Bearer-less", valid, 401, { Authorization: deployToken }],
      ["shop", other.deployToken, valid, 401],
      ["shop", ingestToken, valid, 401],
      ["shop", `nft_${"A".repeat(43)}`, valid, 401],
      ["absent", deployToken, valid, 401],
      ["shop", deployToken, valid, 415, { "Content-Type": "text/plain" }],
      ["shop", deployToken, "{", 400],
      ["shop", deployToken, [], 400],
      ["shop", deployToken, { ...valid, hostIds: [foreign] }, 400],
      ["shop", deployToken, { ...valid, hostIds: ["h_00000000000000000000000000000000"] }, 400],
      ["shop", deployToken, { ...valid, hostIds: [] }, 400],
      ["shop", deployToken, { ...valid, hostIds: [hostIds[0], hostIds[0]] }, 400],
      ["shop", deployToken, { ...valid, markerId: "" }, 400],
      ["shop", deployToken, { ...valid, markerId: "a b" }, 400],
      ["shop", deployToken, { ...valid, markerId: "m".repeat(129) }, 400],
      ["shop", deployToken, { ...valid, version: "1/2" }, 400],
      ["shop", deployToken, { ...valid, version: 1 }, 400],
      ["shop", deployToken, { ...valid, message: "m".repeat(1001) }, 400],
      ["shop", deployToken, { ...valid, extra: 1 }, 400],
      ["shop", deployToken, { ...valid, message: "x".repeat(9000) }, 413],
      ["shop", deployToken, valid, 403, { Origin: "https://evil.example" }]
    ];
    for (const [name, credential, body, status, headers] of cases) {
      const response = await mark(name, credential === "Bearer-less" ? null : credential, body, headers);
      expect(response.status, `${name} ${JSON.stringify(body).slice(0, 80)} ${JSON.stringify(headers ?? {})}`).toBe(status);
    }
    const streamed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...valid, message: "x".repeat(9000) }))); controller.close(); } });
    const unsized = await SELF.fetch(`${ORIGIN}/ingest/services/shop/deployments`, { method: "POST", headers: { Authorization: `Bearer ${deployToken}`, "Content-Type": "application/json" }, body: streamed, duplex: "half" } as RequestInit);
    expect(unsized.status).toBe(413);
    const underAccess = await admin("/services/shop/deployments", { method: "POST", headers: { Authorization: `Bearer ${deployToken}`, "Content-Type": "application/json" }, body: JSON.stringify(valid) });
    expect(underAccess.status).toBe(405);
    expect(await markerRows("shop")).toBe(0);
    expect(await markerRows("absent")).toBe(0);
    for (const call of log.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(deployToken);
      expect(JSON.stringify(call)).not.toContain(ingestToken);
      expect(JSON.stringify(call)).not.toContain(other.deployToken);
    }
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "deploy_mark_rejected", code: "unauthorized" }));
  });
});
