import { MARKER_ID, MARKER_VERSION, HOST_ID, type Service, type ServiceDeploymentHistory, type ServiceMarker } from "../../core/installation/services.ts";
import { decodeService, decodeServiceDeploymentHistory, decodeServiceMarker, decodeServices } from "../../deployments/service-decode.ts";
import type { Deployment } from "../../deployments/model.ts";
import { isUp } from "../../projects/probes.ts";
import { credentialFileExists, credentialToken, prepareCredentialWrite, readCredentialJson, writeCredentialJson } from "../credential-file.ts";
import { authError, CommandError, EXIT, transportError, usageError } from "../exit.ts";
import { REQUEST_TIMEOUT_MS } from "../http.ts";
import { defineCommand, type CommandContext } from "../registry.ts";
import { table, timeText } from "../text.ts";
import { newestFirst, PROJECT_ID, TEXT_ROWS } from "./deployments.ts";

const MARKER_MEDIA_TYPE = "application/json";
const MARKER_ID_PREFIX = "v-";
const MAX_MARKER_REPLY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 1000;
const SERVICE_TOKEN = /^nft_[A-Za-z0-9_-]{43}$/u;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u;
const HEALTH_TIMEOUT_MS = 5_000;

export interface DeployMarkPayload {
  readonly created: boolean;
  readonly marker: ServiceMarker;
}

export interface ServicesPayload {
  readonly services: readonly Service[];
}

export interface ServiceDeploymentsPayload {
  readonly service: string;
  readonly deployments: readonly { readonly deployment: Deployment; readonly markerId: string; readonly hostIds: readonly string[] }[];
}

interface ServiceCredential {
  readonly deployToken: string;
  readonly hostIds: readonly string[] | null;
}

export function readServiceCredential(file: string, service: string): ServiceCredential {
  const credential = readCredentialJson(file, "name and deployToken");
  if (credential.fields["name"] !== service) throw authError("credential_file_service", `${credential.path} is the credential for service ${JSON.stringify(credential.fields["name"] ?? null)}, not ${service}`);
  const deployToken = credentialToken(credential, "deployToken");
  const hosts = credential.fields["hostIds"];
  if (hosts === undefined) return { deployToken, hostIds: null };
  if (!Array.isArray(hosts) || !hosts.every((id): id is string => typeof id === "string" && HOST_ID.test(id))) throw authError("credential_file_invalid", `${credential.path} has invalid hostIds`);
  return { deployToken, hostIds: hosts };
}

export function defaultMarkerId(version: string): string {
  const markerId = `${MARKER_ID_PREFIX}${version}`;
  if (!MARKER_ID.test(markerId)) throw usageError(`--version ${version} cannot be turned into a marker id (no "+", at most 126 characters); pass --marker-id`);
  return markerId;
}

function requireService(context: CommandContext): string {
  const service = context.option("service");
  if (service === undefined || !PROJECT_ID.test(service)) throw usageError("--service must be a service name such as stats-node");
  return service;
}

function hostList(raw: string): string[] {
  const hosts = raw.split(",");
  if (!hosts.every(host => HOST_ID.test(host)) || new Set(hosts).size !== hosts.length) throw usageError("--host must be distinct host ids (h_ and 32 hex digits), comma-separated");
  return hosts.sort();
}

function requiredFile(context: CommandContext, option: string): string {
  const file = context.option(option);
  if (file === undefined) throw usageError(`missing required option --${option}`);
  return file;
}

type TokenKind = "deploy" | "ingest";

function tokenKind(value: string | undefined): TokenKind {
  if (value === undefined) return "deploy";
  if (value !== "deploy" && value !== "ingest") throw usageError("--kind must be deploy or ingest");
  return value;
}

export interface LatestServiceMarker {
  readonly markerId: string;
  readonly deploymentId: string;
  readonly version: string;
  readonly atMs: number;
  readonly message: string | null;
  readonly hostIds: readonly string[];
}

export interface ServiceProbe {
  readonly state: "up" | "down" | "unavailable";
  readonly status: number | null;
  readonly ms: number | null;
  readonly detail: string;
}

export interface ServiceCreatePayload extends Service {
  readonly credentialFile: string;
}

export interface ServiceInspectPayload {
  readonly service: Service;
  readonly latest: LatestServiceMarker | null;
  readonly markers: number;
}

export interface ServiceRotatePayload {
  readonly name: string;
  readonly kind: TokenKind;
  readonly credentialFile: string;
}

export interface ServiceRevokePayload {
  readonly name: string;
  readonly credentialFile: string | null;
}

export interface ServiceCheckPayload {
  readonly name: string;
  readonly healthUrl: string | null;
  readonly unit: string | null;
  readonly hostIds: readonly string[];
  readonly latest: LatestServiceMarker | null;
  readonly probe: ServiceProbe;
}

function recordObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
}

function serviceToken(value: unknown): string {
  if (typeof value !== "string" || !SERVICE_TOKEN.test(value)) throw new Error("invalid service token");
  return value;
}

function decodeCreatedService(value: unknown): { readonly service: Service; readonly deployToken: string; readonly ingestToken: string } {
  const item = recordObject(value);
  return { service: decodeService(value), deployToken: serviceToken(item["deployToken"]), ingestToken: serviceToken(item["ingestToken"]) };
}

function decodeRotatedToken(value: unknown, service: string, kind: TokenKind): string {
  const item = recordObject(value);
  if (item["name"] !== service) throw new Error("service name mismatch");
  return serviceToken(item[kind === "deploy" ? "deployToken" : "ingestToken"]);
}

function servicePath(name: string): string {
  return `/api/v1/services/${encodeURIComponent(name)}`;
}

async function readServiceConfig(context: CommandContext, name: string): Promise<Service> {
  const path = servicePath(name);
  const fetched = await context.http.getJson(path, decodeService);
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  if (fetched.value.name !== name) throw transportError("contract", `${path} described service ${fetched.value.name}`);
  return fetched.value;
}

async function readServiceHistory(context: CommandContext, name: string): Promise<ServiceDeploymentHistory> {
  const path = `${servicePath(name)}/deployments`;
  const fetched = await context.http.getJson(path, value => decodeServiceDeploymentHistory(value, name));
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  return fetched.value;
}

function latestServiceMarker(history: ServiceDeploymentHistory): LatestServiceMarker | null {
  const deployment = newestFirst(history.deployments)[0];
  if (deployment === undefined) return null;
  const marker = history.markers.find(item => item.deploymentId === deployment.id);
  if (marker === undefined) throw transportError("contract", `service ${history.projectId} has a deployment without a marker`);
  return {
    markerId: marker.markerId,
    deploymentId: deployment.id,
    version: deployment.versions[0]?.id ?? "",
    atMs: deployment.atMs,
    message: deployment.message,
    hostIds: marker.hostIds
  };
}

async function probeHealth(context: CommandContext, healthUrl: string | null): Promise<ServiceProbe> {
  if (healthUrl === null) return { state: "unavailable", status: null, ms: null, detail: "no health URL configured" };
  const started = performance.now();
  const timeout = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(healthUrl, { method: "GET", redirect: "manual", cache: "no-store", signal: AbortSignal.any([context.signal, timeout]) });
    const ms = Math.max(0, Math.round(performance.now() - started));
    if (response.body !== null) await response.body.cancel().catch(() => undefined);
    return isUp(response.status)
      ? { state: "up", status: response.status, ms, detail: "answered" }
      : { state: "down", status: response.status, ms, detail: "answered with a failing status" };
  } catch {
    if (context.signal.aborted) throw transportError("cancelled", "request cancelled");
    return { state: "unavailable", status: null, ms: Math.max(0, Math.round(performance.now() - started)), detail: timeout.aborted ? `no response within ${HEALTH_TIMEOUT_MS} ms` : "no response" };
  }
}

function isHtml(response: Response, body: Uint8Array): boolean {
  if ((response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return true;
  const head = new TextDecoder().decode(body.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function errorCode(body: Uint8Array): string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { error?: { code?: unknown; message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === "string" && /^[\x20-\x7e]{1,200}$/u.test(message) ? `: ${message}` : "";
  } catch {
    return "";
  }
}

async function postMarker(context: CommandContext, service: string, token: string, body: string): Promise<{ readonly status: number; readonly value: DeployMarkPayload }> {
  const path = `/ingest/services/${service}/deployments`;
  const target = new URL(path, context.origin);
  if (target.origin !== context.origin) throw new TypeError("request would leave the configured origin");
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": MARKER_MEDIA_TYPE, accept: "application/json" },
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([context.signal, timeout])
    });
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    if (context.signal.aborted) throw transportError("cancelled", "request cancelled");
    if (timeout.aborted) throw transportError("timeout", `marker request exceeded ${REQUEST_TIMEOUT_MS} ms`);
    throw transportError("network", "marker request failed before a response");
  }
  const { status } = response;
  const challenged = (status >= 300 && status < 400) || ((status === 200 || status === 401 || status === 403) && isHtml(response, bytes));
  if (challenged) throw authError("access_challenge", `${path} answered ${status}, an Access challenge or login page, so the request never reached the Worker; the path needs a Bypass Access application on ${context.origin}`);
  if (status === 401 || status === 403) throw authError("marker_unauthorized", `${path} answered ${status}${errorCode(bytes)}; the deploy token was refused`);
  if (status === 409) throw new CommandError(EXIT.usage, "marker_conflict", `${path} answered 409${errorCode(bytes)}; this marker id was recorded with a different version, message, or host set; use a new --marker-id`);
  if (status === 400 || status === 413 || status === 415) throw usageError(`${path} answered ${status}${errorCode(bytes)}`);
  if (status === 404) throw transportError("not_found", `${path} answered 404`);
  if (status !== 200 && status !== 201) throw transportError(`http_${status}`, `${path} answered ${status}${errorCode(bytes)}`);
  if (bytes.length > MAX_MARKER_REPLY_BYTES) throw transportError("body_too_large", `${path} reply is larger than ${MAX_MARKER_REPLY_BYTES} bytes`);
  try {
    return { status, value: { created: status === 201, marker: decodeServiceMarker(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), service) } };
  } catch (error) {
    throw transportError("contract", `${path} did not return a marker: ${error instanceof Error ? error.message : "invalid response"}`);
  }
}

export const deployMarkCommand = defineCommand<DeployMarkPayload>({
  name: "deploy mark",
  summary: "record a deployment marker for a service",
  description: [
    "MUTATION: writes one deployment marker for the named service. POSTs {markerId, version, message, hostIds} to /ingest/services/NAME/deployments and prints the stored marker.",
    "The service deploy token comes from the token file, the JSON returned once when the service was created, and is sent only to the configured origin in the Authorization header. No Access or other credential is sent, on either target.",
    "The marker id defaults to v-VERSION, so repeating a deploy is idempotent. Exit 0 when the marker was recorded (201) and when an identical marker already existed (200, created false). A marker id already recorded with a different version, message, or host set exits 2 with marker_conflict. Use a new --marker-id to record another deploy of the same version, such as a rollback to it; with the default, that rollback records nothing and the newer marker stays latest.",
    "Exit 3 when the token file or the token is refused, or when an Access challenge intercepts the request (access_challenge). Exit 4 on transport failure."
  ],
  access: "mutation",
  targets: ["cloudflare", "node"],
  options: {
    service: { type: "string", placeholder: "NAME", required: true, description: "service name, as created through POST /api/v1/admin/services" },
    version: { type: "string", placeholder: "V", required: true, description: "what was deployed: a commit, tag, or semver (1-128 of A-Za-z0-9._:+-, starting with a letter or digit)" },
    message: { type: "string", placeholder: "TEXT", description: `free text shown on the timeline, at most ${MAX_MESSAGE_CHARS} characters` },
    host: { type: "string", placeholder: "ID[,ID...]", description: "host ids the deploy reached, comma-separated (default: every host of the service, from the token file)" },
    "marker-id": { type: "string", placeholder: "ID", description: "idempotency key (default: v-VERSION)" },
    "token-file": { type: "string", placeholder: "FILE", required: true, description: "service creation response JSON {name, hostIds, deployToken, ingestToken}, mode 0600; never passed in argv" }
  },
  examples: ["statsctl deploy mark --service stats-node --version 9df651c1a2b3 --message 'make node-deploy' --token-file .work/credentials/stats-node-deploy.json --origin http://threadripper.tailcf741.ts.net:18790"],
  limitations: [
    "Markers older than 30 days are dropped by the server.",
    "On Cloudflare the marker path is under /ingest/*, which must bypass Access; otherwise the request fails with access_challenge."
  ],
  async run(context) {
    const service = requireService(context);
    const version = context.option("version");
    if (version === undefined || !MARKER_VERSION.test(version)) throw usageError("--version must be 1-128 letters, digits, or ._:+- starting with a letter or digit");
    const message = context.option("message");
    if (message !== undefined && message.length > MAX_MESSAGE_CHARS) throw usageError(`--message must be at most ${MAX_MESSAGE_CHARS} characters`);
    const explicitMarker = context.option("marker-id");
    if (explicitMarker !== undefined && !MARKER_ID.test(explicitMarker)) throw usageError("--marker-id must be 1-128 letters, digits, or ._:- starting with a letter or digit");
    const markerId = explicitMarker ?? defaultMarkerId(version);
    const explicitHosts = context.option("host");
    const credential = readServiceCredential(context.option("token-file") ?? "", service);
    const hostIds = explicitHosts === undefined ? credential.hostIds : hostList(explicitHosts);
    if (hostIds === null) throw usageError("the token file has no hostIds; pass --host");
    const body = JSON.stringify({ markerId, version, ...(message === undefined ? {} : { message }), hostIds });
    const { value } = await postMarker(context, service, credential.deployToken, body);
    return { payload: value, identities: { deploymentIds: [value.marker.deployment.id], versionIds: [version] } };
  },
  render({ created, marker }) {
    const version = marker.deployment.versions[0]?.id ?? "";
    return [
      `${created ? "recorded" : "already recorded"} ${marker.service} ${version} (marker ${marker.markerId}, deployment ${marker.deployment.id}) at ${timeText(marker.deployment.atMs)}`,
      `hosts: ${marker.hostIds.join(" ")}`
    ];
  }
});

export const servicesCommand = defineCommand<ServicesPayload>({
  name: "services",
  summary: "list the services that report deployment markers",
  description: ["Lists every service with its hosts, health URL, and unit. Deploy tokens are never listed."],
  access: "read",
  targets: ["cloudflare", "node"],
  options: {},
  examples: ["statsctl services", "statsctl services --json --origin http://threadripper.tailcf741.ts.net:18790"],
  limitations: ["Services are created through POST /api/v1/admin/services; see docs/operations.md."],
  async run(context) {
    const fetched = await context.http.getJson("/api/v1/services", decodeServices);
    if (fetched.kind !== "ok") throw transportError("contract", "/api/v1/services answered not-modified to an unconditional request");
    return { payload: { services: fetched.value } };
  },
  render({ services }) {
    if (services.length === 0) return ["no services configured"];
    return table([["service", "hosts", "unit", "health url"], ...services.map(item => [item.name, String(item.hostIds.length), item.unit ?? "-", item.healthUrl ?? "-"])]);
  }
});

export const serviceDeploymentsCommand = defineCommand<ServiceDeploymentsPayload>({
  name: "service deployments",
  summary: "list a service's deployment markers",
  description: ["Lists the service's markers newest first with version, message, and hosts. Markers are kept for 30 days."],
  access: "read",
  targets: ["cloudflare", "node"],
  options: { service: { type: "string", placeholder: "NAME", required: true, description: "service name from `statsctl services`" } },
  examples: ["statsctl service deployments --service stats-node", "statsctl service deployments --service stats-node --json"],
  limitations: [`Text output shows the newest ${TEXT_ROWS} markers; --json carries all of them.`],
  async run(context) {
    const service = requireService(context);
    const history = await readServiceHistory(context, service);
    const markers = new Map(history.markers.map(marker => [marker.deploymentId, marker]));
    const deployments = newestFirst(history.deployments).map(deployment => {
      const marker = markers.get(deployment.id)!;
      return { deployment, markerId: marker.markerId, hostIds: marker.hostIds };
    });
    return {
      payload: { service, deployments },
      identities: { deploymentIds: deployments.map(item => item.deployment.id), versionIds: [...new Set(deployments.map(item => item.deployment.versions[0]?.id ?? ""))] }
    };
  },
  render({ service, deployments }) {
    if (deployments.length === 0) return [`no deployment markers recorded for ${service}`];
    const shown = deployments.slice(0, TEXT_ROWS);
    const lines = [`deployment markers for ${service}`, ...table([
      ["deployment", "time", "version", "marker", "hosts", "message"],
      ...shown.map(item => [item.deployment.id, timeText(item.deployment.atMs), item.deployment.versions[0]?.id ?? "", item.markerId, String(item.hostIds.length), item.deployment.message ?? ""])
    ])];
    if (deployments.length > shown.length) lines.push(`${deployments.length - shown.length} older markers omitted; use --json for all`);
    return lines;
  }
});

export const serviceCreateCommand = defineCommand<ServiceCreatePayload>({
  name: "service create",
  summary: "create a service and write its two credentials to an owner-only file",
  description: [
    "MUTATION: creates one service through POST /api/v1/admin/services and writes the response to a new JSON file with mode 0600.",
    "The file holds the deploy token used by `statsctl deploy mark` and the ingest token reserved for application telemetry. Neither token is printed in text or JSON output; the file is the only copy.",
    "The command refuses to overwrite an existing file and refuses a symbolic link or a file readable by group or others.",
    "Management routes use the target's human authentication: a Cloudflare Access credential on the Cloudflare origin, or the Tailscale identity a tailnet origin provides."
  ],
  access: "mutation",
  targets: ["cloudflare", "node"],
  options: {
    name: { type: "string", placeholder: "NAME", required: true, description: "service name: 1-32 lowercase letters, digits, or hyphens, starting with a letter" },
    host: { type: "string", placeholder: "ID[,ID...]", required: true, description: "host ids the service runs on, comma-separated" },
    "health-url": { type: "string", placeholder: "URL", description: "https URL, or an http URL on the tailnet, probed for health" },
    unit: { type: "string", placeholder: "UNIT", description: "service manager unit or cgroup name shown on the service page" },
    "credential-file": { type: "string", placeholder: "FILE", required: true, description: "new file to hold {name, hostIds, deployToken, ingestToken}, created mode 0600; never passed in argv" }
  },
  examples: ["statsctl service create --name stats-node --host h_0123456789abcdef0123456789abcdef --credential-file .work/credentials/stats-node.json"],
  limitations: [
    "The server returns both credentials once; they cannot be read back from the service.",
    "If the file is lost, rotate both credentials with `statsctl service token rotate`; the service itself is not recreated."
  ],
  async run(context) {
    const name = context.option("name");
    if (name === undefined || !PROJECT_ID.test(name)) throw usageError("--name must be 1-32 lowercase letters, digits, or hyphens, starting with a letter");
    const hostIds = hostList(context.option("host") ?? "");
    const healthUrl = context.option("health-url");
    if (healthUrl !== undefined && healthUrl.length > 2048) throw usageError("--health-url must be at most 2048 characters");
    const unit = context.option("unit");
    if (unit !== undefined && !UNIT.test(unit)) throw usageError("--unit must be 1-128 letters, digits, or ._@- starting with a letter or digit");
    const prepared = prepareCredentialWrite(requiredFile(context, "credential-file"), { replace: false });
    const created = await context.http.postJson("/api/v1/admin/services", {
      name,
      hostIds,
      ...(healthUrl === undefined ? {} : { healthUrl }),
      ...(unit === undefined ? {} : { unit })
    }, decodeCreatedService);
    let credentialFile: string;
    try {
      credentialFile = writeCredentialJson(prepared, { ...created.service, deployToken: created.deployToken, ingestToken: created.ingestToken }, { replace: false });
    } catch (error) {
      if (error instanceof CommandError) {
        throw new CommandError(error.exit, error.code, `${error.message}; service ${created.service.name} exists, so recover with statsctl service token rotate --service ${created.service.name} --kind deploy --credential-file ${prepared} then --kind ingest`);
      }
      throw error;
    }
    return { payload: { ...created.service, credentialFile } };
  },
  render(payload) {
    return [
      `created ${payload.name} with ${payload.hostIds.length} host${payload.hostIds.length === 1 ? "" : "s"}`,
      `credentials written to ${payload.credentialFile} (mode 0600); tokens are not printed`,
      `health url: ${payload.healthUrl ?? "none"}`,
      `unit: ${payload.unit ?? "none"}`
    ];
  }
});

export const serviceInspectCommand = defineCommand<ServiceInspectPayload>({
  name: "service inspect",
  summary: "show one service's configuration and latest deployment marker",
  description: ["Reads the service and its marker history, then prints the hosts, health URL, unit, creation time, and the newest marker with its version and deployment id."],
  access: "read",
  targets: ["cloudflare", "node"],
  options: { service: { type: "string", placeholder: "NAME", required: true, description: "service name from `statsctl services`" } },
  examples: ["statsctl service inspect --service stats-node", "statsctl service inspect --service stats-node --json"],
  limitations: ["Marker history is kept for 30 days; a service whose last deploy is older shows no latest marker."],
  async run(context) {
    const name = requireService(context);
    const [service, history] = await Promise.all([readServiceConfig(context, name), readServiceHistory(context, name)]);
    return { payload: { service, latest: latestServiceMarker(history), markers: history.markers.length } };
  },
  render({ service, latest, markers }) {
    const lines = [
      `service ${service.name}`,
      ...table([
        ["hosts", service.hostIds.join(" ")],
        ["unit", service.unit ?? "-"],
        ["health url", service.healthUrl ?? "-"],
        ["created", timeText(service.createdAtMs)],
        ["markers", String(markers)]
      ])
    ];
    if (latest === null) lines.push("latest marker: none recorded");
    else lines.push(
      `latest marker: ${latest.version} (${latest.markerId}) at ${timeText(latest.atMs)}`,
      `deployment: ${latest.deploymentId}`,
      `marker hosts: ${latest.hostIds.join(" ")}`
    );
    return lines;
  }
});

export const serviceTokenRotateCommand = defineCommand<ServiceRotatePayload>({
  name: "service token rotate",
  summary: "replace one service credential and save it to the credential file",
  description: [
    "MUTATION: rotates the deploy or ingest token for one service. The old token stops working immediately.",
    "The new token is written to the credential file and is never printed. When the file exists it must belong to the service, and the other token is preserved; when it does not exist the service configuration is read first and a new file is written with the rotated token.",
    "Use --kind deploy for the marker token read by `statsctl deploy mark`, or --kind ingest for the application telemetry token."
  ],
  access: "mutation",
  targets: ["cloudflare", "node"],
  options: {
    service: { type: "string", placeholder: "NAME", required: true, description: "service name from `statsctl services`" },
    kind: { type: "string", placeholder: "deploy|ingest", description: "which credential to rotate (default: deploy)" },
    "credential-file": { type: "string", placeholder: "FILE", required: true, description: "credential file to update, or create when it does not exist; mode 0600" }
  },
  examples: [
    "statsctl service token rotate --service stats-node --kind deploy --credential-file .work/credentials/stats-node.json",
    "statsctl service token rotate --service stats-node --kind ingest --credential-file .work/credentials/stats-node.json"
  ],
  limitations: ["The old token is invalid before the new one is written; if the file cannot be written, run the command again to rotate and save another token."],
  async run(context) {
    const name = requireService(context);
    const kind = tokenKind(context.option("kind"));
    const file = requiredFile(context, "credential-file");
    let fields: Record<string, unknown>;
    if (credentialFileExists(file)) {
      const credential = readCredentialJson(file, "name and tokens");
      if (credential.fields["name"] !== name) throw authError("credential_file_service", `${credential.path} is the credential for service ${JSON.stringify(credential.fields["name"] ?? null)}, not ${name}`);
      fields = { ...credential.fields };
    } else {
      fields = { ...await readServiceConfig(context, name) };
    }
    const path = kind === "deploy"
      ? `/api/v1/admin/services/${encodeURIComponent(name)}/rotate`
      : `/api/v1/admin/services/${encodeURIComponent(name)}/token/rotate`;
    const token = await context.http.postJson(path, {}, value => decodeRotatedToken(value, name, kind));
    const field = kind === "deploy" ? "deployToken" : "ingestToken";
    let credentialFile: string;
    try {
      credentialFile = writeCredentialJson(file, { ...fields, [field]: token }, { replace: true });
    } catch (error) {
      if (error instanceof CommandError) throw new CommandError(error.exit, error.code, `${error.message}; the ${kind} token for ${name} was rotated but not saved, so run the command again to rotate and save a new token`);
      throw error;
    }
    return { payload: { name, kind, credentialFile } };
  },
  render({ name, kind, credentialFile }) {
    return [
      `rotated the ${kind} token for ${name}`,
      `credentials saved to ${credentialFile} (mode 0600); the new token is not printed`
    ];
  }
});

export const serviceTokenRevokeCommand = defineCommand<ServiceRevokePayload>({
  name: "service token revoke",
  summary: "revoke both service credentials and delete the service",
  description: [
    "MUTATION: deletes the service, both of its credentials, and its deployment markers. Both tokens stop working immediately.",
    "Pass --credential-file to verify that the file belongs to the service before deleting. The file is not removed and becomes stale.",
    "Use `service token rotate` to invalidate one token without deleting the service."
  ],
  access: "mutation",
  targets: ["cloudflare", "node"],
  options: {
    service: { type: "string", placeholder: "NAME", required: true, description: "service name from `statsctl services`" },
    "credential-file": { type: "string", placeholder: "FILE", description: "optional credential file to verify the service name before revoking" }
  },
  examples: ["statsctl service token revoke --service stats-node --credential-file .work/credentials/stats-node.json"],
  limitations: ["Deleting a service also deletes its deployment markers; there is no undo."],
  async run(context) {
    const name = requireService(context);
    const file = context.option("credential-file");
    if (file !== undefined) {
      const credential = readCredentialJson(file, "name");
      if (credential.fields["name"] !== name) throw authError("credential_file_service", `${credential.path} is the credential for service ${JSON.stringify(credential.fields["name"] ?? null)}, not ${name}`);
    }
    await context.http.delete(`/api/v1/admin/services/${encodeURIComponent(name)}`);
    return {
      payload: { name, credentialFile: file ?? null },
      ...(file === undefined ? {} : { warnings: [{ code: "credential_file_stale", message: `${file} still holds the revoked credentials; delete it` }] })
    };
  },
  render({ name, credentialFile }) {
    return [
      `revoked ${name}; both credentials and its deployment markers are deleted`,
      ...(credentialFile === null ? [] : [`the local credential file ${credentialFile} is stale and can be deleted`])
    ];
  }
});

export const serviceCheckCommand = defineCommand<ServiceCheckPayload>({
  name: "service check",
  summary: "check a service's health URL, latest marker, and probe state",
  description: [
    "Reads the service and its deployment history, then probes the configured health URL directly with a 5 second timeout and no credentials.",
    "The probe is up for a 2xx or 3xx response, down for any other response, and unavailable when the URL is missing or does not answer.",
    "Exit 0 when the probe is up and a marker exists, 5 when the health URL or marker is missing or the probe does not answer, and 7 when the probe answers with a failing status."
  ],
  access: "read",
  targets: ["cloudflare", "node"],
  options: { service: { type: "string", placeholder: "NAME", required: true, description: "service name from `statsctl services`" } },
  examples: ["statsctl service check --service stats-node", "statsctl service check --service stats-node --json"],
  limitations: ["The probe is one request from this machine; it does not read the server's recorded probe series."],
  async run(context) {
    const name = requireService(context);
    const [service, history] = await Promise.all([readServiceConfig(context, name), readServiceHistory(context, name)]);
    const probe = await probeHealth(context, service.healthUrl);
    const latest = latestServiceMarker(history);
    const exit = probe.state === "down" ? EXIT.regressed : probe.state === "unavailable" || latest === null ? EXIT.pending : EXIT.ok;
    return {
      payload: { name: service.name, healthUrl: service.healthUrl, unit: service.unit, hostIds: service.hostIds, latest, probe },
      exit
    };
  },
  render({ name, healthUrl, unit, hostIds, latest, probe }) {
    const lines = [
      `service check ${name}`,
      `health url: ${healthUrl ?? "none"}`,
      `probe: ${probe.state}${probe.status === null ? "" : `, status ${probe.status}`}${probe.ms === null ? "" : `, ${probe.ms} ms`} (${probe.detail})`
    ];
    if (latest === null) lines.push("latest marker: none recorded");
    else lines.push(`latest marker: ${latest.version} (${latest.markerId}) at ${timeText(latest.atMs)}`, `deployment: ${latest.deploymentId}`);
    lines.push(`unit: ${unit ?? "none"}`, `hosts: ${hostIds.join(" ") || "none"}`);
    return lines;
  }
});
