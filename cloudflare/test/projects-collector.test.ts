import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCollector, windowStartMs, type AnalyticsQuery } from "../src/projects/collector";
import { readMetricHistory } from "../src/projects/history";
import { SqlAccount } from "../src/sql-account";
import type { ProbeFetch } from "../src/projects/probes";
import type { BoundQuery } from "../src/projects/queries";
import r2OperationsBody from "./fixtures/analytics/r2-operations.json";
import r2StorageBody from "./fixtures/analytics/r2-storage.json";
import workerBody from "./fixtures/analytics/worker.json";

const NOW = Date.UTC(2026, 10, 1, 16, 35);
const PROJECTS = JSON.stringify([
  { id: "stuff", name: "stuff", worker: "stuff", buckets: ["stuff-mycrates", "stuff-mynpm", "stuff-mypypi"], durableObjectNamespaces: [], d1Databases: [], probes: [] },
]);

type Rows = { worker: unknown[]; routes: unknown[]; durableObjects: unknown[]; operations: unknown[]; storage: unknown[] };

function fixtureRows(): Rows {
  return {
    worker: structuredClone(workerBody.data),
    routes: [],
    durableObjects: [],
    operations: structuredClone(r2OperationsBody.data),
    storage: structuredClone(r2StorageBody.data),
  };
}

function fakeAnalytics(rows: Rows, options: { failOn?: "operations" } = {}): AnalyticsQuery & { calls: BoundQuery[] } {
  const calls: BoundQuery[] = [];
  return {
    calls,
    async query(request) {
      calls.push(request);
      if (request.query.includes("r2CombinedOperations")) {
        if (options.failOn === "operations") throw new Error("analytics unavailable");
        return { data: rows.operations, statistics: { rows_read: 100 } };
      }
      if (request.query.includes("r2CombinedStorage")) return { data: rows.storage, statistics: { rows_read: 10 } };
      if (request.query.includes("invocationLabel")) return { data: rows.routes, statistics: { rows_read: 1000 } };
      if (request.query.includes("durableObjectsInvocations")) return { data: rows.durableObjects, statistics: { rows_read: 100 } };
      return { data: rows.worker, statistics: { rows_read: 1000 } };
    },
  };
}

function stub() {
  return env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
}

const noProbes: ProbeFetch = async () => {
  throw new Error("this registry configures no probes");
};

function collect(store: ReturnType<typeof stub>, analytics: AnalyticsQuery, now = NOW) {
  return runCollector({ analytics, store, projectsJson: PROJECTS, storeWorker: "stats", now, probeFetch: noProbes });
}

function inside<T>(store: ReturnType<typeof stub>, body: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(store, async (_instance, state) => body(state.storage.sql));
}

beforeEach(async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    for (const table of ["project_samples", "project_hours", "collector_runs"]) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collector", () => {
  it("stores the first run and writes nothing for an identical second run", async () => {
    const store = stub();
    const analytics = fakeAnalytics(fixtureRows());
    const first = await collect(store, analytics);
    expect(first.metricRowsWritten).toBeGreaterThan(0);
    const second = await collect(store, analytics, NOW + 300_000);
    expect(second.metricRowsWritten).toBe(0);
    await inside(store, (sql) => {
      expect(sql.exec("SELECT ok FROM collector_runs ORDER BY id").toArray()).toEqual([{ ok: 1 }, { ok: 1 }]);
      expect(sql.exec("SELECT rows_read FROM collector_runs").toArray()).toEqual([{ rows_read: 2110 }, { rows_read: 2110 }]);
    });
  });

  it("replaces a value when later data raises it and keeps the rewrite small", async () => {
    const store = stub();
    const rows = fixtureRows();
    await collect(store, fakeAnalytics(rows));
    const changed = rows.worker[0] as { invocations: number; hour: number; slot: number };
    const before = changed.invocations;
    changed.invocations = before + 40;
    const result = await collect(store, fakeAnalytics(rows), NOW + 300_000);
    expect(result.metricRowsWritten).toBeGreaterThan(0);
    expect(result.metricRowsWritten).toBeLessThanOrEqual(60);
    await inside(store, (sql) => {
      const total = sql.exec<{ value: number }>("SELECT SUM(value) AS value FROM project_samples WHERE metric = 'worker.invocations'").one().value;
      const expected = workerBody.data.reduce((sum, row) => sum + row.invocations, 0) + 40;
      expect(total).toBe(expected);
    });
  });

  it("asks at most six bound queries per project over the trailing window", async () => {
    const analytics = fakeAnalytics(fixtureRows());
    const result = await collect(stub(), analytics);
    expect(result.queries).toBe(4);
    expect(analytics.calls).toHaveLength(4);
    for (const call of analytics.calls) {
      expect(call.params["start"]).toBe(new Date(windowStartMs(NOW)).toISOString());
    }
    expect(windowStartMs(NOW)).toBe(Date.UTC(2026, 10, 1, 15, 5));
  });

  it("asks only the Worker and route queries for a project without buckets or namespaces", async () => {
    const analytics = fakeAnalytics(fixtureRows());
    const result = await runCollector({
      analytics,
      store: stub(),
      projectsJson: JSON.stringify([{ id: "stats", name: "stats", worker: "stats", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [] }]),
      storeWorker: "elsewhere",
      now: NOW,
      probeFetch: noProbes,
    });
    expect(result.queries).toBe(2);
    expect(analytics.calls.map((call) => call.query).join(" ")).not.toContain("r2Combined");
  });

  it("records the object's own SQLite size for the project whose Worker owns it, and for no other", async () => {
    const store = stub();
    const owner = { id: "stats", name: "stats", worker: "stats", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [] };
    const other = { ...owner, id: "stuff", name: "stuff", worker: "stuff" };
    await runCollector({ analytics: fakeAnalytics(fixtureRows()), store, projectsJson: JSON.stringify([owner, other]), storeWorker: "stats", now: NOW, probeFetch: noProbes });
    await inside(store, (sql) => {
      const sizes = (project: typeof owner) => readMetricHistory(new SqlAccount(sql), project, { range: "1h" }, "durable-objects", NOW).series.find((series) => series.metric === "do.storageBytes")!.values;
      const recorded = sizes(owner).filter((value) => value !== null);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toBeGreaterThan(0);
      expect(recorded[0]).toBeLessThanOrEqual(sql.databaseSize);
      expect(sizes(other).every((value) => value === null)).toBe(true);
    });
  });

  it("collects D1 totals and ranks statements by billed cost, folding whitespace and keeping ten", async () => {
    const bucket = "2026-11-01 16:05:00";
    const statement = (text: string, queries: number, rows_read: number, rows_written: number) => ({ bucket, statement: text, queries, rows_read, rows_written });
    const d1Statements = [
      statement("SELECT *\n  FROM big_read", 10, 2_000_000, 0),
      statement("UPDATE hot   SET a = ?", 10, 10, 2_000),
      statement("UPDATE hot SET a = ?", 5, 5, 1_000),
      ...Array.from({ length: 12 }, (_, i) => statement(`INSERT INTO t${i} VALUES (?)`, 1, 0, 1 + i)),
    ];
    const analytics: AnalyticsQuery = {
      async query(request) {
        if (request.query.includes("d1Storage")) {
          return { data: [{ databaseId: "9870c4da-3758-4f0c-ab6d-2372eb34009b", bucket, size_bytes: 245_923_840 }], statistics: { rows_read: 5 } };
        }
        if (request.query.includes("d1Queries")) {
          const data = request.query.includes("AS statement") ? d1Statements : [{ bucket, queries: 40, rows_read: 2_000_015, rows_written: 3_078 }];
          return { data, statistics: { rows_read: 10 } };
        }
        return { data: [], statistics: { rows_read: 1 } };
      },
    };
    const store = stub();
    const projectsJson = JSON.stringify([{ id: "memories", name: "memories", worker: "memories", buckets: [], durableObjectNamespaces: [], d1Databases: ["9870c4da-3758-4f0c-ab6d-2372eb34009b"], probes: [] }]);
    const result = await runCollector({ analytics, store, projectsJson, storeWorker: "stats", now: NOW, probeFetch: noProbes });
    expect(result.queries).toBe(5);
    await inside(store, (sql) => {
      const project = { id: "memories", name: "memories", worker: "memories", buckets: [], durableObjectNamespaces: [], d1Databases: [], probes: [] };
      const withDatabase = { ...project, d1Databases: ["9870c4da-3758-4f0c-ab6d-2372eb34009b"] };
      const sizes = readMetricHistory(new SqlAccount(sql), withDatabase, { range: "1h" }, "d1", NOW).series.find((series) => series.metric === "d1.9870c4da-3758-4f0c-ab6d-2372eb34009b.storageBytes");
      expect(Math.max(...(sizes?.values ?? []).map((value) => value ?? 0))).toBe(245_923_840);
      const totals = readMetricHistory(new SqlAccount(sql), project, { range: "1h" }, "d1", NOW).series;
      const written = totals.find((series) => series.metric === "d1.rowsWritten")?.values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      expect(written).toBe(3_078);
      const ranked = readMetricHistory(new SqlAccount(sql), project, { range: "1h" }, "d1-statements", NOW).series.filter((series) => series.metric.endsWith(".rowsWritten")).map((series) => series.metric);
      expect(ranked).toHaveLength(10);
      expect(ranked[0]).toBe("d1q.UPDATE hot SET a = ?.rowsWritten");
      expect(ranked[1]).toBe("d1q.SELECT * FROM big_read.rowsWritten");
      const hot = readMetricHistory(new SqlAccount(sql), project, { range: "1h" }, "d1-statements", NOW).series.find((series) => series.metric === "d1q.UPDATE hot SET a = ?.rowsWritten");
      expect(hot?.values.reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBe(3_000);
    });
  });

  it("records a failed run, writes no metrics, logs one fixed line, and rethrows", async () => {
    const store = stub();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(collect(store, fakeAnalytics(fixtureRows(), { failOn: "operations" }))).rejects.toThrow("analytics unavailable");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "collector_failed" }));
    await inside(store, (sql) => {
      expect(sql.exec("SELECT count(*) AS total FROM project_samples").one().total).toBe(0);
      expect(sql.exec("SELECT count(*) AS total FROM project_hours").one().total).toBe(0);
      expect(sql.exec("SELECT ok, detail FROM collector_runs").toArray()).toEqual([{ ok: 0, detail: "collector_failed" }]);
    });
  });

  it("keeps earlier metrics when a later run fails", async () => {
    const store = stub();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await collect(store, fakeAnalytics(fixtureRows()));
    await expect(collect(store, fakeAnalytics(fixtureRows(), { failOn: "operations" }), NOW + 300_000)).rejects.toThrow("analytics unavailable");
    await inside(store, (sql) => {
      expect(sql.exec("SELECT count(*) AS total FROM project_samples").one().total).toBeGreaterThan(0);
      expect(sql.exec("SELECT ok FROM collector_runs ORDER BY id").toArray()).toEqual([{ ok: 1 }, { ok: 0 }]);
    });
  });

  it("fails loudly on a malformed row and on an invalid registry without storing metrics", async () => {
    const store = stub();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rows = fixtureRows();
    rows.worker.push({ day: "2026-11-01" });
    await expect(collect(store, fakeAnalytics(rows))).rejects.toThrow(TypeError);
    await expect(runCollector({ analytics: fakeAnalytics(fixtureRows()), store, projectsJson: "{", storeWorker: "stats", now: NOW, probeFetch: noProbes })).rejects.toThrow("not valid JSON");
    await inside(store, (sql) => {
      expect(sql.exec("SELECT count(*) AS total FROM project_samples").one().total).toBe(0);
      expect(sql.exec("SELECT count(*) AS total FROM collector_runs WHERE ok = 0").one().total).toBe(2);
    });
  });
});

describe("collector failure reporting", () => {
  type Store = Parameters<typeof runCollector>[0]["store"];
  const noProbesFetch: ProbeFetch = async () => {
    throw new Error("unused");
  };

  it("rethrows the analytics error even when the failed run cannot be recorded", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store: Store = {
      async recordCollectorRun() {
        throw new Error("storage unavailable");
      },
    };
    await expect(runCollector({ analytics: fakeAnalytics(fixtureRows(), { failOn: "operations" }), store, projectsJson: PROJECTS, storeWorker: "stats", now: NOW, probeFetch: noProbesFetch })).rejects.toThrow("analytics unavailable");
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "collector_run_unrecorded" }));
  });

  it("records a failed run and rethrows when committing the metrics fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recorded: boolean[] = [];
    const store: Store = {
      async recordCollectorRun(run) {
        recorded.push(run.ok);
        if (run.ok) throw new Error("commit failed");
        return { metricRowsWritten: 0 };
      },
    };
    await expect(runCollector({ analytics: fakeAnalytics(fixtureRows()), store, projectsJson: PROJECTS, storeWorker: "stats", now: NOW, probeFetch: noProbesFetch })).rejects.toThrow("commit failed");
    expect(recorded).toEqual([true, false]);
  });
});

