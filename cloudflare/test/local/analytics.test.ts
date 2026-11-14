import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { offlineOutbound } from "../../local/outbound.ts";
import { gatewayHeaders } from "../gateway-headers.ts";
import { offlineAnalytics, UNEXPECTED_QUERY, type OfflineAnalytics } from "../../local/analytics.ts";
import { DATASETS, QUERY_KINDS, RECORDED_AT_MS, expectedQueries, queryKey, rows, scenario, type QueryKind } from "../../local/scenario.ts";
import { CLOUDFLARE_ROOT, OBSERVE_OUTPUT, STATS_OUTPUT, openWorkers, readBuiltWorker, readTestVars } from "../../local/topology.ts";

const STATS = readBuiltWorker(STATS_OUTPUT);
const OBSERVE = readBuiltWorker(OBSERVE_OUTPUT);
const PRODUCTION_PROJECTS = (() => {
  const binding = STATS.env.get("PROJECTS");
  if (binding?.type !== "text") throw new TypeError("the built stats config has no PROJECTS text binding");
  return binding.value;
})();
const { GATEWAY_SECRET } = readTestVars();
const SCRATCH = join(CLOUDFLARE_ROOT, "../.work/tmp");
const CALLER = `export default { async fetch(request, env) {
  try { return Response.json({ ok: true, result: await env.ANALYTICS_SQL.query(await request.json()) }); }
  catch (error) { return Response.json({ ok: false, error: String(error.message) }); }
} };`;

mkdirSync(SCRATCH, { recursive: true });
const persist = mkdtempSync(join(SCRATCH, "analytics-"));
const provider: OfflineAnalytics = offlineAnalytics(STATS);
const mf = openWorkers(STATS, OBSERVE, {
  text: { ENVIRONMENT: "test" },
  secrets: { GATEWAY_SECRET: GATEWAY_SECRET!, TEST_NOW_MS: String(RECORDED_AT_MS) },
  analytics: provider.binding,
  collector: { kind: "absent" },
  outbound: offlineOutbound([]).handler,
  persist: { directory: persist },
  alarms: "platform",
  extraWorkers: [provider.worker, { name: "analytics-caller", modules: true, script: CALLER, compatibilityDate: STATS.compatibilityDate, serviceBindings: { ANALYTICS_SQL: { name: provider.binding.service, entrypoint: provider.binding.entrypoint } } }]
});
await mf.ready;

function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collect(atMs: number): Promise<string> {
  return (await (await mf.getWorker("stats")).scheduled({ cron: STATS.crons[0]!, scheduledTime: new Date(atMs) })).outcome;
}

try {
  await test("the production registry makes the real collector query and parse all six datasets", async () => {
    const model = scenario(PRODUCTION_PROJECTS, RECORDED_AT_MS);
    provider.use(model);
    const before = provider.calls.length;
    assert.equal(await collect(RECORDED_AT_MS), "ok");
    const calls = provider.calls.slice(before);
    assert.deepEqual(calls.filter(call => call.outcome !== "answered"), []);
    assert.deepEqual(calls.map(call => queryKey(call)).sort(byText), expectedQueries(model).map(query => queryKey(query.bound)).sort(byText));
    assert.deepEqual([...new Set(calls.map(call => call.dataset ?? "none"))].sort(byText), [...DATASETS].sort(byText));
    assert.deepEqual([...new Set(calls.map(call => call.kind ?? "none"))].sort(byText), [...QUERY_KINDS].sort(byText));
    assert.ok(calls.every(call => call.rows > 0), "every answered query returned rows");
    const response = await mf.dispatchFetch("https://stats.example/api/v1/projects", { headers: { ...gatewayHeaders() } });
    const projects = await response.json() as { id: string; collector: { lastSuccessAtMs: number | null; lastError: string | null; stale: boolean } }[];
    assert.equal(response.status, 200);
    assert.deepEqual(projects.map(project => project.id).sort(byText), (JSON.parse(PRODUCTION_PROJECTS) as { id: string }[]).map(project => project.id).sort(byText));
    for (const project of projects) {
      assert.equal(project.collector.stale, false, project.id);
      assert.equal(project.collector.lastError, null, project.id);
      assert.ok(project.collector.lastSuccessAtMs !== null && project.collector.lastSuccessAtMs >= RECORDED_AT_MS, project.id);
    }
  });

  await test("a query whose params differ by one byte throws and is recorded", async () => {
    provider.use(scenario(PRODUCTION_PROJECTS, RECORDED_AT_MS));
    const [first] = expectedQueries(scenario(PRODUCTION_PROJECTS, RECORDED_AT_MS));
    const call = async (body: unknown) => (await (await mf.getWorker("analytics-caller")).fetch("https://caller/", { method: "POST", body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; error?: string }>;
    assert.equal((await call(first!.bound)).ok, true);
    const start = String(first!.bound.params["start"]);
    const shifted = { ...first!.bound, params: { ...first!.bound.params, start: start.replace(/.$/u, start.endsWith("Z") ? "z" : "Z") } };
    const before = provider.calls.length;
    assert.deepEqual(await call(shifted), { ok: false, error: UNEXPECTED_QUERY });
    assert.deepEqual(provider.calls.slice(before).map(entry => [entry.outcome, entry.params["start"]]), [["unexpected", shifted.params.start]]);
  });

  await test("a failing dataset fails the collection and is recorded as failed", async () => {
    const model = scenario(PRODUCTION_PROJECTS, RECORDED_AT_MS, { "states.r2CombinedStorage": { kind: "fail" } });
    provider.use(model);
    const before = provider.calls.length;
    assert.equal(await collect(RECORDED_AT_MS), "exception");
    const issued = expectedQueries(model).length;
    const deadline = Date.now() + 10_000;
    while (provider.calls.length - before < issued) {
      if (Date.now() > deadline) throw new Error(`the failed run issued ${provider.calls.length - before} of its ${issued} queries`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(provider.calls.length - before, issued);
    const failed = provider.calls.slice(before).filter(call => call.outcome === "failed");
    assert.ok(failed.length > 0 && failed.every(call => call.dataset === "states.r2CombinedStorage"));
  });

  const RECORDED: Partial<Record<QueryKind, string>> = { worker: "worker.json", r2Operations: "r2-operations.json", r2Storage: "r2-storage.json" };

  function selectAliases(query: string): string[] {
    const list = query.slice("SELECT ".length, query.indexOf(" FROM "));
    const items: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of list) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        items.push(current.trim());
        current = "";
      } else current += char;
    }
    items.push(current.trim());
    return items.map(item => /\bAS (\w+)$/u.exec(item)?.[1] ?? item);
  }

  await test("generated rows carry exactly the recorded fixtures' columns and the fixed queries' select list", () => {
    const model = scenario(PRODUCTION_PROJECTS, RECORDED_AT_MS);
    const queries = expectedQueries(model);
    for (const kind of QUERY_KINDS) {
      const query = queries.find(candidate => candidate.kind === kind)!;
      const generated = rows(model, query);
      assert.ok(generated.length > 0, kind);
      const columns = [...new Set(generated.map(row => Object.keys(row).sort().join(",")))];
      assert.deepEqual(columns, [selectAliases(query.bound.query).sort().join(",")], kind);
      const recorded = RECORDED[kind];
      if (recorded !== undefined) {
        const fixture = JSON.parse(readFileSync(join(CLOUDFLARE_ROOT, "test/fixtures/analytics", recorded), "utf8")) as { data: Record<string, unknown>[] };
        assert.deepEqual([...new Set(fixture.data.map(row => Object.keys(row).sort().join(",")))], columns, kind);
      }
    }
  });

  await test("late, empty, and failing datasets shape the rows they return", () => {
    const ok = scenario(PRODUCTION_PROJECTS, RECORDED_AT_MS);
    const late = scenario(PRODUCTION_PROJECTS, RECORDED_AT_MS, { "logs.workersLogs": { kind: "late", omitNewestSlots: 3 }, "events.r2CombinedOperations": { kind: "empty" } });
    const worker = expectedQueries(ok).find(query => query.kind === "worker")!;
    const operations = expectedQueries(ok).find(query => query.kind === "r2Operations")!;
    assert.equal(rows(ok, worker).length, 18 * 2);
    assert.equal(rows(late, worker).length, 15 * 2);
    assert.equal(rows(late, operations).length, 0);
  });

  await test("the call log is complete across 20 collector runs", async () => {
    const model = scenario(PRODUCTION_PROJECTS, RECORDED_AT_MS);
    provider.use(model);
    const before = provider.calls.length;
    for (let run = 0; run < 20; run += 1) assert.equal(await collect(RECORDED_AT_MS), "ok");
    const counts = new Map<string, number>();
    for (const call of provider.calls.slice(before)) counts.set(queryKey(call), (counts.get(queryKey(call)) ?? 0) + 1);
    const expected = expectedQueries(model).map(query => queryKey(query.bound));
    assert.equal(provider.calls.length - before, 20 * expected.length);
    assert.deepEqual([...counts.keys()].sort(), [...expected].sort());
    assert.ok([...counts.values()].every(count => count === 20));
  });
} finally {
  await mf.dispose();
  rmSync(persist, { recursive: true, force: true });
}
