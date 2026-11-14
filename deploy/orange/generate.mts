import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { OBSERVE_OUTPUT, STATS_OUTPUT, readBuiltWorker, type Binding, type BuiltWorker } from "../../cloudflare/local/topology.ts";

export const ORANGE_ROOT = import.meta.dirname;

export type Profile =
  | { readonly kind: "production"; readonly release: string }
  | { readonly kind: "dev"; readonly release: string; readonly gatewaySecret: string; readonly nowMs: string | null };

export interface Dropped {
  readonly worker: string;
  readonly item: string;
  readonly reason: string;
}

export interface Generated {
  readonly stats: string;
  readonly observe: string;
  readonly dropped: readonly Dropped[];
}

const DROPPED_BINDINGS: Readonly<Record<Binding["type"], string | null>> = {
  text: null,
  "durable-object": null,
  assets: null,
  worker: null,
  r2: null,
  analytics: "Workers Analytics SQL has no OpenOrange equivalent; project collection from Cloudflare accounts is an optional provider adapter"
};

const TAIL_REASON = "OpenOrange tails report zero CPU and no diagnostics; operations arrive as application events instead";

function descriptor(worker: BuiltWorker, profile: Profile, dropped: Dropped[]): Record<string, unknown> {
  const vars: Record<string, string> = {};
  const durableObjects: { name: string; class_name: string }[] = [];
  const services: { binding: string; service: string }[] = [];
  const r2: { binding: string; bucket_name: string }[] = [];
  let assets: { binding: string; directory: string; run_worker_first: true } | undefined;
  for (const [name, binding] of worker.env) {
    const reason = DROPPED_BINDINGS[binding.type];
    if (reason !== null) {
      dropped.push({ worker: worker.name, item: `${name} (${binding.type})`, reason });
      continue;
    }
    switch (binding.type) {
      case "text": vars[name] = binding.value; break;
      case "durable-object": durableObjects.push({ name, class_name: binding.exportName }); break;
      case "worker": services.push({ binding: name, service: binding.worker }); break;
      case "r2": r2.push({ binding: name, bucket_name: binding.name }); break;
      case "assets": assets = { binding: name, directory: join(worker.output, "assets"), run_worker_first: true }; break;
    }
  }
  if (worker.assets !== null && assets === undefined) throw new TypeError(`${worker.name} declares assets without an assets binding`);
  for (const consumer of worker.tailConsumers) dropped.push({ worker: worker.name, item: `tail consumer ${consumer}`, reason: TAIL_REASON });
  if (worker.env.has("APPLICATION_EVENTS_RELEASE") || worker.env.has("GATEWAY_SECRET")) throw new TypeError(`${worker.name} binds a name the generator owns`);
  if (worker.env.has("INSTALLATION")) vars["APPLICATION_EVENTS_RELEASE"] = profile.release;
  if (profile.kind === "dev") {
    vars["ENVIRONMENT"] = profile.nowMs === null ? "development" : "test";
    if (worker.assets !== null) vars["GATEWAY_SECRET"] = profile.gatewaySecret;
    if (profile.nowMs !== null && worker.env.has("INSTALLATION")) vars["TEST_NOW_MS"] = profile.nowMs;
  }
  return {
    name: worker.name,
    main: join(worker.output, "bundle", worker.mainModule),
    no_bundle: true,
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: [...worker.compatibilityFlags],
    workers_dev: false,
    preview_urls: false,
    vars,
    durable_objects: { bindings: durableObjects },
    migrations: [{ tag: "v1", new_sqlite_classes: [...worker.sqliteDurableObjects] }],
    ...(assets === undefined ? {} : { assets }),
    ...(services.length === 0 ? {} : { services }),
    ...(r2.length === 0 ? {} : { r2_buckets: r2 }),
    ...(worker.crons.length === 0 ? {} : { triggers: { crons: [...worker.crons] } })
  };
}

export function generate(outDir: string, profile: Profile, outputs = { stats: STATS_OUTPUT, observe: OBSERVE_OUTPUT }): Generated {
  const stats = readBuiltWorker(outputs.stats);
  const observe = readBuiltWorker(outputs.observe);
  if (stats.name !== "stats" || observe.name !== "stats-observe") throw new TypeError(`unexpected built workers ${stats.name} and ${observe.name}`);
  const dropped: Dropped[] = [];
  mkdirSync(outDir, { recursive: true });
  const written = { stats: join(outDir, "stats.jsonc"), observe: join(outDir, "observe.jsonc") };
  writeFileSync(written.stats, `${JSON.stringify(descriptor(stats, profile, dropped), null, 2)}\n`, { mode: profile.kind === "dev" ? 0o600 : 0o644 });
  writeFileSync(written.observe, `${JSON.stringify(descriptor(observe, profile, dropped), null, 2)}\n`);
  return { ...written, dropped };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" }, release: { type: "string" } } });
  if (values.out === undefined || values.release === undefined) {
    console.error("usage: node deploy/orange/generate.mts --out DIR --release ID");
    process.exit(2);
  }
  const generated = generate(resolve(values.out), { kind: "production", release: values.release });
  console.log(JSON.stringify(generated, null, 2));
}
