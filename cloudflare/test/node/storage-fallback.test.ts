import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runCollector } from "../../src/cloudflare/projects/collector.ts";
import type { CollectorRun } from "../../src/projects/store.ts";

await test("the actual quiet-storage SQL carries the latest shrinking observation, keeping the R2 pair together", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("ATTACH DATABASE ':memory:' AS states; CREATE TABLE states.r2CombinedStorage (bucketName TEXT, usageReportTimestamp TEXT, payloadSizeBytes INTEGER, objectCount INTEGER); CREATE TABLE states.d1Storage (databaseId TEXT, timestamp TEXT, databaseSizeBytes INTEGER)");
  const database = "9870c4da-3758-4f0c-ab6d-2372eb34009b";
  db.prepare("INSERT INTO states.r2CombinedStorage VALUES ('quiet-bucket', ?, ?, ?)").run("2026-11-09T01:00:00.000Z", 1000, 10);
  db.prepare("INSERT INTO states.r2CombinedStorage VALUES ('quiet-bucket', ?, ?, ?)").run("2026-11-09T02:00:00.000Z", 100, 1);
  db.prepare("INSERT INTO states.d1Storage VALUES (?, ?, ?)").run(database, "2026-11-09T01:00:00.000Z", 1000);
  db.prepare("INSERT INTO states.d1Storage VALUES (?, ?, ?)").run(database, "2026-11-09T02:00:00.000Z", 100);
  const runs: CollectorRun[] = [];
  const now = Date.UTC(2026, 10, 10);
  try {
    await runCollector({
      now, storeWorker: "stats", projectsJson: JSON.stringify([{ id: "p", name: "p", worker: "p", workerBilling: "requests-and-cpu", buckets: ["quiet-bucket"], durableObjectNamespaces: [], d1Databases: [database], probes: [] }]),
      probeFetch: async () => { throw new Error("unexpected probe"); },
      store: { recordCollectorRun: async run => { runs.push(run); return { metricRowsWritten: 0 }; } },
      analytics: { query: async request => {
        if (!request.query.includes("ORDER BY") || !/states\.(r2CombinedStorage|d1Storage)/u.test(request.query)) return { data: [], statistics: { rows_read: 0 } };
        const rows = db.prepare(request.query).all(Object.fromEntries(Object.entries(request.params).map(([key, value]) => [key, typeof value === "boolean" ? Number(value) : value])));
        return { data: rows.map(row => ({ ...row, bucket: String(row["bucket"]).replace("T", " ").replace(".000Z", "") })), statistics: { rows_read: rows.length } };
      } }
    });
    const run = runs[0]!;
    assert.ok(run.ok);
    const values = Object.fromEntries(run.collected[0]!.points.map(point => [point.metric, point.value]));
    assert.equal(values["r2.quiet-bucket.storageBytes"], 100);
    assert.equal(values["r2.quiet-bucket.objects"], 1);
    assert.equal(values[`d1.${database}.storageBytes`], 100);
  } finally { db.close(); }
});
