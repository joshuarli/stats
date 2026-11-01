import { describe, expect, it } from "vitest";
import {
  aggregationOf,
  parseR2OperationRows,
  parseR2StorageRows,
  parseWorkerRows,
  statusClass,
  workerBucketMs,
} from "../src/projects/parse";
import {
  d1Query,
  d1StatementQuery,
  MAX_BUCKETS_PER_PROJECT,
  r2OperationsQuery,
  r2StorageQuery,
  workerQuery,
} from "../src/projects/queries";
import r2OperationsBody from "./fixtures/analytics/r2-operations.json";
import r2StorageBody from "./fixtures/analytics/r2-storage.json";
import workerBody from "./fixtures/analytics/worker.json";

const START_MS = Date.UTC(2026, 10, 1, 15, 0);
const BUCKETS = ["stuff-mycrates", "stuff-mynpm", "stuff-mypypi"];
const DATABASE = "9870c4da-3758-4f0c-ab6d-2372eb34009b";

const built = {
  worker: workerQuery("stuff", START_MS),
  r2Operations: r2OperationsQuery(BUCKETS, START_MS),
  r2Storage: r2StorageQuery(BUCKETS, START_MS),
  d1: d1Query([DATABASE], START_MS),
};

function total(points: readonly { metric: string; value: number }[], metric: string): number {
  return points.filter((point) => point.metric === metric).reduce((sum, point) => sum + point.value, 0);
}

describe("analytics query text", () => {
  it.each(Object.entries(built))("%s binds every value and respects the SQL dialect", (_name, bound) => {
    const sql = bound.query;
    expect(sql).not.toMatch(/COUNT\s*\(/i);
    expect(sql).not.toMatch(/\bMIN\s*\(/i);
    expect(sql).not.toMatch(/toStartOfInterval|quantile/i);
    if (sql !== built.r2Storage.query) {
      expect(sql.replaceAll("APPROX_MAX(", "")).not.toMatch(/\bMAX\s*\(/i);
    }
    expect(sql).not.toMatch(/ORDER BY/i);
    expect(sql).toMatch(/LIMIT \d+$/);
    expect(sql).toMatch(/>= \$start/);
    expect(sql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    for (const [key, value] of Object.entries(bound.params)) {
      expect(sql).toContain(`$${key}`);
      if (typeof value === "string") {
        expect(sql).not.toContain(value);
      }
    }
  });

  it("weights D1 rows by sampleInterval, binds the database id, and orders statements by rows written", () => {
    const statements = d1StatementQuery([DATABASE], START_MS);
    for (const bound of [built.d1, statements]) {
      expect(bound.query).toMatch(/SUM\(rowsRead \* sampleInterval\) AS rows_read/u);
      expect(bound.query).toMatch(/SUM\(rowsWritten \* sampleInterval\) AS rows_written/u);
      expect(bound.query).not.toContain(DATABASE);
      expect(bound.params["database0"]).toBe(DATABASE);
    }
    expect(statements.query).toMatch(/ORDER BY rows_written DESC LIMIT \d+$/u);
    expect(() => d1Query([], START_MS)).toThrow(RangeError);
    expect(() => d1Query(["x' OR 1=1 --"], START_MS)).toThrow(RangeError);
  });

  it("weights event counts by sampleInterval and groups each dataset on its own time column", () => {
    expect(built.worker.query).toMatch(/SUM\([^)]*sampleInterval[^)]*\) AS invocations/u);
    expect(built.worker.query).toMatch(/SUM\([^)]*sampleInterval[^)]*\) AS cpu_sum/u);
    expect(built.worker.query).toContain("APPROX_MAX(cpuTimeMs)");
    expect(built.r2Operations.query).toMatch(/SUM\([^)]*sampleInterval[^)]*\) AS operations/u);
    expect(built.worker.query).toMatch(/GROUP BY toDate\(timestamp\), toHour\(timestamp\), floor\(toMinute\(timestamp\) \/ 5\), httpStatus/u);
    expect(built.r2Operations.query).toContain("toStartOfFiveMinutes(timestamp)");
    expect(built.r2Storage.query).toContain("usageReportTimestamp >= $start");
    expect(built.r2Storage.query).toContain("toStartOfTenMinutes(usageReportTimestamp)");
    expect(built.r2Storage.query).toContain("MAX(payloadSizeBytes)");
  });

  it("passes the start as an ISO instant, binds each bucket, and rejects values that could change the statement", () => {
    expect(built.worker.params).toEqual({ script: "stuff", start: "2026-11-01T15:00:00.000Z" });
    expect(built.r2Operations.params).toEqual({
      bucket0: "stuff-mycrates",
      bucket1: "stuff-mynpm",
      bucket2: "stuff-mypypi",
      start: "2026-11-01T15:00:00.000Z",
    });
    expect(built.r2Operations.query).toContain("bucketName IN ($bucket0, $bucket1, $bucket2)");

    expect(() => r2OperationsQuery(["a') OR ('1'='1"], START_MS)).toThrow(RangeError);
    expect(() => r2StorageQuery([], START_MS)).toThrow(RangeError);
    expect(() =>
      r2StorageQuery(Array.from({ length: MAX_BUCKETS_PER_PROJECT + 1 }, (_, i) => `bucket-${i}`), START_MS),
    ).toThrow(RangeError);
    expect(() => workerQuery("stuff", -1)).toThrow(RangeError);
  });
});

describe("worker rows", () => {
  it("keeps invocations, status mix, and CPU consistent with the captured result", () => {
    const points = parseWorkerRows(workerBody.data);
    const invocations = workerBody.data.reduce((sum, row) => sum + row.invocations, 0);
    const cpuSum = workerBody.data.reduce((sum, row) => sum + row.cpu_sum, 0);
    expect(total(points, "worker.invocations")).toBe(invocations);
    expect(total(points, "worker.cpuMsSum")).toBe(cpuSum);
    const statusTotal = points
      .filter((point) => point.metric.startsWith("worker.status."))
      .reduce((sum, point) => sum + point.value, 0);
    expect(statusTotal).toBe(invocations);
    expect(Math.max(...points.filter((p) => p.metric === "worker.cpuMsMax").map((p) => p.value))).toBe(
      Math.max(...workerBody.data.map((row) => row.cpu_max)),
    );
  });

  it("rebuilds the bucket start from day, hour, and slot across midnight", () => {
    expect(workerBucketMs("2026-11-01", 23, 11)).toBe(Date.UTC(2026, 10, 1, 23, 55));
    expect(workerBucketMs("2026-11-02", 0, 0)).toBe(Date.UTC(2026, 10, 2, 0, 0));
    const points = parseWorkerRows([
      { day: "2026-12-31", hour: 23, slot: 11, httpStatus: 200, invocations: 4, cpu_sum: 8, cpu_max: 3 },
      { day: "2027-01-01", hour: 0, slot: 0, httpStatus: 200, invocations: 8, cpu_sum: 16, cpu_max: 2 },
    ]);
    const starts = [...new Set(points.map((point) => point.bucketMs))].sort((a, b) => a - b);
    expect(starts).toEqual([Date.UTC(2026, 11, 31, 23, 55), Date.UTC(2027, 0, 1, 0, 0)]);
  });

  it("classifies status 0, 1xx, and 5xx and merges statuses of one class", () => {
    expect([0, 100, 199, 200, 299, 300, 404, 499, 500, 599, 600].map(statusClass)).toEqual([
      "other", "other", "other", "2xx", "2xx", "3xx", "4xx", "4xx", "5xx", "5xx", "other",
    ]);
    const row = { day: "2026-11-01", hour: 1, slot: 2, cpu_sum: 10, cpu_max: 5 };
    const points = parseWorkerRows([
      { ...row, httpStatus: 0, invocations: 4 },
      { ...row, httpStatus: 500, invocations: 8 },
      { ...row, httpStatus: 503, invocations: 4 },
      { ...row, httpStatus: 200, invocations: 12 },
    ]);
    const at = (metric: string) => points.find((point) => point.metric === metric)?.value;
    expect(at("worker.status.other")).toBe(4);
    expect(at("worker.status.5xx")).toBe(12);
    expect(at("worker.status.2xx")).toBe(12);
    expect(at("worker.status.3xx")).toBeUndefined();
    expect(at("worker.invocations")).toBe(28);
    expect(at("worker.cpuMsSum")).toBe(40);
    expect(at("worker.cpuMsMax")).toBe(5);
  });

  it("accepts decimal-string counters and rejects malformed rows", () => {
    const ok = { day: "2026-11-01", hour: 0, slot: 0, httpStatus: 200, cpu_sum: "9", cpu_max: 1 };
    expect(total(parseWorkerRows([{ ...ok, invocations: "12" }]), "worker.invocations")).toBe(12);
    expect(() => parseWorkerRows([{ ...ok, invocations: -1 }])).toThrow(TypeError);
    expect(() => parseWorkerRows([{ ...ok, invocations: "1e3" }])).toThrow(TypeError);
    expect(() => parseWorkerRows([{ ...ok, invocations: null }])).toThrow(TypeError);
    expect(() => parseWorkerRows([{ ...ok, invocations: 1, slot: 12 }])).toThrow(RangeError);
    expect(() => parseWorkerRows([{ ...ok, invocations: 1, day: "yesterday" }])).toThrow(RangeError);
    expect(() => parseWorkerRows(["row"])).toThrow(TypeError);
  });
});

describe("R2 rows", () => {
  it("keeps outcome counts and storage gauges from the captured results", () => {
    const operations = parseR2OperationRows(r2OperationsBody.data);
    const all = r2OperationsBody.data.reduce((sum, row) => sum + row.operations, 0);
    expect(operations.reduce((sum, point) => sum + point.value, 0)).toBe(all);
    const metrics = new Set(operations.map((point) => point.metric));
    expect(metrics).toContain("r2.stuff-mycrates.ops.other");
    expect(metrics).toContain("r2.stuff-mynpm.ops.userError");
    for (const point of operations) {
      expect(point.bucketMs % 300_000).toBe(0);
    }
    const storage = parseR2StorageRows(r2StorageBody.data);
    expect(storage).toHaveLength(r2StorageBody.data.length * 2);
    expect(storage.map((point) => aggregationOf(point.metric))).toEqual(storage.map(() => "max"));
  });

  it("scores only success as good and treats unknown outcomes as other", () => {
    const row = { bucketName: "stuff-mynpm", bucket: "2026-11-01 15:05:00", operations: 3 };
    const points = parseR2OperationRows([
      { ...row, actionStatus: "success" },
      { ...row, actionStatus: "userError" },
      { ...row, actionStatus: "internalError" },
      { ...row, actionStatus: "timeout" },
    ]);
    expect(points.map((point) => [point.metric, point.value])).toEqual([
      ["r2.stuff-mynpm.ops.success", 3],
      ["r2.stuff-mynpm.ops.userError", 3],
      ["r2.stuff-mynpm.ops.other", 6],
    ]);
  });

  it("rejects timestamps and bucket names it cannot place", () => {
    const row = { bucketName: "stuff-mynpm", bucket: "2026-11-01 15:05:00", actionStatus: "success", operations: 1 };
    expect(() => parseR2OperationRows([{ ...row, bucket: "2026-11-01T15:05:00Z" }])).toThrow(RangeError);
    expect(() => parseR2OperationRows([{ ...row, bucketName: "Bad.Name" }])).toThrow(RangeError);
    expect(() => parseR2StorageRows([{ bucketName: "stuff-mynpm", bucket: "2026-11-01 15:00:00", storage_bytes: null, objects: 1 }])).toThrow(TypeError);
  });
});

describe("metric aggregation", () => {
  it("tags counters as sums and gauges as maxes", () => {
    expect(aggregationOf("worker.invocations")).toBe("sum");
    expect(aggregationOf("worker.cpuMsMax")).toBe("max");
    expect(aggregationOf("r2.stuff-mynpm.ops.userError")).toBe("sum");
    expect(aggregationOf("r2.stuff-mynpm.storageBytes")).toBe("max");
    expect(aggregationOf("probe.crates.up")).toBe("min");
    expect(aggregationOf("probe.crates.ms")).toBe("max");
    expect(() => aggregationOf("worker.errors")).toThrow(RangeError);
    expect(() => aggregationOf("r2.stuff-mynpm.ops.other.extra")).toThrow(RangeError);
  });
});
