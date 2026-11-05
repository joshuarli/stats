import test from "node:test";
import assert from "node:assert/strict";
import { prepareTailItems, type TailItem } from "../../src/observe/cloudflare/tail.ts";
import { POLICIES } from "../../src/observe/cloudflare/policies.ts";
import { OBSERVE_CHANNEL } from "../../src/observe/producer/channel.ts";
import { ingest } from "../../src/observe/core/store.ts";
import { createObserveService } from "../../src/observe/core/service.ts";
import { handleApi } from "../../src/observe/http/api.ts";
import { OBJECT, T0, VERSION, database, hex } from "./support.ts";

function item(n: number, overrides: Partial<TailItem> & { url?: string; status?: number; method?: string; service?: string } = {}): TailItem {
  const trace = { traceId: hex(n + 1, 32), spanId: hex(2 * n + 1, 16) };
  const { url = "https://s.example/api/v1/hosts", status = 200, method = "GET", service, ...rest } = overrides;
  const message = service === undefined ? { kind: "invocation", ...trace } : { kind: "operation", ...trace, operation: service, synthetic: false, rows: null };
  return {
    event: { request: { url, method }, response: { status } }, eventTimestamp: T0 + n * 7_000, exceptions: [], diagnosticsChannelEvents: [{ channel: OBSERVE_CHANNEL, message }],
    scriptVersion: { id: VERSION }, executionModel: "stateless", outcome: "ok", cpuTime: 1 + (n % 4), wallTime: 10 + (n % 50), ...rest
  };
}

const FAILURE = { outcome: "exception", exceptions: [{ name: "TypeError", message: "boom", stack: "    at f (index.js:10:3)" }] };
const SCENARIOS = {
  stats: {
    batches: [
      [item(0)],
      [item(1, { url: "https://s.example/ingest/v2/batches", status: 500, ...FAILURE }), item(2, { event: { rpcMethod: "ingest" }, executionModel: "durableObject", durableObjectId: OBJECT, entrypoint: "Installation" }), item(3, { url: "https://s.example/health" })],
      [item(4, { status: 404 })],
      [item(5, { status: 401 }), item(6, { diagnosticsChannelEvents: [{ channel: OBSERVE_CHANNEL, message: { kind: "invocation", traceId: 7 } }] }), item(7, { wallTime: 500, cpuTime: 30 }), item(8)]
    ],
    rows: [2, 6, 2, 6]
  },
  "usr-memories": {
    batches: [
      [item(0, { url: "https://m.example/api/v1/sync/objects/abc", service: "request.route" })],
      [item(1, { url: "https://m.example/api/v1/sync/replace", status: 500, service: "sync.replace", ...FAILURE }), item(2, { url: "https://m.example/", service: "request.route" }), item(3, { url: "https://m.example/api/v1/status", status: 403 })],
      [item(4, { url: "https://m.example/m/p/1", service: "request.auth" })],
      [item(5, { url: "https://m.example/api/v1/sync/objects/abc", service: "request.route" })]
    ],
    rows: [2, 6, 2, 2]
  }
} as const;

for (const service of ["stats", "usr-memories"] as const) {
  await test(`${service} writes the same rows per batch and answers without sampling fields`, async () => {
    const db = database();
    const policy = POLICIES[service];
    const rows: number[] = [];
    let now = T0;
    for (const batch of SCENARIOS[service].batches) {
      now = Math.max(...batch.map(entry => entry.eventTimestamp ?? 0)) + 2_000;
      const prepared = await prepareTailItems(batch, policy, now);
      const before = db.rowsWritten();
      ingest(db, prepared.preparations, now, prepared.outcomes);
      rows.push(db.rowsWritten() - before);
    }
    assert.deepEqual(rows, SCENARIOS[service].rows);
    assert.equal(db.rows("SELECT 1 FROM observe_counts").length, 0);
    const api = createObserveService(db, { now: () => now + 1_000, databaseBytes: () => 0 });
    const from = T0 - 300_000;
    const to = T0 + 3_600_000;
    const aligned = T0 - (T0 % 300_000);
    for (const path of ["/health", `/explore?from=${from}&to=${to}`, `/objects?from=${from}&to=${to}`, `/traces?from=${from}&to=${to}`, `/window?from=${aligned}&to=${aligned + 3_600_000}`, `/traces/${hex(2, 32)}`]) {
      const text = JSON.stringify(await (await handleApi(new Request(`https://o.test${path}`), path.split("?")[0]!, api)).json());
      assert.ok(!text.includes("sampling") && !text.includes("observed"), path);
    }
  });
}
