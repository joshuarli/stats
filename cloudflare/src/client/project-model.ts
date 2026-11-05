type Fields = Readonly<Record<string, unknown>>;

function fail(what: string): never {
  throw new Error(`invalid ${what}`);
}

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown, what: string): Fields {
  if (!isFields(value)) fail(what);
  return value;
}

export function text(value: unknown, what: string, limit = 4096): string {
  if (typeof value !== "string" || value.length > limit) fail(what);
  return value;
}

export function timestamp(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(what);
  return value;
}

export function boolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") fail(what);
  return value;
}

export function nullable<T>(value: unknown, decode: (value: unknown, what: string) => T, what: string): T | null {
  return value === null ? null : decode(value, what);
}

export function list<T>(value: unknown, limit: number, decode: (item: unknown, what: string) => T, what: string): T[] {
  if (!Array.isArray(value) || value.length > limit) fail(what);
  return value.map(item => decode(item, what));
}

export interface CollectorState {
  readonly lastRunAtMs: number | null;
  readonly lastSuccessAtMs: number | null;
  readonly lastError: string | null;
  readonly stale: boolean;
}

export interface ProbeTarget {
  readonly name: string;
  readonly url: string;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly worker: string;
  readonly buckets: readonly string[];
  readonly durableObjectNamespaces: readonly string[];
  readonly d1Databases: readonly string[];
  readonly probes: readonly ProbeTarget[];
  readonly collector: CollectorState;
}

function project(value: unknown, what: string): ProjectSummary {
  const fields = record(value, what);
  const collector = record(fields["collector"], "project collector");
  const strings = (key: string) => list(fields[key], 256, (item, label) => text(item, label, 256), `project ${key}`);
  return {
    id: text(fields["id"], "project id", 32),
    name: text(fields["name"], "project name", 128),
    worker: text(fields["worker"], "project worker", 63),
    buckets: strings("buckets"),
    durableObjectNamespaces: strings("durableObjectNamespaces"),
    d1Databases: strings("d1Databases"),
    probes: list(fields["probes"], 64, (item, label) => {
      const probe = record(item, label);
      return { name: text(probe["name"], "probe name", 128), url: text(probe["url"], "probe url", 2048) };
    }, "project probes"),
    collector: {
      lastRunAtMs: nullable(collector["lastRunAtMs"], timestamp, "collector last run"),
      lastSuccessAtMs: nullable(collector["lastSuccessAtMs"], timestamp, "collector last success"),
      lastError: nullable(collector["lastError"], (item, label) => text(item, label, 1024), "collector last error"),
      stale: boolean(collector["stale"], "collector stale")
    }
  };
}

export function decodeProjects(value: unknown): readonly ProjectSummary[] {
  const projects = list(value, 256, project, "project");
  if (new Set(projects.map(item => item.id)).size !== projects.length) fail("project list: duplicate id");
  return projects.sort((a, b) => a.id.localeCompare(b.id));
}

export const decodeProject = (value: unknown): ProjectSummary => project(value, "project");
