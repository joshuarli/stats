import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyAccess } from "../src/access";
import { privateJwk } from "./access-key";

const encoder = new TextEncoder();
const team = "test.cloudflareaccess.com";
const audience = "test-aud";

function b64url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function accessToken(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const headerValue = { alg: "RS256", kid: "test-key", typ: "JWT", ...header };
  const claims = { iss: `https://${team}`, aud: audience, exp: now + 3600, nbf: now - 10, iat: now - 10, ...overrides };
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${b64url(JSON.stringify(headerValue))}.${b64url(JSON.stringify(claims))}`));
  return `${b64url(JSON.stringify(headerValue))}.${b64url(JSON.stringify(claims))}.${b64url(new Uint8Array(signature))}`;
}

function api(token?: string): Promise<Response> {
  return SELF.fetch("https://example.com/api/v1/hosts", { headers: token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token } });
}

function decodePart(value: string): Uint8Array {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function tamperedSignature(token: string): string {
  const parts = token.split(".");
  const signature = parts[2]!;
  const index = Math.floor(signature.length / 2);
  parts[2] = `${signature.slice(0, index)}${signature[index] === "A" ? "B" : "A"}${signature.slice(index + 1)}`;
  return parts.join(".");
}

function tamperedPayload(token: string): string {
  const parts = token.split(".");
  const claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1]!))) as Record<string, unknown>;
  claims.aud = "other";
  parts[1] = b64url(JSON.stringify(claims));
  return parts.join(".");
}

describe("Access authorization", () => {
  it("accepts a signed assertion and rejects every invalid shape", async () => {
    expect((await api()).status).toBe(401);
    expect((await api(await accessToken({ aud: "other" }))).status).toBe(401);
    expect((await api(await accessToken({ iss: "https://other.cloudflareaccess.com" }))).status).toBe(401);
    expect((await api(await accessToken({ exp: Math.floor(Date.now() / 1000) - 120 }))).status).toBe(401);
    expect((await api(await accessToken({}, { kid: "unknown" }))).status).toBe(401);
    expect((await api(await accessToken({}, { alg: "HS256" }))).status).toBe(401);
    expect((await api(`${await accessToken()}.x`)).status).toBe(401);
    const valid = await accessToken();
    const response = await api(valid);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects a signature or payload altered after signing", async () => {
    const valid = await accessToken();
    expect((await api(tamperedSignature(valid))).status).toBe(401);
    expect((await api(tamperedPayload(valid))).status).toBe(401);
  });

  it("rejects a not-yet-valid assertion and accepts an audience array", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await api(await accessToken({ nbf: now + 3_600 }))).status).toBe(401);
    expect((await api(await accessToken({ aud: [audience, "another-aud"] }))).status).toBe(200);
  });

  it("returns 503 when no JWKS is available", async () => {
    const request = new Request("https://example.com/api/v1/hosts", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
    const result = await verifyAccess(request, { ENVIRONMENT: "test" } as unknown as Env);
    expect(result).toEqual({ ok: false, status: 503, message: "Access verification is unavailable" });
  });

  it("protects static assets behind Access", async () => {
    expect((await SELF.fetch("https://example.com/")).status).toBe(401);
    const response = await SELF.fetch("https://example.com/", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Stats</title>");
  });

  it("serves llms.txt only behind Access", async () => {
    expect((await SELF.fetch("https://example.com/llms.txt")).status).toBe(401);
    const response = await SELF.fetch("https://example.com/llms.txt", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/api/v1/projects/:id/history");
  });

  it("rejects malformed admin calls without the raw exception", async () => {
    const token = await accessToken();
    const headers = { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" };
    const invalidName = await SELF.fetch("https://example.com/api/v1/admin/hosts", { method: "POST", headers, body: JSON.stringify({ name: "\u0000" }) });
    expect(invalidName.status).toBe(400);
    expect((await invalidName.json() as { error: { code: string } }).error.code).toBe("invalid_request");

    const invalidJson = await SELF.fetch("https://example.com/api/v1/admin/hosts", { method: "POST", headers, body: "notjson" });
    expect(invalidJson.status).toBe(400);
    expect((await invalidJson.json() as { error: { code: string } }).error.code).toBe("invalid_request");

    const nullBody = await SELF.fetch("https://example.com/api/v1/admin/hosts", { method: "POST", headers, body: "null" });
    expect(nullBody.status).toBe(400);

    const missing = await SELF.fetch("https://example.com/api/v1/admin/hosts/h_00000000000000000000000000000000/rotate", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("provisions, rotates, and revokes a host", async () => {
    const token = await accessToken();
    const headers = { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" };
    const created = await SELF.fetch("https://example.com/api/v1/admin/hosts", { method: "POST", headers, body: JSON.stringify({ name: "alpha" }) });
    expect(created.status).toBe(201);
    const host = await created.json() as { hostId: string; token: string; name: string };
    expect(host.hostId).toMatch(/^h_[0-9a-f]{32}$/u);
    expect(host.token).toMatch(/^nft_[A-Za-z0-9_-]{43}$/u);

    const list = await SELF.fetch("https://example.com/api/v1/admin/hosts", { headers: { "Cf-Access-Jwt-Assertion": token } });
    const listText = await list.text();
    expect((JSON.parse(listText) as { hosts: { hostId: string }[] }).hosts.some(entry => entry.hostId === host.hostId)).toBe(true);
    expect(listText.includes(host.token)).toBe(false);

    const rotated = await SELF.fetch(`https://example.com/api/v1/admin/hosts/${host.hostId}/rotate`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token } });
    expect((await rotated.json() as { token: string }).token).not.toBe(host.token);
    const revoked = await SELF.fetch(`https://example.com/api/v1/admin/hosts/${host.hostId}`, { method: "DELETE", headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(revoked.status).toBe(204);
    const purged = await SELF.fetch(`https://example.com/api/v1/admin/hosts/${host.hostId}/purge`, { method: "DELETE", headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(purged.status).toBe(204);
    const after = await SELF.fetch("https://example.com/api/v1/admin/hosts", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect((await after.json() as { hosts: { hostId: string }[] }).hosts.some(entry => entry.hostId === host.hostId)).toBe(false);
    const missing = await SELF.fetch(`https://example.com/api/v1/admin/hosts/${host.hostId}/purge`, { method: "DELETE", headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(missing.status).toBe(404);
  });
});
