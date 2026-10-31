import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Installation } from "../src/installation";
import { parseBatch } from "../src/protocol";

const files: Record<string, string> = JSON.parse(env.FIXTURES ?? "{}");
const manifest = JSON.parse(files["manifest.json"] ?? "{}") as { fixtures: { file: string; expect: "accept" | "reject"; code?: string }[] };
const now = 1_793_510_400_000;

function fixture(name: string): string {
  return files[name]!;
}

function stub() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

async function createHost(name = "test"): Promise<{ hostId: string; token: string }> {
  return runInDurableObject(stub(), async (instance: Installation) => instance.createHost(name));
}

function rewrite(name: string, hostId: string): Record<string, unknown> {
  return { ...JSON.parse(fixture(name)), hostId };
}

async function ingest(token: string, body: unknown): Promise<Response> {
  return SELF.fetch("https://example.com/ingest/v1/batches", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function sample(seq: number, monoMs: number, atMs: number): Record<string, unknown> {
  return {
    seq: String(seq),
    atMs: String(atMs),
    monoMs: String(monoMs),
    cpu: { user: String(seq), system: "1", idle: "1", iowait: "0", steal: "0", total: String(seq + 2) }
  };
}

describe("wire fixtures", () => {
  it("accepts and rejects the corpus exactly as manifested", () => {
    for (const entry of manifest.fixtures) {
      const parsed = parseBatch(fixture(entry.file));
      if (entry.expect === "accept") {
        expect(parsed.ok, entry.file).toBe(true);
        if (parsed.ok) expect(parsed.samples.every(result => result.ok), entry.file).toBe(true);
      } else if (parsed.ok) {
        expect(parsed.samples.some(result => !result.ok), entry.file).toBe(true);
      } else {
        expect(parsed.code, entry.file).toBe(entry.code);
      }
    }
  });
});

describe("ingest", () => {
  it("stores a batch exactly once and preserves it across an object abort", async () => {
    const host = await createHost();
    const body = rewrite("batch-full.json", host.hostId);
    const first = await ingest(host.token, body);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ v: 1, accepted: 2, duplicates: 0, rejected: [] });
    const replay = await ingest(host.token, body);
    expect(await replay.json()).toEqual({ v: 1, accepted: 0, duplicates: 2, rejected: [] });

    const latest = await runInDurableObject(stub(), async (instance: Installation) => instance.latest(host.hostId));
    expect(latest?.sample.seq).toBe("900015");

    try {
      await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) => state.abort());
    } catch {
      // the object reset is the point of this check
    }
    const persisted = await runInDurableObject(stub(), async (instance: Installation) => instance.latest(host.hostId));
    expect(persisted?.sample.seq).toBe("900015");
  });

  it("accepts out-of-order delivery and repairs the following interval", async () => {
    const host = await createHost();
    expect((await ingest(host.token, rewrite("batch-full.json", host.hostId))).status).toBe(200);
    const late = await ingest(host.token, rewrite("out-of-order-late.json", host.hostId));
    expect(late.status).toBe(200);
    const rows = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) =>
      state.storage.sql.exec<{ seq: string; elapsed_ms: number }>("SELECT seq, elapsed_ms FROM samples WHERE host_id = ? ORDER BY mono_ms", host.hostId).toArray()
    );
    expect(rows.map(row => [row.seq, row.elapsed_ms])).toEqual([["900000", 0], ["900007", 7500], ["900015", 7500]]);
  });

  it("keeps reboots and counter resets distinct", async () => {
    const host = await createHost();
    expect((await ingest(host.token, rewrite("reboot-before.json", host.hostId))).status).toBe(200);
    expect((await ingest(host.token, rewrite("reboot-after.json", host.hostId))).status).toBe(200);
    expect((await ingest(host.token, rewrite("counter-reset.json", host.hostId))).status).toBe(200);
    const boots = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) =>
      state.storage.sql.exec<{ boot_id: string }>("SELECT DISTINCT boot_id FROM samples WHERE host_id = ?", host.hostId).toArray().map(row => row.boot_id)
    );
    expect(boots.length).toBe(2);
  });

  it("rejects a conflicting replay and an oversized body", async () => {
    const host = await createHost();
    expect((await ingest(host.token, rewrite("batch-full.json", host.hostId))).status).toBe(200);
    const conflict = rewrite("batch-full.json", host.hostId);
    (conflict.samples as { cpu: { user: string } }[])[0]!.cpu.user = "7";
    const response = await ingest(host.token, conflict);
    expect(response.status).toBe(200);
    expect((await response.json() as { rejected: { code: string }[] }).rejected[0]?.code).toBe("conflict");

    const oversized = await SELF.fetch("https://example.com/ingest/v1/batches", {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" },
      body: "x".repeat(65_537)
    });
    expect(oversized.status).toBe(413);
  });

  it("rejects missing, wrong, revoked, and cross-host credentials", async () => {
    const host = await createHost();
    const other = await createHost("other");
    const body = rewrite("batch-minimal.json", host.hostId);

    expect((await SELF.fetch("https://example.com/ingest/v1/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
    expect((await ingest("nft_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", body)).status).toBe(401);
    expect((await ingest(other.token, body)).status).toBe(401);

    await runInDurableObject(stub(), async (instance: Installation) => instance.revokeHost(host.hostId));
    expect((await ingest(host.token, body)).status).toBe(401);
  });

  it("rate limits a host after six requests in a window", async () => {
    const host = await createHost();
    const body = { v: 1, hostId: host.hostId, bootId: "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f", samples: [sample(1, 1000, now)] };
    for (let index = 0; index < 6; index += 1) {
      expect((await ingest(host.token, body)).status).toBe(200);
    }
    const limited = await ingest(host.token, body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("rejects future and too-old observations", async () => {
    const host = await createHost();
    const bootId = "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f";
    const future = await ingest(host.token, { v: 1, hostId: host.hostId, bootId, samples: [sample(1, 1000, now + 600_000)] });
    expect(future.status).toBe(400);
    expect((await future.json() as { error: { code: string } }).error.code).toBe("invalid_sample");
    const old = await ingest(host.token, { v: 1, hostId: host.hostId, bootId, samples: [sample(2, 2000, now - 49 * 60 * 60 * 1000)] });
    expect(old.status).toBe(400);
    expect((await old.json() as { error: { code: string } }).error.code).toBe("too_old");
  });
});
