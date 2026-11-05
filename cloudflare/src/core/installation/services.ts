import { constantTimeEqual, generateToken, tokenHash } from "../../auth.ts";
import { annotation, DEPLOYMENT_RETENTION_MS, type Deployment, type DeploymentHistory } from "../../deployments/model.ts";
import { PROJECT_ID_PATTERN } from "../../projects/config.ts";
import type { SqlDatabase } from "../sql.ts";

export const MAX_MARKER_BODY_BYTES = 8192;
export const MAX_SERVICE_BODY_BYTES = 8192;
const MAX_SERVICE_HOSTS = 64;
const MAX_HEALTH_URL_LENGTH = 2048;
const MAX_MARKER_MESSAGE_LENGTH = 1000;
const MARKERS_LISTED = 1000;
const HOST_ID = /^h_[0-9a-f]{32}$/u;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u;
const MARKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const TAILNET_SUFFIX = ".ts.net";

export const SERVICE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS services (
  name TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  host_ids TEXT NOT NULL,
  health_url TEXT,
  unit TEXT,
  created_at_ms INTEGER NOT NULL
) STRICT`,
  `CREATE TABLE IF NOT EXISTS service_deployments (
  service TEXT NOT NULL,
  marker_id TEXT NOT NULL,
  id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  host_ids TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (service, marker_id)
) STRICT`,
  "CREATE INDEX IF NOT EXISTS service_deployments_by_time ON service_deployments (service, at_ms)",
  "CREATE INDEX IF NOT EXISTS service_deployments_by_expiry ON service_deployments (at_ms)"
];

export interface Service {
  readonly name: string;
  readonly hostIds: readonly string[];
  readonly healthUrl: string | null;
  readonly unit: string | null;
  readonly createdAtMs: number;
}

export interface ServiceMarker {
  readonly service: string;
  readonly markerId: string;
  readonly hostIds: readonly string[];
  readonly deployment: Deployment;
}

export interface ServiceMarkerHosts {
  readonly deploymentId: string;
  readonly markerId: string;
  readonly hostIds: readonly string[];
}

export interface ServiceDeploymentHistory extends DeploymentHistory {
  readonly markers: readonly ServiceMarkerHosts[];
}

export type ServiceProblem =
  | { readonly status: 400; readonly code: "invalid_request"; readonly message: string }
  | { readonly status: 401; readonly code: "unauthorized"; readonly message: string }
  | { readonly status: 404; readonly code: "not_found"; readonly message: string }
  | { readonly status: 409; readonly code: "conflict"; readonly message: string }
  | { readonly status: 413; readonly code: "too_large"; readonly message: string };

export type ServiceResult<T> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & ServiceProblem);

type ServiceRow = {
  readonly name: string;
  readonly token_hash: string;
  readonly host_ids: string;
  readonly health_url: string | null;
  readonly unit: string | null;
  readonly created_at_ms: number;
};

type MarkerRow = {
  readonly marker_id: string;
  readonly host_ids: string;
  readonly payload: string;
};

interface ServiceDefinition {
  readonly name: string;
  readonly hostIds: readonly string[];
  readonly healthUrl: string | null;
  readonly unit: string | null;
}

interface MarkerRequest {
  readonly markerId: string;
  readonly version: string;
  readonly message: string | null;
  readonly hostIds: readonly string[];
}

const SERVICE_KEYS = new Set(["name", "hostIds", "healthUrl", "unit"]);
const MARKER_KEYS = new Set(["markerId", "version", "message", "hostIds"]);

function invalid(message: string): { ok: false } & ServiceProblem {
  return { ok: false, status: 400, code: "invalid_request", message };
}

function exactObject(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => keys.has(key)) ? record : null;
}

function hostIdList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SERVICE_HOSTS) return null;
  if (!value.every((hostId): hostId is string => typeof hostId === "string" && HOST_ID.test(hostId))) return null;
  const sorted = [...value].sort();
  return new Set(sorted).size === sorted.length ? sorted : null;
}

function healthUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_HEALTH_URL_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
  const tailnet = url.protocol === "http:" && url.hostname.toLowerCase().endsWith(TAILNET_SUFFIX);
  return url.protocol === "https:" || tailnet ? value : undefined;
}

function optionalMatch(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function parseDefinition(body: unknown): ServiceResult<ServiceDefinition> {
  const record = exactObject(body, SERVICE_KEYS);
  if (record === null) return invalid("body must be an object with name, hostIds, and optional healthUrl and unit");
  const name = record["name"];
  if (typeof name !== "string" || !PROJECT_ID_PATTERN.test(name)) return invalid("name must be 1-32 lowercase letters, digits, or hyphens, starting with a letter");
  const hostIds = hostIdList(record["hostIds"]);
  if (hostIds === null) return invalid(`hostIds must be 1-${MAX_SERVICE_HOSTS} distinct host ids`);
  const url = healthUrl(record["healthUrl"]);
  if (url === undefined) return invalid("healthUrl must be an https URL, or an http URL on the tailnet, without credentials or fragment");
  const unit = optionalMatch(record["unit"], UNIT);
  if (unit === undefined) return invalid("unit must be 1-128 letters, digits, or ._@- starting with a letter or digit");
  return { ok: true, value: { name, hostIds, healthUrl: url, unit } };
}

function parseMarker(body: unknown): ServiceResult<MarkerRequest> {
  const record = exactObject(body, MARKER_KEYS);
  if (record === null) return invalid("body must be an object with markerId, version, hostIds, and an optional message");
  const markerId = record["markerId"];
  if (typeof markerId !== "string" || !MARKER_ID.test(markerId)) return invalid("markerId must be 1-128 letters, digits, or ._:- starting with a letter or digit");
  const version = record["version"];
  if (typeof version !== "string" || !VERSION.test(version)) return invalid("version must be 1-128 letters, digits, or ._:+- starting with a letter or digit");
  const message = record["message"];
  if (message !== undefined && message !== null && (typeof message !== "string" || message.length > MAX_MARKER_MESSAGE_LENGTH)) return invalid(`message must be at most ${MAX_MARKER_MESSAGE_LENGTH} characters`);
  const hostIds = hostIdList(record["hostIds"]);
  if (hostIds === null) return invalid(`hostIds must be 1-${MAX_SERVICE_HOSTS} distinct host ids`);
  return { ok: true, value: { markerId, version, message: annotation(message, MAX_MARKER_MESSAGE_LENGTH), hostIds } };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function serviceOf(row: ServiceRow): Service {
  return { name: row.name, hostIds: JSON.parse(row.host_ids) as string[], healthUrl: row.health_url, unit: row.unit, createdAtMs: row.created_at_ms };
}

function serviceRow(sql: SqlDatabase, name: string): ServiceRow | undefined {
  return sql.rows<ServiceRow>("SELECT * FROM services WHERE name = ?", name)[0];
}

function unusableHost(sql: SqlDatabase, hostIds: readonly string[]): string | null {
  for (const hostId of hostIds) {
    const host = sql.rows<{ revoked_at_ms: number | null }>("SELECT revoked_at_ms FROM hosts WHERE host_id = ?", hostId)[0];
    if (host === undefined || host.revoked_at_ms !== null) return hostId;
  }
  return null;
}

async function markerDeploymentId(service: string, markerId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`service-marker\n${service}\n${markerId}`)));
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sameMarker(stored: ServiceMarker, request: MarkerRequest): boolean {
  const version = stored.deployment.versions[0]?.id;
  return version === request.version && stored.deployment.message === request.message && stored.hostIds.join(",") === request.hostIds.join(",");
}

function markerOf(service: string, row: MarkerRow): ServiceMarker {
  return { service, markerId: row.marker_id, hostIds: JSON.parse(row.host_ids) as string[], deployment: JSON.parse(row.payload) as Deployment };
}

export async function createService(sql: SqlDatabase, text: string | null, now: number): Promise<ServiceResult<Service & { token: string }>> {
  if (text === null) return { ok: false, status: 413, code: "too_large", message: "body exceeds the cap" };
  const parsed = parseDefinition(parseJson(text));
  if (!parsed.ok) return parsed;
  const definition = parsed.value;
  const token = generateToken();
  const hash = await tokenHash(token);
  return sql.transaction((): ServiceResult<Service & { token: string }> => {
    if (serviceRow(sql, definition.name) !== undefined) return { ok: false, status: 409, code: "conflict", message: "a service with this name exists" };
    const unusable = unusableHost(sql, definition.hostIds);
    if (unusable !== null) return invalid(`host ${unusable} is unknown or revoked`);
    sql.run("INSERT INTO services (name, token_hash, host_ids, health_url, unit, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)", definition.name, hash, JSON.stringify(definition.hostIds), definition.healthUrl, definition.unit, now);
    return { ok: true, value: { ...definition, createdAtMs: now, token } };
  });
}

export function listServices(sql: SqlDatabase): Service[] {
  return sql.rows<ServiceRow>("SELECT * FROM services ORDER BY name").map(serviceOf);
}

export function readService(sql: SqlDatabase, name: string): Service | null {
  const row = serviceRow(sql, name);
  return row === undefined ? null : serviceOf(row);
}

export async function authenticateService(sql: SqlDatabase, name: string, token: string | null): Promise<boolean> {
  if (token === null) return false;
  const hash = await tokenHash(token);
  const row = serviceRow(sql, name);
  return row !== undefined && constantTimeEqual(row.token_hash, hash);
}

export async function recordMarker(sql: SqlDatabase, name: string, text: string | null, now: number): Promise<ServiceResult<{ created: boolean; marker: ServiceMarker }>> {
  if (text === null) return { ok: false, status: 413, code: "too_large", message: "body exceeds the cap" };
  const parsed = parseMarker(parseJson(text));
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const id = await markerDeploymentId(name, request.markerId);
  return sql.transaction((): ServiceResult<{ created: boolean; marker: ServiceMarker }> => {
    const service = serviceRow(sql, name);
    if (service === undefined) return { ok: false, status: 401, code: "unauthorized", message: "deploy credential rejected" };
    const serviceHosts = new Set(JSON.parse(service.host_ids) as string[]);
    const foreign = request.hostIds.find(hostId => !serviceHosts.has(hostId));
    if (foreign !== undefined) return invalid(`host ${foreign} is not a host of this service`);
    const unusable = unusableHost(sql, request.hostIds);
    if (unusable !== null) return invalid(`host ${unusable} is unknown or revoked`);
    const existing = sql.rows<MarkerRow>("SELECT marker_id, host_ids, payload FROM service_deployments WHERE service = ? AND marker_id = ?", name, request.markerId)[0];
    if (existing !== undefined) {
      const stored = markerOf(name, existing);
      return sameMarker(stored, request) ? { ok: true, value: { created: false, marker: stored } } : { ok: false, status: 409, code: "conflict", message: "this markerId was recorded with different content" };
    }
    const deployment: Deployment = { id, atMs: now, source: "marker", message: request.message, versions: [{ id: request.version, percentage: 100 }], deferred: false };
    sql.run("INSERT INTO service_deployments (service, marker_id, id, at_ms, host_ids, payload) VALUES (?, ?, ?, ?, ?, ?)", name, request.markerId, id, now, JSON.stringify(request.hostIds), JSON.stringify(deployment));
    return { ok: true, value: { created: true, marker: { service: name, markerId: request.markerId, hostIds: request.hostIds, deployment } } };
  });
}

export function readServiceDeployments(sql: SqlDatabase, service: Service, now: number): ServiceDeploymentHistory {
  const markers = sql.rows<MarkerRow>(
    "SELECT marker_id, host_ids, payload FROM service_deployments WHERE service = ? AND at_ms >= ? ORDER BY at_ms DESC, rowid DESC LIMIT ?",
    service.name, now - DEPLOYMENT_RETENTION_MS, MARKERS_LISTED
  ).map(row => markerOf(service.name, row));
  return {
    projectId: service.name, worker: service.name, enabled: true, sync: null, versions: [],
    deployments: markers.map(marker => marker.deployment),
    markers: markers.map(marker => ({ deploymentId: marker.deployment.id, markerId: marker.markerId, hostIds: marker.hostIds }))
  };
}

export function purgeServiceDeployments(sql: SqlDatabase, now: number): void {
  sql.run("DELETE FROM service_deployments WHERE rowid IN (SELECT rowid FROM service_deployments WHERE at_ms < ? LIMIT 1000)", now - DEPLOYMENT_RETENTION_MS);
}
