import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Installation } from "../src/cloudflare/installation";
import { HOUR_MS } from "../src/limits";
import type { MetricPoint } from "../src/projects/metrics";
import {
  COLLECTOR_RUNS_KEPT,
  PROJECT_HOUR_RETENTION_MS,
  PROJECT_SAMPLE_RETENTION_MS,
  PURGE_BATCH,
  purgeExpired,
  recordRun,
  upsertPoints,
} from "../src/projects/store";
import { CloudflareSql } from "../src/cloudflare/sql";

const HOUR = Date.UTC(2026, 10, 1, 12);
const BUCKET = 300_000;

let counter = 0;
function stub() {
  counter += 1;
  return env.INSTALLATION.get(env.INSTALLATION.idFromName(`projects-store-${counter}`));
}

function inside<T>(body: (sql: SqlStorage, state: DurableObjectState) => T | Promise<T>): Promise<T> {
  return runInDurableObject(stub(), async (_instance, state) => body(state.storage.sql, state));
}

function point(metric: string, bucketMs: number, value: number): MetricPoint {
  return { metric, bucketMs, value };
}

function hourValue(sql: SqlStorage, metric: string, hourMs = HOUR): number | undefined {
  return sql.exec<{ value: number }>("SELECT value FROM project_hours WHERE project = 'p' AND metric = ? AND hour_ms = ?", metric, hourMs).toArray()[0]?.value;
}

describe("project storage", () => {
  it("writes nothing when the same points arrive again", async () => {
    await inside((sql, state) => {
      const points = [
        point("worker.invocations", HOUR, 10),
        point("worker.invocations", HOUR + BUCKET, 20),
        point("worker.cpuMsMax", HOUR, 7),
      ];
      state.storage.transactionSync(() => {
        expect(upsertPoints(new CloudflareSql(state.storage), "p", points).rowsWritten).toBeGreaterThan(0);
        expect(upsertPoints(new CloudflareSql(state.storage), "p", points).rowsWritten).toBe(0);
      });
    });
  });

  it("rewrites only the changed bucket and its hour when late data corrects a value", async () => {
    await inside((sql, state) => {
      const first = [point("worker.invocations", HOUR, 10), point("worker.invocations", HOUR + BUCKET, 20)];
      state.storage.transactionSync(() => {
        upsertPoints(new CloudflareSql(state.storage), "p", first);
        const written = upsertPoints(new CloudflareSql(state.storage), "p", [first[0]!, point("worker.invocations", HOUR + BUCKET, 25)]).rowsWritten;
        expect(written).toBe(2);
      });
      expect(sql.exec("SELECT value FROM project_samples WHERE bucket_ms = ?", HOUR + BUCKET).one().value).toBe(25);
      expect(hourValue(sql, "worker.invocations")).toBe(35);
    });
  });

  it("rebuilds hours by adding sums, taking the maximum of maxes, and keeping hours apart", async () => {
    await inside((sql, state) => {
      state.storage.transactionSync(() => {
        upsertPoints(new CloudflareSql(state.storage), "p", [
          point("worker.invocations", HOUR, 1),
          point("worker.invocations", HOUR + 2 * BUCKET, 2),
          point("worker.invocations", HOUR + HOUR_MS, 4),
          point("worker.cpuMsMax", HOUR, 9),
          point("worker.cpuMsMax", HOUR + BUCKET, 30),
          point("worker.cpuMsMax", HOUR + 2 * BUCKET, 12),
          point("r2.stuff-mynpm.storageBytes", HOUR, 500),
          point("r2.stuff-mynpm.storageBytes", HOUR + 10 * BUCKET, 400),
        ]);
        upsertPoints(new CloudflareSql(state.storage), "p", [point("worker.invocations", HOUR + 3 * BUCKET, 3)]);
      });
      expect(hourValue(sql, "worker.invocations")).toBe(6);
      expect(hourValue(sql, "worker.invocations", HOUR + HOUR_MS)).toBe(4);
      expect(hourValue(sql, "worker.cpuMsMax")).toBe(30);
      expect(hourValue(sql, "r2.stuff-mynpm.storageBytes")).toBe(500);
    });
  });

  it("keeps an outage visible in the hour by taking the minimum of probe availability", async () => {
    await inside((sql, state) => {
      state.storage.transactionSync(() => {
        upsertPoints(new CloudflareSql(state.storage), "p", [point("probe.npm.up", HOUR, 1), point("probe.npm.up", HOUR + BUCKET, 0), point("probe.npm.up", HOUR + 2 * BUCKET, 1)]);
        upsertPoints(new CloudflareSql(state.storage), "p", [point("probe.npm.ms", HOUR, 80), point("probe.npm.ms", HOUR + BUCKET, 900)]);
      });
      expect(hourValue(sql, "probe.npm.up")).toBe(0);
      expect(hourValue(sql, "probe.npm.ms")).toBe(900);
    });
  });

  it("lowers a maximum hour when the corrected bucket was the maximum", async () => {
    await inside((sql, state) => {
      state.storage.transactionSync(() => {
        upsertPoints(new CloudflareSql(state.storage), "p", [point("worker.cpuMsMax", HOUR, 9), point("worker.cpuMsMax", HOUR + BUCKET, 30)]);
        upsertPoints(new CloudflareSql(state.storage), "p", [point("worker.cpuMsMax", HOUR + BUCKET, 5)]);
      });
      expect(hourValue(sql, "worker.cpuMsMax")).toBe(9);
    });
  });

  it("reads only its own project's rows when other projects share the window", async () => {
    await inside((_sql, state) => {
      const window = (metric: string) => Array.from({ length: 18 }, (_, index) => point(metric, HOUR + index * BUCKET, index + 1));
      const own = [...window("worker.invocations"), ...window("worker.cpuMsSum")];
      const metrics = Array.from({ length: 90 }, (_, index) => `route.GET /r${index}.invocations`);
      state.storage.transactionSync(() => {
        for (const other of ["a", "b", "c", "d"]) upsertPoints(new CloudflareSql(state.storage), other, metrics.flatMap(window));
        upsertPoints(new CloudflareSql(state.storage), "p", own);
        const reader = new CloudflareSql(state.storage);
        expect(upsertPoints(reader, "p", own).rowsWritten).toBe(0);
        expect(reader.total().read).toBeLessThan(own.length * 2);
      });
    });
  });

  it("reads a project with more metrics than one statement can bind", async () => {
    await inside((_sql, state) => {
      const points = Array.from({ length: 250 }, (_, index) => point(`route.GET /r${index}.invocations`, HOUR, index + 1));
      state.storage.transactionSync(() => {
        expect(upsertPoints(new CloudflareSql(state.storage), "p", points).rowsWritten).toBeGreaterThan(0);
        expect(upsertPoints(new CloudflareSql(state.storage), "p", points).rowsWritten).toBe(0);
      });
    });
  });

  it("keeps projects separate and refuses metrics it cannot aggregate", async () => {
    await inside((sql, state) => {
      state.storage.transactionSync(() => {
        upsertPoints(new CloudflareSql(state.storage), "p", [point("worker.invocations", HOUR, 1)]);
        upsertPoints(new CloudflareSql(state.storage), "q", [point("worker.invocations", HOUR, 100)]);
      });
      expect(hourValue(sql, "worker.invocations")).toBe(1);
      expect(() => upsertPoints(new CloudflareSql(state.storage), "p", [point("worker.unknown", HOUR, 1)])).toThrow("unknown project metric");
    });
  });

  it("purges expired samples and hours in batches and keeps recent rows", async () => {
    await inside((sql, state) => {
      const now = Date.UTC(2026, 10, 20);
      const old = now - PROJECT_SAMPLE_RETENTION_MS - HOUR_MS;
      const oldPoints = Array.from({ length: PURGE_BATCH + 5 }, (_, i) => point("worker.invocations", old - i * BUCKET, 1));
      state.storage.transactionSync(() => {
        upsertPoints(new CloudflareSql(state.storage), "p", [...oldPoints, point("worker.invocations", now - HOUR_MS, 1)]);
        sql.exec("INSERT INTO project_hours (project, metric, hour_ms, value) VALUES ('p', 'worker.invocations', ?, 1)", now - PROJECT_HOUR_RETENTION_MS - HOUR_MS);
      });
      const first = purgeExpired(new CloudflareSql(state.storage), now);
      expect(first.samples).toBe(PURGE_BATCH);
      expect(first.hours).toBe(1);
      const second = purgeExpired(new CloudflareSql(state.storage), now);
      expect(second.samples).toBe(5);
      expect(purgeExpired(new CloudflareSql(state.storage), now)).toEqual({ samples: 0, hours: 0 });
      expect(sql.exec("SELECT count(*) AS total FROM project_samples").one().total).toBe(1);
      expect(sql.exec("SELECT count(*) AS total FROM project_hours WHERE hour_ms >= ?", now - PROJECT_HOUR_RETENTION_MS).one().total).toBeGreaterThan(0);
    });
  });

  it("keeps the newest runs only", async () => {
    await inside((sql, state) => {
      for (let i = 0; i < COLLECTOR_RUNS_KEPT + 3; i += 1) {
        const outcome = i % 2 === 0 ? { ok: true as const, collected: [], storeOwners: [] } : { ok: false as const };
        recordRun(new CloudflareSql(state.storage), { atMs: i, detail: "d", rowsRead: 0, durationMs: 1, upstreamQueries: 0, ...outcome });
      }
      const rows = sql.exec<{ at_ms: number }>("SELECT at_ms FROM collector_runs ORDER BY id").toArray();
      expect(rows).toHaveLength(COLLECTOR_RUNS_KEPT);
      expect(rows[0]?.at_ms).toBe(3);
    });
  });
});

describe("collector run commit", () => {
  it("stores metrics with the run, and a failed run stores the run alone", async () => {
    await runInDurableObject(stub(), async (instance: Installation, state) => {
      const ok = await instance.recordCollectorRun({
        ok: true, atMs: 1, detail: "ok", rowsRead: 5, durationMs: 9, upstreamQueries: 2, storeOwners: [],
        collected: [{ project: "p", points: [point("worker.invocations", HOUR, 3)] }],
      });
      expect(ok.metricRowsWritten).toBeGreaterThan(0);
      const again = await instance.recordCollectorRun({
        ok: true, atMs: 2, detail: "ok", rowsRead: 5, durationMs: 9, upstreamQueries: 2, storeOwners: [],
        collected: [{ project: "p", points: [point("worker.invocations", HOUR, 3)] }],
      });
      expect(again.metricRowsWritten).toBe(0);
      const failed = await instance.recordCollectorRun({ ok: false, atMs: 3, detail: "query_failed", rowsRead: 0, durationMs: 4, upstreamQueries: 0 });
      expect(failed.metricRowsWritten).toBe(0);
      expect(state.storage.sql.exec("SELECT count(*) AS total FROM project_samples").one().total).toBe(1);
      expect(state.storage.sql.exec("SELECT ok FROM collector_runs ORDER BY id").toArray()).toEqual([{ ok: 1 }, { ok: 1 }, { ok: 0 }]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});
