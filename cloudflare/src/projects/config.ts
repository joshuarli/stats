import {
  D1_DATABASE_ID_PATTERN,
  MAX_BUCKETS_PER_PROJECT,
  MAX_D1_DATABASES_PER_PROJECT,
  MAX_NAMESPACES_PER_PROJECT,
  NAMESPACE_ID_PATTERN,
} from "./queries.ts";

export const MAX_PROBES_PER_PROJECT = 8;

export const WORKER_BILLINGS = ["requests-and-cpu", "cpu-only"] as const;
export type WorkerBilling = (typeof WORKER_BILLINGS)[number];

export interface ProbeConfig {
  readonly name: string;
  readonly url: string;
}

export interface ProjectConfig {
  readonly id: string;
  readonly name: string;
  readonly worker: string;
  readonly workerBilling: WorkerBilling;
  readonly buckets: readonly string[];
  readonly durableObjectNamespaces: readonly string[];
  readonly d1Databases: readonly string[];
  readonly probes: readonly ProbeConfig[];
}

export class ProjectConfigError extends Error {
  override readonly name = "ProjectConfigError";
}

export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const PROBE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const DISPLAY_NAME_MAX = 64;

const PROJECT_KEYS = ["id", "name", "worker", "workerBilling", "buckets", "durableObjectNamespaces", "d1Databases", "probes"];
const PROBE_KEYS = ["name", "url"];

export function parseProjects(text: string): ProjectConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectConfigError("projects: not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new ProjectConfigError("projects: expected an array");
  }
  const seen = new Set<string>();
  return parsed.map((entry: unknown, index) => {
    const project = parseProject(entry, `projects[${index}]`);
    if (seen.has(project.id)) {
      throw new ProjectConfigError(`projects[${index}].id: duplicate project id`);
    }
    seen.add(project.id);
    return project;
  });
}

function parseProject(entry: unknown, path: string): ProjectConfig {
  const record = exactRecord(entry, PROJECT_KEYS, path);
  const buckets = array(record["buckets"], `${path}.buckets`);
  if (buckets.length > MAX_BUCKETS_PER_PROJECT) {
    throw new ProjectConfigError(`${path}.buckets: expected at most ${MAX_BUCKETS_PER_PROJECT} names`);
  }
  const namespaces = array(record["durableObjectNamespaces"], `${path}.durableObjectNamespaces`);
  if (namespaces.length > MAX_NAMESPACES_PER_PROJECT) {
    throw new ProjectConfigError(`${path}.durableObjectNamespaces: expected at most ${MAX_NAMESPACES_PER_PROJECT} ids`);
  }
  const databases = array(record["d1Databases"], `${path}.d1Databases`);
  if (databases.length > MAX_D1_DATABASES_PER_PROJECT) {
    throw new ProjectConfigError(`${path}.d1Databases: expected at most ${MAX_D1_DATABASES_PER_PROJECT} ids`);
  }
  const probes = array(record["probes"], `${path}.probes`);
  if (probes.length > MAX_PROBES_PER_PROJECT) {
    throw new ProjectConfigError(`${path}.probes: expected at most ${MAX_PROBES_PER_PROJECT}`);
  }
  const probeNames = new Set<string>();
  return {
    id: matching(record["id"], PROJECT_ID_PATTERN, `${path}.id`),
    name: displayName(record["name"], `${path}.name`),
    worker: matching(record["worker"], WORKER_NAME_PATTERN, `${path}.worker`),
    workerBilling: workerBilling(record["workerBilling"], `${path}.workerBilling`),
    buckets: unique(
      buckets.map((bucket, index) => matching(bucket, BUCKET_NAME_PATTERN, `${path}.buckets[${index}]`)),
      `${path}.buckets`,
    ),
    durableObjectNamespaces: unique(
      namespaces.map((id, index) => matching(id, NAMESPACE_ID_PATTERN, `${path}.durableObjectNamespaces[${index}]`)),
      `${path}.durableObjectNamespaces`,
    ),
    d1Databases: unique(
      databases.map((id, index) => matching(id, D1_DATABASE_ID_PATTERN, `${path}.d1Databases[${index}]`)),
      `${path}.d1Databases`,
    ),
    probes: probes.map((probe, index) => {
      const parsed = parseProbe(probe, `${path}.probes[${index}]`);
      if (probeNames.has(parsed.name)) {
        throw new ProjectConfigError(`${path}.probes[${index}].name: duplicate probe name`);
      }
      probeNames.add(parsed.name);
      return parsed;
    }),
  };
}

function parseProbe(entry: unknown, path: string): ProbeConfig {
  const record = exactRecord(entry, PROBE_KEYS, path);
  return {
    name: matching(record["name"], PROBE_NAME_PATTERN, `${path}.name`),
    url: httpsUrl(record["url"], `${path}.url`),
  };
}

function exactRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectConfigError(`${path}: expected an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new ProjectConfigError(`${path}.${key}: unknown key`);
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw new ProjectConfigError(`${path}.${key}: missing`);
    }
  }
  return record;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProjectConfigError(`${path}: expected an array`);
  }
  return value;
}

function matching(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProjectConfigError(`${path}: does not match ${pattern.source}`);
  }
  return value;
}

function workerBilling(value: unknown, path: string): WorkerBilling {
  const found = WORKER_BILLINGS.find(billing => billing === value);
  if (found === undefined) {
    throw new ProjectConfigError(`${path}: expected one of ${WORKER_BILLINGS.join(", ")}`);
  }
  return found;
}

function displayName(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() !== value || value === "" || value.length > DISPLAY_NAME_MAX) {
    throw new ProjectConfigError(`${path}: expected 1 to ${DISPLAY_NAME_MAX} characters without edge spaces`);
  }
  return value;
}

function unique(values: string[], path: string): string[] {
  if (new Set(values).size !== values.length) {
    throw new ProjectConfigError(`${path}: duplicate entry`);
  }
  return values;
}

function httpsUrl(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ProjectConfigError(`${path}: expected a string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProjectConfigError(`${path}: not a URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new ProjectConfigError(`${path}: expected an https URL without credentials or fragment`);
  }
  return value;
}
