import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBuiltWorker } from "../../../cloudflare/local/topology.ts";

export const ROOT = resolve(import.meta.dirname, "../../..");
export const BUILDS = {
  stats: join(ROOT, "cloudflare/.cloudflare/output/v0/workers/default"),
  observe: join(ROOT, "cloudflare/observe-worker/.cloudflare/output/v0/workers/default"),
};

const TEST_NOW_MS = "1793510415000";
const TEST_JWKS_JSON = JSON.stringify({
  keys: [
    {
      kty: "RSA",
      n: "qA4IPs0iZehTD525JxA93Hto9lkj62-D1PDybLDBljT8lmWSRKK4Zid1nUqBuQ5c8hWz0n_WiwFDB-e7mSVwqZkwGHmXQyVtpz1JHCr3_hOoQyxXJQWxTdUy-cQwCvsMja84s_mBQmDsA3m6lpfzEVC9nB6RiQT9F7nXByxoX-FO_XguKWJdlNMZ6HqKddAI7GWJpQYSUhntD6-vRCfwrfTr8HwBpd5I8JEWX-B3bhk_s7EcnfilTqKgo9st-6Qe_e5DNRu7k9jNwi2cu9z7G-V9WiEOUcuBba9dwI-II4KHpPwcSdHraEK9ulTcm039ve9Due5_gjtEILfpEpSgIQ",
      e: "AQAB",
      kid: "test-key",
      alg: "RS256",
      use: "sig",
    },
  ],
});

function baseConfig(built, { vars, assets, services, durableObjects, migrations }) {
  const config = {
    name: built.name,
    main: join(built.output, "bundle", built.mainModule),
    no_bundle: true,
    compatibility_date: built.compatibilityDate,
    compatibility_flags: [...built.compatibilityFlags],
    workers_dev: false,
    preview_urls: false,
    vars,
    durable_objects: {
      bindings: durableObjects.map(({ name, className }) => ({ name, class_name: className })),
    },
    migrations: [{ tag: "v1", new_sqlite_classes: durableObjects.map(entry => entry.className) }],
    ...(assets === undefined ? {} : { assets }),
    ...(services === undefined ? {} : { services }),
    ...(built.crons.length === 0 ? {} : { triggers: { crons: [...built.crons] } }),
    ...(built.tailConsumers.length === 0 ? {} : { tail_consumers: built.tailConsumers.map(service => ({ service })) }),
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function generate({ statsOutput = BUILDS.stats, observeOutput = BUILDS.observe, outDir, projects = "[]" } = {}) {
  const stats = readBuiltWorker(statsOutput);
  const observe = readBuiltWorker(observeOutput);
  if (stats.name !== "stats" || observe.name !== "stats-observe") throw new Error(`unexpected built names: ${stats.name}, ${observe.name}`);
  for (const [output, worker] of [[statsOutput, stats], [observeOutput, observe]]) {
    const bundle = join(output, "bundle", worker.mainModule);
    if (!existsSync(bundle)) throw new Error(`missing bundle ${bundle}; run the build first`);
  }
  mkdirSync(outDir, { recursive: true });
  const vars = {
    ENVIRONMENT: "test",
    PROJECTS: projects,
    WORKER_NAME: "stats",
    TEST_NOW_MS,
    ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    ACCESS_AUD: "test-aud",
    ACCESS_JWKS_JSON: TEST_JWKS_JSON,
  };
  const assetBindings = [...stats.env.entries()].filter(([, value]) => value.type === "assets");
  if (assetBindings.length !== 1 || stats.assets === null) throw new Error("stats assets binding did not map");
  const [assetBinding] = assetBindings[0];
  const observeBindings = [...observe.env.entries()];
  if (observeBindings.length !== 1) throw new Error("observe env keys did not map");
  const statsSlack = [...stats.env.entries()].map(([key, value]) => `${key}:${value.type}`).sort();
  const mapped = new Set(["ENVIRONMENT", "INSTALLATION", "ASSETS", "ANALYTICS_SQL", "PROJECTS", "WORKER_NAME", "OBSERVE"]);
  const unexpected = statsSlack.filter(entry => !mapped.has(entry.split(":")[0]));
  if (unexpected.length > 0) throw new Error(`unmapped stats bindings: ${unexpected.join(", ")}`);
  const observeSlack = observeBindings.map(([key, value]) => `${key}:${value.type}`).sort();
  if (observeSlack.length !== 1 || observeSlack[0] !== "STORE:durable-object") throw new Error(`unmapped observe bindings: ${observeSlack.join(", ")}`);
  const statsJsonc = baseConfig(stats, {
    vars,
    assets: { directory: join(statsOutput, "assets"), binding: assetBinding, run_worker_first: true },
    services: [{ binding: "OBSERVE", service: "stats-observe" }],
    durableObjects: [{ name: "INSTALLATION", className: "Installation" }],
  });
  const observeJsonc = baseConfig(observe, {
    vars: {},
    durableObjects: [{ name: "STORE", className: "ObservationStore" }],
  });
  writeFileSync(join(outDir, "stats.jsonc"), statsJsonc);
  writeFileSync(join(outDir, "observe.jsonc"), observeJsonc);
  const dropped = [{ binding: "ANALYTICS_SQL", reason: "OpenOrange has no local Analytics SQL substitute; collector/probe path is unproven on the candidate (global fetch to the remote Analytics API is not used)" }];
  return { stats, observe, outDir, dropped };
}

if (import.meta.main) {
  const out = process.argv[2];
  if (out === undefined) { console.error("usage: node experiments/rivet/openorange/generate.mjs <out-dir>"); process.exit(2); }
  const result = generate({ outDir: resolve(out) });
  console.log(JSON.stringify({ outDir: result.outDir, dropped: result.dropped }));
}
