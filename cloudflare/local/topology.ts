import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions, type MiniflareOptions, type Request as MiniflareRequest, type Response as MiniflareResponse, type V4DurableObject, type V4ModuleDefinition, type V4WorkerOptions } from "miniflare";

export const CLOUDFLARE_ROOT = resolve(import.meta.dirname, "..");
export const STATS_OUTPUT = join(CLOUDFLARE_ROOT, ".cloudflare/output/v0/workers/default");
export const OBSERVE_OUTPUT = join(CLOUDFLARE_ROOT, "observe-worker/.cloudflare/output/v0/workers/default");
const WRANGLER_TEST = join(CLOUDFLARE_ROOT, "wrangler.test.jsonc");

export type Binding =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "durable-object"; readonly worker: string; readonly exportName: string }
  | { readonly type: "assets" }
  | { readonly type: "analytics" }
  | { readonly type: "worker"; readonly worker: string };

export interface BuiltWorker {
  readonly output: string;
  readonly name: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly assets: { readonly runWorkerFirst: true } | null;
  readonly crons: readonly string[];
  readonly domains: readonly string[];
  readonly tailConsumers: readonly string[];
  readonly env: ReadonlyMap<string, Binding>;
  readonly sqliteDurableObjects: readonly string[];
  readonly mainModule: string;
}

type Json = Record<string, unknown>;

function record(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} is not an object`);
  return value as Json;
}

function only(value: Json, allowed: readonly string[], path: string): Json {
  const unread = Object.keys(value).filter(key => !allowed.includes(key));
  if (unread.length > 0) throw new TypeError(`${path} has keys the local topology does not read: ${unread.join(", ")}`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${path} is not a non-empty string`);
  return value;
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} is not an array`);
  return value;
}

function binding(value: unknown, path: string): Binding {
  const entry = record(value, path);
  const type = entry["type"];
  switch (type) {
    case "text":
      only(entry, ["type", "value"], path);
      if (typeof entry["value"] !== "string") throw new TypeError(`${path}.value is not a string`);
      return { type, value: entry["value"] };
    case "durable-object":
      only(entry, ["type", "worker", "exportName"], path);
      return { type, worker: text(entry["worker"], `${path}.worker`), exportName: text(entry["exportName"], `${path}.exportName`) };
    case "assets":
    case "analytics":
      only(entry, ["type"], path);
      return { type };
    case "worker":
      only(entry, ["type", "worker"], path);
      return { type, worker: text(entry["worker"], `${path}.worker`) };
    default:
      throw new TypeError(`${path} has binding type ${JSON.stringify(type)}, which the local topology does not map`);
  }
}

export function parseBuiltWorker(output: string, configText: string): BuiltWorker {
  const path = join(output, "worker.config.json");
  const config = only(record(JSON.parse(configText), path), ["name", "compatibilityDate", "compatibilityFlags", "assets", "domains", "triggers", "tailConsumers", "observability", "workersDev", "previewUrls", "env", "exports", "manifest"], path);
  const name = text(config["name"], `${path} name`);
  const env = new Map(Object.entries(record(config["env"] ?? {}, `${path} env`)).map(([key, value]) => [key, binding(value, `${path} env.${key}`)] as const));
  const sqliteDurableObjects = Object.entries(record(config["exports"] ?? {}, `${path} exports`)).map(([exportName, value]) => {
    const entry = only(record(value, `${path} exports.${exportName}`), ["type", "storage"], `${path} exports.${exportName}`);
    if (entry["type"] !== "durable-object" || entry["storage"] !== "sqlite") throw new TypeError(`${path} exports.${exportName} is not a SQLite Durable Object, which the local topology does not map`);
    return exportName;
  });
  for (const [key, value] of env) {
    if (value.type !== "durable-object") continue;
    if (value.worker !== name) throw new TypeError(`${path} env.${key} binds a Durable Object of ${value.worker}, which the local topology does not map`);
    if (!sqliteDurableObjects.includes(value.exportName)) throw new TypeError(`${path} env.${key} binds ${value.exportName}, which ${name} does not export`);
  }
  const unbound = sqliteDurableObjects.filter(exportName => ![...env.values()].some(value => value.type === "durable-object" && value.exportName === exportName));
  if (unbound.length > 0) throw new TypeError(`${path} exports ${unbound.join(", ")} with no binding`);
  let assets: BuiltWorker["assets"] = null;
  if (config["assets"] !== undefined) {
    const entry = only(record(config["assets"], `${path} assets`), ["runWorkerFirst"], `${path} assets`);
    if (entry["runWorkerFirst"] !== true) throw new TypeError(`${path} assets.runWorkerFirst is not true, which the local topology does not map`);
    assets = { runWorkerFirst: true };
  }
  const assetBindings = [...env.values()].filter(value => value.type === "assets").length;
  if (assetBindings !== (assets === null ? 0 : 1)) throw new TypeError(`${path} has ${assetBindings} assets bindings for ${assets === null ? "no" : "one"} assets directory`);
  const crons = list(config["triggers"] ?? [], `${path} triggers`).map((value, index) => {
    const entry = only(record(value, `${path} triggers[${index}]`), ["type", "schedule"], `${path} triggers[${index}]`);
    if (entry["type"] !== "scheduled") throw new TypeError(`${path} triggers[${index}] is not a scheduled trigger`);
    return text(entry["schedule"], `${path} triggers[${index}].schedule`);
  });
  const tailConsumers = list(config["tailConsumers"] ?? [], `${path} tailConsumers`).map((value, index) =>
    text(only(record(value, `${path} tailConsumers[${index}]`), ["worker"], `${path} tailConsumers[${index}]`)["worker"], `${path} tailConsumers[${index}].worker`));
  const manifest = only(record(config["manifest"], `${path} manifest`), ["type", "mainModule", "modules"], `${path} manifest`);
  if (manifest["type"] !== "partial" || Object.keys(record(manifest["modules"], `${path} manifest.modules`)).length > 0) throw new TypeError(`${path} manifest is not a partial manifest with one bundled module`);
  const domains = list(config["domains"] ?? [], `${path} domains`).map((value, index) => text(value, `${path} domains[${index}]`));
  const compatibilityFlags = list(config["compatibilityFlags"] ?? [], `${path} compatibilityFlags`).map((value, index) => text(value, `${path} compatibilityFlags[${index}]`));
  return { output, name, compatibilityDate: text(config["compatibilityDate"], `${path} compatibilityDate`), compatibilityFlags, assets, crons, domains, tailConsumers, env, sqliteDurableObjects, mainModule: text(manifest["mainModule"], `${path} manifest.mainModule`) };
}

export function readBuiltWorker(output: string): BuiltWorker {
  return parseBuiltWorker(output, readFileSync(join(output, "worker.config.json"), "utf8"));
}

export function readTestVars(): Readonly<Record<string, string>> {
  return (JSON.parse(readFileSync(WRANGLER_TEST, "utf8")) as { vars: Record<string, string> }).vars;
}

export type Outbound = (request: MiniflareRequest) => MiniflareResponse | Promise<MiniflareResponse>;

export type Collector =
  | { readonly kind: "attached" }
  | { readonly kind: "replaced"; readonly script: string }
  | { readonly kind: "absent" };

export type Persistence = { readonly directory: string } | "memory";

export type AnalyticsProvider = "unbound" | { readonly service: string; readonly entrypoint: string };

export interface StackOptions {
  readonly text: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly analytics: AnalyticsProvider;
  readonly collector: Collector;
  readonly outbound: Outbound;
  readonly persist: Persistence;
  readonly extraWorkers?: readonly V4WorkerOptions[];
  readonly alarms: "platform" | "rpc";
}

export const RUN_ALARM_METHOD = "runAlarm";

function compat(worker: BuiltWorker): Pick<V4WorkerOptions, "compatibilityDate" | "compatibilityFlags"> {
  return { compatibilityDate: worker.compatibilityDate, compatibilityFlags: [...worker.compatibilityFlags] };
}

function bundlePath(worker: BuiltWorker): string {
  return join(worker.output, "bundle", worker.mainModule);
}

function durableObjects(worker: BuiltWorker, ownerScript: string): Record<string, V4DurableObject> {
  return Object.fromEntries([...worker.env].flatMap(([key, value]) => value.type === "durable-object"
    ? [[key, { className: value.exportName, useSQLite: true, ...(ownerScript === worker.name ? {} : { scriptName: worker.name }) }]]
    : []));
}

function tailScriptNameWrapper(producer: string, mainModule: string): string {
  return `import collector from "./${mainModule}";
export * from "./${mainModule}";
export default { ...collector, tail(events, env, ctx) { return collector.tail(events.map(event => ({ ...event, scriptName: event.scriptName ?? ${JSON.stringify(producer)} })), env, ctx); } };`;
}

function observeProject(observe: BuiltWorker): string {
  return resolve(observe.output, "../../../../..");
}

export function collectorModules(observe: BuiltWorker, producer: string): V4ModuleDefinition[] {
  const project = observeProject(observe);
  return [
    { type: "ESModule", path: join(project, "collector-entry.js"), contents: tailScriptNameWrapper(producer, observe.mainModule) },
    { type: "ESModule", path: join(project, observe.mainModule), contents: readFileSync(bundlePath(observe), "utf8") }
  ];
}

export function collectorWorker(observe: BuiltWorker, name: string, producer: string): V4WorkerOptions {
  for (const [key, value] of observe.env) {
    if (value.type !== "durable-object") throw new TypeError(`${observe.name} env.${key} is a ${value.type} binding, which the local collector does not map`);
  }
  return { name, modules: collectorModules(observe, producer), modulesRoot: observeProject(observe), ...compat(observe), durableObjects: durableObjects(observe, name) };
}

function alarmModules(worker: BuiltWorker): V4ModuleDefinition[] {
  const main = `./${worker.mainModule}`;
  const subclasses = worker.sqliteDurableObjects.map(name => `export class ${name} extends bundle.${name} { async ${RUN_ALARM_METHOD}() { return this.alarm(); } }`);
  const entry = [`import * as bundle from "${main}";`, `export * from "${main}";`, `export { default } from "${main}";`, ...subclasses].join("\n");
  return [
    { type: "ESModule", path: join(worker.output, "bundle", "alarm-entry.js"), contents: entry },
    { type: "ESModule", path: bundlePath(worker), contents: readFileSync(bundlePath(worker), "utf8") }
  ];
}

function statsWorker(stats: BuiltWorker, observe: BuiltWorker, options: StackOptions): V4WorkerOptions {
  const bindings: Record<string, string> = {};
  const serviceBindings: NonNullable<V4WorkerOptions["serviceBindings"]> = {};
  const attached = options.collector.kind !== "absent";
  let assets: V4WorkerOptions["assets"];
  for (const [key, value] of stats.env) {
    switch (value.type) {
      case "text":
        bindings[key] = options.text[key] ?? value.value;
        break;
      case "durable-object":
        break;
      case "assets":
        assets = {
          directory: join(stats.output, "assets"),
          binding: key,
          routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
          assetConfig: { has_user_worker: true }
        };
        break;
      case "analytics":
        if (options.analytics !== "unbound") serviceBindings[key] = { name: options.analytics.service, entrypoint: options.analytics.entrypoint };
        break;
      case "worker":
        if (value.worker !== observe.name) throw new TypeError(`${stats.name} env.${key} binds worker ${value.worker}, which the local topology does not run`);
        if (attached) serviceBindings[key] = value.worker;
        break;
    }
  }
  for (const key of Object.keys(options.text)) {
    if (stats.env.get(key)?.type !== "text") throw new TypeError(`text override ${key} names no text binding of ${stats.name}`);
  }
  for (const [key, value] of Object.entries(options.secrets)) {
    if (stats.env.has(key)) throw new TypeError(`secret ${key} shadows a ${stats.name} binding`);
    bindings[key] = value;
  }
  if (options.analytics !== "unbound" && ![...stats.env.values()].some(value => value.type === "analytics")) throw new TypeError(`${stats.name} has no analytics binding for the provider`);
  if (attached && ![...stats.env.values()].some(value => value.type === "worker" && value.worker === observe.name)) throw new TypeError(`${stats.name} has no service binding to ${observe.name} for the attached collector`);
  for (const consumer of stats.tailConsumers) {
    if (consumer !== observe.name) throw new TypeError(`${stats.name} tails into ${consumer}, which the local topology does not run`);
  }
  return {
    name: stats.name,
    ...(options.alarms === "rpc" ? { modules: alarmModules(stats), modulesRoot: join(stats.output, "bundle") } : { modules: true, scriptPath: bundlePath(stats) }),
    ...compat(stats),
    bindings,
    durableObjects: durableObjects(stats, stats.name),
    ...(assets === undefined ? {} : { assets }),
    ...(Object.keys(serviceBindings).length === 0 ? {} : { serviceBindings }),
    ...(attached && stats.tailConsumers.length > 0 ? { tails: [...stats.tailConsumers] } : {}),
    outboundService: options.outbound
  };
}

export function workers(stats: BuiltWorker, observe: BuiltWorker, options: StackOptions): V4WorkerOptions[] {
  const collector: V4WorkerOptions[] = options.collector.kind === "attached"
    ? [collectorWorker(observe, observe.name, stats.name)]
    : options.collector.kind === "replaced"
      ? [{ name: observe.name, modules: true, script: options.collector.script, ...compat(observe) }]
      : [];
  return [statsWorker(stats, observe, options), ...collector, ...(options.extraWorkers ?? [])];
}

export function miniflareOptions(stats: BuiltWorker, observe: BuiltWorker, options: StackOptions): MiniflareOptions {
  const converted = convertV4MiniflareOptions({ workers: workers(stats, observe, options) });
  return options.persist === "memory" ? converted : { ...converted, resourcePersistencePath: options.persist.directory };
}

export interface Listen {
  readonly port: number;
  readonly localExplorer: boolean;
}

export function openWorkers(stats: BuiltWorker, observe: BuiltWorker, options: StackOptions, listen: Listen | null = null): Miniflare {
  return new Miniflare({
    ...miniflareOptions(stats, observe, options),
    ...(listen === null ? {} : { host: "127.0.0.1", port: listen.port, ...(listen.localExplorer ? { unsafeLocalExplorer: true } : {}) })
  });
}
