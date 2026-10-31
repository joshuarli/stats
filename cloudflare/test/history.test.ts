import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Installation } from "../src/installation";
import { privateJwk } from "./access-key";
import { downsample } from "../src/aggregate";

const encoder = new TextEncoder();
const now = 1_793_510_415_000;
const files: Record<string, string> = JSON.parse(env.FIXTURES ?? "{}");

function b64url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function accessToken(): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: "test-key", typ: "JWT" };
  const claims = { iss: "https://test.cloudflareaccess.com", aud: "test-aud", exp: seconds + 3600, nbf: seconds - 10, iat: seconds - 10 };
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`));
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}.${b64url(new Uint8Array(signature))}`;
}

function stub() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

async function createHost(): Promise<{ hostId: string; token: string }> {
  return runInDurableObject(stub(), async (instance: Installation) => instance.createHost("history"));
}

async function ingest(token: string, name: string, hostId: string): Promise<Response> {
  const body = { ...JSON.parse(files[name]!), hostId };
  return SELF.fetch("https://example.com/ingest/v1/batches", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function history(hostId: string, range: string, kind: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/v1/hosts/${hostId}/history?range=${range}&kind=${kind}`, { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
}

describe("history", () => {
  it("returns bounded raw and rolled history", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "batch-full.json", host.hostId)).status).toBe(200);
    const summary = await history(host.hostId, "1h", "summary");
    expect(summary.status).toBe(200);
    const body = await summary.json() as { resolution: string; points: { atMs: number; coverageMs: number; cpu?: { user: number } }[] };
    expect(body.resolution).toBe("raw");
    expect(body.points.length).toBe(2);
    expect(body.points[0]!.coverageMs).toBe(0);
    expect(body.points[1]!.coverageMs).toBe(15_000);
    expect(body.points[1]!.cpu?.user).toBeGreaterThan(0);

    for (const range of ["1h", "6h", "24h", "7d", "90d"]) {
      expect((await history(host.hostId, range, "summary")).status, range).toBe(200);
    }
    for (const kind of ["disks", "nets", "filesystems"]) {
      const response = await history(host.hostId, "1h", kind);
      expect(response.status, kind).toBe(200);
      const value = await response.json() as { series: { id: string; points: unknown[] }[] };
      expect(value.series.length, kind).toBeGreaterThan(0);
      expect(value.series.every(series => series.points.length <= 900), kind).toBe(true);
    }

    const week = await history(host.hostId, "7d", "summary");
    const weekBody = await week.json() as { resolution: string; stepMs: number; points: { coverageMs: number; partial: boolean }[] };
    expect(weekBody.resolution).toBe("1m");
    expect(weekBody.stepMs).toBe(60_000);
    expect(weekBody.points.length).toBe(1);
    expect(weekBody.points[0]!.coverageMs).toBe(15_000);
    expect(weekBody.points[0]!.partial).toBe(true);

    const quarter = await history(host.hostId, "90d", "summary");
    const quarterBody = await quarter.json() as { resolution: string; stepMs: number };
    expect(quarterBody.resolution).toBe("1h");
    expect(quarterBody.stepMs).toBe(3_600_000);
    expect((await history(host.hostId, "2h", "summary")).status).toBe(400);
    expect((await history(host.hostId, "1h", "memory")).status).toBe(400);
    const sampled = downsample(Array.from({ length: 1200 }, (_, index) => index)).items;
    expect(sampled.length).toBeGreaterThan(0);
    expect(sampled.length).toBeLessThanOrEqual(900);
  });

  it("repairs a late sample in the rolled bucket", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "batch-full.json", host.hostId)).status).toBe(200);
    expect((await ingest(host.token, "out-of-order-late.json", host.hostId)).status).toBe(200);
    const response = await history(host.hostId, "7d", "summary");
    const body = await response.json() as { points: { coverageMs: number }[] };
    expect(body.points[0]!.coverageMs).toBe(15_000);
  });

  it("expires raw and rolled rows on the alarm", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "batch-full.json", host.hostId)).status).toBe(200);
    await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO samples (host_id, boot_id, seq, at_ms, received_at_ms, mono_ms, elapsed_ms, delta, payload) VALUES (?, ?, 'old', ?, ?, 1, 0, '{}', '{}')", host.hostId, "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f", now - 49 * 60 * 60 * 1000, now - 49 * 60 * 60 * 1000);
      state.storage.sql.exec("INSERT INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES (?, '1m', ?, 0, 1, '{}')", host.hostId, now - 8 * 24 * 60 * 60 * 1000);
      state.storage.sql.exec("INSERT INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES (?, '1h', ?, 0, 1, '{}')", host.hostId, now - 91 * 24 * 60 * 60 * 1000);
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const counts = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) => state.storage.sql.exec<{ samples: number; minute: number; hour: number }>("SELECT (SELECT count(*) FROM samples WHERE host_id = ? AND seq = 'old') AS samples, (SELECT count(*) FROM rollups WHERE host_id = ? AND resolution = '1m' AND bucket_ms < ?) AS minute, (SELECT count(*) FROM rollups WHERE host_id = ? AND resolution = '1h' AND bucket_ms < ?) AS hour", host.hostId, host.hostId, now - 7 * 24 * 60 * 60 * 1000, host.hostId, now - 90 * 24 * 60 * 60 * 1000).one());
    expect(counts).toEqual({ samples: 0, minute: 0, hour: 0 });
  });
});
