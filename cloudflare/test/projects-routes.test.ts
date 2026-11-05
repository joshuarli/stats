import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { foldWideRoutes, MAX_ROUTES_PER_PROJECT, parseDurableObjectRows, parseRouteRows, routeKey } from "../src/cloudflare/projects/parse";
import { durableObjectQuery } from "../src/projects/queries";
import type { CollectorRun } from "../src/projects/store";
import { accessToken } from "./access-token";
import { readFrame } from "./support/history";

const NOW = 1_793_510_415_000;
const BUCKET = 300_000;
const NEWEST_BUCKET = Math.floor(NOW / BUCKET) * BUCKET;

function installation() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

async function history(kind: string): Promise<{ series: { metric: string; values: (number | null)[] }[] }> {
  const response = await SELF.fetch(`https://example.com/api/v1/projects/stuff/history?range=1h&kind=${kind}`, {
    headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
  });
  expect(response.status).toBe(200);
  return await readFrame(response) as Awaited<ReturnType<typeof history>>;
}

function routeRow(label: string, cpuSum: number, invocations = 10, slot = 0) {
  return { day: "2026-11-01", hour: 16, slot, invocationLabel: label, invocations, cpu_sum: cpuSum };
}

beforeEach(async () => {
  await runInDurableObject(installation(), async (_instance, state) => {
    for (const table of ["project_samples", "project_hours", "collector_runs"]) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
});

describe("route keys", () => {
  it("collapses ids, versions stay, and unusual labels are bounded", () => {
    expect(routeKey("GET /api/v1/hosts/h_86a98a784c7124f81bf544462d520e49/history")).toBe("GET /api/v1/hosts/:id/history");
    expect(routeKey("GET /api/v1/projects/stats/history?range=1h")).toBe("GET /api/v1/projects/stats/history");
    expect(routeKey("POST /ingest/v1/batches")).toBe("POST /ingest/v1/batches");
    expect(routeKey("Installation.jsrpc")).toBe("Installation.jsrpc");
    expect(routeKey("*/5 * * * *")).toBe("*/5 * * * *");
    expect(routeKey("11/1/2026, 8:23:33 PM")).toBe("alarm");
    expect(routeKey("GET /café")).toBe("GET /caf?");
    expect(routeKey(`GET /${"ab/".repeat(60)}`)).toHaveLength(80);
  });
});

describe("route rows", () => {
  it("merges routes that normalize alike and keeps only the busiest", () => {
    const rows = [
      routeRow("GET /api/v1/hosts/h_1/history", 4, 2),
      routeRow("GET /api/v1/hosts/h_2/history", 6, 3),
      ...Array.from({ length: MAX_ROUTES_PER_PROJECT }, (_, index) => routeRow(`Entry${String.fromCharCode(97 + index)}.rpc`, 100 + index)),
    ];
    const metrics = new Set(parseRouteRows(rows).map((point) => point.metric));
    expect(metrics.size).toBe(MAX_ROUTES_PER_PROJECT * 2);
    expect(metrics.has("route.GET /api/v1/hosts/:id/history.cpuMsSum")).toBe(false);
    expect(metrics.has("route.Entrya.rpc.cpuMsSum")).toBe(true);

    const merged = parseRouteRows(rows.slice(0, 2)).filter((point) => point.metric.startsWith("route.GET /api/v1/hosts/:id/history."));
    expect(Object.fromEntries(merged.map((point) => [point.metric.split(".").pop(), point.value]))).toEqual({ invocations: 5, cpuMsSum: 10 });
  });
});

describe("Durable Object rows", () => {
  it("converts microseconds to milliseconds and counts non-success as errors", () => {
    const points = parseDurableObjectRows([
      { bucket: "2026-11-01 16:00:00", status: "success", invocations: 40, cpu_us: 400_000, wall_us: 2_000_000, cpu_max_us: 35_000 },
      { bucket: "2026-11-01 16:00:00", status: "exception", invocations: 10, cpu_us: 50_000, wall_us: 100_000, cpu_max_us: 20_000 },
    ]);
    const at = (metric: string) => points.find((point) => point.metric === metric)?.value;
    expect(at("do.invocations")).toBe(50);
    expect(at("do.errors")).toBe(10);
    expect(at("do.cpuMsSum")).toBe(450);
    expect(at("do.wallMsSum")).toBe(2_100);
    expect(at("do.cpuMsMax")).toBe(35);
  });

  it("binds namespace ids as parameters and rejects anything else", () => {
    const id = "b25c2595ba784bb1bd51a87a3e87c62b";
    expect(durableObjectQuery([id], 0).params["namespace0"]).toBe(id);
    expect(() => durableObjectQuery(["x') OR ('1'='1"], 0)).toThrow(RangeError);
    expect(() => durableObjectQuery([], 0)).toThrow(RangeError);
  });
});

describe("route and Durable Object history", () => {
  it("lists routes busiest first and zero-fills nothing it did not see", async () => {
    const run: CollectorRun = {
      ok: true,
      atMs: NOW,
      detail: "ok",
      rowsRead: 1,
      durationMs: 1,
      upstreamQueries: 1,
      storeOwners: [],
      collected: [
        {
          project: "stuff",
          points: [
            { metric: "route.GET /light.invocations", bucketMs: NEWEST_BUCKET - 4 * BUCKET, value: 9 },
            { metric: "route.GET /light.cpuMsSum", bucketMs: NEWEST_BUCKET - 4 * BUCKET, value: 9 },
            { metric: "route.GET /heavy.invocations", bucketMs: NEWEST_BUCKET - 4 * BUCKET, value: 2 },
            { metric: "route.GET /heavy.cpuMsSum", bucketMs: NEWEST_BUCKET - 4 * BUCKET, value: 90 },
            { metric: "do.invocations", bucketMs: NEWEST_BUCKET - 4 * BUCKET, value: 7 },
          ],
        },
      ],
    };
    await runInDurableObject(installation(), async (instance) => {
      await instance.recordCollectorRun(run);
    });

    const routes = await history("routes");
    expect(routes.series.map((entry) => entry.metric)).toEqual([
      "route.GET /heavy.invocations",
      "route.GET /heavy.cpuMsSum",
      "route.GET /light.invocations",
      "route.GET /light.cpuMsSum",
    ]);

    const durableObjects = await history("durable-objects");
    expect(durableObjects.series.map((entry) => entry.metric)).toEqual(["do.invocations", "do.errors", "do.cpuMsSum", "do.cpuMsMax", "do.wallMsSum", "do.storageBytes"]);
    expect(durableObjects.series[0]?.values.filter((value) => value === 7)).toHaveLength(1);
    expect(durableObjects.series[3]?.values.every((value) => value === null)).toBe(true);
  });
});

describe("wide route folding", () => {
  it("folds a path position with many distinct children and keeps narrow ones", () => {
    const crates = Array.from({ length: 12 }, (_, index) => `GET /current/crates-io/${String.fromCharCode(97 + index)}x/pkg`);
    const folded = foldWideRoutes([...crates, "GET /current/simple/", "GET /api/v1/projects", "GET /api/v1/hosts", "*/5 * * * *"]);
    expect(new Set(crates.map((key) => folded.get(key)))).toEqual(new Set(["GET /current/crates-io/:*/pkg"]));
    expect(folded.get("GET /current/simple/")).toBe("GET /current/simple/");
    expect(folded.get("GET /api/v1/projects")).toBe("GET /api/v1/projects");
    expect(folded.get("*/5 * * * *")).toBe("*/5 * * * *");
  });

  it("sums folded routes into one series per bucket", () => {
    const rows = Array.from({ length: 12 }, (_, index) => routeRow(`GET /pkg/${String.fromCharCode(97 + index)}x`, 10, 2));
    const metrics = parseRouteRows(rows);
    expect(metrics.map((point) => point.metric).sort()).toEqual(["route.GET /pkg/:*.cpuMsSum", "route.GET /pkg/:*.invocations"]);
    expect(metrics.find((point) => point.metric.endsWith(".cpuMsSum"))?.value).toBe(120);
  });
});
