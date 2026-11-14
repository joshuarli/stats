import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/cloudflare/index";
import { gatewayHeaders } from "./gateway-headers";

function api(headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch("https://example.com/api/v1/hosts", { headers });
}

describe("Gateway authorization", () => {
  it("reports unavailable bindings without accessing providers and rejects forged identities", async () => {
    const env = { GATEWAY_SECRET: "secret" } as Env;
    const request = (headers: Record<string, string>) => new Request("https://example.com/api/v1/capabilities", { headers });
    const response = await worker.fetch(request({ "Stats-Gateway-Secret": "secret", "Stats-Tailnet-Identity": "user:test@example.com" }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, applicationEvents: true });
    expect((await worker.fetch(request({ "Stats-Gateway-Secret": "wrong", "Stats-Tailnet-Identity": "user:test@example.com" }), env)).status).toBe(401);
    expect((await worker.fetch(request({ "Stats-Tailnet-Identity": "user:test@example.com" }), env)).status).toBe(401);
  });
  it("accepts gateway-asserted users and tagged machines and rejects forged or missing assertions", async () => {
    expect((await api()).status).toBe(401);
    expect((await api({ "Tailscale-User-Login": "tester@example.com" })).status).toBe(401);
    expect((await api({ "Stats-Tailnet-Identity": "user:tester@example.com" })).status).toBe(401);
    expect((await api(gatewayHeaders("wrong-secret"))).status).toBe(401);
    expect((await api(gatewayHeaders(undefined, "user:"))).status).toBe(401);
    expect((await api(gatewayHeaders(undefined, "tags:tag:ci"))).status).toBe(200);
    const response = await api(gatewayHeaders());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("protects static assets behind the gateway", async () => {
    expect((await SELF.fetch("https://example.com/")).status).toBe(401);
    const response = await SELF.fetch("https://example.com/", { headers: gatewayHeaders() });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Stats</title>");
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const path of [/src="([^"]+\.js)"/u.exec(html)?.[1], /href="([^"]+\.css)"/u.exec(html)?.[1]].filter((entry): entry is string => entry !== undefined)) {
      const asset = await SELF.fetch(`https://example.com${path}`, { headers: gatewayHeaders() });
      expect(asset.status, path).toBe(200);
      expect(asset.headers.get("cache-control"), path).toBe("private, max-age=31536000, immutable");
      expect(asset.headers.get("content-security-policy"), path).toContain("default-src 'self'");
    }
  });

  it("serves llms.txt only behind the gateway", async () => {
    expect((await SELF.fetch("https://example.com/llms.txt")).status).toBe(401);
    const response = await SELF.fetch("https://example.com/llms.txt", { headers: gatewayHeaders() });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/api/v1/projects/:id/history");
  });

  it("serves the two linked docs behind the gateway and no other doc", async () => {
    const headers = gatewayHeaders();
    for (const path of ["/docs/protocol.md", "/docs/architecture.md"]) {
      expect((await SELF.fetch(`https://example.com${path}`)).status, path).toBe(401);
      const response = await SELF.fetch(`https://example.com${path}`, { headers });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toMatch(/^# /u);
    }
    for (const path of ["/docs/operations.md", "/docs/dependencies.md", "/docs/"]) {
      expect((await SELF.fetch(`https://example.com${path}`, { headers })).status, path).toBe(404);
    }
  });

  it("rejects malformed admin calls without the raw exception", async () => {
    const headers = { ...gatewayHeaders(), "Content-Type": "application/json" };
    const invalidName = await SELF.fetch("https://example.com/api/v1/admin/hosts", { method: "POST", headers, body: JSON.stringify({ name: "\u0000" }) });
    expect(invalidName.status).toBe(400);
    expect((await invalidName.json() as { error: { code: string } }).error.code).toBe("invalid_request");

    const invalidJson = await SELF.fetch("https://example.com/api/v1/admin/hosts", { method: "POST", headers, body: "notjson" });
    expect(invalidJson.status).toBe(400);
    expect((await invalidJson.json() as { error: { code: string } }).error.code).toBe("invalid_request");

    const nullBody = await SELF.fetch("https://example.com/api/v1/admin/hosts", { method: "POST", headers, body: "null" });
    expect(nullBody.status).toBe(400);

    const missing = await SELF.fetch("https://example.com/api/v1/admin/hosts/h_00000000000000000000000000000000/rotate", { method: "POST", headers: gatewayHeaders() });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("rejects cross-site writes and non-JSON admin bodies, and allows same-origin and header-less clients", async () => {
    const base = gatewayHeaders();
    const create = (headers: Record<string, string>) => SELF.fetch("https://example.com/api/v1/admin/hosts", { method: "POST", headers: { ...base, ...headers }, body: JSON.stringify({ name: "csrf" }) });
    const crossOrigin = await create({ "Content-Type": "text/plain", Origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json() as { error: { code: string } }).error.code).toBe("forbidden");
    expect((await create({ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const rotate = await SELF.fetch("https://example.com/api/v1/admin/hosts/h_00000000000000000000000000000000/rotate", { method: "POST", headers: { ...base, Origin: "https://evil.example" } });
    expect(rotate.status).toBe(403);
    const revoke = await SELF.fetch("https://example.com/api/v1/admin/hosts/h_00000000000000000000000000000000", { method: "DELETE", headers: { ...base, "Sec-Fetch-Site": "cross-site" } });
    expect(revoke.status).toBe(403);
    const text = await create({ "Content-Type": "text/plain" });
    expect(text.status).toBe(415);
    expect((await text.json() as { error: { code: string } }).error.code).toBe("unsupported_media_type");
    expect((await create({ "Content-Type": "application/json", Origin: "https://example.com", "Sec-Fetch-Site": "same-origin" })).status).toBe(201);
    expect((await create({ "Content-Type": "application/json" })).status).toBe(201);
  });

  it("provisions, rotates, and revokes a host", async () => {
    const headers = { ...gatewayHeaders(), "Content-Type": "application/json" };
    const created = await SELF.fetch("https://example.com/api/v1/admin/hosts", { method: "POST", headers, body: JSON.stringify({ name: "alpha" }) });
    expect(created.status).toBe(201);
    const host = await created.json() as { hostId: string; token: string; name: string };
    expect(host.hostId).toMatch(/^h_[0-9a-f]{32}$/u);
    expect(host.token).toMatch(/^nft_[A-Za-z0-9_-]{43}$/u);

    const list = await SELF.fetch("https://example.com/api/v1/admin/hosts", { headers: gatewayHeaders() });
    const listText = await list.text();
    expect((JSON.parse(listText) as { hosts: { hostId: string }[] }).hosts.some(entry => entry.hostId === host.hostId)).toBe(true);
    expect(listText.includes(host.token)).toBe(false);

    const rotated = await SELF.fetch(`https://example.com/api/v1/admin/hosts/${host.hostId}/rotate`, { method: "POST", headers: gatewayHeaders() });
    expect((await rotated.json() as { token: string }).token).not.toBe(host.token);
    const revoked = await SELF.fetch(`https://example.com/api/v1/admin/hosts/${host.hostId}`, { method: "DELETE", headers: gatewayHeaders() });
    expect(revoked.status).toBe(204);
    const purged = await SELF.fetch(`https://example.com/api/v1/admin/hosts/${host.hostId}/purge`, { method: "DELETE", headers: gatewayHeaders() });
    expect(purged.status).toBe(204);
    const after = await SELF.fetch("https://example.com/api/v1/admin/hosts", { headers: gatewayHeaders() });
    expect((await after.json() as { hosts: { hostId: string }[] }).hosts.some(entry => entry.hostId === host.hostId)).toBe(false);
    const missing = await SELF.fetch(`https://example.com/api/v1/admin/hosts/${host.hostId}/purge`, { method: "DELETE", headers: gatewayHeaders() });
    expect(missing.status).toBe(404);
  });
});
