import assert from "node:assert/strict";
import test from "node:test";
import { database, T0, H, D } from "./support.ts";
import { ingestExternal } from "../../src/observe/core/store.ts";
import { receiveEvents } from "../../src/observe/ingest/failures.ts";
import { readApplicationSummary } from "../../src/observe/application/telemetry.ts";
import type { ExternalEvent } from "../../src/observe/ingest/model.ts";
import type { SqlValue } from "../../src/core/sql.ts";

await test("rollup rows equal raw aggregates across unaligned windows and canonical mutations", async context => {
  const db = database();
  try {
    const events: ExternalEvent[] = Array.from({ length: 540 }, (_, i) => ({ schemaVersion: 1, eventId: `e${i}`, atMs: T0 - H + Math.floor(i / 3) * 6731 + i % 3 * 231 + Math.floor(i / 3) % 17, operation: `op${Math.floor(i / 3) % 24}`, outcome: i % 3 === 0 ? "cancelled" : i % 2 === 0 ? "ok" : "error", durationMs: i, work: i % 4 === 0 ? { http_status: 200 + i % 400 } : {}, release: "r", service: "stats" }));
    for (let i = 0; i < events.length; i += 60) ingestExternal(db, "stats", await receiveEvents("stats", events.slice(i, i + 60)), T0);
    for (const [id, atMs, payload] of [
      ["legacy-missing-first", T0 - H + 931, '{"operation":"nullable"}'],
      ["legacy-known", T0 - H + 731, '{"operation":"nullable","outcome":"ok","durationMs":7,"work":{"http_status":200}}'],
      ["legacy-missing-next-second", T0 - H + 2030, '{"operation":"nullable"}']
    ] as const) db.run("INSERT INTO observe_external_events VALUES ('stats', ?, ?, ?, 'application', ?)", id, T0, atMs, payload);
    const original = db.rows.bind(db);
    const measures = `COUNT(*) AS events, SUM(outcome <> 'ok') AS failed, SUM(outcome = 'cancelled') AS cancelled, SUM(http_status IS NOT NULL) AS requests, SUM(CASE WHEN http_status IS NOT NULL THEN duration_ms ELSE 0 END) AS requestDurationMsSum, MAX(CASE WHEN http_status IS NOT NULL THEN duration_ms ELSE 0 END) AS requestDurationMsMax, SUM(CASE WHEN http_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS status2xx, SUM(CASE WHEN http_status BETWEEN 300 AND 399 THEN 1 ELSE 0 END) AS status3xx, SUM(CASE WHEN http_status BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS status4xx, SUM(CASE WHEN http_status BETWEEN 500 AND 599 THEN 1 ELSE 0 END) AS status5xx, SUM(duration_ms) AS durationMsSum, MAX(duration_ms) AS durationMsMax, MIN(event_at) AS firstAtMs, MAX(event_at) AS lastAtMs`;
    let actual: unknown;
    let oracle: ReturnType<typeof original> | undefined;
    context.mock.method(db, "rows", (sql: string, ...args: SqlValue[]) => { const rows = sql.includes("WITH ranges") && oracle !== undefined ? oracle : original(sql, ...args); if (sql.includes("WITH ranges")) actual = rows; return rows; });
    const check = () => {
      for (const [from, to] of [[T0 - H + 31, T0 - H + 900003], [T0 - H + 999, T0 - H + 120001], [T0 - H, T0], [T0 - 6 * H + 31, T0], [T0 - D + 999, T0 - 1234], [T0 - 7 * D + 31, T0]] as const) {
        const result = readApplicationSummary(db, "stats", T0, { fromMs: from, toMs: to });
        const raw = original(`SELECT * FROM (WITH events AS MATERIALIZED (SELECT event_at, operation, outcome, duration_ms, NULLIF(http_status, 0) AS http_status FROM observe_application_projection WHERE service = ? AND event_at >= ? AND event_at < ?), buckets AS (SELECT 0 AS kind, CAST((event_at - ?) / ? AS INTEGER) * ? + ? AS atMs, NULL AS operation, ${measures} FROM events GROUP BY atMs), operations AS (SELECT 1 AS kind, NULL AS atMs, operation, ${measures} FROM events GROUP BY operation ORDER BY events DESC, operation LIMIT 21) SELECT * FROM buckets UNION ALL SELECT * FROM operations) ORDER BY kind, atMs, events DESC, operation`, "stats", from!, to!, from!, result.stepMs, result.stepMs, from!);
        assert.deepEqual(actual, raw);
        oracle = raw;
        assert.equal(JSON.stringify(readApplicationSummary(db, "stats", T0, { fromMs: from, toMs: to })), JSON.stringify(result));
        oracle = undefined;
      }
    };
    check();
    db.run("UPDATE observe_external_events SET event_at = event_at + 1299, payload = '{}' WHERE event_id = ?", "e1");
    db.run("UPDATE observe_external_events SET payload = ? WHERE event_id = ?", '{"operation":""}', "e4");
    db.run("DELETE FROM observe_external_events WHERE event_id IN ('e2', 'e3', 'e5', 'legacy-known')");
    check();
  } finally { db.db.close(); }
});
