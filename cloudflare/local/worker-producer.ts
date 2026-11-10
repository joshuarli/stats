import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { V4DurableObject, V4ModuleDefinition, V4WorkerOptions } from "miniflare";
import { isObservedService, OBSERVED_SERVICES, SERVICE_NAME } from "../src/observe/services.ts";
import type { Outbound } from "./topology.ts";
import { loopbackPassthrough } from "./outbound.ts";
import { readBuiltWorker, type BuiltWorker } from "./topology.ts";

export interface WorkerProducer {
  readonly kind: "worker";
  readonly output: string;
  readonly service: string;
  readonly origin: string;
  readonly port: number;
  readonly worker: BuiltWorker;
  readonly vars: Readonly<Record<string, string>>;
}

const SUPPORTED: ReadonlySet<string> = new Set(["text", "durable-object", "assets", "r2"]);
const RESERVED = new Set(["stats-observe"]);
const PRODUCER_VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

function assertProducerVarName(name: string): void {
  if (!PRODUCER_VAR_NAME.test(name)) throw new TypeError(`${JSON.stringify(name)} is not a producer var name; use ^[A-Z][A-Z0-9_]{0,63}$`);
}

export function parseProducerVars(entries: readonly string[]): Readonly<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator === -1) throw new TypeError("--producer-var needs NAME=VALUE");
    const name = entry.slice(0, separator);
    assertProducerVarName(name);
    if (Object.hasOwn(vars, name)) throw new TypeError(`--producer-var ${name} is given more than once`);
    vars[name] = entry.slice(separator + 1);
  }
  return vars;
}

export function readWorkerProducer(output: string, service: string, port: number, vars: Readonly<Record<string, string>> = {}): WorkerProducer {
  if (!SERVICE_NAME.test(service)) throw new TypeError(`${JSON.stringify(service)} is not a service name; use ^[a-z][a-z0-9-]{0,31}$`);
  if (RESERVED.has(service) || isObservedService(service)) throw new TypeError(`${service} is already an observed service (${OBSERVED_SERVICES.join(", ")}); use a new name for local profiling`);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new TypeError(`${output} needs a TCP port, not ${String(port)}`);
  const worker = readBuiltWorker(output);
  for (const consumer of worker.tailConsumers) {
    if (consumer !== "stats-observe") throw new TypeError(`${worker.name} tails into ${consumer}, but the stack hosts only stats-observe`);
  }
  for (const [key, value] of worker.env) {
    if (!SUPPORTED.has(value.type)) throw new TypeError(`${worker.name} env.${key} is a ${value.type} binding, which the local producer does not map; supported: ${[...SUPPORTED].join(", ")}`);
    if (value.type === "durable-object" && value.worker !== worker.name) throw new TypeError(`${worker.name} env.${key} binds a Durable Object of ${value.worker}, which the local producer does not map`);
  }
  if (worker.crons.length > 0) throw new TypeError(`${worker.name} declares cron triggers ${worker.crons.join(", ")}, which the local producer does not fire; remove them or fire them from the workload`);
  const assetBindings = [...worker.env].filter(([, value]) => value.type === "assets").length;
  if (assetBindings !== (worker.assets === null ? 0 : 1)) throw new TypeError(`${worker.name} has ${assetBindings} assets bindings for ${worker.assets === null ? "no" : "one"} assets directory`);
  for (const name of Object.keys(vars)) assertProducerVarName(name);
  return { kind: "worker", output, service, origin: `http://127.0.0.1:${port}`, port, worker, vars };
}

function modules(worker: BuiltWorker): V4ModuleDefinition[] {
  const path = join(worker.output, "bundle", worker.mainModule);
  return [{ type: "ESModule", path, contents: readFileSync(path, "utf8") }];
}

function durableObjects(worker: BuiltWorker): Record<string, V4DurableObject> {
  return Object.fromEntries([...worker.env].flatMap(([key, value]) => value.type === "durable-object" ? [[key, { className: value.exportName, useSQLite: true }]] : []));
}

export function workerProducerBuckets(producer: WorkerProducer): readonly string[] {
  return [...producer.worker.env].flatMap(([, value]) => value.type === "r2" ? [value.name] : []);
}

export function workerProducerOptions(producer: WorkerProducer, outbound: Outbound, tail: string | undefined): V4WorkerOptions {
  const built = producer.worker;
  const bindings: Record<string, string> = {};
  const r2Buckets: Record<string, string> = {};
  let assets: V4WorkerOptions["assets"];
  for (const [key, value] of built.env) {
    switch (value.type) {
      case "text":
        bindings[key] = value.value;
        break;
      case "r2":
        r2Buckets[key] = value.name;
        break;
      case "assets":
        assets = { directory: join(built.output, "assets"), binding: key, routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }, assetConfig: { has_user_worker: true } };
        break;
      case "durable-object":
        break;
    }
  }
  for (const [key, value] of Object.entries(producer.vars)) bindings[key] = value;
  const objects = durableObjects(built);
  return {
    name: built.name,
    modules: modules(built),
    modulesRoot: join(built.output, "bundle"),
    compatibilityDate: built.compatibilityDate,
    compatibilityFlags: [...built.compatibilityFlags],
    bindings,
    ...(Object.keys(r2Buckets).length === 0 ? {} : { r2Buckets }),
    ...(Object.keys(objects).length === 0 ? {} : { durableObjects: objects }),
    ...(assets === undefined ? {} : { assets }),
    ...(tail === undefined ? {} : { tails: [tail] }),
    unsafeDirectSockets: [{ host: "127.0.0.1", port: producer.port }],
    outboundService: loopbackPassthrough([], outbound)
  };
}
