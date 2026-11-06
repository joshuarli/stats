import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Installation } from "../src/cloudflare/installation";
import { canonicalJson } from "../src/protocol";
import { ACK_TYPE, INGEST_TYPE, INGEST_URL, fixtureBytes, fixtureText, frame, frameFor, post, readAck, source } from "./ingest-worker";
import type { SourceBatch } from "../src/ingest/encode.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const now = 1_793_510_415_000;
const BOOT = "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f";

interface BatchCase { readonly name: string; readonly frame: string; readonly source: string; readonly samples: readonly ("accept" | "invalid_sample")[] }
interface MalformedCase { readonly name: string; readonly code: string; readonly hex: string }

const manifest = JSON.parse(fixtureText("manifest.json")) as { batches: BatchCase[] };
const malformed = (JSON.parse(fixtureText("malformed.json")) as { cases: MalformedCase[] }).cases;

function stub() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

async function createHost(name = "test"): Promise<{ hostId: string; token: string }> {
  const result = await runInDurableObject(stub(), async (instance: Installation) => instance.createHost(name));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function withHost(bytes: Uint8Array<ArrayBuffer>, hostId: string): Uint8Array<ArrayBuffer> {
  const copy = bytes.slice();
  for (let index = 0; index < 16; index += 1) copy[6 + index] = Number.parseInt(hostId.slice(2 + index * 2, 4 + index * 2), 16);
  return copy;
}

function hex(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: text.length / 2 }, (_, index) => Number.parseInt(text.slice(index * 2, index * 2 + 2), 16));
}

async function storedPayloads(hostId: string): Promise<Record<string, string>> {
  const rows = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) =>
    state.storage.sql.exec<{ seq: string; payload: string }>("SELECT seq, payload FROM samples WHERE host_id = ? ORDER BY mono_ms", hostId).toArray()
  );
  return Object.fromEntries(rows.map(row => [row.seq, row.payload]));
}

async function sampleCount(): Promise<number> {
  return runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) => state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM samples").one().count);
}

function cpuSample(seq: number, monoMs: number, atMs: number): Record<string, unknown> {
  return { seq: String(seq), atMs: String(atMs), monoMs: String(monoMs), cpu: { user: String(seq), system: "1", idle: "1", iowait: "0", steal: "0", total: String(seq + 2) } };
}

function batchOf(hostId: string, samples: readonly Record<string, unknown>[], bootId = BOOT): Uint8Array<ArrayBuffer> {
  return frame({ hostId, bootId, samples });
}

describe("binary ingest corpus through the Worker and Durable Object", () => {
  it("stores every golden frame's accepted samples as their canonical source and rejects the rest per sample", async () => {
    for (const entry of manifest.batches) {
      const host = await createHost(entry.name);
      const expected = JSON.parse(fixtureText(entry.source)) as SourceBatch;
      const response = await post(host.token, withHost(fixtureBytes(entry.frame), host.hostId));
      const outcomes = expected.samples.map((sample, index) => {
        if (entry.samples[index] !== "accept") return "invalid_sample";
        const at = Number(sample.atMs);
        if (at > now + 300_000) return "invalid_sample";
        if (at < now - 48 * 60 * 60 * 1000) return "too_old";
        return "accept";
      });
      const stored = await storedPayloads(host.hostId);
      if (!outcomes.includes("accept")) {
        expect(response.status, entry.name).toBe(400);
        expect(Object.keys(stored), entry.name).toEqual([]);
        continue;
      }
      const ack = await readAck(response);
      expect(ack.accepted, entry.name).toBe(outcomes.filter(outcome => outcome === "accept").length);
      expect(ack.duplicates, entry.name).toBe(0);
      expect(ack.rejected, entry.name).toEqual(expected.samples.flatMap((sample, index) => (outcomes[index] === "accept" ? [] : [{ seq: String(sample.seq), code: outcomes[index] }])));
      for (const [index, sample] of expected.samples.entries()) {
        if (outcomes[index] === "accept") expect(stored[String(sample.seq)], `${entry.name}[${index}]`).toBe(canonicalJson(sample));
      }
    }
  });

  it("rejects every malformed frame whole through the public route and writes nothing", async () => {
    const before = await sampleCount();
    const host = await createHost("malformed");
    for (const entry of malformed) {
      const response = await post(host.token, hex(entry.hex));
      expect(response.status, entry.name).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code, entry.name).toBe(entry.code);
    }
    expect(await sampleCount()).toBe(before);
  });

  it("accepts the absolute-only encoding of a batch as the same content", async () => {
    const host = await createHost();
    expect((await readAck(await post(host.token, frameFor("linux-normal", host.hostId, { delta: false })))).accepted).toBe(2);
    expect(await readAck(await post(host.token, frameFor("linux-normal", host.hostId)))).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
  });
});

describe("ingest", () => {
  it("stores a batch exactly once and preserves it across an object abort", async () => {
    const host = await createHost();
    const body = frameFor("linux-normal", host.hostId);
    const first = await post(host.token, body);
    expect(first.headers.get("content-type")).toBe(ACK_TYPE);
    expect(await readAck(first)).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
    expect(await readAck(await post(host.token, body))).toEqual({ accepted: 0, duplicates: 2, rejected: [] });

    const latest = await runInDurableObject(stub(), async (instance: Installation) => instance.latest(host.hostId));
    expect(latest?.sample.seq).toBe("900015");

    let aborted = false;
    let abortError: unknown;
    try {
      await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) => state.abort());
    } catch (error) {
      aborted = true;
      abortError = error;
    }
    expect(aborted).toBe(true);
    expect(abortError).toBeInstanceOf(Error);
    const persisted = await runInDurableObject(stub(), async (instance: Installation) => instance.latest(host.hostId));
    expect(persisted?.sample.seq).toBe("900015");
  });

  it("treats a sample as a duplicate whatever its position, encoding, or dictionary indexes in a later request", async () => {
    const host = await createHost();
    expect((await readAck(await post(host.token, frameFor("linux-normal", host.hostId)))).accepted).toBe(2);
    expect(await readAck(await post(host.token, frameFor("rebatch-second-alone", host.hostId)))).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
    expect(await readAck(await post(host.token, frameFor("rebatch-second-after-other", host.hostId)))).toEqual({ accepted: 1, duplicates: 1, rejected: [] });
    expect(await readAck(await post(host.token, frameFor("rebatch-other-dictionary-order", host.hostId)))).toEqual({ accepted: 0, duplicates: 1, rejected: [{ seq: source("rebatch-other-dictionary-order").samples[0]!.seq as string, code: "conflict" }] });
  });

  it("stores the same rows whether a backlog arrives whole, split, or retried in overlapping pieces", async () => {
    const whole = await createHost("whole");
    const split = await createHost("split");
    const backlog = source("linux-backlog-16");
    expect((await readAck(await post(whole.token, frameFor("linux-backlog-16", whole.hostId)))).accepted).toBe(16);
    for (const [start, end] of [[0, 5], [5, 11], [11, 16]] as const) {
      expect((await readAck(await post(split.token, frame({ ...backlog, hostId: split.hostId, samples: backlog.samples.slice(start, end) })))).accepted).toBe(end - start);
    }
    expect(await readAck(await post(split.token, frame({ ...backlog, hostId: split.hostId, samples: backlog.samples.slice(3, 9) })))).toEqual({ accepted: 0, duplicates: 6, rejected: [] });
    const rows = async (hostId: string) => runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) =>
      state.storage.sql.exec<{ seq: string; elapsed_ms: number; delta: string; payload: string }>("SELECT seq, elapsed_ms, delta, payload FROM samples WHERE host_id = ? ORDER BY mono_ms", hostId).toArray()
    );
    expect(await rows(split.hostId)).toEqual(await rows(whole.hostId));
  });

  it("reconstructs a delta whose wire predecessor is rejected, and still rejects that predecessor", async () => {
    const host = await createHost();
    const batch = source("partial-acceptance");
    const ack = await readAck(await post(host.token, frameFor("partial-acceptance", host.hostId)));
    expect(ack).toEqual({ accepted: 2, duplicates: 0, rejected: [{ seq: "1", code: "invalid_sample" }, { seq: "9007199254740992", code: "invalid_sample" }] });
    const stored = await storedPayloads(host.hostId);
    expect(stored["2"]).toBe(canonicalJson(batch.samples[1]));
    expect(stored["4"]).toBe(canonicalJson(batch.samples[3]));
  });

  it("accepts out-of-order delivery and repairs the following interval", async () => {
    const host = await createHost();
    expect((await post(host.token, frameFor("linux-normal", host.hostId))).status).toBe(200);
    expect((await post(host.token, frameFor("out-of-order-late", host.hostId))).status).toBe(200);
    const rows = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) =>
      state.storage.sql.exec<{ seq: string; elapsed_ms: number }>("SELECT seq, elapsed_ms FROM samples WHERE host_id = ? ORDER BY mono_ms", host.hostId).toArray()
    );
    expect(rows.map(row => [row.seq, row.elapsed_ms])).toEqual([["900000", 0], ["900007", 7500], ["900015", 7500]]);
  });

  it("keeps reboots distinct and turns a counter regression into a gap", async () => {
    const host = await createHost();
    expect((await post(host.token, frameFor("reboot-before", host.hostId))).status).toBe(200);
    expect((await post(host.token, frameFor("reboot-after", host.hostId))).status).toBe(200);
    const other = await createHost("reset");
    expect((await post(other.token, frameFor("counter-reset", other.hostId))).status).toBe(200);
    const boots = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) =>
      state.storage.sql.exec<{ boot_id: string }>("SELECT DISTINCT boot_id FROM samples WHERE host_id = ?", host.hostId).toArray().map(row => row.boot_id)
    );
    expect(boots.sort()).toEqual([BOOT, source("reboot-after").bootId].sort());
    const deltas = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) =>
      state.storage.sql.exec<{ delta: string }>("SELECT delta FROM samples WHERE host_id = ? ORDER BY mono_ms", other.hostId).toArray().map(row => JSON.parse(row.delta) as { cpu?: unknown; intervalMs: number })
    );
    expect(deltas[1]?.intervalMs).toBe(15_000);
    expect(deltas[1]?.cpu).toBeUndefined();
  });

  it("stores the announced system details in their canonical form", async () => {
    const host = await createHost();
    expect((await post(host.token, frameFor("system", host.hostId))).status).toBe(200);
    const system = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) => state.storage.sql.exec<{ payload: string }>("SELECT payload FROM host_system WHERE host_id = ?", host.hostId).one().payload);
    expect(system).toBe(canonicalJson(source("system").system));
  });

  it("rejects a conflicting replay", async () => {
    const host = await createHost();
    expect((await post(host.token, frameFor("linux-normal", host.hostId))).status).toBe(200);
    const response = await post(host.token, frameFor("conflict", host.hostId));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "conflict", message: "no samples were accepted" }, rejected: [{ seq: "900015", code: "conflict" }] });
  });

  it("caps the body at the reading boundary, with or without a declared length", async () => {
    const host = await createHost();
    const oversized = new Uint8Array(65_537);
    expect((await post(host.token, oversized)).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 17; index += 1) controller.enqueue(new Uint8Array(4096));
        controller.close();
      }
    });
    const streamed = await SELF.fetch(INGEST_URL, { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": INGEST_TYPE }, body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect((await streamed.json() as { error: { code: string } }).error.code).toBe("too_large");
    expect(await storedPayloads(host.hostId)).toEqual({});
  });

  it("refuses JSON, other media types, and content encodings instead of guessing", async () => {
    const host = await createHost();
    const legacy = fixtureText("sources/linux-normal.json");
    const old = await SELF.fetch("https://example.com/ingest/v1/batches", { method: "POST", headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" }, body: legacy });
    expect(old.status).toBe(410);
    expect((await old.json() as { error: { code: string } }).error.code).toBe("gone");
    expect((await SELF.fetch("https://example.com/ingest/v1/batches")).status).toBe(410);
    expect((await post(host.token, legacy, { "Content-Type": "application/json" })).status).toBe(415);
    expect((await post(host.token, frameFor("minimal", host.hostId), { "Content-Type": "application/octet-stream" })).status).toBe(415);
    expect((await post(host.token, frameFor("minimal", host.hostId), { "Content-Encoding": "gzip" })).status).toBe(415);
    const jsonAsFrame = await post(host.token, legacy);
    expect(jsonAsFrame.status).toBe(400);
    expect((await jsonAsFrame.json() as { error: { code: string } }).error.code).toBe("invalid_frame");
    expect((await post(host.token, frameFor("minimal", host.hostId), { "Content-Type": `${INGEST_TYPE}; charset=binary` })).status).toBe(200);
    expect((await post(host.token, frameFor("macos-single", host.hostId), { "Content-Encoding": "identity" })).status).toBe(200);
    expect((await SELF.fetch(INGEST_URL)).status).toBe(405);
    expect(await storedPayloads(host.hostId)).not.toEqual({});
  });

  it("rejects missing, wrong, revoked, and cross-host credentials", async () => {
    const host = await createHost();
    const other = await createHost("other");
    const body = frameFor("minimal", host.hostId);
    expect((await post(null, body)).status).toBe(401);
    expect((await post("nft_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", body)).status).toBe(401);
    expect((await post(other.token, body)).status).toBe(401);
    await runInDurableObject(stub(), async (instance: Installation) => instance.revokeHost(host.hostId));
    expect((await post(host.token, body)).status).toBe(401);
  });

  it("rejects a missing or malformed bearer token before reading the body", async () => {
    expect((await post(null, "notbinary")).status).toBe(401);
    expect((await post(null, "notbinary", { Authorization: "Basic abc" })).status).toBe(401);
  });

  it("rolls back samples when the rollup rebuild fails", async () => {
    const object = env.INSTALLATION.get(env.INSTALLATION.idFromName("rollup-transaction"));
    await runInDurableObject(object, async (instance: Installation, state: DurableObjectState) => {
      const host = await instance.createHost("rollback");
      if (!host.ok) throw new Error(host.message);
      (instance as unknown as { core: { rebuildRollups: () => void } }).core.rebuildRollups = () => { throw new Error("rollup failed"); };
      const response = await instance.fetch(new Request("https://installation/ingest", { method: "POST", headers: { Authorization: `Bearer ${host.value.token}`, "Content-Type": INGEST_TYPE }, body: frameFor("linux-normal", host.value.hostId) }));
      expect(response.status).toBe(500);
      expect(state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM samples").one().count).toBe(0);
    });
  });

  it("purges a host with its samples and rollups", async () => {
    const host = await createHost();
    const body = frameFor("linux-normal", host.hostId);
    expect((await post(host.token, body)).status).toBe(200);
    expect(await runInDurableObject(stub(), async (instance: Installation) => instance.purgeHost(host.hostId))).toEqual({ ok: true, value: null });
    const counts = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) =>
      state.storage.sql.exec<{ hosts: number; samples: number; rollups: number }>("SELECT (SELECT count(*) FROM hosts WHERE host_id = ?) AS hosts, (SELECT count(*) FROM samples WHERE host_id = ?) AS samples, (SELECT count(*) FROM rollups WHERE host_id = ?) AS rollups", host.hostId, host.hostId, host.hostId).one()
    );
    expect(counts).toEqual({ hosts: 0, samples: 0, rollups: 0 });
    expect((await post(host.token, body)).status).toBe(401);
  });

  it("rate limits a host after six requests in a window", async () => {
    const host = await createHost();
    const body = batchOf(host.hostId, [cpuSample(1, 1000, now)]);
    for (let index = 0; index < 6; index += 1) expect((await post(host.token, body)).status).toBe(200);
    const limited = await post(host.token, body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("logs an ingest rejection with a fixed shape", async () => {
    const host = await createHost();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post(host.token, batchOf(host.hostId, [cpuSample(1, 1000, now + 600_000)]));
    expect(response.status).toBe(400);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "ingest_rejected", hostId: host.hostId, code: "invalid_sample" }));
  });

  it("logs the Worker gate and the 500 catch-all without exception text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post(null, "notbinary")).status).toBe(401);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "ingest_rejected", code: "unauthorized" }));

    const object = env.INSTALLATION.get(env.INSTALLATION.idFromName("log-500"));
    await runInDurableObject(object, async (instance: Installation) => {
      (instance as unknown as { core: { createHost: () => never } }).core.createHost = () => { throw new Error("secret detail"); };
      const response = await instance.fetch(new Request("https://installation/admin/hosts", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"name":"x"}' }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "internal", message: "internal error" } });
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "request_failed", code: "internal" }));
    });
  });

  it("rejects future and too-old observations", async () => {
    const host = await createHost();
    const future = await post(host.token, batchOf(host.hostId, [cpuSample(1, 1000, now + 600_000)]));
    expect(future.status).toBe(400);
    expect((await future.json() as { error: { code: string } }).error.code).toBe("invalid_sample");
    const old = await post(host.token, batchOf(host.hostId, [cpuSample(2, 2000, now - 49 * 60 * 60 * 1000)]));
    expect(old.status).toBe(400);
    expect((await old.json() as { error: { code: string } }).error.code).toBe("too_old");
  });
});
