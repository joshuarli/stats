import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Installation } from "../src/installation";
import { retentionDelayMs } from "../src/core/installation/schema";
import { historyQuery } from "../src/aggregate";
import { HISTORY_CONTENT_TYPE } from "../src/binary/history";
import { accessToken } from "./access-token";
import { readFrame as frame } from "./support/history";
import { fixtureText, frame as encode, frameFor, post, source } from "./ingest-worker";
import type { SourceBatch } from "../src/ingest/encode.ts";

const now = 1_793_510_415_000;

function stub() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

async function createHost(): Promise<{ hostId: string; token: string }> {
  const result = await runInDurableObject(stub(), async (instance: Installation) => instance.createHost("history"));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

async function ingest(token: string, name: string, hostId: string): Promise<Response> {
  return post(token, frameFor(name, hostId));
}

async function history(hostId: string, range: string, kind: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/v1/hosts/${hostId}/history?range=${range}&kind=${kind}`, { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
}

async function historySearch(hostId: string, search: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://example.com/api/v1/hosts/${hostId}/history?${search}`, { headers: { "Cf-Access-Jwt-Assertion": await accessToken(), ...headers } });
}

describe("history query", () => {
  const parse = (search: string) => historyQuery(new URLSearchParams(search));

  it("accepts a preset range, a from/to window, or nothing", () => {
    expect(parse("")).toEqual({ range: "1h" });
    expect(parse("range=7d")).toEqual({ range: "7d" });
    expect(parse("from=1000&to=2000")).toEqual({ fromMs: 1_000, toMs: 2_000 });
  });

  it("rejects ambiguous, partial, or unbounded windows", () => {
    for (const search of ["from=1000", "to=2000", "range=1h&from=1000&to=2000", "from=2000&to=1000", "from=1000&to=1000", "from=abc&to=2000", "from=1.5&to=2000", "from=-1&to=2000", `from=0&to=${30 * 24 * 60 * 60 * 1000 + 1}`, "range=2h"]) {
      expect(parse(search), search).toBeNull();
    }
    expect(parse(`from=0&to=${30 * 24 * 60 * 60 * 1000}`)).not.toBeNull();
  });
});

describe("history", () => {
  it("serves an explicit window at the finest tier that still holds it", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "linux-normal", host.hostId)).status).toBe(200);
    const preset = await frame(await history(host.hostId, "1h", "summary")) as { points: { atMs: number }[] };
    const [first, second] = preset.points;
    expect(preset.points.length).toBe(2);

    const around = await historySearch(host.hostId, `from=${first!.atMs - 1_000}&to=${second!.atMs + 1_000}&kind=summary`);
    expect(around.status).toBe(200);
    const body = await frame(around) as { range?: string; fromMs: number; toMs: number; resolution: string; points: { atMs: number }[] };
    expect(body.range).toBeUndefined();
    expect(body.fromMs).toBe(first!.atMs - 1_000);
    expect(body.toMs).toBe(second!.atMs + 1_000);
    expect(body.resolution).toBe("raw");
    expect(body.points.map(point => point.atMs)).toEqual([first!.atMs, second!.atMs]);

    const narrow = await frame(await historySearch(host.hostId, `from=${first!.atMs - 1_000}&to=${first!.atMs + 1_000}&kind=summary`)) as { points: unknown[] };
    expect(narrow.points.length).toBe(1);
    const after = await frame(await historySearch(host.hostId, `from=${second!.atMs + 1}&to=${second!.atMs + 60_000}&kind=summary`)) as { points: unknown[] };
    expect(after.points.length).toBe(0);

    const day = 24 * 60 * 60 * 1000;
    const tiers = new Map([[`from=${now - 3 * day}&to=${now - 2 * day}`, "1m"], [`from=${now - 30 * day}&to=${now - 29 * day}`, "1h"], [`from=${now - 600_000}&to=${now}`, "raw"]]);
    for (const [search, resolution] of tiers) {
      const response = await historySearch(host.hostId, `${search}&kind=summary`);
      expect(response.status, search).toBe(200);
      expect((await frame(response) as { resolution: string }).resolution, search).toBe(resolution);
    }

    expect((await historySearch(host.hostId, "from=1000&kind=summary")).status).toBe(400);
    expect((await historySearch(host.hostId, `range=1h&from=${now - 1_000}&to=${now}&kind=summary`)).status).toBe(400);
  });

  it("returns bounded raw and rolled history", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "linux-normal", host.hostId)).status).toBe(200);
    const summary = await history(host.hostId, "1h", "summary");
    expect(summary.status).toBe(200);
    const body = await frame(summary) as { resolution: string; points: { atMs: number; coverageMs: number; cpu?: { user: number } }[] };
    expect(body.resolution).toBe("raw");
    expect(body.points.length).toBe(2);
    expect(body.points[0]!.coverageMs).toBe(0);
    expect(body.points[1]!.coverageMs).toBe(15_000);
    expect(body.points[1]!.cpu?.user).toBe(9.609);

    for (const range of ["1h", "6h", "24h", "7d", "30d"]) {
      expect((await history(host.hostId, range, "summary")).status, range).toBe(200);
    }
    const seriesIds: Record<string, string[]> = { disks: ["259:0", "8:0"], nets: ["eth0", "tailscale0"], filesystems: ["/", "/var"] };
    for (const kind of Object.keys(seriesIds)) {
      const response = await history(host.hostId, "1h", kind);
      expect(response.status, kind).toBe(200);
      const value = await frame(response) as { series: { id: string; points: unknown[] }[] };
      expect(value.series.map(series => series.id), kind).toEqual(seriesIds[kind]);
      expect(value.series.every(series => series.points.length <= 900), kind).toBe(true);
    }

    const week = await history(host.hostId, "7d", "summary");
    const weekBody = await frame(week) as { resolution: string; stepMs: number; points: { coverageMs: number; partial: boolean }[] };
    expect(weekBody.resolution).toBe("1m");
    expect(weekBody.stepMs).toBe(60_000);
    expect(weekBody.points.length).toBe(1);
    expect(weekBody.points[0]!.coverageMs).toBe(15_000);
    expect(weekBody.points[0]!.partial).toBe(true);

    const sixHours = await history(host.hostId, "6h", "summary");
    expect((await frame(sixHours) as { resolution: string }).resolution).toBe("raw");
    const day = await history(host.hostId, "24h", "summary");
    const dayBody = await frame(day) as { resolution: string; stepMs: number };
    expect(dayBody.resolution).toBe("1m");
    expect(dayBody.stepMs).toBe(60_000);

    const month = await history(host.hostId, "30d", "summary");
    const monthBody = await frame(month) as { resolution: string; stepMs: number };
    expect(monthBody.resolution).toBe("1h");
    expect(monthBody.stepMs).toBe(3_600_000);

    const block = await history(host.hostId, "1h", "block");
    const blockBody = await frame(block) as { resolution: string; series: { points: { count: number; p50Us: number; p95Us: number; p99Us: number; maxUs: number }[] }[] };
    expect(blockBody.resolution).toBe("raw");
    expect(blockBody.series[0]!.points[0]!.count).toBe(110);
    expect(blockBody.series[0]!.points[0]!.p50Us).toBeGreaterThan(0);
    expect(blockBody.series[0]!.points[0]!.p95Us).toBeGreaterThanOrEqual(blockBody.series[0]!.points[0]!.p50Us);
    expect(blockBody.series[0]!.points[0]!.p99Us).toBeGreaterThanOrEqual(blockBody.series[0]!.points[0]!.p95Us);
    expect(blockBody.series[0]!.points[0]!.maxUs).toBe(45_000);

    const blockWeek = await history(host.hostId, "7d", "block");
    const blockWeekBody = await frame(blockWeek) as { resolution: string; series: { points: { count: number }[] }[] };
    expect(blockWeekBody.resolution).toBe("1m");
    expect(blockWeekBody.series[0]!.points[0]!.count).toBe(110);
    expect((await history(host.hostId, "2h", "summary")).status).toBe(400);
    expect((await history(host.hostId, "1h", "memory")).status).toBe(400);
  });

  it("returns several history kinds in one response", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "linux-normal", host.hostId)).status).toBe(200);
    const response = await historySearch(host.hostId, "range=1h&kinds=summary,disks,nets,filesystems,block");
    expect(response.status).toBe(200);
    const body = await frame(response) as { hostId: string; histories: Record<string, { kind: string; points?: unknown[]; series?: { points: unknown[] }[] }> };
    expect(body.hostId).toBe(host.hostId);
    expect(Object.keys(body.histories)).toEqual(["summary", "disks", "nets", "filesystems", "block"]);
    for (const [kind, history] of Object.entries(body.histories)) expect(history.kind, kind).toBe(kind);
    expect(body.histories.summary!.points).toHaveLength(2);
    for (const kind of ["disks", "nets", "filesystems", "block"]) {
      const series = body.histories[kind]!.series;
      expect(series, kind).not.toHaveLength(0);
      expect(series!.every(entry => entry.points.length > 0), kind).toBe(true);
    }

    for (const search of ["kinds=summary,memory", "kind=summary&kinds=summary", "kinds="]) {
      expect((await historySearch(host.hostId, search)).status, search).toBe(400);
    }
    expect((await historySearch("h_0123456789abcdef0123456789abcdef", "range=1h&kinds=summary")).status).toBe(404);
  });

  it("answers with 304 until ingest changes the history version", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "linux-normal", host.hostId)).status).toBe(200);
    const first = await historySearch(host.hostId, "range=1h&kinds=summary,disks");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const unchanged = await historySearch(host.hostId, "range=1h&kinds=summary,disks", { "If-None-Match": etag! });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");

    const weakened = await historySearch(host.hostId, "range=1h&kinds=summary,disks", { "If-None-Match": `W/${etag!}` });
    expect(weakened.status).toBe(304);

    const otherWindow = await historySearch(host.hostId, "range=6h&kinds=summary,disks", { "If-None-Match": etag! });
    expect(otherWindow.status).toBe(200);

    expect((await ingest(host.token, "reboot-after", host.hostId)).status).toBe(200);
    const changed = await historySearch(host.hostId, "range=1h&kinds=summary,disks", { "If-None-Match": etag! });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });

  it("sends history as a frame, compressed to what the client accepts, with every security header", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "linux-normal", host.hostId)).status).toBe(200);
    const accepted: [string | null, string | null][] = [
      [null, null], ["identity", null], ["gzip", "gzip"], ["br, gzip", "br"], ["gzip, deflate, br", "br"],
      ["br;q=0, gzip", "gzip"], ["gzip;q=0, br;q=0.5", "br"], ["br;q=0, gzip;q=0", null], ["*", "br"], ["deflate", null]
    ];
    for (const [header, coding] of accepted) {
      const response = await historySearch(host.hostId, "range=1h&kinds=summary,disks", header === null ? {} : { "Accept-Encoding": header });
      expect(response.status, String(header)).toBe(200);
      expect(response.headers.get("content-type")).toBe(HISTORY_CONTENT_TYPE);
      expect(response.headers.get("content-encoding"), String(header)).toBe(coding);
      expect(response.headers.get("vary")).toBe("Accept-Encoding");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(Object.keys(await frame(response) as object)).toContain("histories");
    }
  });

  it("revalidates with Vary and leaves errors as uncompressed JSON", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "linux-normal", host.hostId)).status).toBe(200);
    const first = await historySearch(host.hostId, "range=1h&kind=summary", { "Accept-Encoding": "br" });
    const etag = first.headers.get("etag")!;
    expect(etag.endsWith(':stc1"')).toBe(true);
    const unchanged = await historySearch(host.hostId, "range=1h&kind=summary", { "Accept-Encoding": "br", "If-None-Match": etag });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("vary")).toBe("Accept-Encoding");
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(unchanged.headers.get("content-encoding")).toBeNull();
    const other = await historySearch(host.hostId, "range=1h&kind=disks");
    expect(other.headers.get("etag")).not.toBe(etag);

    const missing = await historySearch("h_0123456789abcdef0123456789abcdef", "range=1h&kinds=summary", { "Accept-Encoding": "br" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-encoding")).toBeNull();
    expect(missing.headers.get("content-type")).toContain("application/json");
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "host not found" } });
    const invalid = await historySearch(host.hostId, "range=1h&kinds=bogus", { "Accept-Encoding": "br" });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-encoding")).toBeNull();
    expect(invalid.headers.get("content-type")).toContain("application/json");
  });

  it("repairs a late sample in the rolled bucket", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "linux-normal", host.hostId)).status).toBe(200);
    expect((await ingest(host.token, "out-of-order-late", host.hostId)).status).toBe(200);
    const response = await history(host.hostId, "7d", "summary");
    const body = await frame(response) as { points: { coverageMs: number }[] };
    expect(body.points[0]!.coverageMs).toBe(15_000);
  });

  it("keeps the tier step when the first samples are far apart", async () => {
    const host = await createHost();
    await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) => {
      const payload = (seq: string, atMs: number) => JSON.stringify({ seq, atMs: String(atMs), monoMs: String(atMs) });
      for (const [seq, atMs] of [["1", now - 600_000], ["2", now - 300_000], ["3", now - 285_000]] as const) {
        state.storage.sql.exec("INSERT INTO samples (host_id, boot_id, seq, at_ms, received_at_ms, mono_ms, elapsed_ms, delta, payload) VALUES (?, '3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f', ?, ?, ?, 1, 0, '{}', ?)", host.hostId, seq, atMs, atMs, payload(seq, atMs));
      }
      for (const bucketMs of [now - 2 * 86_400_000, now - 2 * 86_400_000 + 600_000]) {
        state.storage.sql.exec("INSERT INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES (?, '1m', ?, 15_000, 1, ?)", host.hostId, bucketMs, JSON.stringify({ v: 1, bucketMs, samples: 1, coverageMs: 15_000, partial: true, gauges: {}, psi: {}, disks: {}, nets: {}, filesystems: {} }));
      }
    });
    const raw = await frame(await history(host.hostId, "1h", "summary")) as { stepMs: number };
    expect(raw.stepMs).toBe(15_000);
    const rolled = await frame(await history(host.hostId, "7d", "summary")) as { stepMs: number };
    expect(rolled.stepMs).toBe(60_000);
  });

  it("schedules another pass after a full retention batch", async () => {
    const retention = env.INSTALLATION.get(env.INSTALLATION.idFromName("retention"));
    await runInDurableObject(retention, async (_instance: Installation, state: DurableObjectState) => {
      for (let index = 0; index < 1001; index += 1) {
        state.storage.sql.exec("INSERT INTO samples (host_id, boot_id, seq, at_ms, received_at_ms, mono_ms, elapsed_ms, delta, payload) VALUES ('h_0123456789abcdef0123456789abcdef', '3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f', ?, ?, ?, 1, 0, '{}', '{}')", `old-${index}`, now - 49 * 60 * 60 * 1000, now - 49 * 60 * 60 * 1000);
      }
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    expect(await runDurableObjectAlarm(retention)).toBe(true);
    const remaining = await runInDurableObject(retention, async (_instance: Installation, state: DurableObjectState) => state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM samples WHERE seq LIKE 'old-%'").one().count);
    expect(remaining).toBe(1);
  });

  it("reschedules within a minute after any tier deletes a full batch", async () => {
    expect(retentionDelayMs({ raw: 1000, minute: 0, hour: 0 })).toBe(60_000);
    expect(retentionDelayMs({ raw: 0, minute: 1000, hour: 0 })).toBe(60_000);
    expect(retentionDelayMs({ raw: 0, minute: 0, hour: 1000 })).toBe(60_000);
    expect(retentionDelayMs({ raw: 999, minute: 999, hour: 0 })).toBe(600_000);
  });

  it("expires raw and rolled rows on the alarm", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "linux-normal", host.hostId)).status).toBe(200);
    await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO samples (host_id, boot_id, seq, at_ms, received_at_ms, mono_ms, elapsed_ms, delta, payload) VALUES (?, ?, 'old', ?, ?, 1, 0, '{}', '{}')", host.hostId, "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f", now - 49 * 60 * 60 * 1000, now - 49 * 60 * 60 * 1000);
      state.storage.sql.exec("INSERT INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES (?, '1m', ?, 0, 1, '{}')", host.hostId, now - 8 * 24 * 60 * 60 * 1000);
      state.storage.sql.exec("INSERT INTO rollups (host_id, resolution, bucket_ms, coverage_ms, partial, payload) VALUES (?, '1h', ?, 0, 1, '{}')", host.hostId, now - 91 * 24 * 60 * 60 * 1000);
    });
    await runDurableObjectAlarm(stub());
    const counts = await runInDurableObject(stub(), async (_instance: Installation, state: DurableObjectState) => state.storage.sql.exec<{ samples: number; minute: number; hour: number }>("SELECT (SELECT count(*) FROM samples WHERE host_id = ? AND seq = 'old') AS samples, (SELECT count(*) FROM rollups WHERE host_id = ? AND resolution = '1m' AND bucket_ms < ?) AS minute, (SELECT count(*) FROM rollups WHERE host_id = ? AND resolution = '1h' AND bucket_ms < ?) AS hour", host.hostId, host.hostId, now - 7 * 24 * 60 * 60 * 1000, host.hostId, now - 90 * 24 * 60 * 60 * 1000).one());
    expect(counts).toEqual({ samples: 0, minute: 0, hour: 0 });
  });
});

describe("history reads", () => {
  describe("after an earlier read", () => {
    const full = source("linux-normal");
    type Samples = SourceBatch["samples"];
    async function send(token: string, hostId: string, samples: Samples): Promise<void> {
      const response = await post(token, encode({ ...source("linux-normal"), hostId, samples }));
      expect(response.status).toBe(200);
    }
    async function everyKind(hostId: string): Promise<unknown> {
      const response = await historySearch(hostId, "range=1h&kinds=summary,disks,nets,filesystems,block");
      expect(response.status).toBe(200);
      const body = await frame(response) as { histories: Record<string, Record<string, unknown>> };
      return Object.fromEntries(Object.entries(body.histories).map(([kind, value]) => [kind, { ...value, hostId: undefined }]));
    }
    async function readBetween(first: Samples, second: Samples): Promise<{ primed: unknown; fresh: unknown }> {
      const primed = await createHost();
      await send(primed.token, primed.hostId, first);
      await everyKind(primed.hostId);
      await send(primed.token, primed.hostId, second);
      const fresh = await createHost();
      await send(fresh.token, fresh.hostId, first);
      await send(fresh.token, fresh.hostId, second);
      return { primed: await everyKind(primed.hostId), fresh: await everyKind(fresh.hostId) };
    }

    it("serves a later sample exactly as a host never read before", async () => {
      const { primed, fresh } = await readBetween([full.samples[0]!], [full.samples[1]!]);
      expect((primed as { summary: { points: unknown[] } }).summary.points).toHaveLength(2);
      expect(primed).toEqual(fresh);
    });

    it("serves a late sample and the delta it rewrites exactly as a host never read before", async () => {
      const { primed, fresh } = await readBetween([full.samples[1]!], [full.samples[0]!]);
      expect((primed as { summary: { points: unknown[] } }).summary.points).toHaveLength(2);
      expect(primed).toEqual(fresh);
    });
  });

  it("returns history that includes a later batch", async () => {
    const host = await createHost();
    expect((await ingest(host.token, "linux-normal", host.hostId)).status).toBe(200);
    const before = (await frame(await history(host.hostId, "1h", "summary"))) as { points: { atMs: number }[] };
    expect(before.points.map(point => point.atMs)).toEqual([now - 15_000, now]);
    expect((await ingest(host.token, "reboot-after", host.hostId)).status).toBe(200);
    const after = (await frame(await history(host.hostId, "1h", "summary"))) as { points: { atMs: number }[] };
    expect(after.points.map(point => point.atMs)).toEqual([now - 15_000, now, now]);
  });
});

describe("system details", () => {
  async function system(hostId: string): Promise<Response> {
    return SELF.fetch(`https://example.com/api/v1/hosts/${hostId}/system`, { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
  }

  it("keeps what the agent last reported, serves it behind Access, and drops it with the host", async () => {
    const host = await createHost();
    expect((await system(host.hostId)).status).toBe(404);
    expect((await ingest(host.token, "system", host.hostId)).status).toBe(200);
    const body = await (await system(host.hostId)).json() as { hostId: string; reportedAtMs: number; system: { hostname: string; cpu: { threads: number; cores: number } } };
    expect(body.hostId).toBe(host.hostId);
    expect(body.reportedAtMs).toBe(now);
    expect(body.system.hostname).toBe("threadripper");
    expect(body.system.cpu).toMatchObject({ threads: 32, cores: 16 });

    expect((await ingest(host.token, "minimal", host.hostId)).status).toBe(200);
    expect((await system(host.hostId)).status).toBe(200);

    expect((await SELF.fetch(`https://example.com/api/v1/hosts/${host.hostId}/system`)).status).toBe(401);
    expect(await runInDurableObject(stub(), async (instance: Installation) => instance.purgeHost(host.hostId))).toBe(true);
    expect((await system(host.hostId)).status).toBe(404);
  });

  it("rejects a batch whose system details are malformed", async () => {
    const host = await createHost();
    const malformed = (JSON.parse(fixtureText("malformed.json")) as { cases: { name: string; hex: string }[] }).cases.find(entry => entry.name === "system-threads-zero")!;
    const bytes = Uint8Array.from({ length: malformed.hex.length / 2 }, (_, index) => Number.parseInt(malformed.hex.slice(index * 2, index * 2 + 2), 16));
    bytes.set(Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(host.hostId.slice(2 + index * 2, 4 + index * 2), 16)), 6);
    const response = await post(host.token, bytes);
    expect(response.status).toBe(400);
    expect((await system(host.hostId)).status).toBe(404);
  });
});
