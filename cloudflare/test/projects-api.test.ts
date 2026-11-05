import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Installation } from "../src/installation";
import { HISTORY_CONTENT_TYPE } from "../src/binary/history";
import { HOUR_MS, PROJECT_SETTLE_MS, RANGES } from "../src/limits";
import { bucketWidthMs } from "../src/projects/history";
import type { CollectorRun } from "../src/projects/store";
import { accessToken } from "./access-token";
import { readFrame } from "./support/history";

const NOW = 1_793_510_415_000;
const BUCKET = 300_000;
const NEWEST_BUCKET = Math.floor(NOW / BUCKET) * BUCKET;
const OLD_BUCKET = NEWEST_BUCKET - 3 * HOUR_MS;

function installation() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://example.com/api/v1${path}`, { headers: { "Cf-Access-Jwt-Assertion": await accessToken(), ...headers } });
}

async function history(range: string, kind: string): Promise<{ stepMs: number; fromMs: number; series: { metric: string; values: (number | null)[] }[] }> {
  const response = await get(`/projects/stuff/history?range=${range}&kind=${kind}`);
  expect(response.status).toBe(200);
  return await readFrame(response) as Awaited<ReturnType<typeof history>>;
}

function metricRun(atMs: number, points: { metric: string; bucketMs: number; value: number }[]): CollectorRun {
  return { ok: true, atMs, detail: "ok", rowsRead: 1, durationMs: 1, collected: [{ project: "stuff", points }], storeOwners: [] };
}

function failedRun(atMs: number): CollectorRun {
  return { ok: false, atMs, detail: "collector_failed", rowsRead: 0, durationMs: 1 };
}

async function record(...runs: CollectorRun[]): Promise<void> {
  await runInDurableObject(installation(), async (instance: Installation) => {
    for (const run of runs) await instance.recordCollectorRun(run);
  });
}

function seriesOf(body: { series: { metric: string; values: (number | null)[] }[] }, metric: string): (number | null)[] {
  const found = body.series.find((entry) => entry.metric === metric);
  if (found === undefined) throw new Error(`no series ${metric}`);
  return found.values;
}

function indexOf(body: { fromMs: number; stepMs: number }, atMs: number): number {
  return (atMs - body.fromMs) / body.stepMs;
}

beforeEach(async () => {
  await runInDurableObject(installation(), async (_instance, state) => {
    for (const table of ["project_samples", "project_hours", "collector_runs"]) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
});

describe("project API", () => {
  it("requires Access on both routes", async () => {
    for (const path of ["/projects", "/projects/stuff/history?range=1h&kind=worker"]) {
      expect((await SELF.fetch(`https://example.com/api/v1${path}`)).status).toBe(401);
    }
  });

  it("lists configured projects with collector state", async () => {
    const empty = await (await get("/projects")).json() as { id: string; buckets: string[]; collector: unknown }[];
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ id: "stuff", worker: "stuff", buckets: ["stuff-mycrates", "stuff-mynpm"] });
    expect(empty[0]?.collector).toEqual({ lastRunAtMs: null, lastSuccessAtMs: null, lastError: null, stale: true });

    await record(metricRun(NOW - 5 * 60_000, []));
    const fresh = await (await get("/projects")).json() as { collector: unknown }[];
    expect(fresh[0]?.collector).toEqual({ lastRunAtMs: NOW - 300_000, lastSuccessAtMs: NOW - 300_000, lastError: null, stale: false });

    await record(failedRun(NOW - 60_000));
    const failing = await (await get("/projects")).json() as { collector: unknown }[];
    expect(failing[0]?.collector).toEqual({ lastRunAtMs: NOW - 60_000, lastSuccessAtMs: NOW - 300_000, lastError: "collector_failed", stale: false });
  });

  it("marks the collector stale after fifteen minutes without a success", async () => {
    await record(metricRun(NOW - 16 * 60_000, []), failedRun(NOW - 60_000));
    const [project] = await (await get("/projects")).json() as { collector: { stale: boolean } }[];
    expect(project?.collector.stale).toBe(true);
  });

  it("answers unknown projects with 404 and bad queries with 400", async () => {
    expect((await get("/projects/other/history?range=1h&kind=worker")).status).toBe(404);
    expect((await get("/projects/Bad_Id/history?range=1h&kind=worker")).status).toBe(404);
    for (const query of ["range=2h&kind=worker", "range=1h&kind=hosts", "range=1h", "kind=worker", ""]) {
      expect((await get(`/projects/stuff/history?${query}`)).status, query).toBe(400);
    }
    expect((await get("/projects/stuff")).status).toBe(404);
  });

  it("answers 503 with a fixed message when the registry is invalid", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runInDurableObject(installation(), async (instance: Installation) => {
      const original = (instance as unknown as { env: Env }).env;
      Object.defineProperty(instance, "env", { value: { ...original, PROJECTS: '[{"id":"stuff"}]' }, configurable: true });
      try {
        for (const path of ["https://installation/projects", "https://installation/projects/stuff/history?range=1h&kind=worker"]) {
          const response = await instance.fetch(new Request(path));
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({ error: { code: "unavailable", message: "project configuration is invalid" } });
        }
      } finally {
        Object.defineProperty(instance, "env", { value: original, configurable: true });
      }
    });
  });
});

describe("project history", () => {
  it("picks the smallest bucket width that gives at most 900 points", () => {
    const widths = RANGES.map((range) => bucketWidthMs({ "1h": HOUR_MS, "6h": 6 * HOUR_MS, "24h": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS, "30d": 30 * 24 * HOUR_MS }[range]));
    expect(widths).toEqual([BUCKET, BUCKET, BUCKET, 15 * 60_000, HOUR_MS]);
  });

  it("returns several kinds in one response", async () => {
    const start = Math.floor((NOW - 2 * 24 * HOUR_MS) / (15 * 60_000)) * 15 * 60_000;
    await record(metricRun(NOW - BUCKET, [
      { metric: "worker.invocations", bucketMs: start, value: 4 },
      { metric: "probe.npm.up", bucketMs: start, value: 1 },
    ]));
    const response = await get("/projects/stuff/history?range=1h&kinds=worker,routes,collector,probes");
    expect(response.status).toBe(200);
    const body = await readFrame(response) as { projectId: string; histories: Record<string, { kind: string; series?: unknown[]; runs?: unknown[] }> };
    expect(body.projectId).toBe("stuff");
    expect(Object.keys(body.histories)).toEqual(["worker", "routes", "collector", "probes"]);
    for (const [kind, history] of Object.entries(body.histories)) expect(history.kind, kind).toBe(kind);
    expect(body.histories.worker).toEqual(await history("1h", "worker"));
    expect(body.histories.collector!.runs).toHaveLength(1);

    for (const query of ["range=1h&kinds=worker,hosts", "range=1h&kind=worker&kinds=worker", "range=1h&kinds="]) {
      expect((await get(`/projects/stuff/history?${query}`)).status, query).toBe(400);
    }
  });

  it("answers with 304 until a collector run changes the project version", async () => {
    await record(metricRun(NOW - BUCKET, []));
    const path = "/projects/stuff/history?range=1h&kinds=worker,collector";
    const first = await get(path);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    expect(first.headers.get("content-type")).toBe(HISTORY_CONTENT_TYPE);
    expect(first.headers.get("vary")).toBe("Accept-Encoding");
    expect(first.headers.get("content-encoding")).toBeNull();
    expect((await get(path, { "Accept-Encoding": "gzip, br" })).headers.get("content-encoding")).toBe("br");

    const unchanged = await get(path, { "If-None-Match": etag! });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("vary")).toBe("Accept-Encoding");
    expect(await unchanged.text()).toBe("");

    await record(metricRun(NOW - 2 * BUCKET, []));
    const changed = await get(path, { "If-None-Match": etag! });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });

  it("adds sums and takes maxes when 5 minute buckets share a wider bucket", async () => {
    const start = Math.floor((NOW - 2 * 24 * HOUR_MS) / (15 * 60_000)) * 15 * 60_000;
    await record(metricRun(NOW - BUCKET, [
      { metric: "worker.invocations", bucketMs: start, value: 1 },
      { metric: "worker.invocations", bucketMs: start + BUCKET, value: 2 },
      { metric: "worker.invocations", bucketMs: start + 2 * BUCKET, value: 3 },
      { metric: "worker.cpuMsMax", bucketMs: start, value: 4 },
      { metric: "worker.cpuMsMax", bucketMs: start + BUCKET, value: 9 },
      { metric: "worker.cpuMsMax", bucketMs: start + 2 * BUCKET, value: 5 },
    ]));
    const body = await history("7d", "worker");
    expect(body.stepMs).toBe(15 * 60_000);
    expect(seriesOf(body, "worker.invocations")[indexOf(body, start)]).toBe(6);
    expect(seriesOf(body, "worker.cpuMsMax")[indexOf(body, start)]).toBe(9);
  });

  it("keeps a probe outage visible in coarse buckets", async () => {
    const start = Math.floor((NOW - 2 * 24 * HOUR_MS) / (15 * 60_000)) * 15 * 60_000;
    await record(metricRun(NOW - BUCKET, [
      { metric: "probe.npm.up", bucketMs: start, value: 1 },
      { metric: "probe.npm.up", bucketMs: start + BUCKET, value: 0 },
      { metric: "probe.npm.up", bucketMs: start + 2 * BUCKET, value: 1 },
    ]));
    const body = await history("7d", "probes");
    expect(seriesOf(body, "probe.npm.up")[indexOf(body, start)]).toBe(0);
  });

  it("starts the 7 day and 30 day views at the first bucket that retention left whole", async () => {
    for (const [range, stepMs, retentionMs] of [["7d", 15 * 60_000, 7 * 24 * HOUR_MS], ["30d", HOUR_MS, 30 * 24 * HOUR_MS]] as const) {
      const body = await history(range, "worker");
      expect(body.stepMs).toBe(stepMs);
      expect(body.fromMs % stepMs).toBe(0);
      expect(body.fromMs).toBeGreaterThanOrEqual(NOW - retentionMs);
      expect(body.fromMs - stepMs).toBeLessThan(NOW - retentionMs);
    }
    const hour = await history("1h", "worker");
    expect(hour.fromMs).toBeLessThanOrEqual(NOW - HOUR_MS);
  });

  it("serves 30 days from hourly rows in one hour buckets", async () => {
    const hour = Math.floor((NOW - 10 * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS;
    await record(metricRun(NOW - BUCKET, [
      { metric: "worker.invocations", bucketMs: hour, value: 10 },
      { metric: "worker.invocations", bucketMs: hour + BUCKET, value: 20 },
      { metric: "worker.invocations", bucketMs: hour + 3 * HOUR_MS, value: 40 },
    ]));
    const body = await history("30d", "worker");
    expect(body.stepMs).toBe(HOUR_MS);
    expect(body.series[0]?.values.length).toBeLessThanOrEqual(900);
    expect(seriesOf(body, "worker.invocations")[indexOf(body, hour)]).toBe(30);
    expect(seriesOf(body, "worker.invocations")[indexOf(body, hour + 3 * HOUR_MS)]).toBe(40);
  });

  it("serves an explicit window in fine buckets, with no range in its frame", async () => {
    const fromMs = OLD_BUCKET - HOUR_MS;
    const toMs = OLD_BUCKET + HOUR_MS;
    await record(metricRun(NOW - BUCKET, [
      { metric: "worker.invocations", bucketMs: OLD_BUCKET, value: 7 },
      { metric: "worker.invocations", bucketMs: toMs + 6 * HOUR_MS, value: 99 },
    ]));
    const response = await get(`/projects/stuff/history?from=${fromMs}&to=${toMs}&kind=worker`);
    expect(response.status).toBe(200);
    const body = await readFrame(response) as { stepMs: number; fromMs: number; toMs: number; series: { metric: string; values: (number | null)[] }[] };
    expect("range" in body).toBe(false);
    expect(body.stepMs).toBe(BUCKET);
    expect(body.fromMs).toBe(fromMs);
    expect(body.toMs).toBe(toMs);
    expect(body.series[0]?.values).toHaveLength((toMs - fromMs) / BUCKET + 1);
    expect(seriesOf(body, "worker.invocations")[indexOf(body, OLD_BUCKET)]).toBe(7);
    expect(seriesOf(body, "worker.invocations").filter((value) => value === 99)).toEqual([]);
  });

  it("serves a window older than the fine samples from hourly rows", async () => {
    const hour = Math.floor((NOW - 10 * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS;
    await record(metricRun(NOW - BUCKET, [
      { metric: "worker.invocations", bucketMs: hour, value: 10 },
      { metric: "worker.invocations", bucketMs: hour + BUCKET, value: 20 },
    ]));
    const response = await get(`/projects/stuff/history?from=${hour - 2 * HOUR_MS}&to=${hour + 4 * HOUR_MS}&kind=worker`);
    expect(response.status).toBe(200);
    const body = await readFrame(response) as { stepMs: number; fromMs: number; series: { metric: string; values: (number | null)[] }[] };
    expect(body.stepMs).toBe(HOUR_MS);
    expect(seriesOf(body, "worker.invocations")[indexOf(body, hour)]).toBe(30);
  });

  it("returns only the collector runs inside an explicit window", async () => {
    await record(metricRun(NOW - 3 * HOUR_MS, []), metricRun(NOW - HOUR_MS, []));
    const response = await get(`/projects/stuff/history?from=${NOW - 4 * HOUR_MS}&to=${NOW - 2 * HOUR_MS}&kinds=worker,collector`);
    expect(response.status).toBe(200);
    const body = await readFrame(response) as { histories: { collector: { runs: { atMs: number }[] } } };
    expect(body.histories.collector.runs.map((run) => run.atMs)).toEqual([NOW - 3 * HOUR_MS]);
  });

  it("rejects a window that is incomplete, inverted, mixed with a range, in the future, or longer than 30 days", async () => {
    const from = NOW - 2 * HOUR_MS;
    const to = NOW - HOUR_MS;
    const queries = [
      `from=${from}&kind=worker`,
      `to=${to}&kind=worker`,
      `from=${to}&to=${from}&kind=worker`,
      `from=${from}&to=${from}&kind=worker`,
      `range=1h&from=${from}&to=${to}&kind=worker`,
      `from=${NOW + HOUR_MS}&to=${NOW + 2 * HOUR_MS}&kind=worker`,
      `from=${NOW - 31 * 24 * HOUR_MS}&to=${NOW}&kind=worker`,
      `from=abc&to=${to}&kind=worker`,
    ];
    for (const query of queries) expect((await get(`/projects/stuff/history?${query}`)).status, query).toBe(400);
  });

  it("fills a settled counter bucket with zero when a later successful run covered it", async () => {
    await record(
      metricRun(OLD_BUCKET + HOUR_MS, [{ metric: "worker.invocations", bucketMs: OLD_BUCKET, value: 5 }]),
    );
    const body = await history("6h", "worker");
    const at = indexOf(body, OLD_BUCKET);
    expect(seriesOf(body, "worker.invocations")[at]).toBe(5);
    expect(seriesOf(body, "worker.status.5xx")[at]).toBe(0);
    expect(seriesOf(body, "worker.cpuMsSum")[at]).toBe(0);
  });

  it("leaves a bucket absent when no successful run covered it", async () => {
    await record(failedRun(OLD_BUCKET + HOUR_MS));
    const failed = await history("6h", "worker");
    expect(seriesOf(failed, "worker.status.5xx")[indexOf(failed, OLD_BUCKET)]).toBeNull();

    await record(metricRun(OLD_BUCKET + 10 * 60_000, []));
    const tooEarly = await history("6h", "worker");
    expect(seriesOf(tooEarly, "worker.status.5xx")[indexOf(tooEarly, OLD_BUCKET)]).toBeNull();

    await record(metricRun(OLD_BUCKET + 2 * HOUR_MS, []));
    const tooLate = await history("6h", "worker");
    expect(seriesOf(tooLate, "worker.status.5xx")[indexOf(tooLate, OLD_BUCKET)]).toBeNull();
  });

  it("fills at exactly the settle time and not a millisecond before", async () => {
    const settledAt = OLD_BUCKET + BUCKET + PROJECT_SETTLE_MS;
    await record(metricRun(settledAt - 1, []));
    const early = await history("6h", "worker");
    expect(seriesOf(early, "worker.status.5xx")[indexOf(early, OLD_BUCKET)]).toBeNull();
    await record(metricRun(settledAt, []));
    const exact = await history("6h", "worker");
    expect(seriesOf(exact, "worker.status.5xx")[indexOf(exact, OLD_BUCKET)]).toBe(0);
  });

  it("starts filling when the clock reaches the settle time of the newest bucket", async () => {
    const settledAt = NEWEST_BUCKET + BUCKET + PROJECT_SETTLE_MS;
    await record(metricRun(settledAt, []));
    const filledAt = (now: number) => runInDurableObject(installation(), async (instance) => {
      const original = (instance as unknown as { env: Env }).env;
      Object.defineProperty(instance, "env", { value: { ...original, TEST_NOW_MS: String(now) }, configurable: true });
      try {
        const response = await instance.fetch(new Request("https://installation/projects/stuff/history?range=6h&kind=worker"));
        const body = await readFrame(response) as { fromMs: number; stepMs: number; series: { metric: string; values: (number | null)[] }[] };
        return seriesOf(body, "worker.invocations")[(NEWEST_BUCKET - body.fromMs) / body.stepMs];
      } finally {
        Object.defineProperty(instance, "env", { value: original, configurable: true });
      }
    });
    expect(await filledAt(settledAt - 1)).toBeNull();
    expect(await filledAt(settledAt)).toBe(0);
  });

  it("fills while a run's 90 minute window still reaches the bucket and stops once it does not", async () => {
    await record(metricRun(OLD_BUCKET + 90 * 60_000, []));
    const inside = await history("6h", "worker");
    expect(seriesOf(inside, "worker.status.5xx")[indexOf(inside, OLD_BUCKET)]).toBe(0);
    await runInDurableObject(installation(), async (_instance, state) => state.storage.sql.exec("DELETE FROM collector_runs"));
    await record(metricRun(OLD_BUCKET + 95 * 60_000, []));
    const outside = await history("6h", "worker");
    expect(seriesOf(outside, "worker.status.5xx")[indexOf(outside, OLD_BUCKET)]).toBeNull();
  });

  it("never fills the unsettled newest bucket, gauges, or buckets before the first covering run", async () => {
    await record(metricRun(NOW - BUCKET, []), metricRun(OLD_BUCKET + HOUR_MS, []));
    const worker = await history("6h", "worker");
    expect(seriesOf(worker, "worker.invocations")[indexOf(worker, NEWEST_BUCKET)]).toBeNull();
    expect(seriesOf(worker, "worker.cpuMsMax")[indexOf(worker, OLD_BUCKET)]).toBeNull();
    const r2 = await history("6h", "r2");
    expect(seriesOf(r2, "r2.stuff-mynpm.storageBytes")[indexOf(r2, OLD_BUCKET)]).toBeNull();
    expect(seriesOf(r2, "r2.stuff-mynpm.ops.success")[indexOf(r2, OLD_BUCKET)]).toBe(0);
    expect(seriesOf(r2, "r2.stuff-mynpm.ops.success")[indexOf(r2, OLD_BUCKET - 2 * HOUR_MS)]).toBeNull();
  });

  it("returns configured series even before any collection and probe series for configured probes", async () => {
    const r2 = await history("1h", "r2");
    expect(r2.series).toHaveLength(10);
    expect(r2.series.every((entry) => entry.values.every((value) => value === null))).toBe(true);
    const probes = await history("1h", "probes");
    expect(probes.series.map((entry) => entry.metric)).toEqual(["probe.npm.up", "probe.npm.ms"]);
  });

  it("returns the collector runs in the range", async () => {
    await record(metricRun(NOW - 2 * HOUR_MS, []), failedRun(NOW - 60_000));
    const response = await get("/projects/stuff/history?range=1h&kind=collector");
    const body = await readFrame(response) as { runs: { atMs: number; ok: boolean; detail: string }[] };
    expect(body.runs).toEqual([{ atMs: NOW - 60_000, ok: false, detail: "collector_failed", rowsRead: 0, durationMs: 1 }]);
  });
});
