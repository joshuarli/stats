import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Miniflare } from "miniflare";
import { accessToken } from "../access-token.ts";
import { CLOUDFLARE_ROOT, OBSERVE_OUTPUT, STATS_OUTPUT, miniflareOptions, parseBuiltWorker, readBuiltWorker, readTestVars, rejectAndRecord, workers, type BuiltWorker, type StackOptions } from "../../local/topology.ts";

const STATS_CONFIG = readFileSync(join(STATS_OUTPUT, "worker.config.json"), "utf8");
const STATS = readBuiltWorker(STATS_OUTPUT);
const OBSERVE = readBuiltWorker(OBSERVE_OUTPUT);
const { ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_JWKS_JSON, PROJECTS } = readTestVars();
const SCRATCH = join(CLOUDFLARE_ROOT, "../.work/tmp");

function options(persist: string): StackOptions {
  return {
    text: { ENVIRONMENT: "test", PROJECTS: PROJECTS!, WORKER_NAME: "stats" },
    secrets: { ACCESS_TEAM_DOMAIN: ACCESS_TEAM_DOMAIN!, ACCESS_AUD: ACCESS_AUD!, ACCESS_JWKS_JSON: ACCESS_JWKS_JSON! },
    analytics: { service: "analytics-provider", entrypoint: "Analytics" },
    collector: { kind: "attached" },
    outbound: rejectAndRecord().handler,
    persist,
    alarms: "platform"
  };
}

function edited(edit: (config: { env: Record<string, unknown> } & Record<string, unknown>) => void): BuiltWorker {
  const config = JSON.parse(STATS_CONFIG) as { env: Record<string, unknown> } & Record<string, unknown>;
  edit(config);
  return parseBuiltWorker(STATS_OUTPUT, JSON.stringify(config));
}

await test("the topology runs both built Workers with their SQLite Durable Objects, service bindings, tail link, and assets", () => {
  const [stats, observe, ...rest] = workers(STATS, OBSERVE, options("unused"));
  assert.deepEqual(rest, []);
  assert.equal(stats?.name, "stats");
  assert.equal(observe?.name, "stats-observe");
  assert.deepEqual(stats?.durableObjects, { INSTALLATION: { className: "Installation", useSQLite: true } });
  assert.deepEqual(observe?.durableObjects, { STORE: { className: "ObservationStore", useSQLite: true } });
  assert.deepEqual(stats?.serviceBindings, { ANALYTICS_SQL: { name: "analytics-provider", entrypoint: "Analytics" }, OBSERVE: "stats-observe" });
  assert.deepEqual(stats?.tails, ["stats-observe"]);
  assert.deepEqual(stats?.assets, {
    directory: join(STATS_OUTPUT, "assets"),
    binding: "ASSETS",
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    assetConfig: { has_user_worker: true }
  });
  assert.equal(stats?.bindings?.["ENVIRONMENT"], "test");
  assert.equal(stats?.compatibilityDate, STATS.compatibilityDate);
});

await test("a binding type the topology does not map, or an unread config key, throws", () => {
  assert.throws(() => edited(config => { config.env["QUEUE"] = { type: "queue", queueName: "jobs" }; }), /env\.QUEUE has binding type "queue"/u);
  assert.throws(() => edited(config => { config.env["ENVIRONMENT"] = { type: "text", value: "production", secret: true }; }), /env\.ENVIRONMENT has keys the local topology does not read: secret/u);
  assert.throws(() => edited(config => { config["limits"] = { cpuMs: 50 }; }), /has keys the local topology does not read: limits/u);
  assert.throws(() => edited(config => { config["exports"] = { Installation: { type: "durable-object", storage: "kv" } }; }), /exports\.Installation is not a SQLite Durable Object/u);
});

await test("removing any binding from a copy of the built config throws when the stack is built", () => {
  for (const name of Object.keys((JSON.parse(STATS_CONFIG) as { env: Record<string, unknown> }).env)) {
    assert.throws(() => workers(edited(config => { delete config.env[name]; }), OBSERVE, options("unused")), TypeError, `removing ${name}`);
  }
});

await test("the built production config keeps ENVIRONMENT production and carries no TEST_NOW_MS", () => {
  assert.deepEqual(STATS.env.get("ENVIRONMENT"), { type: "text", value: "production" });
  assert.equal(STATS.env.has("TEST_NOW_MS"), false);
  assert.equal(OBSERVE.env.has("TEST_NOW_MS"), false);
});

await test("wrangler.test.jsonc runs the built config's compatibility settings and Durable Object class", () => {
  const wrangler = JSON.parse(readFileSync(join(CLOUDFLARE_ROOT, "wrangler.test.jsonc"), "utf8")) as {
    compatibility_date: string;
    compatibility_flags: string[];
    durable_objects: { bindings: { name: string; class_name: string }[] };
    migrations: { new_sqlite_classes?: string[] }[];
  };
  assert.equal(wrangler.compatibility_date, STATS.compatibilityDate);
  assert.deepEqual(wrangler.compatibility_flags, STATS.compatibilityFlags);
  const built = [...STATS.env].flatMap(([name, value]) => value.type === "durable-object" ? [{ name, class_name: value.exportName }] : []);
  assert.deepEqual(wrangler.durable_objects.bindings, built);
  assert.deepEqual(wrangler.migrations.flatMap(migration => migration.new_sqlite_classes ?? []), STATS.sqliteDurableObjects);
});

await test("the stack serves the dashboard at / only with an Access assertion", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const persist = mkdtempSync(join(SCRATCH, "topology-"));
  const mf = new Miniflare(miniflareOptions(STATS, OBSERVE, { ...options(persist), analytics: "unbound" }));
  try {
    const page = await mf.dispatchFetch("https://stats.example/", { headers: { "cf-access-jwt-assertion": await accessToken() } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/u);
    await page.arrayBuffer();
    const anonymous = await mf.dispatchFetch("https://stats.example/");
    assert.equal(anonymous.status, 401);
    await anonymous.arrayBuffer();
  } finally {
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
});
