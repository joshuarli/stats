import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCollector, type AnalyticsQuery } from "../src/projects/collector";
import { isUp, runProbes, type ProbeFetch } from "../src/projects/probes";
import r2OperationsBody from "./fixtures/analytics/r2-operations.json";
import r2StorageBody from "./fixtures/analytics/r2-storage.json";
import workerBody from "./fixtures/analytics/worker.json";

const NOW = Date.UTC(2026, 10, 1, 16, 37);
const BUCKET = Date.UTC(2026, 10, 1, 16, 35);
const probes = [
  { name: "crates", url: "https://crates.example.com/config.json" },
  { name: "npm", url: "https://npm.example.com/" },
];

function fetchWith(statuses: Record<string, number | "throw" | "hang">, seen: string[] = []): ProbeFetch {
  return async (url, init) => {
    seen.push(url);
    const outcome = statuses[url];
    if (outcome === "throw") throw new Error("connection refused");
    if (outcome === "hang") {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    }
    return { status: outcome ?? 200, body: { cancel: async () => undefined } };
  };
}

function ticking(step: number): () => number {
  let current = 1_000;
  return () => {
    current += step;
    return current;
  };
}

function valueOf(points: readonly { metric: string; value: number }[], metric: string): number | undefined {
  return points.find((point) => point.metric === metric)?.value;
}

describe("probes", () => {
  it("counts 200 and 301 as up and anything else as down", () => {
    expect([199, 200, 204, 301, 399, 400, 404, 500, 522].map(isUp)).toEqual([false, true, true, true, true, false, false, false, false]);
  });

  it("records up and a time for each probe in the current bucket", async () => {
    const points = await runProbes({
      fetch: fetchWith({ [probes[0]!.url]: 200, [probes[1]!.url]: 301 }),
      probes,
      now: NOW,
    });
    expect(points.every((point) => point.bucketMs === BUCKET)).toBe(true);
    expect(valueOf(points, "probe.crates.up")).toBe(1);
    expect(valueOf(points, "probe.npm.up")).toBe(1);
    expect(valueOf(points, "probe.crates.ms")).toBeTypeOf("number");
    expect(valueOf(points, "probe.npm.ms")).toBeTypeOf("number");
  });

  it("measures elapsed time from the injected clock", async () => {
    const points = await runProbes({
      fetch: fetchWith({ [probes[0]!.url]: 200 }),
      probes: [probes[0]!],
      now: NOW,
      clock: ticking(7),
    });
    expect(valueOf(points, "probe.crates.ms")).toBe(7);
  });

  it("does not follow redirects and asks with GET", async () => {
    const seen: unknown[] = [];
    await runProbes({
      fetch: async (_url, init) => {
        seen.push([init.method, init.redirect]);
        return { status: 301, body: null };
      },
      probes: [probes[0]!],
      now: NOW,
    });
    expect(seen).toEqual([["GET", "manual"]]);
  });

  it("marks a 500, a thrown fetch, and a timeout down with the time spent", async () => {
    const hung = { name: "hung", url: "https://hung.example.com/" };
    const thrown = { name: "thrown", url: "https://thrown.example.com/" };
    const broken = { name: "broken", url: "https://broken.example.com/" };
    const points = await runProbes({
      fetch: fetchWith({ [broken.url]: 500, [thrown.url]: "throw", [hung.url]: "hang" }),
      probes: [broken, thrown, hung],
      now: NOW,
      timeoutMs: 20,
    });
    for (const name of ["broken", "thrown", "hung"]) {
      expect(valueOf(points, `probe.${name}.up`), name).toBe(0);
      expect(valueOf(points, `probe.${name}.ms`), name).toBeGreaterThanOrEqual(0);
    }
    expect(valueOf(points, "probe.hung.ms")).toBeGreaterThanOrEqual(15);
  });

  it("makes no request when the list is empty", async () => {
    const seen: string[] = [];
    expect(await runProbes({ fetch: fetchWith({}, seen), probes: [], now: NOW })).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("probes in a collector run", () => {
  beforeEach(async () => {
    await runInDurableObject(store(), async (_instance, state) => {
      for (const table of ["project_samples", "project_hours", "collector_runs"]) state.storage.sql.exec(`DELETE FROM ${table}`);
    });
  });

  const json = JSON.stringify([{ id: "stuff", name: "stuff", worker: "stuff", workerBilling: "requests-and-cpu" as const, buckets: ["stuff-mynpm"], durableObjectNamespaces: [], d1Databases: [], probes }]);

  function store() {
    return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
  }

  function analytics(fail: boolean): AnalyticsQuery {
    return {
      async query(request) {
        if (fail) throw new Error("analytics unavailable");
        const data = request.query.includes("r2CombinedOperations") ? r2OperationsBody.data : request.query.includes("r2CombinedStorage") ? r2StorageBody.data : workerBody.data;
        return { data, statistics: { rows_read: 1 } };
      },
    };
  }

  it("stores probe results next to the analytics metrics", async () => {
    await runCollector({ analytics: analytics(false), store: store(), projectsJson: json, storeWorker: "stats", now: NOW, probeFetch: fetchWith({ [probes[1]!.url]: 500 }) });
    await runInDurableObject(store(), async (_instance, state) => {
      const rows = state.storage.sql.exec<{ metric: string; value: number }>("SELECT metric, value FROM project_samples WHERE metric LIKE 'probe.%' ORDER BY metric").toArray();
      expect(rows.map((row) => row.metric)).toEqual(["probe.crates.ms", "probe.crates.up", "probe.npm.ms", "probe.npm.up"]);
      expect(rows.filter((row) => row.metric.endsWith(".up")).map((row) => row.value)).toEqual([1, 0]);
    });
  });

  it("leaves probes absent, not down, when the collector fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: string[] = [];
    await expect(runCollector({ analytics: analytics(true), store: store(), projectsJson: json, storeWorker: "stats", now: NOW, probeFetch: fetchWith({}, seen) })).rejects.toThrow("analytics unavailable");
    await runInDurableObject(store(), async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT count(*) AS total FROM project_samples WHERE metric LIKE 'probe.%'").one().total).toBe(0);
    });
  });
});
