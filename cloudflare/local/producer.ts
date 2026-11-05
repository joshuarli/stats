import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isObservedService } from "../src/observe/services.ts";

export const PRODUCER_MANIFEST = "producer-export.json";
const PRODUCER_KIND = "nanoshop-producer-export";
const CACHE_NAMESPACES = "cache";
const NAMESPACE_INDEX = /(?:^|\/)metadata\.sqlite$/u;

export class StaleProducerExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleProducerExportError";
  }
}

export interface ProducerExport {
  readonly dir: string;
  readonly digest: string;
  readonly service: string;
  readonly versionId: string;
  readonly origin: string;
  readonly port: number;
  readonly crons: readonly string[];
  readonly tailConsumers: readonly string[];
  readonly persistSeed: string;
  readonly objectState: string;
  readonly config: Readonly<Record<string, unknown>>;
}

type Json = Record<string, unknown>;

function record(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} is not an object`);
  return value as Json;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${path} is not a non-empty string`);
  return value;
}

function texts(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} is not an array`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function inside(root: string, path: string, what: string): string {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(root + sep)) throw new TypeError(`${what} ${JSON.stringify(path)} leaves the export directory`);
  return absolute;
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new StaleProducerExportError(`${path} is not a regular file or directory`);
    files.push(relative(root, path).split(sep).join("/"));
  }
  return files.sort();
}

export function producerExportDigest(root: string): string {
  const hash = createHash("sha256");
  for (const path of filesUnder(root)) {
    if (path === PRODUCER_MANIFEST) continue;
    hash.update(`${path}\0${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function workerConfig(root: string, value: unknown, path: string): Json {
  const config = structuredClone(record(value, path));
  const manifest = record(config["manifest"], `${path}.manifest`);
  const modulesRoot = inside(root, text(manifest["modulesRoot"], `${path}.manifest.modulesRoot`), `${path}.manifest.modulesRoot`);
  manifest["modulesRoot"] = modulesRoot;
  for (const [name, module] of Object.entries(record(manifest["modules"], `${path}.manifest.modules`))) {
    record(module, `${path}.manifest.modules.${name}`)["contents"] = readFileSync(inside(modulesRoot, name, `${path}.manifest.modules key`), "utf8");
  }
  if (config["assets"] !== undefined) {
    const assets = record(config["assets"], `${path}.assets`);
    assets["directory"] = inside(root, text(assets["directory"], `${path}.assets.directory`), `${path}.assets.directory`);
  }
  if (config["triggers"] !== undefined) throw new TypeError(`${path}.triggers routes requests by host, which the stack does not map; it serves each producer on its own port`);
  if (config["tailConsumers"] !== undefined) throw new TypeError(`${path}.tailConsumers is set by the stack, not the export`);
  return config;
}

export function readProducerExport(dir: string): ProducerExport {
  const root = resolve(dir);
  const manifestPath = join(root, PRODUCER_MANIFEST);
  if (!existsSync(manifestPath)) throw new StaleProducerExportError(`${root} has no ${PRODUCER_MANIFEST}; it is not a producer export`);
  const manifest = record(JSON.parse(readFileSync(manifestPath, "utf8")), manifestPath);
  if (manifest["kind"] !== PRODUCER_KIND || manifest["version"] !== 1) throw new StaleProducerExportError(`${manifestPath} is not a version 1 ${PRODUCER_KIND}`);
  const digest = text(manifest["digest"], `${manifestPath} digest`);
  const actual = producerExportDigest(root);
  if (actual !== digest) throw new StaleProducerExportError(`${root} no longer matches its manifest digest (${digest}, files hash to ${actual}); export it again`);
  const tenants = manifest["tenants"];
  if (!Array.isArray(tenants) || tenants.length !== 1 || manifest["includeFetchTriggers"] !== false) {
    throw new TypeError(`${manifestPath} exports ${Array.isArray(tenants) ? tenants.length : "no"} tenants; the stack serves one tenant per export on its own port, so export one tenant per env`);
  }
  const tenant = record(tenants[0], `${manifestPath} tenants[0]`);
  const service = text(tenant["serviceName"], `${manifestPath} tenants[0].serviceName`);
  if (!isObservedService(service)) throw new TypeError(`${manifestPath} exports ${service}, which stats-observe does not observe, so its tail events would be dropped`);
  const version = record(tenant["version"], `${manifestPath} tenants[0].version`);
  const origin = new URL(text(tenant["shopOrigin"], `${manifestPath} tenants[0].shopOrigin`));
  const port = Number(origin.port);
  if (origin.protocol !== "http:" || !Number.isInteger(port) || port <= 0 || manifest["shopPort"] !== port) throw new TypeError(`${manifestPath} shopOrigin ${origin.href} is not an http origin on shopPort ${String(manifest["shopPort"])}`);
  const config = workerConfig(root, tenant["worker"], `${manifestPath} tenants[0].worker`);
  if (config["name"] !== service) throw new TypeError(`${manifestPath} tenants[0].worker.name is ${String(config["name"])}, not ${service}`);
  const persistSeed = inside(root, text(manifest["persistSeedDir"], `${manifestPath} persistSeedDir`), `${manifestPath} persistSeedDir`);
  const objectState = relative(persistSeed, inside(root, text(tenant["durableObjectDir"], `${manifestPath} tenants[0].durableObjectDir`), `${manifestPath} tenants[0].durableObjectDir`));
  if (objectState === "" || objectState.startsWith("..")) throw new TypeError(`${manifestPath} tenants[0].durableObjectDir is not inside persistSeedDir`);
  return {
    dir: root,
    digest,
    service,
    versionId: text(version["id"], `${manifestPath} tenants[0].version.id`),
    origin: origin.origin,
    port,
    crons: texts(tenant["scheduled"], `${manifestPath} tenants[0].scheduled`),
    tailConsumers: texts(tenant["tailConsumers"], `${manifestPath} tenants[0].tailConsumers`),
    persistSeed,
    objectState,
    config
  };
}

function databaseOf(path: string): string {
  return path.replace(/\.sqlite-(?:wal|shm)$/u, ".sqlite");
}

export function seedProducerState(producer: ProducerExport, persist: string): "seeded" | "kept" {
  if (existsSync(join(persist, producer.objectState))) return "kept";
  const files = filesUnder(producer.persistSeed).filter(path => path.split("/")[0] !== CACHE_NAMESPACES);
  const copied = files.filter(path => {
    const database = databaseOf(path);
    if (!existsSync(join(persist, database))) return true;
    if (NAMESPACE_INDEX.test(database)) return false;
    throw new Error(`${persist} already holds ${database}, which ${producer.service}'s seed in ${producer.dir} also writes; seeding would overwrite another Worker's state`);
  });
  for (const path of copied) {
    const target = join(persist, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(producer.persistSeed, path), target, { errorOnExist: true, force: false });
  }
  return "seeded";
}
