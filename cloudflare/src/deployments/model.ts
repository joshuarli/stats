/** Immutable deployment events; a rollback is a new event referencing an old version. */
export interface DeploymentVersion {
  readonly id: string;
  readonly percentage: number;
}

export interface Deployment {
  readonly id: string;
  readonly atMs: number;
  readonly source: string;
  readonly message: string | null;
  readonly versions: readonly DeploymentVersion[];
  readonly deferred: boolean;
}

export interface VersionMetadata {
  readonly id: string;
  readonly tag: string | null;
  readonly message: string | null;
}

export interface DeploymentSync {
  readonly lastAttemptAtMs: number;
  readonly lastSuccessAtMs: number | null;
  readonly error: string | null;
  readonly truncated: boolean;
}

export interface DeploymentHistory {
  readonly projectId: string;
  readonly worker: string;
  readonly enabled: boolean;
  readonly sync: DeploymentSync | null;
  readonly deployments: readonly Deployment[];
  readonly versions: readonly VersionMetadata[];
}

export const DEPLOYMENT_RETENTION_MS = 90 * 86_400_000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid deployment response");
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("invalid deployment text");
  return value;
}

function annotation(value: unknown, maximum: number): string | null {
  // Messages can contain line breaks. Keep them as plain text, never HTML or URLs.
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maximum) throw new Error("invalid deployment annotation");
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ");
}

function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!UUID.test(result)) throw new Error("invalid deployment id");
  return result.toLowerCase();
}

export function parseDeployment(value: unknown): Deployment {
  const item = record(value);
  const atMs = Date.parse(text(item["created_on"], 64));
  if (!Number.isSafeInteger(atMs) || atMs < 0 || item["strategy"] !== "percentage") throw new Error("invalid deployment timestamp or strategy");
  const values = item["versions"];
  if (!Array.isArray(values) || values.length < 1 || values.length > 2) throw new Error("invalid deployment versions");
  const versions = values.map((entry: unknown) => {
    const version = record(entry);
    const percentage = version["percentage"];
    if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage <= 0 || percentage > 100) throw new Error("invalid deployment percentage");
    return { id: uuid(version["version_id"]), percentage };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(versions.map(version => version.id)).size !== versions.length || Math.abs(versions.reduce((sum, version) => sum + version.percentage, 0) - 100) > 0.000001) throw new Error("invalid deployment allocation");
  const annotations = item["annotations"] === undefined ? {} : record(item["annotations"]);
  const strategy = item["code_update_strategy"] === undefined ? {} : record(item["code_update_strategy"]);
  return {
    id: uuid(item["id"]), atMs, source: text(item["source"], 128),
    message: annotation(annotations["workers/message"], 1000), versions,
    deferred: strategy["mode"] === "deferred",
  };
}

export function parseVersion(value: unknown, expectedId: string): VersionMetadata {
  const item = record(value);
  const id = uuid(item["id"]);
  if (id !== expectedId) throw new Error("version identity mismatch");
  const annotations = item["annotations"] === undefined ? {} : record(item["annotations"]);
  return { id, tag: annotation(annotations["workers/tag"], 100), message: annotation(annotations["workers/message"], 1000) };
}

export function singleVersion(deployment: Deployment): boolean {
  return deployment.versions.length === 1 && deployment.versions[0]?.percentage === 100;
}
